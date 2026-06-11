// Block-level diff for two Tiptap documents. Used by the revisions UI to
// highlight what changed between a snapshot and the current article.
// The unit of comparison is the top-level content block (paragraph,
// heading, callout, articleImage, list, etc.) — we don't try to do
// character-level diffs inside a paragraph because Tiptap JSON is nested
// enough that LCS on stringified blocks gives a useful signal at a
// fraction of the implementation cost.
//
// Algorithm: classic LCS over JSON-stringified blocks. The diff is then
// projected into a side-by-side render where each row carries either the
// previous block, the current block, or both (when they match). This
// keeps the renderer in lib/ pure (no React, no Tiptap-React) so the
// public reader's seam stays intact.

export type TiptapBlock = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapBlock[];
  text?: string;
  marks?: unknown[];
};

export interface TiptapDoc {
  type: "doc";
  content?: TiptapBlock[];
}

export type DiffOpKind = "same" | "added" | "removed";

export interface DiffOp {
  kind: DiffOpKind;
  previous?: TiptapBlock;
  current?: TiptapBlock;
}

// Side-by-side rendering wants paired rows: when a block exists in both
// docs the row carries both sides, when it's added we leave the previous
// column empty, when it's removed we leave the current column empty.
export interface DiffRow {
  kind: "same" | "added" | "removed";
  previous: TiptapBlock | null;
  current: TiptapBlock | null;
}

const EMPTY_DOC: TiptapDoc = { type: "doc", content: [{ type: "paragraph" }] };

export function parseDoc(raw: string | null | undefined): TiptapDoc {
  if (!raw) return EMPTY_DOC;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as TiptapDoc).type === "doc"
    ) {
      return parsed as TiptapDoc;
    }
  } catch {
    // fall through
  }
  return EMPTY_DOC;
}

// Recursively sort object keys so the stringified output is identical for
// two blocks that differ only in key insertion order. JSON.stringify's
// array-replacer is a whitelist, not a sort — using it directly drops every
// attribute not at the top level, which silently broke attr-sensitive
// equality (e.g. heading level 2 vs 3 compared the same).
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

function key(b: TiptapBlock): string {
  // Stable comparison across saves: Tiptap doesn't promise key order in
  // JSON, and a different order would otherwise be reported as "changed."
  return JSON.stringify(sortKeysDeep(b));
}

// LCS over arrays of block keys. Returns a list of (i, j) pairs marking
// matched blocks. O(N * M) time, O(N * M) memory, which is fine for our
// scale (typical article has < 100 blocks).
function lcs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const matches: Array<[number, number]> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      matches.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  matches.reverse();
  return matches;
}

export function diffBlocks(
  previous: TiptapBlock[],
  current: TiptapBlock[],
): DiffOp[] {
  const prevKeys = previous.map(key);
  const currKeys = current.map(key);
  const matches = lcs(prevKeys, currKeys);

  // Walk both arrays in lockstep with the matched indices to emit a stream
  // of ops. Unmatched prev blocks are removed, unmatched curr blocks are
  // added, matched blocks emit a `same` op.
  const ops: DiffOp[] = [];
  let pi = 0;
  let ci = 0;
  for (const [mi, mj] of matches) {
    while (pi < mi) {
      ops.push({ kind: "removed", previous: previous[pi] });
      pi++;
    }
    while (ci < mj) {
      ops.push({ kind: "added", current: current[ci] });
      ci++;
    }
    ops.push({ kind: "same", previous: previous[mi], current: current[mj] });
    pi = mi + 1;
    ci = mj + 1;
  }
  // Trailing tails after the last match.
  while (pi < previous.length) {
    ops.push({ kind: "removed", previous: previous[pi] });
    pi++;
  }
  while (ci < current.length) {
    ops.push({ kind: "added", current: current[ci] });
    ci++;
  }
  return ops;
}

// Convert the ops into side-by-side rows for the renderer. `same` rows show
// the block in both columns; `added` only in current; `removed` only in
// previous. The result reads top-to-bottom like a Git side-by-side diff.
export function toDiffRows(ops: DiffOp[]): DiffRow[] {
  return ops.map((op) => {
    if (op.kind === "same") {
      return {
        kind: "same",
        previous: op.previous ?? null,
        current: op.current ?? null,
      };
    }
    if (op.kind === "added") {
      return { kind: "added", previous: null, current: op.current ?? null };
    }
    return { kind: "removed", previous: op.previous ?? null, current: null };
  });
}

export interface DiffSummary {
  added: number;
  removed: number;
  unchanged: number;
}

export function summarize(ops: DiffOp[]): DiffSummary {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const op of ops) {
    if (op.kind === "added") added++;
    else if (op.kind === "removed") removed++;
    else unchanged++;
  }
  return { added, removed, unchanged };
}

// Convenience wrapper: stringified documents in, ready-to-render rows + a
// summary out. Tolerant of malformed inputs so the diff UI never crashes
// on a corrupt revision (it just shows everything as added/removed against
// the empty doc).
export function diffDocuments(
  previousRaw: string | null | undefined,
  currentRaw: string | null | undefined,
): { rows: DiffRow[]; summary: DiffSummary } {
  const prev = parseDoc(previousRaw);
  const curr = parseDoc(currentRaw);
  const ops = diffBlocks(prev.content ?? [], curr.content ?? []);
  return { rows: toDiffRows(ops), summary: summarize(ops) };
}
