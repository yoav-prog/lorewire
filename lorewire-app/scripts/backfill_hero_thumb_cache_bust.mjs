#!/usr/bin/env node
/**
 * One-time backfill for the cache-bust fix shipped 2026-06-27.
 *
 * `pipeline/media.py:_cache_bust` stamps `?v={int(time.time())}` onto
 * every hero/thumbnail URL a regen writes, so cache layers (browser,
 * Vercel Image Optimizer, Cloudflare/edge) treat each regen as a
 * fresh asset. But that only helps URLs WRITTEN AFTER the fix
 * shipped. URLs already in the DB still carry the bust-less form
 * (e.g. `https://media.lorewire.com/<id>/hero.webp`) — every cache
 * layer keeps serving whichever version it last fetched for that
 * exact URL, and the user sees the thumbnail "revert" on subsequent
 * loads.
 *
 * This script does ONE thing: for every story whose hero/thumb
 * column carries a non-empty URL with NO `v=` query param, append
 * `?v=<NOW>` (or `&v=<NOW>` when the URL already has a query
 * string). R2/GCS ignore the query for object lookup, so the file
 * still serves; every layer in front keys on the full URL, so the
 * new `v=` is a fresh cache entry that pulls the CURRENT bytes from
 * R2. No file is moved or renamed.
 *
 * Safety:
 *   - Default is --dry-run: prints the WHERE clause counts + a
 *     handful of sample before/after URLs. No writes.
 *   - --apply runs the actual UPDATE. Prints the rows affected per
 *     column.
 *   - Idempotent. Re-runs do nothing because the WHERE clause skips
 *     URLs that already carry `v=`.
 *   - Touches ONLY the five hero/thumbnail columns on `stories`. Does
 *     not touch `images`, `video_url`, `props`, articles, anything
 *     else.
 *
 * Run:
 *   node scripts/backfill_hero_thumb_cache_bust.mjs            # dry-run
 *   node scripts/backfill_hero_thumb_cache_bust.mjs --apply    # write
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

const COLUMNS = [
  "hero_image",
  "hero_image_landscape",
  "thumbnail_image",
  "thumbnail_image_landscape",
  "thumbnail_image_square",
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
    } catch {}
  }
  console.error("[backfill] no DATABASE_URL found in .env.local");
  process.exit(2);
}

function bust(url, ts) {
  if (!url) return url;
  if (url.includes("v=")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${ts}`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const ts = Math.floor(Date.now() / 1000);
  console.info(`[backfill] mode=${apply ? "APPLY" : "DRY-RUN"}  bust_value=${ts}`);

  const url = await readDatabaseUrl();
  const postgres = (await import("postgres")).default;
  const sql = postgres(url, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 10 });
  try {
    for (const col of COLUMNS) {
      // Eligibility: non-NULL, non-empty, and no `v=` substring yet.
      const eligible = await sql`
        SELECT count(*)::int AS n
          FROM stories
         WHERE ${sql(col)} IS NOT NULL
           AND ${sql(col)} <> ''
           AND ${sql(col)} NOT LIKE '%v=%'
      `;
      const n = eligible[0]?.n ?? 0;
      console.info(`\n[backfill] column=${col}  eligible_rows=${n}`);
      if (n === 0) continue;

      const samples = await sql`
        SELECT id, ${sql(col)} AS val
          FROM stories
         WHERE ${sql(col)} IS NOT NULL
           AND ${sql(col)} <> ''
           AND ${sql(col)} NOT LIKE '%v=%'
         ORDER BY id LIMIT 3
      `;
      for (const r of samples) {
        const before = r.val;
        const after = bust(before, ts);
        console.info(`  ${r.id}`);
        console.info(`     before: ${before}`);
        console.info(`     after : ${after}`);
      }

      if (!apply) continue;
      // UPDATE in one round-trip — same `bust` shape Postgres can
      // compute inline. Skip rows that already carry the marker.
      const updated = await sql`
        UPDATE stories
           SET ${sql(col)} = ${sql(col)} ||
                 CASE WHEN ${sql(col)} LIKE '%?%' THEN '&' ELSE '?' END ||
                 'v=' || ${ts}::text
         WHERE ${sql(col)} IS NOT NULL
           AND ${sql(col)} <> ''
           AND ${sql(col)} NOT LIKE '%v=%'
        RETURNING id
      `;
      console.info(`  [backfill] wrote ${updated.length} rows for ${col}`);
    }

    if (!apply) {
      console.info(
        "\n[backfill] DRY-RUN complete. Re-run with --apply to write.",
      );
    } else {
      console.info("\n[backfill] DONE.");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[backfill] fatal", err);
  process.exit(1);
});
