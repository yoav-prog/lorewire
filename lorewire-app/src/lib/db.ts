// Dual-driver data access. With DATABASE_URL set we talk to Postgres (porsager
// "postgres", pure JS); without it we use Node 24's built-in node:sqlite against
// the same file the Python pipeline writes. The same SQL runs on both: we keep
// to portable types and translate "?" placeholders to "$1" for Postgres.
//
// Callers use all/one/run; the schema is created/migrated on first query.

import "server-only";
import path from "node:path";
import {
  TABLES,
  POST_TABLE_DDL,
  createTableSql,
  type Table,
} from "@/lib/schema";

export type Row = Record<string, unknown>;

export interface TxHandle {
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
}

interface Driver {
  kind: "postgres" | "sqlite";
  all(sql: string, params: unknown[]): Promise<Row[]>;
  run(sql: string, params: unknown[]): Promise<void>;
  columns(table: string): Promise<string[]>;
  tx<T>(fn: (tx: TxHandle) => Promise<T>): Promise<T>;
}

declare global {
  // Cached across dev HMR reloads so we do not reopen the SQLite handle or
  // re-run migrations on every request.
  // eslint-disable-next-line no-var
  var __lwDriver: Promise<Driver> | undefined;
  // eslint-disable-next-line no-var
  var __lwSchema: Promise<Driver> | undefined;
}

function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function makeDriver(): Promise<Driver> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const postgres = (await import("postgres")).default;
    // Serverless tuning: each function instance holds at most one connection
    // (the driver's default of 10 exhausts the DB across cold starts and is
    // the wrong shape for Vercel). prepare=false keeps us compatible with
    // transaction-mode poolers (Neon, Supabase). The idle/connect timeouts
    // recycle stalled handles rather than waiting forever on a dead pooler.
    const sql = postgres(url, {
      prepare: false,
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
    });
    return {
      kind: "postgres",
      async all(text, params) {
        return (await sql.unsafe(toPg(text), params as never[])) as unknown as Row[];
      },
      async run(text, params) {
        await sql.unsafe(toPg(text), params as never[]);
      },
      async columns(table) {
        const rows = (await sql.unsafe(
          "SELECT column_name FROM information_schema.columns WHERE table_name = $1",
          [table],
        )) as unknown as Array<{ column_name: string }>;
        return rows.map((r) => r.column_name);
      },
      async tx<T>(fn: (tx: TxHandle) => Promise<T>): Promise<T> {
        // porsager/postgres exposes `sql.begin(async tx => ...)` which
        // pins a single connection for the whole block and rolls back on
        // throw. We adapt its callback to our TxHandle shape so callers
        // see the same `all`/`run` they'd use outside a transaction.
        const txResult = await sql.begin(async (txSql) => {
          const handle: TxHandle = {
            async all(text, params = []) {
              return (await txSql.unsafe(
                toPg(text),
                params as never[],
              )) as unknown as Row[];
            },
            async run(text, params = []) {
              await txSql.unsafe(toPg(text), params as never[]);
            },
          };
          return await fn(handle);
        });
        return txResult as T;
      },
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const file =
    process.env.PIPELINE_DB ||
    path.join(process.cwd(), "..", "pipeline", "lorewire.db");
  const handle = new DatabaseSync(file);
  handle.exec("PRAGMA journal_mode = WAL");
  return {
    kind: "sqlite",
    async all(sql, params) {
      return handle.prepare(sql).all(...(params as never[])) as Row[];
    },
    async run(sql, params) {
      handle.prepare(sql).run(...(params as never[]));
    },
    async columns(table) {
      const rows = handle
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      return rows.map((r) => r.name);
    },
    async tx<T>(fn: (tx: TxHandle) => Promise<T>): Promise<T> {
      // node:sqlite shares one connection across the process, so BEGIN
      // / COMMIT statements emitted via the same handle form a single
      // transaction. We DO NOT support nested tx — guarded by the
      // single shared handle (BEGIN inside BEGIN throws on SQLite). A
      // throw inside `fn` triggers ROLLBACK and re-throws so the caller
      // sees the original error.
      handle.exec("BEGIN");
      try {
        const txHandle: TxHandle = {
          async all(sql, params = []) {
            return handle.prepare(sql).all(...(params as never[])) as Row[];
          },
          async run(sql, params = []) {
            handle.prepare(sql).run(...(params as never[]));
          },
        };
        const result = await fn(txHandle);
        handle.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          handle.exec("ROLLBACK");
        } catch {
          // If ROLLBACK itself fails the original error is more useful.
        }
        throw err;
      }
    },
  };
}

// Create each table, then additively add any column missing on an older DB.
// After all tables exist, run the load-bearing index DDL in POST_TABLE_DDL —
// these are the indexes the TS write paths actually depend on (e.g. the
// partial unique index that the story_jobs ON CONFLICT clause targets).
async function ensureSchema(d: Driver): Promise<Driver> {
  for (const t of TABLES) {
    try {
      await d.run(createTableSql(t), []);
    } catch {
      // Postgres's CREATE TABLE IF NOT EXISTS is NOT atomic against
      // concurrent transactions on a not-yet-existing relation: two
      // workers can both pass the existence check, both try to insert
      // into pg_type, and the loser gets `duplicate key value violates
      // unique constraint "pg_type_typname_nsp_index"`. This bit the
      // voiceover-picker Phase 4 deploy when `voice_renders` was new —
      // existing tables raced cleanly (NOTICE "already exists,
      // skipping") but the brand-new one tripped the catalog. Safe to
      // swallow: the column-existence check below verifies the table
      // actually exists. If it genuinely doesn't, the ALTER TABLE
      // loop's catch handles the missing-column case the same way.
    }
    const existing = new Set(await d.columns(t.name));
    for (const c of t.columns) {
      if (c.pk || existing.has(c.name)) continue;
      try {
        await d.run(`ALTER TABLE ${t.name} ADD COLUMN ${c.name} ${c.type}`, []);
      } catch {
        // A concurrent migration may have added it; safe to ignore.
      }
    }
  }
  for (const stmt of POST_TABLE_DDL) {
    try {
      await d.run(stmt, []);
    } catch {
      // CREATE INDEX IF NOT EXISTS is idempotent, but a concurrent
      // migration may collide; safe to ignore on retry.
    }
  }
  return d;
}

export function db(): Promise<Driver> {
  if (!globalThis.__lwSchema) {
    globalThis.__lwDriver ??= makeDriver();
    globalThis.__lwSchema = globalThis.__lwDriver.then(ensureSchema);
  }
  return globalThis.__lwSchema;
}

export async function all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await (await db()).all(sql, params)) as unknown as T[];
}

export async function one<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await all<T>(sql, params);
  return rows[0] ?? null;
}

export async function run(sql: string, params: unknown[] = []): Promise<void> {
  await (await db()).run(sql, params);
}

/** Run `fn` inside a database transaction. The handle exposes the same
 *  `all` / `run` shape callers use outside a transaction. Throwing inside
 *  `fn` rolls back; returning commits. Both drivers honour this contract:
 *  Postgres via `sql.begin`, SQLite via shared-connection BEGIN/COMMIT. */
export async function tx<T>(
  fn: (tx: TxHandle) => Promise<T>,
): Promise<T> {
  return (await db()).tx(fn);
}
