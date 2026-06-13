#!/usr/bin/env node
/**
 * Read-only peek into the production image_renders table. No
 * mutations. Shows the 10 most recent rows so we can see what the
 * cron drainer / local worker actually did, separately from what
 * the admin UI is rendering (stale caches lie sometimes).
 *
 * Run:  node scripts/peek_image_renders.mjs
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
    const counts = await sql`
      SELECT status, count(*) AS n
        FROM image_renders
       GROUP BY status
       ORDER BY status
    `;
    console.info("[peek] status counts:");
    for (const c of counts) {
      console.info(`  ${c.status.padEnd(12)}  ${c.n}`);
    }
    const recent = await sql`
      SELECT id, owner_kind, owner_id, asset, status,
             requested_at, started_at, finished_at,
             cost_cents, error
        FROM image_renders
       ORDER BY requested_at DESC
       LIMIT 10
    `;
    console.info("\n[peek] last 10 rows:");
    for (const r of recent) {
      console.info(
        `  ${r.requested_at}  ${(r.status || "").padEnd(10)}  ` +
          `${r.owner_kind}/${r.owner_id}  asset=${r.asset}  ` +
          `cost_cents=${r.cost_cents ?? "-"}  ` +
          `err=${(r.error || "").slice(0, 60)}`,
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
