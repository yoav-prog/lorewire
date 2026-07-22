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
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const HERE = path.dirname(__filename);
// Repo root = two levels up from video/scripts/.
const REPO_ROOT = path.resolve(HERE, "..", "..");
const ENV_FILE = path.join(REPO_ROOT, ".env.local");

// ── env-line parser + validation ───────────────────────────────────────────
//
// Pulled out and exported so the validation rules can be unit-tested without
// spawning gcloud. The parser is aggressive about refusing malformed input —
// we'd rather block the deploy than silently forward `"aporia-unleash"M9OP0\-`
// as a bucket name (the 2026-06-30 incident: corrupted .env.local poisoned
// the Cloud Run runtime's GCS_BUCKET, the splice's defense-in-depth bucket
// check correctly refused every legacy GCS segment URL, and every short
// shipped body-only until the env was fixed and redeployed).
//
// Per CLAUDE.md rule 13 (fail closed at the boundary) and rule 14 (loud,
// specific diagnostics that point at the offending line, not a "deploy
// failed" wall of text).

const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/; // C0 + DEL, exhaustive.

/** Parse one env-file line. Returns one of:
 *    - { kind: "skip" }                       — empty / comment / non-assignment.
 *    - { kind: "assign", key, value }         — clean assignment.
 *    - { kind: "error", message }             — malformed; caller aggregates.
 *
 *  Validation rules:
 *    - Strips BOM + CR (CRLF support).
 *    - Refuses leading whitespace on an assignment.
 *    - Refuses any C0 / DEL control character in the value (paste garbage).
 *    - Refuses a one-sided / unmatched quote (the 2026-06-30 bug shape).
 *    - Refuses an embedded same-quote inside a quoted literal.
 *    - Refuses a bare lone quote (`KEY="`).
 *  Strips a clean matched outer quote pair.
 */
export function parseEnvLine(rawLine) {
  const line = rawLine.replace(/^﻿/, "").replace(/\r$/, "");

  if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
    return { kind: "skip" };
  }

  if (/^\s/.test(line)) {
    return {
      kind: "error",
      message:
        "leading whitespace before the variable name. Remove the indent.",
    };
  }

  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
  if (!m) {
    return {
      kind: "error",
      message:
        "not a recognized KEY=VALUE line. Comments must start with '#'; " +
        "assignments use KEY=VALUE with no leading whitespace and no " +
        "`export` prefix (gcloud doesn't accept it).",
    };
  }

  const key = m[1];
  let value = m[2];

  if (CONTROL_CHAR_RE.test(value)) {
    return {
      kind: "error",
      message:
        `value for ${key} contains a control character ` +
        "(NUL, ESC, DEL, etc.) — almost always paste garbage. " +
        `Raw value: ${JSON.stringify(value)}.`,
    };
  }

  const startsDouble = value.startsWith('"');
  const endsDouble = value.endsWith('"');
  const startsSingle = value.startsWith("'");
  const endsSingle = value.endsWith("'");

  if (startsDouble !== endsDouble) {
    return {
      kind: "error",
      message:
        `value for ${key} has a mismatched double-quote — starts with " ` +
        `but doesn't end with " (or vice versa). Raw value: ` +
        `${JSON.stringify(value)}. If the value should contain a literal ", ` +
        "drop the surrounding quotes.",
    };
  }
  if (startsSingle !== endsSingle) {
    return {
      kind: "error",
      message:
        `value for ${key} has a mismatched single-quote — starts with ' ` +
        `but doesn't end with ' (or vice versa). Raw value: ` +
        `${JSON.stringify(value)}. If the value should contain a literal ', ` +
        "drop the surrounding quotes.",
    };
  }

  if (startsDouble && endsDouble) {
    if (value.length < 2) {
      return {
        kind: "error",
        message: `value for ${key} is a single bare " — not a usable value.`,
      };
    }
    value = value.slice(1, -1);
    if (value.includes('"')) {
      return {
        kind: "error",
        message:
          `value for ${key} contains an embedded " inside the quoted ` +
          `literal. Raw value: ${JSON.stringify(value)}.`,
      };
    }
  } else if (startsSingle && endsSingle) {
    if (value.length < 2) {
      return {
        kind: "error",
        message: `value for ${key} is a single bare ' — not a usable value.`,
      };
    }
    value = value.slice(1, -1);
    if (value.includes("'")) {
      return {
        kind: "error",
        message:
          `value for ${key} contains an embedded ' inside the quoted ` +
          `literal. Raw value: ${JSON.stringify(value)}.`,
      };
    }
  }

  return { kind: "assign", key, value };
}

/** Parse the whole .env.local file. Returns the values + an aggregated error
 *  list keyed by `file:lineNumber`, so the caller can surface EVERY malformed
 *  line at once instead of one-fix-then-re-run-then-fix loops. */
export function loadEnvFile(file) {
  if (!fs.existsSync(file)) return { values: {}, errors: [] };
  const values = {};
  const errors = [];
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const result = parseEnvLine(line);
    if (result.kind === "skip") return;
    if (result.kind === "error") {
      errors.push(`${file}:${idx + 1}: ${result.message}`);
      return;
    }
    values[result.key] = result.value;
  });
  return { values, errors };
}

// ── main: only runs when this file is the entry point ──────────────────────
//
// Tests import the parser above without wanting the side effects below
// (loading env, requiring vars, spawning gcloud). Gate on `import.meta.url`
// vs `process.argv[1]` so `node deploy-cloud-run.mjs` runs main() but
// `import { parseEnvLine } from "..."` doesn't.

function main() {
  const { values: fileEnv, errors: envErrors } = loadEnvFile(ENV_FILE);

  if (envErrors.length > 0) {
    console.error(
      `\n[deploy:cloud-run] ${envErrors.length} malformed env line(s) ` +
        `in ${ENV_FILE} — refusing to deploy with poisoned config:`,
    );
    for (const e of envErrors) console.error(`  - ${e}`);
    console.error(
      "\nFix .env.local and re-run. (The 2026-06-30 incident shipped a " +
        "corrupted GCS_BUCKET to Cloud Run because the parser didn't catch " +
        "an unmatched quote — that's what this gate prevents.)\n",
    );
    process.exit(2);
  }

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
}

// Entry-point gate: `node scripts/deploy-cloud-run.mjs` runs main(),
// `import { parseEnvLine } from "..."` does not.
const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  main();
}
