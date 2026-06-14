#!/usr/bin/env node
/**
 * One-shot migration: move the five pipeline-owned cache fields
 *   - world_bible
 *   - scene_prompts
 *   - scene_prompts_built_with
 *   - scene_entity_ids
 *   - character_bible (legacy)
 *
 * out of `stories.video_config` and into `stories.pipeline_cache`.
 * Idempotent — re-running it after the source rows are already migrated
 * is a no-op because the WHERE clause skips rows whose video_config no
 * longer has any of the five keys.
 *
 * Why this exists: the editor's parseVideoConfig strictly drops
 * unknown top-level fields. Every heartbeat write path wiped the
 * pipeline-owned cache silently, forcing the first scene worker on
 * every Rebuild to re-pay the ~$0.30 world-bible build cost — which
 * busted the 270s cron deadline and locked the batch in an infinite
 * re-claim loop on the `envelope` story (2026-06-14).
 *
 * Plan: _plans/2026-06-14-pipeline-cache-column.md
 *
 * Run:
 *   node scripts/migrate_pipeline_cache.mjs           # dry run, prints affected count
 *   node scripts/migrate_pipeline_cache.mjs --apply   # actually moves the data
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(APP_ROOT, "..");
const ENV_CANDIDATES = [
  resolve(APP_ROOT, ".env.local"),
  resolve(REPO_ROOT, ".env.local"),
];

const CACHE_KEYS = [
  "world_bible",
  "scene_prompts",
  "scene_prompts_built_with",
  "scene_entity_ids",
  "character_bible",
];

async function readDatabaseUrl() {
  for (const candidate of ENV_CANDIDATES) {
    try {
      const raw = await readFile(candidate, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^DATABASE_URL=(.*)$/);
        if (!m) continue;
        let val = m[1].trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (val) return val;
      }
    } catch {
      // next candidate
    }
  }
  console.error("[migrate] no DATABASE_URL found in .env.local");
  process.exit(2);
}

function splitCache(rawConfig) {
  if (!rawConfig) return null;
  let parsed;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const cacheOut = {};
  const editorOut = { ...parsed };
  let hadAny = false;
  for (const key of CACHE_KEYS) {
    if (key in editorOut) {
      cacheOut[key] = editorOut[key];
      delete editorOut[key];
      hadAny = true;
    }
  }
  if (!hadAny) return null;
  return { cache: cacheOut, editor: editorOut };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const url = await readDatabaseUrl();
  const postgres = (await import("postgres")).default;
  const sql = postgres(url, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  try {
    const candidates = await sql`
      SELECT id, video_config, pipeline_cache
        FROM stories
       WHERE video_config IS NOT NULL
    `;
    let moved = 0;
    let skipped = 0;
    let merged = 0;
    for (const row of candidates) {
      const split = splitCache(row.video_config);
      if (!split) {
        skipped++;
        continue;
      }
      moved++;
      // If pipeline_cache already holds data (idempotency edge case
      // where a fresh write landed before the migration ran), merge
      // — existing pipeline_cache keys WIN over the legacy video_config
      // values because they're the more recent write.
      let mergedCache = split.cache;
      if (row.pipeline_cache) {
        try {
          const existing = JSON.parse(row.pipeline_cache);
          if (existing && typeof existing === "object" && !Array.isArray(existing)) {
            mergedCache = { ...split.cache, ...existing };
            merged++;
          }
        } catch {
          // existing cache unparseable: replace.
        }
      }
      if (!apply) continue;
      await sql`
        UPDATE stories
           SET pipeline_cache = ${JSON.stringify(mergedCache)},
               video_config   = ${JSON.stringify(split.editor)},
               updated_at     = ${new Date().toISOString()}
         WHERE id = ${row.id}
      `;
    }
    console.info(
      `[migrate pipeline cache] mode=${apply ? "APPLY" : "DRY-RUN"} ` +
      `scanned=${candidates.length} moved=${moved} ` +
      `merged_with_existing=${merged} skipped_no_keys=${skipped}`,
    );
    if (!apply && moved > 0) {
      console.info("[migrate pipeline cache] re-run with --apply to commit the change");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[migrate pipeline cache] fatal", err);
  process.exit(1);
});
