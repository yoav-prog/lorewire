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
import {
  LEGACY_DEFAULT_ASPECT,
  activeSegmentSettingKey,
  isVideoAspect,
  legacyActiveSegmentSettingKey,
  type VideoAspect,
} from "@/lib/aspect";
import { CATEGORY_DEFS } from "@/lib/categories/manifest";
import { GRANULAR_CATEGORIES } from "@/lib/categories/granular";

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
  try {
    await seedActiveSegmentAspect(d);
  } catch {
    // Best-effort data seed (see below). A failure must never block schema
    // readiness — the slot stays empty and the render falls to body-only
    // until the admin sets an active segment by hand.
  }
  try {
    await cleanupStaleThinCategoryCurations(d);
  } catch {
    // Best-effort cleanup. Failure leaves the curation rows in place; the
    // homepage still renders correctly because resolveRailIds augments
    // curated picks with the fallback (2026-06-24 semantic change).
  }
  try {
    await seedCategoriesImpl(d);
  } catch {
    // Best-effort: a failed seed leaves the categories table empty; the app
    // still renders today's behavior from stories.category (story_tags is
    // not on the read path yet). Retried on the next boot.
  }
  try {
    await seedGranularCategoriesImpl(d);
  } catch {
    // Best-effort: a failed granular seed leaves the 17 absent / the legacy
    // six still active; the current UI is unaffected (it reads the manifest,
    // not the DB). Retried on the next boot.
  }
  try {
    await backfillStoryPrimaryTagsImpl(d);
  } catch {
    // Best-effort: leaves some stories without a primary tag; self-heals on
    // a later boot once the categories seed has landed.
  }
  return d;
}

// One-shot, idempotent seed for the per-aspect active intro/outro pointers
// (_plans/2026-06-15-intro-outro-per-aspect-active.md). Before this change the
// active segment lived under a single key per kind; now each aspect has its own
// slot. Copy the legacy pointer into the slot matching its segment's aspect so
// existing renders keep their branding the instant the code ships, with no
// manual migration step. It runs inside the schema chain (awaited before any
// query resolves), but only fills an EMPTY slot — so it's a no-op once seeded
// and never overrides an admin's pick. Mirror of `_seed_active_segment_aspect`
// in pipeline/store.py; whichever runtime boots first against the shared DB
// wins and the other no-ops. Uses the raw driver (not the module-level all/run)
// to avoid re-entering db() while the schema promise is still resolving.
async function seedActiveSegmentAspect(d: Driver): Promise<void> {
  for (const kind of ["intro", "outro"] as const) {
    const legacyRows = await d.all("SELECT value FROM settings WHERE key = ?", [
      legacyActiveSegmentSettingKey(kind),
    ]);
    const legacyId = String((legacyRows[0]?.value as string) ?? "").trim();
    if (!legacyId) continue;

    // Skip a dangling legacy pointer — seeding it would just point a new slot
    // at a deleted row, which the resolver drops anyway.
    const segRows = await d.all("SELECT aspect FROM video_segments WHERE id = ?", [
      legacyId,
    ]);
    if (!segRows.length) continue;
    const rawAspect = segRows[0].aspect;
    const aspect: VideoAspect = isVideoAspect(rawAspect)
      ? rawAspect
      : LEGACY_DEFAULT_ASPECT;

    const slotKey = activeSegmentSettingKey(kind, aspect);
    const slotRows = await d.all("SELECT value FROM settings WHERE key = ?", [
      slotKey,
    ]);
    if (String((slotRows[0]?.value as string) ?? "").trim()) continue;

    await d.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [slotKey, legacyId],
    );
  }
}

// 2026-06-24 one-shot: clear stale tiny curations on category rails +
// new_row. Production homepage was showing 2 Dramas because an old
// 2-pick `drama_row` curation was authoritative — resolveRailIds treated
// curation as the full rail. The fallback chain has since been fixed
// (curation now AUGMENTS the fallback instead of replacing it), but the
// old tiny curated entries are leftover state that pin two arbitrary
// stories at the front of every affected rail. This cleanup removes
// them so the rail is purely auto-derived until the admin re-curates.
//
// Safety:
//   - Settings flag guards against re-running: the cleanup fires once
//     across all serverless cold starts.
//   - Only deletes when count < 4 — a fatter curation is admin-intent
//     and must not be touched.
//   - Skips hero (single-pick), top10 (capacity-bound editorial), and
//     continue (personalized) — only the surfaces the user complained
//     about.
//   - Logs every cleared surface per rule 14 so a deploy-time grep
//     confirms what changed.
async function cleanupStaleThinCategoryCurations(d: Driver): Promise<void> {
  const DONE_KEY = "curation.cleanup_2026_06_24_stale_thin_picks_done";
  const settingRows = await d.all(
    "SELECT value FROM settings WHERE key = ?",
    [DONE_KEY],
  );
  if (
    settingRows.length > 0 &&
    String((settingRows[0]?.value as string) ?? "") === "true"
  ) {
    return;
  }

  const surfaces = [
    "entitled_row",
    "humor_row",
    "wholesome_row",
    "dating_row",
    "roommate_row",
    "drama_row",
    "new_row",
  ];
  const THIN_THRESHOLD = 4;
  const cleared: Record<string, number> = {};
  const kept: Record<string, number> = {};

  for (const surface of surfaces) {
    const countRows = await d.all(
      "SELECT COUNT(*) as n FROM homepage_curation WHERE surface = ?",
      [surface],
    );
    const n = Number(countRows[0]?.n ?? 0);
    if (n === 0) continue;
    if (n < THIN_THRESHOLD) {
      await d.run("DELETE FROM homepage_curation WHERE surface = ?", [surface]);
      cleared[surface] = n;
    } else {
      kept[surface] = n;
    }
  }

  await d.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [DONE_KEY, "true"],
  );

  // eslint-disable-next-line no-console -- rule 14
  console.info("[lorewire curation cleanup 2026-06-24]", { cleared, kept });
}

// 2026-07-01 data-driven category taxonomy (PR2,
// _plans/2026-07-01-category-taxonomy-multitag.md). Seed the `categories`
// registry from the shared manifest. Idempotent: ON CONFLICT DO NOTHING so
// admin edits (PR4) are never clobbered. PR2 seeds today's six (all rails);
// the granular set lands in PR3. Mirror of a future pipeline/store.py seed —
// whichever runtime boots first against the shared DB wins, the other no-ops.
async function seedCategoriesImpl(d: Driver): Promise<void> {
  const now = new Date().toISOString();
  for (let i = 0; i < CATEGORY_DEFS.length; i++) {
    const c = CATEGORY_DEFS[i];
    await d.run(
      "INSERT INTO categories " +
        "(slug, label, glyph, color, is_rail, rail_surface, rail_title, sort, status, description, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(slug) DO NOTHING",
      [c.slug, c.label, c.glyph, c.color, 1, c.railSurface, c.railTitle, i, "active", null, now, now],
    );
  }
}

// Map each story's current stories.category LABEL to a category slug via the
// seeded `categories` table and insert it as the story's primary tag. The
// JOIN skips stories whose category matches no seeded category; the NOT
// EXISTS guard skips stories that already carry a primary, so this is
// idempotent and self-heals for stories created after the first run.
// stories.category is left untouched — it stays the denormalized label the
// current read paths use; story_tags is the new slug source and the
// categories table bridges the two.
async function backfillStoryPrimaryTagsImpl(d: Driver): Promise<void> {
  const now = new Date().toISOString();
  await d.run(
    "INSERT INTO story_tags (story_id, category_slug, is_primary, source, confidence, created_at) " +
      "SELECT s.id, c.slug, 1, 'migration', NULL, ? " +
      "FROM stories s JOIN categories c ON c.label = s.category " +
      "WHERE s.category IS NOT NULL " +
      "AND NOT EXISTS (" +
      "SELECT 1 FROM story_tags t WHERE t.story_id = s.id AND t.is_primary = 1" +
      ")",
    [now],
  );
}

// Public, idempotent wrappers for manual re-runs + tests. They resolve the
// driver through db() (post-schema), so they must NOT be called from inside
// the schema chain — ensureSchema uses the *Impl functions with the raw
// driver to avoid re-entering db() while the schema promise is resolving.
export async function seedCategories(): Promise<void> {
  await seedCategoriesImpl(await db());
}

export async function backfillStoryPrimaryTags(): Promise<void> {
  await backfillStoryPrimaryTagsImpl(await db());
}

// 2026-07-01 PR3: seed the 17 granular categories and retire the legacy six.
// The 17 become the classifier's active option set; the six stay in the
// table (stories.category + the PR2 story_tags backfill still reference them
// through the transition) but move to status='legacy' so they're excluded
// from new classification and the eventual read path. Idempotent: ON CONFLICT
// DO NOTHING on insert, plus the status guard on the retire UPDATE. Does NOT
// touch the current UI, which reads the manifest, not the DB categories.
async function seedGranularCategoriesImpl(d: Driver): Promise<void> {
  const now = new Date().toISOString();
  for (let i = 0; i < GRANULAR_CATEGORIES.length; i++) {
    const c = GRANULAR_CATEGORIES[i];
    await d.run(
      "INSERT INTO categories " +
        "(slug, label, glyph, color, is_rail, rail_surface, rail_title, sort, status, description, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(slug) DO NOTHING",
      [c.slug, c.label, c.glyph, c.color, c.isRail ? 1 : 0, null, c.railTitle, i, "active", c.description, now, now],
    );
  }
  // Retire the legacy six (drama / entitled / humor / wholesome / dating /
  // roommate) from the active set.
  const legacySlugs = CATEGORY_DEFS.map((c) => c.slug);
  const placeholders = legacySlugs.map(() => "?").join(", ");
  await d.run(
    "UPDATE categories SET status = 'legacy', updated_at = ? " +
      `WHERE slug IN (${placeholders}) AND status = 'active'`,
    [now, ...legacySlugs],
  );
}

export async function seedGranularCategories(): Promise<void> {
  await seedGranularCategoriesImpl(await db());
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
