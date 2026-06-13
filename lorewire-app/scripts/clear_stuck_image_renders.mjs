#!/usr/bin/env node
/**
 * One-shot to clear stuck image_renders rows from production Postgres
 * without needing access to the Neon web console.
 *
 * Why this exists: 2026-06-13 the AITA story had 4 rows pinned at
 * "Queued · 2m ago" because no production worker was running. We
 * shipped the cron drain in commit a26c4e2 but the queue still needs
 * to be unjammed before the cron starts processing fresh work — and
 * the operator (Yoav) couldn't get into Neon's UI today.
 *
 * Reads DATABASE_URL from the local `.env.local` (same file the Next
 * admin uses) so it points at the same DB the admin writes to. No
 * other args — runs the preview by default and only applies on
 * --apply.
 *
 * Run:
 *   node scripts/clear_stuck_image_renders.mjs            # preview
 *   node scripts/clear_stuck_image_renders.mjs --apply    # commit
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(APP_ROOT, "..");
// .env.local can live in either the Next app dir (Next convention) or the
// repo root (older layout). Check both so the script doesn't care.
const ENV_CANDIDATES = [
  resolve(APP_ROOT, ".env.local"),
  resolve(REPO_ROOT, ".env.local"),
];

async function readDatabaseUrl() {
  let raw = null;
  let usedPath = null;
  for (const candidate of ENV_CANDIDATES) {
    try {
      raw = await readFile(candidate, "utf8");
      usedPath = candidate;
      break;
    } catch {
      // try the next candidate
    }
  }
  if (raw === null) {
    console.error(
      "[clear stuck] no .env.local found. looked in:\n  " +
        ENV_CANDIDATES.join("\n  "),
    );
    process.exit(2);
  }
  console.info(`[clear stuck] reading env from ${usedPath}`);
  // .env.local is "KEY=value" per line — handle optional quotes + comments.
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^DATABASE_URL=(.*)$/);
    if (!m) continue;
    let val = m[1].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    if (val) return val;
  }
  console.error(`[clear stuck] DATABASE_URL not found in ${usedPath}`);
  process.exit(2);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const url = await readDatabaseUrl();
  const host = url.match(/@([^/:]+)/)?.[1] ?? "unknown";
  console.info(`[clear stuck] connected target: ${host}`);

  const postgres = (await import("postgres")).default;
  const sql = postgres(url, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  try {
    // Preview is non-destructive — always runs.
    const rows = await sql`
      SELECT id, owner_kind, owner_id, asset, status, requested_at
        FROM image_renders
       WHERE status IN ('queued', 'generating')
       ORDER BY requested_at
    `;
    console.info(`[clear stuck] stuck rows: ${rows.length}`);
    for (const r of rows) {
      console.info(
        `  ${r.requested_at}  ${r.status.padEnd(10)}  ` +
          `${r.owner_kind}/${r.owner_id}  asset=${r.asset}  id=${r.id}`,
      );
    }

    if (!apply) {
      if (rows.length === 0) {
        console.info("[clear stuck] nothing to clear. exiting.");
      } else {
        console.info(
          "\n[clear stuck] preview only. re-run with --apply to clear:\n" +
            "  node scripts/clear_stuck_image_renders.mjs --apply",
        );
      }
      return;
    }

    if (rows.length === 0) {
      console.info("[clear stuck] queue already empty, no update needed.");
      return;
    }

    // Apply path — mirror Neon SQL from the deploy checklist.
    const result = await sql`
      UPDATE image_renders
         SET status = 'failed',
             error = 'manual reset 2026-06-13 — worker offline',
             finished_at = (now() AT TIME ZONE 'utc')::text
       WHERE status IN ('queued', 'generating')
    `;
    console.info(`[clear stuck] cleared ${result.count} row(s).`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[clear stuck] fatal", err);
  process.exit(1);
});
