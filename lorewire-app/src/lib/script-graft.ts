// Map TTS-provider word timings back onto the source script tokens.
//
// Mirror of `pipeline/captions.py::align_script_to_words`. The pipeline now
// grafts the script over STT homophones before persisting alignment, but any
// story rendered before that fix carries the STT artefacts ("state" for
// "steak", "they're telling" for "in their telling", lowercased starts,
// stripped punctuation). The web Read-along applies the same graft on the
// fly at display time so old + new stories both render the real script.
//
// Pure-logic; no I/O, no DOM. Used by `RealReadAlong` in both shells.

import type { AlignedWord } from "@/lib/stories";

// A token's matchable identity for alignment is its alphanumeric core,
// lowercased, with surrounding punctuation/apostrophes stripped. "Red," and
// "red" both stem to "red"; "don't" and "dont" both stem to "dont".
const STEM_STRIP_RE = /[^\p{L}\p{N}]/gu;
const WORD_SPLIT_RE = /\S+/g;

// Edit-distance dominance threshold above which the alignment is no longer
// reliable (script likely edited after render). We still emit the script-
// aligned form because the alternative is the original STT homophones, but
// the log line flags it so a surprising render can be traced.
const DRIFT_WARN_RATIO = 0.5;

export function tokenizeScript(script: string): string[] {
  return script.match(WORD_SPLIT_RE) ?? [];
}

function stem(token: string): string {
  return token.replace(STEM_STRIP_RE, "").toLowerCase();
}

/** Return `words` with each `.word` rewritten to the matching script token.
 *  Timings (`start`, `end`) are preserved from the provider. When a script
 *  token has no provider word (collapsed/dropped), a zero-duration wedge is
 *  inserted at the prior word's end. When the provider has a phantom word
 *  the script lacks, it is dropped.
 *
 *  Idempotent: running on an already-correct alignment yields equivalent
 *  output, so callers don't need to know whether the alignment came from
 *  ElevenLabs (script-authoritative) or Google STT.
 */
export function alignScriptToWords(
  script: string,
  words: AlignedWord[],
): AlignedWord[] {
  const scriptTokens = tokenizeScript(script);
  if (words.length === 0 || scriptTokens.length === 0) {
    console.info("[lorewire script-graft] no-op", {
      words: words.length,
      scriptTokens: scriptTokens.length,
    });
    return words;
  }

  const scriptStems = scriptTokens.map(stem);
  const sttStems = words.map((w) => stem(w.word));

  const rows = scriptStems.length + 1;
  const cols = sttStems.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = scriptStems[i - 1] === sttStems[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j - 1] + cost,
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
      );
    }
  }
  const editDistance = dp[scriptStems.length][sttStems.length];

  type Op = { kind: "match" | "sub" | "ins" | "del"; si: number; wi: number };
  const ops: Op[] = [];
  let i = scriptStems.length;
  let j = sttStems.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const cost = scriptStems[i - 1] === sttStems[j - 1] ? 0 : 1;
      if (dp[i][j] === dp[i - 1][j - 1] + cost) {
        ops.push({ kind: cost === 0 ? "match" : "sub", si: i - 1, wi: j - 1 });
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      ops.push({ kind: "ins", si: i - 1, wi: -1 });
      i--;
      continue;
    }
    ops.push({ kind: "del", si: -1, wi: j - 1 });
    j--;
  }
  ops.reverse();

  const out: AlignedWord[] = [];
  let matched = 0;
  let subs = 0;
  let phantoms = 0;
  let missing = 0;
  for (const op of ops) {
    if (op.kind === "match" || op.kind === "sub") {
      const w = words[op.wi];
      out.push({ word: scriptTokens[op.si], start: w.start, end: w.end });
      if (op.kind === "match") matched++;
      else subs++;
    } else if (op.kind === "ins") {
      // Wedge a zero-duration token at the prior word's end so the script
      // word still appears in the read-along. If we're at the start, anchor
      // to the first provider word's start.
      const anchor = out.length > 0 ? out[out.length - 1].end : words[0].start;
      out.push({ word: scriptTokens[op.si], start: anchor, end: anchor });
      missing++;
    } else {
      phantoms++;
    }
  }

  const driftRatio = editDistance / Math.max(scriptTokens.length, 1);
  console.info("[lorewire script-graft]", {
    scriptTokens: scriptTokens.length,
    sttWords: words.length,
    matched,
    subs,
    phantoms,
    missing,
    editDistance,
    driftRatio: Number(driftRatio.toFixed(2)),
    drift: driftRatio >= DRIFT_WARN_RATIO,
  });
  return out;
}
