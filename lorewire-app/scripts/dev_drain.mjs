#!/usr/bin/env node
/**
 * Local-dev queue drainer. Convenience wrapper over the Python worker.
 *
 * Why this exists: the Vercel cron at /api/drain_story_jobs (configured
 * in vercel.json to run every 2 minutes) only fires on deployed
 * environments. In local dev, nothing claims queued story_jobs rows
 * automatically — the admin's "Process N" click enqueues them and they
 * sit there forever.
 *
 * The actual queue drainer in dev is `python -m pipeline.story_jobs_worker`.
 * This script just spawns it with stdio inherited so the worker's
 * narration shows up in the same terminal you ran `npm run dev:drain`
 * from. It keeps the worker running until you Ctrl+C, same as if you'd
 * run the Python command directly.
 *
 * I also tried an HTTP-polling variant against /api/drain_story_jobs.
 * That endpoint is a Python serverless function under api/ that only
 * Vercel's runtime serves; `next dev` returns 404. If you ever run
 * `vercel dev` locally that variant becomes viable, but the worker is
 * always available and matches what production logs look like.
 *
 * Usage (from the repo root, in any shell — PowerShell 5.1 included):
 *   npm --prefix lorewire-app run dev:drain
 *   npm --prefix lorewire-app run dev:drain -- --once     # one tick then exit
 *   npm --prefix lorewire-app run dev:drain -- --no-media # text-only mode
 *
 * Or from inside lorewire-app/:
 *   npm run dev:drain
 *
 * Plan: _plans/2026-06-16-story-job-event-timeline.md.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { argv, exit, platform } from "node:process";

function parseArgs(args) {
  const out = { once: false, noMedia: false, extra: [] };
  for (const a of args) {
    if (a === "--once") out.once = true;
    else if (a === "--no-media") out.noMedia = true;
    else out.extra.push(a);
  }
  return out;
}

// Walk up from the script's own directory to find the repo root, which
// is where the `pipeline/` package lives. The script lives at
// lorewire-app/scripts/dev_drain.mjs so the repo root is two levels up.
// Falls back to process.cwd() so a developer who moved the script
// somewhere weird still gets a meaningful error rather than a silent
// PYTHONPATH bug.
function findRepoRoot() {
  const here = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
  if (existsSync(resolve(here, "pipeline", "story_jobs_worker.py"))) {
    return here;
  }
  const fromCwd = process.cwd();
  if (existsSync(resolve(fromCwd, "pipeline", "story_jobs_worker.py"))) {
    return fromCwd;
  }
  // Last-ditch: the immediate parent of cwd (handles "ran from
  // lorewire-app/" case).
  const fromParent = resolve(fromCwd, "..");
  if (existsSync(resolve(fromParent, "pipeline", "story_jobs_worker.py"))) {
    return fromParent;
  }
  return here;
}

function main() {
  const opts = parseArgs(argv.slice(2));
  const repoRoot = findRepoRoot();

  // Build the worker argv. The Python module already handles --once and
  // --no-media so we just forward.
  const workerArgs = ["-m", "pipeline.story_jobs_worker"];
  if (opts.once) workerArgs.push("--once");
  if (opts.noMedia) workerArgs.push("--no-media");
  for (const e of opts.extra) workerArgs.push(e);

  // Pick the python executable. Windows ships `python` on PATH for most
  // installs; on macOS / Linux `python3` is the conventional alias.
  const pythonBin = platform === "win32" ? "python" : "python3";

  console.log(
    `[dev_drain] starting ${pythonBin} ${workerArgs.join(" ")} ` +
      `(cwd=${repoRoot}). Press Ctrl+C to stop.`,
  );

  const child = spawn(pythonBin, workerArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    // shell:false so Ctrl+C goes straight to the python process. With
    // shell:true on Windows the signal hits cmd.exe and the python
    // worker hangs as an orphan.
    shell: false,
  });

  child.on("error", (err) => {
    console.error(
      `[dev_drain] could not spawn ${pythonBin}: ${err.message}. ` +
        `Is Python installed and on PATH? Try \`python --version\`.`,
    );
    exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(`[dev_drain] worker exited via signal ${signal}`);
      exit(0);
    }
    exit(code ?? 0);
  });
}

main();
