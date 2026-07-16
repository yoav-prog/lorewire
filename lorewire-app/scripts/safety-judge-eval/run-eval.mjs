#!/usr/bin/env node
/**
 * Backtest harness for the recalibrated safety judge (v2), Phase 2 of
 * _plans/2026-07-15-autopilot-auto-publish-israel-drop.md.
 *
 * Replays a set of stories through the v2 judge (gpt-5.4-mini + the
 * recalibrated prompt) and checks the go/no-go bar:
 *   - ZERO false holds on SAFE content (the miscalibration we are fixing), and
 *   - ZERO missed dangers on the hand-seeded BAD content (the safety net).
 *
 * The v2 SYSTEM PROMPT and MODEL are read straight out of
 * src/lib/story-safety-judge.ts at runtime, so this harness always tests the
 * live prompt — there is no second copy to drift. The JSON schema and pass rule
 * mirror the lib (kept in sync by the unit tests in story-safety-judge.test.ts).
 * The deterministic degenerate guard is out of scope here; it is tested
 * separately and never fires on real article-length stories.
 *
 * Run (needs a real key; makes real OpenAI calls, a few cents total):
 *   node scripts/safety-judge-eval/run-eval.mjs
 *   node scripts/safety-judge-eval/run-eval.mjs --goldset=./held-66.json
 *   node scripts/safety-judge-eval/run-eval.mjs --limit=4
 *
 * --goldset points at a JSON array of the 66 real held-then-published stories
 * exported from prod: [{ "id": "...", "title": "...", "body": "..." }, ...].
 * All goldset stories are treated as expected "publish". Until you export them,
 * the built-in SAFE fixtures stand in. See README.md for the export query.
 *
 * Exit code is 0 only when the bar is met, so this can gate a shadow->active
 * flip.
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SAFE_FIXTURES, BAD_FIXTURES, scoreBacktest } from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(APP_ROOT, "..");
const JUDGE_SRC = resolve(APP_ROOT, "src", "lib", "story-safety-judge.ts");
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const JUDGE_BODY_MAX_CHARS = 8000;
const JUDGE_MAX_TOKENS = 1200;

// Mirrors JUDGE_SCHEMA in story-safety-judge.ts. The unit tests keep the lib
// honest; if you add a category there, add it here.
const SCHEMA = {
  name: "autopilot_safety_verdict",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      decision: { type: "string", enum: ["publish", "hold"] },
      category: {
        type: "string",
        enum: [
          "clean",
          "real_person",
          "minors_or_self_harm",
          "hate_or_harassment",
          "sexual",
          "graphic_or_shocking",
          "platform_policy_risk",
          "not_a_story",
          "borderline",
        ],
      },
      reason: { type: "string" },
      confidence: { type: "number" },
    },
    required: ["decision", "category", "reason", "confidence"],
  },
};

function parseArgs(argv) {
  const args = { goldset: null, limit: Infinity };
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (!m) continue;
    if (m[1] === "goldset") args.goldset = m[2];
    if (m[1] === "limit") args.limit = Number(m[2]) || Infinity;
  }
  return args;
}

// Same env loader the submission-eval harness uses: prefer the process env,
// fall back to the repo's .env files, tolerate a stray "NAME =" space.
async function loadEnvKey(name) {
  if (process.env[name]?.trim()) return process.env[name].trim();
  const candidates = [
    resolve(REPO_ROOT, ".env.local"),
    resolve(REPO_ROOT, ".env"),
    resolve(APP_ROOT, ".env.local"),
  ];
  for (const file of candidates) {
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.trimStart().startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      if (k !== name) continue;
      return line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

// Pull the live v2 prompt + model out of the TS source so this never drifts.
async function loadJudgeFromSource() {
  const src = await readFile(JUDGE_SRC, "utf8");
  const promptM = src.match(/const JUDGE_SYSTEM_V2 = `([\s\S]*?)`;/);
  const modelM = src.match(/const JUDGE_MODEL_V2 = "([^"]+)";/);
  if (!promptM || !modelM) {
    throw new Error(
      "could not extract JUDGE_SYSTEM_V2 / JUDGE_MODEL_V2 from story-safety-judge.ts — did the markers move?",
    );
  }
  return { system: promptM[1], modelId: modelM[1].replace(/^openai\//, "") };
}

async function judge(apiKey, model, system, story) {
  const body = (story.body ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, JUDGE_BODY_MAX_CHARS);
  const userMsg =
    `<story>\nTitle: ${story.title ?? "(untitled)"}\n\n${body}\n</story>\n\n` +
    `Return the JSON verdict.`;
  const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
      max_completion_tokens: JUDGE_MAX_TOKENS,
      reasoning_effort: "minimal",
      response_format: { type: "json_schema", json_schema: SCHEMA },
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`OpenAI ${r.status}: ${text.slice(0, 200)}`);
  }
  const j = await r.json();
  const content = j.choices?.[0]?.message?.content;
  const out = JSON.parse(content);
  // v2 pass rule: trust the decision, no confidence gate.
  return {
    safe: out.decision === "publish",
    decision: out.decision,
    category: out.category,
    reason: out.reason,
    confidence: out.confidence,
  };
}

async function loadGoldset(path) {
  const raw = await readFile(resolve(process.cwd(), path), "utf8");
  const arr = JSON.parse(raw);
  return arr.map((s) => ({
    id: s.id,
    title: s.title,
    body: s.body,
    expect: "publish",
    note: "prod held-then-published (goldset)",
  }));
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = await loadEnvKey("OPENAI_API_KEY");
  if (!apiKey) {
    console.error("Missing OPENAI_API_KEY (env or .env.local).");
    process.exit(2);
  }
  const { system, modelId } = await loadJudgeFromSource();

  let cases = [...SAFE_FIXTURES, ...BAD_FIXTURES];
  if (args.goldset) cases = [...(await loadGoldset(args.goldset)), ...BAD_FIXTURES];
  cases = cases.slice(0, args.limit);

  console.log(`\nSafety judge v2 backtest — model ${modelId}, ${cases.length} cases\n`);

  const results = [];
  for (const c of cases) {
    let verdict;
    try {
      verdict = await judge(apiKey, modelId, system, c);
    } catch (e) {
      console.error(`  ERROR on ${c.id}: ${e.message}`);
      // A judge error counts as a hold (fail closed), matching the lib.
      verdict = { safe: false, decision: "hold", category: "judge_unavailable", reason: e.message };
    }
    const ok =
      (c.expect === "publish" && verdict.safe) ||
      (c.expect === "hold" && !verdict.safe);
    results.push({ id: c.id, expect: c.expect, safe: verdict.safe });
    const mark = ok ? "ok  " : "MISS";
    console.log(
      `  [${mark}] ${c.expect.padEnd(7)} -> ${verdict.decision.padEnd(7)} ${c.id}` +
        (verdict.category && verdict.category !== "clean" ? `  (${verdict.category})` : ""),
    );
  }

  const score = scoreBacktest(results);
  console.log("\n" + "-".repeat(60));
  console.log(`Safe cases:   ${score.safeCount}   false holds: ${score.falseHolds.length}`);
  console.log(`Danger cases: ${score.badCount}   missed:      ${score.missedBad.length}`);
  if (score.falseHolds.length) console.log(`  false holds: ${score.falseHolds.join(", ")}`);
  if (score.missedBad.length) console.log(`  MISSED bad:  ${score.missedBad.join(", ")}`);
  console.log("-".repeat(60));
  console.log(score.pass ? "PASS — clears the bar.\n" : "FAIL — does not clear the bar.\n");
  process.exit(score.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
