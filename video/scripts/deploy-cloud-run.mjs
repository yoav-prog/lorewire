#!/usr/bin/env node
// Cross-shell wrapper for the Cloud Run deploy.
//
// The previous `gcloud run deploy ... --service-account $GCS_CLIENT_EMAIL`
// inlined bash-style variable substitution which PowerShell does NOT expand —
// every `$VAR` and `${VAR:-default}` got passed to gcloud as a literal
// string, and gcloud tried to interpret `${CLOUD_RUN_REGION:-us-central1}`
// as a real region in its endpoint-override URL.
//
// This wrapper loads `.env.local` from the repo root (same file the Next
// app + the OAuth probe use), resolves the variables in Node, and then
// spawns gcloud with the real argv. Works identically on bash / PowerShell
// / Windows cmd / macOS / Linux. No shell-syntax surprises.
//
// Per _plans/2026-06-28-phase-2-social-poster-render.md — Phase 2 ships
// a new /render-poster endpoint inside the same Cloud Run service, so
// `npm run deploy:cloud-run` is the gate for getting that endpoint live
// before merging the dispatcher PR.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const HERE = path.dirname(__filename);
// Repo root = two levels up from video/scripts/.
const REPO_ROOT = path.resolve(HERE, "..", "..");
const ENV_FILE = path.join(REPO_ROOT, ".env.local");

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const fileEnv = loadEnvFile(ENV_FILE);
// Process env wins over .env.local so `CRON_SECRET=foo npm run ...` works.
const env = { ...fileEnv, ...process.env };

function requireVar(name) {
  const v = env[name];
  if (!v || v.length === 0) {
    console.error(
      `\nERROR: ${name} is not set. Add it to ${ENV_FILE} ` +
        `or export it before running this script.\n`,
    );
    process.exit(2);
  }
  return v;
}

const region = env.CLOUD_RUN_REGION || "us-central1";
const serviceAccount = requireVar("GCS_CLIENT_EMAIL");
const cronSecret = requireVar("CRON_SECRET");
const gcsBucket = requireVar("GCS_BUCKET");

// Optional R2 vars — pass through ONLY if all are present, so a partial
// R2 setup doesn't half-configure the runtime. Mirrors the
// `isR2MediaActive` gate in video/server/r2.ts.
const r2Vars = [
  "R2_MEDIA_WRITE_ENABLED",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_MEDIA_BUCKET",
  "MEDIA_PUBLIC_BASE",
];
const r2Provided = r2Vars.filter((k) => env[k] && env[k].length > 0);
const r2Enabled =
  r2Provided.length === r2Vars.length || // all six present
  // R2_ENDPOINT can substitute for R2_ACCOUNT_ID
  (env.R2_ENDPOINT &&
    r2Provided.length >= r2Vars.length - 1 &&
    !r2Provided.includes("R2_ACCOUNT_ID"));

// Build the gcloud argv. Each `--update-env-vars` carries one KEY=VALUE
// so a comma in any value (token, base URL) doesn't accidentally split
// the pair against gcloud's comma parser.
const argv = [
  "run",
  "deploy",
  "lorewire-render",
  "--source",
  ".",
  "--region",
  region,
  "--memory",
  "16Gi",
  "--cpu",
  "8",
  "--timeout",
  "3600",
  "--no-allow-unauthenticated",
  "--service-account",
  serviceAccount,
  `--update-env-vars`,
  `CRON_SECRET=${cronSecret}`,
  `--update-env-vars`,
  `GCS_BUCKET=${gcsBucket}`,
];

if (r2Enabled) {
  for (const k of [...r2Vars, "R2_ENDPOINT"]) {
    if (env[k] && env[k].length > 0) {
      argv.push("--update-env-vars", `${k}=${env[k]}`);
    }
  }
  console.info(
    `[deploy:cloud-run] R2 env detected — forwarding R2_* + MEDIA_PUBLIC_BASE to the runtime`,
  );
} else if (r2Provided.length > 0) {
  console.warn(
    `[deploy:cloud-run] WARNING: partial R2 config (${r2Provided.join(", ")}) ` +
      `— skipping R2 env forward. The container will fall through to GCS.`,
  );
}

console.info(`[deploy:cloud-run] region=${region}`);
console.info(
  `[deploy:cloud-run] service-account=${serviceAccount.replace(/^([^@]{4})[^@]+/, "$1...")}`,
);
console.info(`[deploy:cloud-run] GCS_BUCKET=${gcsBucket}`);
console.info(`[deploy:cloud-run] CRON_SECRET=<set, ${cronSecret.length} chars>`);
console.info(
  `[deploy:cloud-run] spawning: gcloud ${argv.slice(0, 5).join(" ")} ...`,
);

// `shell: true` on Windows so gcloud.cmd resolves on PATH without a
// manual .cmd extension, mirroring the Remotion subprocess pattern in
// pipeline/video.py. The working directory stays at video/ (npm sets
// cwd to the package dir for "scripts") so `--source .` ships the
// Cloud Run image from the right tree.
const child = spawn("gcloud", argv, { stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error(`[deploy:cloud-run] failed to spawn gcloud: ${err.message}`);
  process.exit(1);
});
