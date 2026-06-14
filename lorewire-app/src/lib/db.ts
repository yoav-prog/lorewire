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

interface Driver {
  kind: "postgres" | "sqlite";
  all(sql: string, params: unknown[]): Promise<Row[]>;
  run(sql: string, params: unknown[]): Promise<void>;
  columns(table: string): Promise<string[]>;
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
  };
}

// Create each table, then additively add any column missing on an older DB.
// After all tables exist, run the load-bearing index DDL in POST_TABLE_DDL —
// these are the indexes the TS write paths actually depend on (e.g. the
// partial unique index that the story_jobs ON CONFLICT clause targets).
async function ensureSchema(d: Driver): Promise<Driver> {
  for (const t of TABLES) {
    await d.run(createTableSql(t), []);
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
