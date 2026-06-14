#!/usr/bin/env node
/**
 * Read-only diagnostic for a stalled "All scene images" batch.
 *
 * Finds the most-recent scene:N batch (latest requested_at on an
 * asset LIKE 'scene:%' row), prints every row in that batch with
 * status + timing, then prints the last 30 events from
 * image_render_events for any row in that batch.
 *
 * The shape we care about when debugging the stall:
 *   - status distribution across the 27 rows
 *   - which row is at 'generating', and how long ago its started_at was
 *   - whether the cron has emitted any 'claim' / 'reaped' events recently
 *     (silence = cron isn't firing or is bailing on lock_busy)
 *
 * Run:  node scripts/peek_scene_batch.mjs
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
  console.error("[peek] no DATABASE_URL found in .env.local");
  process.exit(2);
}

function ageSeconds(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.round((Date.now() - t) / 1000);
}

function fmtAge(iso) {
  const s = ageSeconds(iso);
  if (s === null) return "-";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

async function main() {
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
      SELECT owner_kind, owner_id, requested_at
        FROM image_renders
       WHERE asset LIKE 'scene:%'
       ORDER BY requested_at DESC
       LIMIT 1
    `;
    if (newest.length === 0) {
      console.info("[peek] no scene:* rows exist at all");
      return;
    }
    const { owner_kind: ownerKind, owner_id: ownerId, requested_at: batchTs } = newest[0];
    console.info(
      `[peek] latest batch: owner=${ownerKind}/${ownerId} requested_at=${batchTs}`,
    );

    const rows = await sql`
      SELECT id, asset, status, started_at, finished_at,
             cost_cents, error
        FROM image_renders
       WHERE owner_kind = ${ownerKind}
         AND owner_id = ${ownerId}
         AND asset LIKE 'scene:%'
         AND requested_at >= ${batchTs}
       ORDER BY asset ASC
    `;

    const byStatus = new Map();
    for (const r of rows) {
      byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1);
    }
    console.info(`\n[peek] batch size: ${rows.length}`);
    console.info("[peek] status counts:");
    for (const [s, n] of [...byStatus.entries()].sort()) {
      console.info(`  ${s.padEnd(12)}  ${n}`);
    }

    console.info("\n[peek] every row in this batch:");
    for (const r of rows) {
      const startedAge = r.started_at ? `start=${fmtAge(r.started_at)}` : "start=-";
      const finishedAge = r.finished_at ? `done=${fmtAge(r.finished_at)}` : "done=-";
      const err = r.error ? `  err=${(r.error || "").slice(0, 80)}` : "";
      console.info(
        `  ${r.asset.padEnd(10)}  ${r.status.padEnd(11)}  ` +
          `${startedAge.padEnd(18)}  ${finishedAge.padEnd(18)}  ` +
          `cost=${r.cost_cents ?? "-"}${err}`,
      );
    }

    const renderIds = rows.map((r) => r.id);
    if (renderIds.length === 0) return;

    const events = await sql`
      SELECT render_id, ts, level, event, message
        FROM image_render_events
       WHERE render_id IN ${sql(renderIds)}
       ORDER BY ts DESC
       LIMIT 30
    `;
    console.info(`\n[peek] last ${events.length} events on any row in this batch:`);
    const renderIdToAsset = new Map(rows.map((r) => [r.id, r.asset]));
    for (const e of events.reverse()) {
      const asset = renderIdToAsset.get(e.render_id) || "?";
      console.info(
        `  ${e.ts}  ${(e.level || "").padEnd(5)}  ${asset.padEnd(10)}  ` +
          `${(e.event || "").padEnd(16)}  ${(e.message || "").slice(0, 80)}`,
      );
    }

    const reaperCutoffS = 180;
    const stuck = rows.filter(
      (r) =>
        r.status === "generating" &&
        r.started_at &&
        ageSeconds(r.started_at) > reaperCutoffS,
    );
    if (stuck.length > 0) {
      console.info(
        `\n[peek] ${stuck.length} row(s) are 'generating' AND older than ` +
          `STALE_AFTER_S=${reaperCutoffS}s. ` +
          "If the cron is firing, the reaper should have reset these. " +
          "Silence in the events block above suggests the cron has stopped firing.",
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[peek] fatal", err);
  process.exit(1);
});
