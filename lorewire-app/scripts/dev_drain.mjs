#!/usr/bin/env node
/**
 * Local-dev drain ticker. The Vercel cron at
 * /api/drain_story_jobs (vercel.json: */2 * * * *) only fires on deployed
 * environments. In local dev, nothing claims queued story_jobs rows
 * automatically — the admin's "Process N" click enqueues them and they
 * sit there forever unless the admin (a) runs the local worker
 * `python -m pipeline.story_jobs_worker`, or (b) runs this script.
 *
 * This is the (b) path. It polls http://localhost:3000/api/drain_story_jobs
 * every 5 seconds with the CRON_SECRET Bearer auth the prod cron uses,
 * so the local dev experience mirrors prod without spawning a Python
 * process. The drain handler runs `story_jobs_worker.run_one_tick` inside
 * the Vercel Python runtime (which Next dev exposes locally), so the
 * pipeline executes the same way it would on a real deployment.
 *
 * Usage:
 *   npm run dev:drain                    # poll every 5s
 *   npm run dev:drain -- --interval 10   # poll every 10s
 *   npm run dev:drain -- --host http://localhost:3001  # alt port
 *
 * Plan: _plans/2026-06-16-story-job-event-timeline.md.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { argv, env, exit } from "node:process";

// CLI argv shape: --interval N --host URL --once
function parseArgs(args) {
  const out = {
    interval: 5,
    host: "http://localhost:3000",
    once: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--interval") {
      out.interval = Math.max(1, Number(args[++i]) || out.interval);
    } else if (a === "--host") {
      out.host = (args[++i] || out.host).replace(/\/+$/, "");
    } else if (a === "--once") {
      out.once = true;
    }
  }
  return out;
}

// Walk up from cwd to repo root looking for .env.local. Returns the
// parsed key/value object, or {} if not found / unreadable. Strict
// minimal parser: KEY=value lines, ignores comments and blanks. Quotes
// are stripped to match Next's dotenv behaviour for the CRON_SECRET read.
async function readEnvLocal() {
  const candidates = [
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), "..", ".env.local"),
  ];
  for (const path of candidates) {
    try {
      const raw = await readFile(path, "utf8");
      const out = {};
      for (const line of raw.split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m || line.trim().startsWith("#")) continue;
        let value = m[2];
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        out[m[1]] = value;
      }
      console.log(`[dev_drain] loaded env from ${path}`);
      return out;
    } catch {
      // Try the next candidate.
    }
  }
  return {};
}

async function tick(host, secret) {
  const url = `${host}/api/drain_story_jobs`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });
    const elapsed = Date.now() - t0;
    let body = "";
    try {
      body = await res.text();
    } catch {
      // ignore body read errors; status is what we care about
    }
    if (res.ok) {
      // Body is JSON from the drain endpoint; pretty-print if it parses,
      // otherwise show the raw text so the developer sees the response.
      let summary = body;
      try {
        const parsed = JSON.parse(body);
        summary = JSON.stringify(parsed);
      } catch {
        // not JSON, fall through to raw body
      }
      console.log(`[dev_drain ok] ${res.status} ${elapsed}ms ${summary}`);
    } else {
      console.warn(
        `[dev_drain err] ${res.status} ${elapsed}ms ${body.slice(0, 200)}`,
      );
    }
  } catch (e) {
    console.warn(`[dev_drain network-err] ${e.message ?? e}`);
  }
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  const envLocal = await readEnvLocal();
  const secret = env.CRON_SECRET || envLocal.CRON_SECRET;
  if (!secret) {
    console.error(
      "[dev_drain] CRON_SECRET not set. Add CRON_SECRET=... to .env.local " +
        "or export it before running this script.",
    );
    exit(1);
  }

  console.log(
    `[dev_drain] ticking ${opts.host}/api/drain_story_jobs every ${opts.interval}s. ` +
      `Press Ctrl+C to stop.`,
  );

  await tick(opts.host, secret);
  if (opts.once) return;

  // Keep the loop on a steady interval rather than chaining setTimeouts off
  // a long tick; a slow request shouldn't double the polling cadence.
  setInterval(() => {
    void tick(opts.host, secret);
  }, opts.interval * 1000);
}

void main();
