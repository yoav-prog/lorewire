#!/usr/bin/env node
/**
 * Surgical cancel for a single "All scene images" batch on one story.
 *
 * Why this exists (and not just clear_stuck_image_renders.mjs): the
 * existing helper clears EVERY non-terminal row globally. After the
 * 2026-06-14 pipeline_cache split, the operator needs to cancel one
 * stuck batch (the `envelope` 27-scene rebuild that infinite-looped on
 * the world-bible build) without touching other stories' in-flight work.
 *
 * Behavior:
 *   - Finds the most recent scene:* batch for the named story.
 *   - Lists every row in that batch with status + age.
 *   - On --apply, flips every (queued|generating) row in the batch to
 *     status='cancelled' with a reason that surfaces in the admin UI.
 *
 * Run:
 *   node scripts/cancel_scene_batch.mjs envelope             # dry run
 *   node scripts/cancel_scene_batch.mjs envelope --apply     # commit
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

const REASON =
  "manual cancel 2026-06-14 — pipeline_cache wipe loop, re-enqueue after fix";

async function readDatabaseUrl() {
  for (const candidate of ENV_CANDIDATES) {
    try {
      const raw = await readFile(candidate, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^DATABASE_URL=(.*)$/);
        if (!m) continue;
        let val = m[1].trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
        if (val) return val;
      }
    } catch {
      // next candidate
    }
  }
  console.error("[cancel batch] no DATABASE_URL found in .env.local");
  process.exit(2);
}

function ageMin(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.round((Date.now() - t) / 60000);
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const apply = process.argv.includes("--apply");
  const ownerId = args[0];
  if (!ownerId) {
    console.error(
      "[cancel batch] usage: node scripts/cancel_scene_batch.mjs <story_id> [--apply]",
    );
    process.exit(2);
  }

  const url = await readDatabaseUrl();
  const postgres = (await import("postgres")).default;
  const sql = postgres(url, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  try {
    const newest = await sql`
      SELECT requested_at
        FROM image_renders
       WHERE owner_kind = 'story'
         AND owner_id = ${ownerId}
         AND asset LIKE 'scene:%'
       ORDER BY requested_at DESC
       LIMIT 1
    `;
    if (newest.length === 0) {
      console.info(`[cancel batch] no scene:* rows for story=${ownerId}`);
      return;
    }
    const batchTs = newest[0].requested_at;
    const rows = await sql`
      SELECT id, asset, status, started_at, requested_at
        FROM image_renders
       WHERE owner_kind = 'story'
         AND owner_id = ${ownerId}
         AND asset LIKE 'scene:%'
         AND requested_at >= ${batchTs}
       ORDER BY asset
    `;

    const counts = new Map();
    for (const r of rows) {
      counts.set(r.status, (counts.get(r.status) || 0) + 1);
    }
    console.info(
      `[cancel batch] story=${ownerId} batch_requested_at=${batchTs} ` +
        `total=${rows.length} status=${JSON.stringify(
          Object.fromEntries([...counts.entries()].sort()),
        )}`,
    );
    for (const r of rows) {
      const startedAge = r.started_at
        ? `start=${ageMin(r.started_at)}m ago`
        : "start=-";
      console.info(
        `  ${r.asset.padEnd(10)}  ${r.status.padEnd(11)}  ${startedAge}`,
      );
    }

    const toCancel = rows.filter(
      (r) => r.status === "queued" || r.status === "generating",
    );
    if (toCancel.length === 0) {
      console.info("[cancel batch] no active rows to cancel. exiting.");
      return;
    }

    if (!apply) {
      console.info(
        `\n[cancel batch] would cancel ${toCancel.length} row(s). ` +
          "re-run with --apply to commit.",
      );
      return;
    }

    const ids = toCancel.map((r) => r.id);
    const result = await sql`
      UPDATE image_renders
         SET status = 'cancelled',
             error = ${REASON},
             finished_at = (now() AT TIME ZONE 'utc')::text
       WHERE id IN ${sql(ids)}
         AND status IN ('queued', 'generating')
    `;
    console.info(`[cancel batch] cancelled ${result.count} row(s).`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[cancel batch] fatal", err);
  process.exit(1);
});
