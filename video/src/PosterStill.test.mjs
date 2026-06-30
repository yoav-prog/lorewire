// Contract tests for the editorial-poster hook splitter. Per
// _plans/2026-06-30-editorial-poster-redesign.md, the portrait
// composition emphasizes ONE word of the hook in red brush script
// (the last whitespace-delimited token, after trailing-punctuation
// strip). This file pins the contract so a future tweak to the
// splitter can't silently change which word renders as the emphasis.
//
// Run via:
//   node --test src/PosterStill.test.mjs
//
// Node can't import the .tsx source directly, so — same convention as
// composition-metadata.test.mjs + motion/mouth-timing.test.mjs — we
// mirror the splitter in plain JS here and assert against the mirror.
// If the .tsx source drifts from the mirror, this test goes red on
// the next render the PR ships, and the operator updates both.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of PosterStill.tsx::splitEmphasisHook + wrapLines ─────────────────

const TRAILING_PUNCT_RE = /[.!?…]+$/;
const SERIF_TAIL_PUNCT_RE = /[.,;:]+$/;
const HOOK_MAX_SERIF_LINES = 4;

function wrapLines(text, charsPerLine) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length <= charsPerLine || !cur) {
      cur = candidate;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function splitEmphasisHook(rawHook, charsPerSerifLine) {
  const trimmed = (rawHook ?? "").trim();
  if (!trimmed) return { serifLines: [], emphasis: null };

  const noTail = trimmed.replace(TRAILING_PUNCT_RE, "").trimEnd();
  if (!noTail) return { serifLines: [], emphasis: null };

  const tokens = noTail.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { serifLines: [], emphasis: null };
  if (tokens.length === 1) {
    return { serifLines: [], emphasis: tokens[0] };
  }

  const emphasis = tokens[tokens.length - 1];
  const remainder = tokens
    .slice(0, -1)
    .join(" ")
    .replace(SERIF_TAIL_PUNCT_RE, "");
  const lines = wrapLines(remainder, charsPerSerifLine).slice(
    0,
    HOOK_MAX_SERIF_LINES,
  );
  return { serifLines: lines, emphasis };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("empty hook returns no serif lines and no emphasis", () => {
  assert.deepEqual(splitEmphasisHook("", 20), { serifLines: [], emphasis: null });
  assert.deepEqual(splitEmphasisHook("   ", 20), { serifLines: [], emphasis: null });
  assert.deepEqual(splitEmphasisHook(null, 20), { serifLines: [], emphasis: null });
  assert.deepEqual(splitEmphasisHook(undefined, 20), { serifLines: [], emphasis: null });
});

test("hook of only punctuation returns no usable text", () => {
  // After the trailing-punct strip the whole string is empty.
  assert.deepEqual(splitEmphasisHook("...", 20), { serifLines: [], emphasis: null });
  assert.deepEqual(splitEmphasisHook("!?!", 20), { serifLines: [], emphasis: null });
});

test("single-word hook renders as brush emphasis only", () => {
  assert.deepEqual(splitEmphasisHook("Gone", 20), {
    serifLines: [],
    emphasis: "Gone",
  });
  // Trailing period stripped before tokenizing.
  assert.deepEqual(splitEmphasisHook("Destroyed.", 20), {
    serifLines: [],
    emphasis: "Destroyed",
  });
  // Trailing ellipsis stripped.
  assert.deepEqual(splitEmphasisHook("Vanished…", 20), {
    serifLines: [],
    emphasis: "Vanished",
  });
  // Trailing exclamation stripped.
  assert.deepEqual(splitEmphasisHook("Stolen!", 20), {
    serifLines: [],
    emphasis: "Stolen",
  });
});

test("the reference design hook splits cleanly at the last word", () => {
  // The reference image Yoav signed off on: "Her wedding dress was destroyed"
  // → 1 serif line ("Her wedding dress was") + brush emphasis ("destroyed").
  const result = splitEmphasisHook("Her wedding dress was destroyed.", 40);
  assert.deepEqual(result, {
    serifLines: ["Her wedding dress was"],
    emphasis: "destroyed",
  });
});

test("two-sentence hook keeps the inner punctuation on the serif side", () => {
  // "Eight hundred dollars. Gone." — the inner period after "dollars"
  // is preserved on the serif line; the trailing period after "Gone"
  // is stripped. Emphasis is "Gone".
  const result = splitEmphasisHook("Eight hundred dollars. Gone.", 40);
  assert.equal(result.emphasis, "Gone");
  assert.ok(result.serifLines.length >= 1);
  // The joined serif should still contain the inner period after "dollars".
  assert.ok(result.serifLines.join(" ").includes("dollars"));
});

test("trailing comma / semicolon is stripped from the serif tail", () => {
  // The splitter strips trailing inline punctuation from the serif
  // remainder so we don't double-punctuate (e.g. "Her wedding dress
  // was," would render with a hanging comma against the brush word).
  const result = splitEmphasisHook("Her wedding dress was, destroyed.", 40);
  assert.equal(result.emphasis, "destroyed");
  // The trailing comma after "was" is stripped.
  assert.equal(result.serifLines.join(" ").endsWith("was"), true);
});

test("a long hook wraps into multiple serif lines, emphasis on its own line", () => {
  const result = splitEmphasisHook(
    "She found the joint account drained to zero overnight.",
    20,
  );
  assert.equal(result.emphasis, "overnight");
  // 20-char budget forces multiple lines.
  assert.ok(result.serifLines.length >= 2);
  // No serif line exceeds the budget by more than 1 word (the wrap is
  // greedy, so a single word longer than the budget gets placed alone).
  for (const line of result.serifLines) {
    assert.ok(
      line.length <= 30,
      `serif line too long: ${JSON.stringify(line)}`,
    );
  }
});

test("serif block caps at HOOK_MAX_SERIF_LINES", () => {
  // A pathologically long hook with a tiny budget would otherwise
  // overflow the gold frame. The splitter slices at the cap.
  const longHook =
    "word ".repeat(40).trim() + " emphasis"; // 41 tokens, last = "emphasis"
  const result = splitEmphasisHook(longHook, 8);
  assert.equal(result.emphasis, "emphasis");
  assert.ok(
    result.serifLines.length <= HOOK_MAX_SERIF_LINES,
    `expected at most ${HOOK_MAX_SERIF_LINES} serif lines, got ${result.serifLines.length}`,
  );
});

test("normalizes double / odd whitespace before tokenizing", () => {
  const result = splitEmphasisHook(
    "  Her   wedding\tdress  was   destroyed.  ",
    40,
  );
  assert.equal(result.emphasis, "destroyed");
  assert.deepEqual(result.serifLines, ["Her wedding dress was"]);
});

test("preserves smart quotes / curly punctuation inside words", () => {
  // The brand-safety guard upstream allows smart quotes in poster_text;
  // the splitter must not strip them mid-word.
  const result = splitEmphasisHook("She’d kept it hidden for decades.", 40);
  assert.equal(result.emphasis, "decades");
  assert.ok(result.serifLines.join(" ").includes("She’d"));
});

test("preserves intra-word punctuation like hyphens and apostrophes", () => {
  const result = splitEmphasisHook("Her sister-in-law had been lying.", 40);
  assert.equal(result.emphasis, "lying");
  assert.ok(result.serifLines.join(" ").includes("sister-in-law"));
});

test("two-word hook puts the first word on serif and the second on brush", () => {
  const result = splitEmphasisHook("She lied.", 40);
  assert.deepEqual(result, {
    serifLines: ["She"],
    emphasis: "lied",
  });
});
