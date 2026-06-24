// Reddit candidate pool — data access for the admin's
// import / browse / bulk-process flow.
//
// Mirrors pipeline/reddit_db_sync.py:
//   - parseCsv: same 9-header contract; same normalization rules
//   - apply: same snapshot-then-bulk strategy (1 SELECT + 1 INSERT batch +
//     1 UPDATE batch) so a 30k-row upload stays sub-30 s on either driver
//
// The Python CLI keeps working for offline / scheduled syncs; the admin
// upload path simply doesn't shell out to it. The two implementations are
// kept in lockstep through the test fixtures and the EXPECTED_HEADERS
// constant. See _plans/2026-06-14-reddit-db-sync.md.

import "server-only";
import { all, one, run } from "@/lib/db";

// The 9 columns the parser expects, in source-sheet order. A header drift
// (renamed / inserted column) is a hard error — silent column re-mapping
// is exactly the bug that destroys a candidate pool weeks later.
export const EXPECTED_HEADERS = [
  "Reddit ID",
  "Subreddit",
  "Date Written",
  "Title",
  "Full Text",
  "Comments",
  "URL",
  "Summary",
  "How Long it Is",
] as const;

export type RedditSourceStatus =
  | "imported"
  | "queued"
  | "processing"
  | "used"
  | "skipped";

// 2026-06-23 IdeasDB priority import (see
// _plans/2026-06-23-ideasdb-priority-import.md). `strength` drives queue
// ordering via JOIN in pipeline/store.py:claim_next_story_job. Legacy
// reddit_source rows imported before the IdeasDB pass default to 'none'.
export type RedditSourceStrength = "none" | "medium" | "strong";

export interface RedditSourceRow {
  reddit_id: string;
  subreddit: string;
  date_written: string;
  title: string;
  full_text: string;
  comments: number | null;
  url: string | null;
  summary: string | null;
  length_chars: number | null;
  status: RedditSourceStatus;
  story_id: string | null;
  notes: string | null;
  first_synced: string;
  last_synced: string;
  // 2026-06-23 IdeasDB priority import columns. All nullable on legacy
  // rows; populated by scripts/import_ideas.py. `headline` is the
  // curator's angle (distinct from `title` which is Reddit's original
  // post title — preserved untouched on matched rows). `source_hint`
  // stores the raw Source string for forensics, including the
  // multi-token form. `needs_expansion=1` is the worker dispatch
  // signal for idea-only seeds (full_text='').
  strength: RedditSourceStrength;
  category: string | null;
  headline: string | null;
  source_hint: string | null;
  needs_expansion: number;
  fingerprint: string | null;
  // 2026-06-24 Full Pipeline toggle (plan:
  // _plans/2026-06-24-reddit-source-full-pipeline-toggle.md). When 1, the
  // worker runs every stage end-to-end AND the TS auto-publish drain
  // flips the resulting story to status='published' on success (web +
  // Facebook). Default 0 = existing review-then-manual-publish behaviour.
  // Propagated onto story_jobs.full_pipeline at enqueue.
  full_pipeline: number;
}

const REFRESH_COLS = [
  "subreddit",
  "date_written",
  "title",
  "full_text",
  "comments",
  "url",
  "summary",
  "length_chars",
] as const;

const ALL_COLS =
  "reddit_id, subreddit, date_written, title, full_text, comments, url, summary, length_chars, status, story_id, notes, first_synced, last_synced, strength, category, headline, source_hint, needs_expansion, fingerprint, full_pipeline";

// ---------- CSV parse ----------

export interface ParsedRow {
  reddit_id: string;
  subreddit: string;
  date_written: string;
  title: string;
  full_text: string;
  comments: number | null;
  url: string | null;
  summary: string | null;
  length_chars: number;
}

export interface ParseResult {
  rows: ParsedRow[];
  warnings: string[];
}

// RFC4180 CSV parser. We use a hand-rolled tokenizer because the source
// sheet has multi-line text fields with embedded quotes — a naive
// split('\n') / split(',') destroys them.
export function parseCsvText(text: string): ParseResult {
  // Strip a UTF-8 BOM if present (Excel and some Sheets exports add one).
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n" || c === "\r") {
        // Treat \r\n, \n, and bare \r identically as row terminators.
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      } else {
        field += c;
      }
    }
  }
  // Trailing field / row without final newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) {
    return { rows: [], warnings: ["CSV is empty"] };
  }

  const headers = rows[0];
  const missing = EXPECTED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length > 0) {
    throw new Error(
      `CSV is missing required header columns: ${missing.join(", ")}. ` +
        `Got: ${headers.join(", ")}`,
    );
  }
  const idx: Record<string, number> = {};
  EXPECTED_HEADERS.forEach((h) => {
    idx[h] = headers.indexOf(h);
  });

  const warnings: string[] = [];
  const parsed: ParsedRow[] = [];
  const seen = new Map<string, number>(); // reddit_id -> first line seen

  for (let r = 1; r < rows.length; r++) {
    // Real-world CSVs include blank trailing rows; skip them silently.
    const line = rows[r];
    if (line.length === 0 || (line.length === 1 && line[0] === "")) continue;
    const lineNo = r + 1; // header is line 1, data starts at 2

    const get = (h: string): string => {
      const j = idx[h];
      return j === undefined || j >= line.length ? "" : (line[j] ?? "").trim();
    };

    const rid = get("Reddit ID");
    if (!rid) {
      warnings.push(`line ${lineNo}: blank Reddit ID, skipped`);
      continue;
    }
    if (seen.has(rid)) {
      warnings.push(
        `line ${lineNo}: duplicate Reddit ID '${rid}' (first seen on line ${seen.get(rid)}); keeping later row`,
      );
      // Don't overwrite the recorded "first seen" line — that's the whole
      // point of the warning. Previously the third+ occurrence would
      // misattribute its "first seen" to the previous duplicate.
    } else {
      seen.set(rid, lineNo);
    }

    const fullText = get("Full Text");
    const title = get("Title");
    const subreddit = get("Subreddit");
    if (!subreddit || !title || !fullText) {
      warnings.push(
        `line ${lineNo}: missing required field ` +
          `(subreddit=${!!subreddit}, title=${!!title}, full_text=${!!fullText}); skipped`,
      );
      continue;
    }

    const dateRaw = get("Date Written");
    const dateIso = normalizeDate(dateRaw);
    if (dateRaw && dateIso === dateRaw) {
      warnings.push(
        `line ${lineNo}: date '${dateRaw}' not in YYYY-MM-DD HH:MM, stored as-is`,
      );
    }

    const lengthRaw = parseIntCell(get("How Long it Is"));
    const lengthChars =
      lengthRaw !== null && lengthRaw > 0 ? lengthRaw : fullText.length;

    parsed.push({
      reddit_id: rid,
      subreddit,
      date_written: dateIso || dateRaw,
      title,
      full_text: fullText,
      comments: parseIntCell(get("Comments")),
      url: noneIfBlank(get("URL")),
      summary: noneIfBlank(get("Summary")),
      length_chars: lengthChars,
    });
  }

  return { rows: parsed, warnings };
}

function parseIntCell(raw: string): number | null {
  // Strip thousands separators that Sheets exports include ("1,234" /
  // "12,000,000"). Without this, Number() returns NaN and the row
  // would be inserted with NULL — silently misclassifying high-comment
  // stories as "no engagement" in the admin's "Min comments" filter.
  // Also accept "none" / blank as null. Pure-integer-only via
  // /^-?\d+$/ to reject scientific notation ("1e3" → 1000) and
  // Infinity that Number() would happily accept.
  const s = raw.trim().replace(/,/g, "");
  if (!s || s.toLowerCase() === "none") return null;
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function noneIfBlank(s: string): string | null {
  return s === "" ? null : s;
}

// Normalize "YYYY-MM-DD HH:MM" → ISO-8601 so the date_written column is
// a clean string-compare on filter. Falls back to raw on parse failure.
function normalizeDate(raw: string): string {
  if (!raw) return "";
  const m = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!m) return raw;
  const [, y, mo, d, h = "00", mi = "00", se = "00"] = m;
  // Pad just in case the regex captured a single-digit (it won't, but
  // belt-and-suspenders for any future schema drift).
  return `${y}-${mo}-${d}T${h}:${mi}:${se}+00:00`;
}

// ---------- DB reads ----------

export interface RedditSourceFilters {
  status?: RedditSourceStatus | RedditSourceStatus[];
  subreddits?: string[];
  length_min?: number;
  length_max?: number;
  comments_min?: number;
  date_from?: string;
  date_to?: string;
  search?: string;
  // 2026-06-23 IdeasDB priority import filter (see
  // _plans/2026-06-23-ideasdb-priority-import.md). Lets the admin focus on
  // strong / medium priority rows that the IdeasDB sheet flagged.
  strength?: RedditSourceStrength | RedditSourceStrength[];
}

export type RedditSourceOrderBy =
  | "comments DESC"
  | "comments ASC"
  | "length_chars DESC"
  | "length_chars ASC"
  | "date_written DESC"
  | "date_written ASC"
  | "subreddit ASC"
  // 2026-06-23 Strength-first sort. Tied to the same CASE weight the
  // worker uses in claim_next_story_job so the admin's "what'll process
  // next" view matches the worker's actual claim order.
  | "strength DESC";

// strength is a TEXT enum; CASE WHEN maps to a numeric weight so the
// ORDER BY is portable across SQLite and Postgres without needing
// FIELD()/array_position() or a string-typed enum ordering.
const STRENGTH_WEIGHT_CASE =
  "CASE strength WHEN 'strong' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END";

const ORDER_BY_SQL: Record<RedditSourceOrderBy, string> = {
  "comments DESC": "comments DESC",
  "comments ASC": "comments ASC",
  "length_chars DESC": "length_chars DESC",
  "length_chars ASC": "length_chars ASC",
  "date_written DESC": "date_written DESC",
  "date_written ASC": "date_written ASC",
  "subreddit ASC": "subreddit ASC, comments DESC",
  "strength DESC": `${STRENGTH_WEIGHT_CASE} DESC, comments DESC`,
};

// Build a (whereSql, params) pair from a filter object. Every value is
// parameter-bound; no value ever touches string concatenation.
function buildWhere(
  f: RedditSourceFilters,
): { where: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];

  if (f.status) {
    const arr = Array.isArray(f.status) ? f.status : [f.status];
    if (arr.length > 0) {
      parts.push(`status IN (${arr.map(() => "?").join(", ")})`);
      params.push(...arr);
    }
  }
  if (f.subreddits && f.subreddits.length > 0) {
    parts.push(`subreddit IN (${f.subreddits.map(() => "?").join(", ")})`);
    params.push(...f.subreddits);
  }
  if (f.length_min !== undefined) {
    parts.push("length_chars >= ?");
    params.push(f.length_min);
  }
  if (f.length_max !== undefined) {
    parts.push("length_chars <= ?");
    params.push(f.length_max);
  }
  if (f.comments_min !== undefined) {
    parts.push("comments >= ?");
    params.push(f.comments_min);
  }
  if (f.date_from) {
    parts.push("date_written >= ?");
    params.push(f.date_from);
  }
  if (f.date_to) {
    parts.push("date_written <= ?");
    params.push(f.date_to);
  }
  if (f.search) {
    // SQLite LIKE is case-insensitive on ASCII by default; @/lib/db's
    // toPg() rewrites ? to $1 etc but does NOT swap LIKE→ILIKE, so for
    // Postgres parity we use LOWER() on both sides. Cheaper than a full
    // ILIKE for the size we're filtering on.
    parts.push("(LOWER(title) LIKE ? OR LOWER(summary) LIKE ?)");
    const q = `%${f.search.toLowerCase()}%`;
    params.push(q, q);
  }
  if (f.strength) {
    const arr = Array.isArray(f.strength) ? f.strength : [f.strength];
    if (arr.length > 0) {
      // No COALESCE: the column has a NOT NULL DEFAULT 'none', so every
      // row already carries a real strength value (the migration set
      // legacy rows to 'none' explicitly).
      parts.push(`strength IN (${arr.map(() => "?").join(", ")})`);
      params.push(...arr);
    }
  }

  return { where: parts.length ? parts.join(" AND ") : "1=1", params };
}

// Minimal-column candidate row used by the global admin search bar's
// in-process scorer (plan:
// _plans/2026-06-19-global-admin-search.md). Wider than RedditSourceRow
// would be pulling unused columns; narrower than the search needs (body
// is `full_text`, which we DO need for snippet fallback when summary is
// empty). last_synced is the recency tiebreaker.
export interface RedditSourceSearchCandidate {
  reddit_id: string;
  subreddit: string;
  title: string;
  summary: string | null;
  full_text: string;
  last_synced: string;
}

/** Fetch up to `limit` reddit_source rows where every token lands in at
 * least one of (title, summary, subreddit, full_text). Each token is
 * parameter-bound — no value ever touches string concatenation. Designed
 * for the global admin search bar: the caller scores + ranks the result
 * in JS. */
export async function listRedditSourcesForSearch(
  tokens: string[],
  limit = 200,
): Promise<RedditSourceSearchCandidate[]> {
  if (tokens.length === 0) return [];
  const cappedLimit = Math.min(Math.max(Math.trunc(limit), 1), 1000);
  const parts: string[] = [];
  const params: unknown[] = [];
  // AND across tokens, OR across fields: every typed token must land
  // somewhere, but they can land in different columns ("leaf" in title,
  // "blower" in full_text still wins).
  for (const t of tokens) {
    parts.push(
      "(LOWER(title) LIKE ? OR LOWER(COALESCE(summary, '')) LIKE ? " +
      "OR LOWER(subreddit) LIKE ? OR LOWER(full_text) LIKE ?)",
    );
    const like = `%${t}%`;
    params.push(like, like, like, like);
  }
  const where = parts.join(" AND ");
  return all<RedditSourceSearchCandidate>(
    `SELECT reddit_id, subreddit, title, summary, full_text, last_synced ` +
    `FROM reddit_source WHERE ${where} ` +
    `ORDER BY last_synced DESC LIMIT ?`,
    [...params, cappedLimit],
  );
}

export async function listRedditSources(
  filters: RedditSourceFilters = {},
  opts: { limit?: number; offset?: number; orderBy?: RedditSourceOrderBy } = {},
): Promise<RedditSourceRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const orderBy = ORDER_BY_SQL[opts.orderBy ?? "comments DESC"];
  const { where, params } = buildWhere(filters);
  const sql =
    `SELECT ${ALL_COLS} FROM reddit_source WHERE ${where} ` +
    `ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  return all<RedditSourceRow>(sql, [...params, limit, offset]);
}

export async function countRedditSources(
  filters: RedditSourceFilters = {},
): Promise<number> {
  const { where, params } = buildWhere(filters);
  const row = await one<{ n: number | string }>(
    `SELECT count(*) AS n FROM reddit_source WHERE ${where}`,
    params,
  );
  return Number(row?.n ?? 0);
}

export async function getRedditSource(
  redditId: string,
): Promise<RedditSourceRow | null> {
  if (!redditId) return null;
  return one<RedditSourceRow>(
    `SELECT ${ALL_COLS} FROM reddit_source WHERE reddit_id = ?`,
    [redditId],
  );
}

export async function listRedditSourceSubreddits(): Promise<string[]> {
  const rows = await all<{ subreddit: string }>(
    "SELECT DISTINCT subreddit FROM reddit_source ORDER BY subreddit ASC",
    [],
  );
  return rows.map((r) => r.subreddit);
}

// ---------- DB writes (sync apply) ----------

export interface SyncDiff {
  parsed: number;
  new: number;
  updated: number;
  unchanged: number;
  errors: number;
  warnings: string[];
  sample_new: string[];
  parse_ms: number;
  apply_ms: number;
}

// Single-fetch snapshot of every reddit_id currently in the table that the
// caller also has in `redditIds`. Used by applyParsed() to partition into
// new vs updated vs unchanged in memory.
async function fetchSnapshot(
  redditIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (redditIds.length === 0) return out;
  const cols =
    "reddit_id, subreddit, date_written, title, full_text, comments, url, summary, length_chars";
  // Chunk to stay under SQLite's older 999-parameter ceiling and Postgres's
  // 32767 bind limit. 500 is a comfortable floor under both.
  for (let i = 0; i < redditIds.length; i += 500) {
    const batch = redditIds.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(", ");
    const rows = await all<Record<string, unknown>>(
      `SELECT ${cols} FROM reddit_source WHERE reddit_id IN (${placeholders})`,
      batch,
    );
    for (const r of rows) out.set(String(r.reddit_id), r);
  }
  return out;
}

export async function applyParsed(
  parsed: ParsedRow[],
  warnings: string[],
  opts: { dryRun?: boolean } = {},
): Promise<SyncDiff> {
  const t0 = performance.now();

  // Dedupe by reddit_id, keeping the LAST occurrence (matches the Python
  // sync's "later export wins" intuition and the warning we already emit).
  const incoming = new Map<string, ParsedRow>();
  for (const r of parsed) incoming.set(r.reddit_id, r);

  const snapshot = await fetchSnapshot([...incoming.keys()]);

  const now = new Date().toISOString();
  const newRows: Array<Record<string, unknown>> = [];
  const updateRows: Array<Record<string, unknown>> = [];
  let unchanged = 0;
  const sampleNew: string[] = [];

  for (const [rid, row] of incoming) {
    const prior = snapshot.get(rid);
    if (!prior) {
      newRows.push({
        ...row,
        status: "imported",
        story_id: null,
        notes: null,
        first_synced: now,
        last_synced: now,
      });
      if (sampleNew.length < 10) sampleNew.push(rid);
      continue;
    }
    const rowAsRec = row as unknown as Record<string, unknown>;
    const changed = REFRESH_COLS.some((c) => prior[c] !== rowAsRec[c]);
    if (!changed) {
      unchanged++;
    } else {
      updateRows.push({ ...row, last_synced: now });
    }
  }

  let errors = 0;
  if (!opts.dryRun) {
    if (newRows.length > 0) {
      try {
        await bulkInsert(newRows);
      } catch (e) {
        console.error("[reddit-sync bulk-insert-error]", {
          count: newRows.length,
          error: e instanceof Error ? e.message : String(e),
        });
        errors += newRows.length;
      }
    }
    if (updateRows.length > 0) {
      try {
        await bulkUpdate(updateRows);
      } catch (e) {
        console.error("[reddit-sync bulk-update-error]", {
          count: updateRows.length,
          error: e instanceof Error ? e.message : String(e),
        });
        errors += updateRows.length;
      }
    }
  }

  const elapsed = Math.round(performance.now() - t0);

  return {
    parsed: parsed.length,
    new: newRows.length,
    updated: updateRows.length,
    unchanged,
    errors,
    warnings,
    sample_new: sampleNew,
    parse_ms: 0,
    apply_ms: elapsed,
  };
}

const INSERT_COLS = [
  "reddit_id",
  "subreddit",
  "date_written",
  "title",
  "full_text",
  "comments",
  "url",
  "summary",
  "length_chars",
  "status",
  "story_id",
  "notes",
  "first_synced",
  "last_synced",
];

async function bulkInsert(rows: Array<Record<string, unknown>>): Promise<void> {
  // @/lib/db doesn't expose executemany, so we batch into a single INSERT
  // with multiple VALUES tuples. Keeping each statement under ~500 rows
  // stays well under both engines' bind-parameter ceilings.
  const cols = INSERT_COLS.join(", ");
  const perRow = INSERT_COLS.length;
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const batch = rows.slice(i, i + chunkSize);
    const placeholders = batch
      .map(() => `(${INSERT_COLS.map(() => "?").join(", ")})`)
      .join(", ");
    const params: unknown[] = [];
    for (const r of batch) {
      for (const c of INSERT_COLS) params.push(r[c] ?? null);
    }
    if (params.length !== batch.length * perRow) {
      throw new Error("bulkInsert param/row mismatch");
    }
    await run(`INSERT INTO reddit_source (${cols}) VALUES ${placeholders}`, params);
  }
}

const UPDATE_REFRESH_COLS = [
  ...REFRESH_COLS,
  "last_synced",
] as const;

async function bulkUpdate(rows: Array<Record<string, unknown>>): Promise<void> {
  // SQL UPDATEs don't multi-row as cleanly as INSERTs; we loop, but inside
  // one logical request (the dual-driver layer keeps the connection warm
  // for the duration of the request). For 30k rows this is still seconds.
  const assigns = UPDATE_REFRESH_COLS.map((c) => `${c} = ?`).join(", ");
  for (const r of rows) {
    const params: unknown[] = UPDATE_REFRESH_COLS.map((c) => r[c] ?? null);
    params.push(r.reddit_id);
    await run(
      `UPDATE reddit_source SET ${assigns} WHERE reddit_id = ?`,
      params,
    );
  }
}

// ---------- DB writes (status transitions) ----------

const PATCHABLE_COLS = new Set(["story_id", "notes"]);

export async function setRedditSourceStatus(
  redditId: string,
  status: RedditSourceStatus,
  patch: { story_id?: string | null; notes?: string | null } = {},
): Promise<void> {
  if (!redditId) throw new Error("setRedditSourceStatus requires reddit_id");
  const cols = ["status"];
  const params: unknown[] = [status];
  for (const k of Object.keys(patch)) {
    if (!PATCHABLE_COLS.has(k)) {
      throw new Error(`setRedditSourceStatus: unknown column ${k}`);
    }
    cols.push(k);
    params.push((patch as Record<string, unknown>)[k] ?? null);
  }
  params.push(redditId);
  await run(
    `UPDATE reddit_source SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE reddit_id = ?`,
    params,
  );
}

// ---------- publish gate (Phase 4) ----------

export interface PublishReadiness {
  ready: boolean;
  /** Human-readable reasons the story isn't ready. Empty when `ready=true`. */
  missing: string[];
}

interface StoryReadinessInput {
  status: string | null;
  body: string | null;
  hero_image: string | null;
  // 2026-06-19 (plan:
  // _plans/2026-06-19-no-long-form-video-for-reddit-jobs.md):
  // video_url is no longer checked here. Reddit-source stories don't
  // auto-render long-form MP4s any more; the short carries the visual
  // payload, the article reads from hero + scenes. Kept on the interface
  // (rather than removed) so callers passing it as part of a wider story
  // shape don't break — the field is just ignored.
  video_url: string | null;
}

interface SourceReadinessInput {
  status: string | null;
  story_id: string | null;
}

// Pure check so the publish action and the review page render from the
// same source of truth — and so it's trivially unit-testable without a
// DB. Each missing piece is its own line so the admin sees exactly what
// to fix before clicking Publish.
export function evaluatePublishReadiness(
  story: StoryReadinessInput | null,
  source: SourceReadinessInput,
): PublishReadiness {
  const missing: string[] = [];

  if (source.status !== "used") {
    missing.push("source row hasn't finished processing");
  }
  if (!source.story_id) {
    missing.push("source row has no linked story_id");
  }
  if (!story) {
    missing.push("story has not been generated yet");
    return { ready: false, missing };
  }

  if (!story.body || story.body.trim() === "") {
    missing.push("story body is empty");
  }
  if (!story.hero_image) {
    missing.push("hero image is missing");
  }
  // 2026-06-19: video_url is no longer a publish prerequisite. See the
  // comment on StoryReadinessInput above and
  // _plans/2026-06-19-no-long-form-video-for-reddit-jobs.md.
  if (story.status === "published") {
    missing.push("story is already published");
  }
  if (story.status === "archived") {
    missing.push("story is archived — re-open before publishing");
  }

  return { ready: missing.length === 0, missing };
}


// ---------- bulk re-process (Phase 6) ----------

export interface BulkReprocessResult {
  /** Rows that were `used`, had their story archived, and got reset to `imported`. */
  reset: number;
  /** Rows skipped because a worker is currently running them (queued or processing). */
  skipped_active: number;
  /** Rows skipped because they're already in `imported` or `skipped` (no work to redo). */
  skipped_other: number;
  /** Rows whose reddit_id didn't match any candidate. */
  not_found: number;
  /** The reddit_ids that actually got reset, in input order. */
  reset_ids: string[];
}

/**
 * Bulk version of the per-row Re-process action. Conservative on purpose:
 * only resets rows in status='used' (workers wouldn't claim those; safe to
 * archive their story and put the row back in the candidate pool).
 *
 * Rows in `queued` / `processing` are deliberately skipped — a worker
 * could be mid-execution and stripping the row's link would orphan the
 * in-flight job. Use the per-row affordance on the review page if you
 * really need to disrupt those.
 *
 * Rows in `imported` / `skipped` are no-ops with their own counter so
 * the admin sees exactly what happened (e.g. "Reset 12, 3 still
 * processing, 1 already imported").
 */
export async function bulkReprocessRedditSources(
  redditIds: string[],
): Promise<BulkReprocessResult> {
  const result: BulkReprocessResult = {
    reset: 0,
    skipped_active: 0,
    skipped_other: 0,
    not_found: 0,
    reset_ids: [],
  };
  if (redditIds.length === 0) return result;

  // Snapshot status + story_id in one chunked SELECT. Per-row writes
  // follow; they're cheap relative to the LLM/kie spend a re-process
  // implies, but we batch the reads to keep parameter counts under the
  // 999 / 32767 ceilings the dual-driver layer cares about.
  const snapshot = new Map<string, { status: string; story_id: string | null }>();
  for (let i = 0; i < redditIds.length; i += 500) {
    const batch = redditIds.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(", ");
    const rows = await all<{
      reddit_id: string;
      status: string;
      story_id: string | null;
    }>(
      `SELECT reddit_id, status, story_id FROM reddit_source ` +
        `WHERE reddit_id IN (${placeholders})`,
      batch,
    );
    for (const r of rows) snapshot.set(r.reddit_id, r);
  }

  const now = new Date().toISOString();

  for (const rid of redditIds) {
    const row = snapshot.get(rid);
    if (!row) {
      result.not_found++;
      continue;
    }
    if (row.status === "queued" || row.status === "processing") {
      result.skipped_active++;
      continue;
    }
    if (row.status !== "used") {
      // imported / skipped — nothing to undo.
      result.skipped_other++;
      continue;
    }
    // Archive the prior story (if any) so the public list doesn't carry
    // the stale draft. We don't delete — the row may be useful to diff
    // against a future re-run.
    if (row.story_id) {
      await run(
        "UPDATE stories SET status = ?, updated_at = ? WHERE id = ?",
        ["archived", now, row.story_id],
      );
    }
    await run(
      "UPDATE reddit_source SET status = ?, story_id = ? WHERE reddit_id = ?",
      ["imported", null, rid],
    );
    result.reset++;
    result.reset_ids.push(rid);
  }

  return result;
}

export async function bulkSetRedditSourceStatus(
  redditIds: string[],
  status: RedditSourceStatus,
  patch: { notes?: string | null } = {},
): Promise<number> {
  if (redditIds.length === 0) return 0;
  let updated = 0;
  // Chunk for the IN-clause bind limit; same 500-row floor as elsewhere.
  for (let i = 0; i < redditIds.length; i += 500) {
    const batch = redditIds.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(", ");
    const sets = ["status = ?"];
    const params: unknown[] = [status];
    if (patch.notes !== undefined) {
      sets.push("notes = ?");
      params.push(patch.notes);
    }
    params.push(...batch);
    await run(
      `UPDATE reddit_source SET ${sets.join(", ")} WHERE reddit_id IN (${placeholders})`,
      params,
    );
    updated += batch.length;
  }
  return updated;
}

// ---------- Full Pipeline toggle (2026-06-24) ----------

// Per-source opt-in for end-to-end run + auto-publish on success. The
// toggle is persisted on reddit_source (not story_jobs) so the admin
// can flip it before processing — propagation onto the job row happens
// at enqueue inside bulkEnqueueStoryJobs. Bulk variant matches the
// shape of bulkSetRedditSourceStatus so the admin footer can reuse the
// same selection model.
export async function setRedditSourceFullPipeline(
  redditId: string,
  value: boolean,
): Promise<void> {
  if (!redditId) {
    throw new Error("setRedditSourceFullPipeline requires reddit_id");
  }
  await run(
    "UPDATE reddit_source SET full_pipeline = ? WHERE reddit_id = ?",
    [value ? 1 : 0, redditId],
  );
}

export async function bulkSetRedditSourceFullPipeline(
  redditIds: string[],
  value: boolean,
): Promise<number> {
  if (redditIds.length === 0) return 0;
  let updated = 0;
  for (let i = 0; i < redditIds.length; i += 500) {
    const batch = redditIds.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(", ");
    await run(
      `UPDATE reddit_source SET full_pipeline = ? WHERE reddit_id IN (${placeholders})`,
      [value ? 1 : 0, ...batch],
    );
    updated += batch.length;
  }
  return updated;
}
