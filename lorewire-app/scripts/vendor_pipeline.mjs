#!/usr/bin/env node
/**
 * Vendors the sibling `pipeline/` Python package into
 * `lorewire-app/api/_lib/pipeline/` so the Vercel Python serverless
 * function at `api/drain_image_renders.py` can import it without
 * monorepo-aware build tooling. Runs as the `prebuild` npm script
 * before `next build`, and is idempotent — re-running just refreshes
 * the copy.
 *
 * The LLM Council flagged this copy step as the most fragile part of
 * the Vercel + Python path (one forgotten file silently breaks prod).
 * Mitigation: this script copies the entire pipeline tree minus
 * tests, caches, and DB artifacts — so the only way to forget a file
 * is to forget the whole package, which fails loudly at import time.
 *
 * Run manually:  node scripts/vendor_pipeline.mjs
 * Auto:         npm run build (via prebuild)
 */
import { cp, mkdir, rm, stat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");
const APP_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(APP_ROOT, "..");
const SRC = resolve(REPO_ROOT, "pipeline");
const DEST_DIR = resolve(APP_ROOT, "api", "_lib");
const DEST = resolve(DEST_DIR, "pipeline");

// Skip anything that would balloon the function bundle past Vercel's
// 500 MB cap or pull in test code the serverless function doesn't
// need. Conservative list — copies everything else verbatim so we
// don't accidentally drop a file the worker needs.
const SKIP_NAMES = new Set([
  "tests",
  "__pycache__",
  "fixtures",
  ".pytest_cache",
  "lorewire.db",
  "lorewire.db-shm",
  "lorewire.db-wal",
]);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyTree(src, dest) {
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTree(srcPath, destPath);
    } else {
      await cp(srcPath, destPath);
    }
  }
}

async function main() {
  if (!(await exists(SRC))) {
    console.error(`[vendor pipeline] source not found at ${SRC}`);
    process.exit(1);
  }
  if (await exists(DEST)) {
    await rm(DEST, { recursive: true, force: true });
  }
  await mkdir(DEST_DIR, { recursive: true });
  await copyTree(SRC, DEST);
  console.info(`[vendor pipeline] copied ${SRC} -> ${DEST}`);
}

main().catch((err) => {
  console.error("[vendor pipeline] failed", err);
  process.exit(1);
});
