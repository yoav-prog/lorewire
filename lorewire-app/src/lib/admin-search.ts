// Pure scoring + snippet helpers behind the global admin search bar
// (plan: _plans/2026-06-19-global-admin-search.md). Lives in @/lib so the
// behaviour is unit-tested without React or DB, and so both the API route
// and the React island stay thin.
//
// Design:
//   - Tokeniser: whitespace-split, lowercased, edge punctuation trimmed,
//     <2 char tokens dropped (no good signal from "a" or "i"), deduped,
//     capped at MAX_TOKENS so a malicious admin can't blow up the SQL OR
//     fan-out.
//   - Scorer: weighted multi-field. Exact-phrase-in-title is the biggest
//     bonus; tokens-in-title beats tokens-in-summary beats tokens-in-body.
//     Prefix bonus fires only on the full query, not per-token. Subreddit /
//     category exact match gets a small boost so "AITAH" surfaces the right
//     rows even with no title match.
//   - Snippet: window of ~140 chars around the first matched token, with
//     all matched tokens wrapped in **bold** markdown the React side parses.
//     Falls back across summary → body → full_text so an empty-summary row
//     still ships a snippet.
//
// This stays in-process so SQLite (dev) and Postgres (prod) behave
// identically — no dependency on FTS5 / tsvector / GIN. If a future
// profile shows the LIKE candidate fetch becoming the bottleneck, we
// can layer Postgres tsvector underneath without changing this file's
// contract.

export const MAX_QUERY_LENGTH = 100;
export const MAX_TOKENS = 8;
export const SNIPPET_WINDOW = 140;
export const SNIPPET_PADDING = 20; // chars of context before the first match

// ─── Tokeniser ────────────────────────────────────────────────────────────

/** Split a free-form query into normalised tokens ready for scoring + SQL.
 * Drops tokens shorter than 2 chars, trims edge punctuation, AND splits on
 * `/` so "r/AITAH" yields "aitah" (the `r` is dropped as <2 chars). The
 * subreddit column doesn't store the "r/" prefix, so a query that keeps
 * it would never match — splitting here turns the user's natural
 * "r/AITAH" into a productive search. Dedups so "aita aita" doesn't
 * double-count. Caps at MAX_TOKENS to bound SQL OR fan-out. */
export function tokenise(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Single split: any whitespace OR forward slash. The apostrophe inside
  // "don't" survives because it's not in the split set; edge punctuation
  // is trimmed in a second pass below.
  for (const raw of query.toLowerCase().split(/[\s/]+/)) {
    const t = raw.replace(/^[\s.,;:!?'"()[\]<>{}\\|*+=~`@#$%^&-]+/, "")
                 .replace(/[\s.,;:!?'"()[\]<>{}\\|*+=~`@#$%^&-]+$/, "");
    if (t.length < 2) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

// ─── Scoring ──────────────────────────────────────────────────────────────

export interface ScoreInput {
  title: string | null;
  summary: string | null;
  body: string | null;
  /** subreddit (for reddit_source) or category (for stories). One small
   * categorical label; an exact match earns +5. */
  bucket: string | null;
}

export interface ScoredRow {
  score: number;
  /** Which fields actually contributed any score. Useful for tests and
   * for the snippet picker (it prefers the field that hit). */
  hits: { title: boolean; summary: boolean; body: boolean; bucket: boolean };
}

/** Score a single row against a tokenised query. Returns score=0 with all
 * hits=false when nothing matches; the caller filters those out before
 * shipping results.
 *
 * Weights chosen so "exact phrase in title" always beats "all tokens
 * scattered in body" by a comfortable margin, and the prefix bonus
 * resolves ties on similar titles in favour of the one whose first
 * characters are the user's query. */
export function score(row: ScoreInput, tokens: string[], rawQuery: string): ScoredRow {
  if (tokens.length === 0) {
    return { score: 0, hits: noHits() };
  }
  const title = (row.title ?? "").toLowerCase();
  const summary = (row.summary ?? "").toLowerCase();
  const body = (row.body ?? "").toLowerCase();
  const bucket = (row.bucket ?? "").toLowerCase();
  const phrase = rawQuery.toLowerCase().trim();

  let s = 0;
  const hits = noHits();

  // Phrase bonuses — only fire when the entire query (as the user typed
  // it) appears verbatim in the field. Cheap to check and catches the
  // strongest signal ("the steak standoff" hitting a title is decisive).
  if (phrase.length >= 2) {
    if (title.includes(phrase)) {
      s += 10;
      hits.title = true;
    }
    if (summary.includes(phrase)) {
      s += 4;
      hits.summary = true;
    }
    if (title.startsWith(phrase)) {
      s += 3; // prefix bonus stacks on top of the phrase-in-title bonus
    }
  }

  // Per-token bonuses. Count how many distinct tokens land in each field
  // and weight by field. Tokens are already deduped by `tokenise`, so the
  // multiplier is bounded by tokens.length (bounded by MAX_TOKENS).
  let titleHitCount = 0;
  let summaryHitCount = 0;
  let bodyHitCount = 0;
  for (const t of tokens) {
    if (title.includes(t)) titleHitCount++;
    if (summary.includes(t)) summaryHitCount++;
    if (body.includes(t)) bodyHitCount++;
  }
  if (titleHitCount > 0) {
    s += 3 * titleHitCount;
    hits.title = true;
    // "all tokens in title" earns an extra +6 — narrowly preferred over
    // phrase-in-summary alone (4) but still well behind phrase-in-title (10).
    if (titleHitCount === tokens.length && tokens.length > 1) {
      s += 6;
    }
  }
  if (summaryHitCount > 0) {
    s += 2 * summaryHitCount;
    hits.summary = true;
  }
  if (bodyHitCount > 0) {
    s += 1 * bodyHitCount;
    hits.body = true;
  }

  // Exact bucket (subreddit / category) match — small boost so the user
  // can filter by typing the bucket name even when the rest of the query
  // doesn't match a title token.
  if (bucket.length > 0 && tokens.includes(bucket)) {
    s += 5;
    hits.bucket = true;
  }

  return { score: s, hits };
}

function noHits(): ScoredRow["hits"] {
  return { title: false, summary: false, body: false, bucket: false };
}

// ─── Snippet ──────────────────────────────────────────────────────────────

/** Build a ~SNIPPET_WINDOW-char snippet around the first matched token,
 * with every matched token wrapped in **bold** markdown the React side
 * parses. Falls back across summary → body → full_text so the snippet
 * is never empty when one of the longer fields has a hit.
 *
 * If no token matches in any field, returns the leading SNIPPET_WINDOW
 * chars of whichever source has content — better than an empty row. */
export function buildSnippet(
  fields: { summary?: string | null; body?: string | null; full_text?: string | null },
  tokens: string[],
): string {
  const sources = [fields.summary, fields.body, fields.full_text]
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length > 0);
  if (sources.length === 0) return "";

  // Pick the first source that has a hit; if none hit, fall back to the
  // first non-empty source's leading chars.
  let chosen = sources[0];
  let hitIndex = -1;
  for (const src of sources) {
    const lo = src.toLowerCase();
    for (const t of tokens) {
      const i = lo.indexOf(t);
      if (i >= 0) {
        chosen = src;
        hitIndex = i;
        break;
      }
    }
    if (hitIndex >= 0) break;
  }

  let snippet: string;
  if (hitIndex < 0) {
    snippet = chosen.slice(0, SNIPPET_WINDOW);
    if (chosen.length > SNIPPET_WINDOW) snippet = snippet.trimEnd() + "…";
  } else {
    const start = Math.max(0, hitIndex - SNIPPET_PADDING);
    const end = Math.min(chosen.length, start + SNIPPET_WINDOW);
    snippet = chosen.slice(start, end);
    if (start > 0) snippet = "…" + snippet.trimStart();
    if (end < chosen.length) snippet = snippet.trimEnd() + "…";
  }

  // Wrap matched tokens with **bold** in a single regex pass so a
  // longer token (e.g. "leafblower") is matched before its substring
  // ("leaf") and the substring never lands inside an already-wrapped
  // span. The regex engine tries alternatives left-to-right at each
  // position, so sorting by length DESC gives the longest-match-wins
  // behaviour we want. One pass also means no risk of re-wrapping
  // (the `**` characters from the previous wrap aren't in any token).
  const uniqueTokens = [...new Set(tokens)]
    .filter((t) => t.length > 0)
    .sort((a, b) => b.length - a.length);
  if (uniqueTokens.length === 0) return snippet;
  const escaped = uniqueTokens.map((t) =>
    t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");
  return snippet.replace(pattern, (match) => `**${match}**`);
}

// ─── Compare / sort ───────────────────────────────────────────────────────

/** Stable comparator used to order the final result list. Higher score
 * wins; ties broken by recency (updated_at), then by id ASC so the order
 * is deterministic across requests. */
export function compareScored<T extends { score: number; updated_at?: string | null; id: string }>(
  a: T,
  b: T,
): number {
  if (a.score !== b.score) return b.score - a.score;
  const au = a.updated_at ?? "";
  const bu = b.updated_at ?? "";
  if (au !== bu) return bu.localeCompare(au);
  return a.id.localeCompare(b.id);
}
