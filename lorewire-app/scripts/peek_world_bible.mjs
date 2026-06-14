#!/usr/bin/env node
/**
 * Read-only diagnostic: check the world_bible cache state on a story
 * AND list every image_render_events row in the last 30 minutes
 * (across all rows) so we can see what the cron has been doing.
 *
 * Usage:  node scripts/peek_world_bible.mjs <story_id>
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
  const storyId = process.argv[2] || "envelope";
  const url = await readDatabaseUrl();
  const postgres = (await import("postgres")).default;
  const sql = postgres(url, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  try {
    const story = await sql`
      SELECT id, video_config, images, updated_at
        FROM stories
       WHERE id = ${storyId}
    `;
    if (story.length === 0) {
      console.error(`[peek] story ${storyId} not found`);
      return;
    }
    const row = story[0];
    let config = null;
    try {
      config = row.video_config ? JSON.parse(row.video_config) : null;
    } catch (e) {
      console.error("[peek] video_config not parseable", e.message);
    }
    console.info(`[peek] story=${row.id} updated_at=${row.updated_at}`);
    console.info(`[peek] video_config keys: ${config ? Object.keys(config).sort().join(", ") : "(none)"}`);
    if (config) {
      const wb = config.world_bible;
      const sp = config.scene_prompts;
      const spm = config.scene_prompts_built_with;
      const cb = config.character_bible;
      console.info(`  world_bible:               ${wb ? `present (chars=${(wb.characters||[]).length} subs=${(wb.sub_characters||[]).length} locs=${(wb.locations||[]).length} items=${(wb.items||[]).length})` : "MISSING"}`);
      console.info(`  scene_prompts:             ${Array.isArray(sp) ? `${sp.length} entries` : "(none)"}`);
      console.info(`  scene_prompts_built_with:  ${spm || "(none)"}`);
      console.info(`  character_bible:           ${cb ? "present (legacy)" : "(none)"}`);
      if (wb) {
        const refs = [
          ...(wb.characters || []),
          ...(wb.sub_characters || []),
          ...(wb.locations || []),
        ];
        const missingRef = refs.filter((e) => !e.reference_image_url).length;
        console.info(`  world_bible entities with NO reference_image_url: ${missingRef}/${refs.length}`);
      }
    }
    let images = [];
    try {
      images = row.images ? JSON.parse(row.images) : [];
    } catch {}
    if (Array.isArray(images)) {
      const filled = images.filter((u) => u).length;
      console.info(`[peek] stories.images: ${filled}/${images.length} slots filled`);
    }

    console.info("\n[peek] image_render_events in the last 30 minutes (newest last):");
    const events = await sql`
      SELECT e.ts, e.level, e.event, e.message, r.asset, r.status
        FROM image_render_events e
        JOIN image_renders r ON r.id = e.render_id
       WHERE e.ts > NOW() - INTERVAL '30 minutes'
       ORDER BY e.ts ASC
    `;
    for (const e of events) {
      console.info(
        `  ${e.ts}  ${(e.level||"").padEnd(5)}  ` +
        `${(e.asset||"").padEnd(10)} [${(e.status||"").padEnd(10)}]  ` +
        `${(e.event||"").padEnd(16)}  ${(e.message||"").slice(0,80)}`,
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
