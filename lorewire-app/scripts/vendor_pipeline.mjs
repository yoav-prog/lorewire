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
import { dirname, join, resolve } from "node:path";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");
const APP_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(APP_ROOT, "..");
const SRC_PIPELINE = resolve(REPO_ROOT, "pipeline");
// `pipeline/models.py:16` reads `<repo>/config/models.json` via
// `Path(__file__).resolve().parent.parent / "config" / "models.json"`.
// After vendoring, `__file__.parent.parent` is `_lib/`, so the registry
// file has to land at `_lib/config/models.json` or the cron drain
// errors with `[Errno 2] No such file or directory`.
const SRC_CONFIG = resolve(REPO_ROOT, "config");
const DEST_DIR = resolve(APP_ROOT, "api", "_lib");
const DEST_PIPELINE = resolve(DEST_DIR, "pipeline");
const DEST_CONFIG = resolve(DEST_DIR, "config");

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

async function vendor(src, dest, label) {
  if (!(await exists(src))) {
    console.error(`[vendor pipeline] ${label} source not found at ${src}`);
    process.exit(1);
  }
  if (await exists(dest)) {
    await rm(dest, { recursive: true, force: true });
  }
  await mkdir(dirname(dest), { recursive: true });
  await copyTree(src, dest);
  console.info(`[vendor pipeline] copied ${src} -> ${dest}`);
}

async function main() {
  await vendor(SRC_PIPELINE, DEST_PIPELINE, "pipeline");
  await vendor(SRC_CONFIG, DEST_CONFIG, "config");
}

main().catch((err) => {
  console.error("[vendor pipeline] failed", err);
  process.exit(1);
});
