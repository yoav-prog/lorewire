// Storage helpers + validation for the engagement-poll surface.
// One poll per story, anonymous cookie-keyed voting, materialised
// aggregate refreshed on a cron. Public reads NEVER touch poll_votes
// directly — they read poll_aggregates with a 20-vote floor applied at
// read time so a fresh poll never advertises 100%/0%.
//
// Plan: _plans/2026-06-17-engagement-polls.md.

import "server-only";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";
import type { CATEGORIES } from "@/app/admin/ui";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PollSide = "A" | "B";

export interface PollRow {
  id: string;
  story_id: string;
  question: string;
  option_a_text: string;
  option_b_text: string;
  enabled: number | null;
  category: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface PollAggregateRow {
  story_id: string;
  poll_id: string;
  category: string | null;
  votes_a: number;
  votes_b: number;
  total_votes: number;
  divisiveness: number;
  agreement: number;
  last_vote_at: string | null;
  refreshed_at: string | null;
}

export interface PollResultView {
  /** Total votes recorded (always known). */
  totalVotes: number;
  /** Whether the poll has crossed the public floor — when false the
   *  widget shows the pre-floor copy and HIDES the percentages. The
   *  floor logic lives at read time so it can be tuned without
   *  backfilling poll_aggregates. */
  hasFloor: boolean;
  /** Integer percentages summing to 100 when hasFloor, else 0/0. */
  pctA: number;
  pctB: number;
  /** 0..1, 1 = perfect 50/50, 0 = 100/0. Surfaces on the rail pages. */
  divisiveness: number;
  lastVoteAt: string | null;
}

// ─── Public floor ─────────────────────────────────────────────────────────────

/** Default minimum total votes before percentages are revealed. The
 *  number lives in code so the floor can ship behind a single deploy;
 *  the settings.polls.public_floor key (Phase 5) overrides it at
 *  runtime once the settings UI lands. */
export const DEFAULT_PUBLIC_FLOOR = 20;

// ─── Author-facing length caps (matches §F1 of the plan) ──────────────────────

export const POLL_QUESTION_MAX = 80;
export const POLL_OPTION_MAX = 24;

// ─── Category presets ─────────────────────────────────────────────────────────

// The category preset is the seed the admin sees in the editor when no
// poll exists yet, AND the source the LLM auto-draft prompt borrows
// the "voice" from (Drama is accusatory, Wholesome is empathetic, etc).
// Editing one of these strings here ships with the next deploy; per-
// instance overrides live under settings.polls.preset.<category>.* and
// are loaded by getPresetForCategory below.

export type StoryCategory = (typeof CATEGORIES)[number];

interface PollPreset {
  question: string;
  optionA: string;
  optionB: string;
}

export const CATEGORY_POLL_PRESETS: Record<StoryCategory, PollPreset> = {
  Drama: {
    question: "Who's wrong?",
    optionA: "Person A",
    optionB: "Person B",
  },
  Entitled: {
    question: "Was she justified?",
    optionA: "Yes",
    optionB: "No",
  },
  Humor: {
    question: "Did this actually happen?",
    optionA: "100% real",
    optionB: "Made up",
  },
  Wholesome: {
    question: "Would you do the same?",
    optionA: "Absolutely",
    optionB: "No way",
  },
  Dating: {
    question: "Red flag?",
    optionA: "Red flag",
    optionB: "Overreacting",
  },
  Roommate: {
    question: "Who would you side with?",
    optionA: "Roommate A",
    optionB: "Roommate B",
  },
};

/** Returns the seed preset for a given story category. Falls back to
 *  the Drama preset when the category is missing or unknown — the
 *  point is to never hand the editor an empty form. */
export function getPresetForCategory(
  category: string | null | undefined,
): PollPreset {
  if (category && category in CATEGORY_POLL_PRESETS) {
    return CATEGORY_POLL_PRESETS[category as StoryCategory];
  }
  return CATEGORY_POLL_PRESETS.Drama;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface PollValidationOk {
  ok: true;
  cleaned: { question: string; optionA: string; optionB: string };
}
export interface PollValidationErr {
  ok: false;
  error: string;
}
export type PollValidation = PollValidationOk | PollValidationErr;

/** Single trust boundary for the editor + auto-draft + LLM output.
 *  Cleans whitespace, enforces length caps, rejects empties + the
 *  pathological "both options identical" case (which would make the
 *  poll meaningless). Server actions hit this BEFORE any DB write. */
export function validatePollInputs(input: {
  question: unknown;
  optionA: unknown;
  optionB: unknown;
}): PollValidation {
  const question = typeof input.question === "string" ? input.question.trim() : "";
  const optionA = typeof input.optionA === "string" ? input.optionA.trim() : "";
  const optionB = typeof input.optionB === "string" ? input.optionB.trim() : "";
  if (!question) return { ok: false, error: "Question is required." };
  if (question.length > POLL_QUESTION_MAX) {
    return {
      ok: false,
      error: `Question must be ${POLL_QUESTION_MAX} characters or fewer.`,
    };
  }
  if (!optionA || !optionB) {
    return { ok: false, error: "Both option labels are required." };
  }
  if (optionA.length > POLL_OPTION_MAX || optionB.length > POLL_OPTION_MAX) {
    return {
      ok: false,
      error: `Option labels must be ${POLL_OPTION_MAX} characters or fewer.`,
    };
  }
  if (optionA.toLowerCase() === optionB.toLowerCase()) {
    return {
      ok: false,
      error: "Option A and Option B must differ.",
    };
  }
  return { ok: true, cleaned: { question, optionA, optionB } };
}

export function isPollSide(v: unknown): v is PollSide {
  return v === "A" || v === "B";
}

// ─── Divisiveness math ────────────────────────────────────────────────────────

/** Returns `1 - |0.5 - pctA| * 2`. Domain: 0..1.
 *  - votesA == votesB → 1.0 (perfect divide)
 *  - one side at 100% → 0.0 (unanimous)
 *  - 0/0 (no votes yet) → 0 by convention so a brand-new poll never
 *    accidentally tops the Most Divisive rail.
 */
export function divisiveness(votesA: number, votesB: number): number {
  const total = votesA + votesB;
  if (total <= 0) return 0;
  const pctA = votesA / total;
  return Math.max(0, Math.min(1, 1 - Math.abs(0.5 - pctA) * 2));
}

/** Integer percentage that rounds toward 50/50 — paired with
 *  `pctBComplement` so the two values ALWAYS sum to 100. Plain
 *  `Math.round(pctA * 100)` + `Math.round(pctB * 100)` can produce
 *  101 or 99 on a 50/50 split. */
export function pctA(votesA: number, votesB: number): number {
  const total = votesA + votesB;
  if (total <= 0) return 0;
  return Math.round((votesA / total) * 100);
}

export function pctBComplement(votesA: number, votesB: number): number {
  const total = votesA + votesB;
  if (total <= 0) return 0;
  return 100 - pctA(votesA, votesB);
}

/** Public-facing view derived from an aggregate row. Applies the
 *  floor: until `totalVotes >= floor` the widget hides percentages.
 *  Callers pass the floor through so settings.polls.public_floor can
 *  override it once that setting lands; the constant is the default. */
export function toResultView(
  agg: PollAggregateRow | null,
  floor: number = DEFAULT_PUBLIC_FLOOR,
): PollResultView {
  const total = agg?.total_votes ?? 0;
  const hasFloor = total >= Math.max(0, floor);
  return {
    totalVotes: total,
    hasFloor,
    pctA: hasFloor ? pctA(agg?.votes_a ?? 0, agg?.votes_b ?? 0) : 0,
    pctB: hasFloor ? pctBComplement(agg?.votes_a ?? 0, agg?.votes_b ?? 0) : 0,
    divisiveness: agg?.divisiveness ?? 0,
    lastVoteAt: agg?.last_vote_at ?? null,
  };
}

// ─── Reads ────────────────────────────────────────────────────────────────────

const POLL_COLS =
  "id, story_id, question, option_a_text, option_b_text, enabled, category, created_at, updated_at";

export async function getPollByStoryId(
  storyId: string,
): Promise<PollRow | null> {
  if (!storyId) return null;
  return one<PollRow>(
    `SELECT ${POLL_COLS} FROM polls WHERE story_id = ?`,
    [storyId],
  );
}

export async function getPollById(id: string): Promise<PollRow | null> {
  if (!id) return null;
  return one<PollRow>(`SELECT ${POLL_COLS} FROM polls WHERE id = ?`, [id]);
}

const AGG_COLS =
  "story_id, poll_id, category, votes_a, votes_b, total_votes, divisiveness, agreement, last_vote_at, refreshed_at";

export async function getAggregateByStoryId(
  storyId: string,
): Promise<PollAggregateRow | null> {
  if (!storyId) return null;
  return one<PollAggregateRow>(
    `SELECT ${AGG_COLS} FROM poll_aggregates WHERE story_id = ?`,
    [storyId],
  );
}

// ─── Writes (admin) ───────────────────────────────────────────────────────────

export interface UpsertPollInput {
  storyId: string;
  question: string;
  optionA: string;
  optionB: string;
  enabled: boolean;
  /** Category snapshot from the story row at write time — denormalised
   *  for fast rail queries. Pass null when the story has no category;
   *  the rail queries treat null as "uncategorised" and never crash. */
  category: string | null;
}

export interface UpsertPollResult {
  ok: boolean;
  pollId: string;
  created: boolean;
  error?: string;
}

/** Insert-or-update one row in polls keyed by story_id. The unique
 *  index `idx_polls_story_id` is what makes ON CONFLICT (story_id) DO
 *  UPDATE work; without it Postgres would reject the statement. */
export async function upsertPoll(
  input: UpsertPollInput,
): Promise<UpsertPollResult> {
  const v = validatePollInputs({
    question: input.question,
    optionA: input.optionA,
    optionB: input.optionB,
  });
  if (!v.ok) {
    return { ok: false, pollId: "", created: false, error: v.error };
  }
  if (!input.storyId) {
    return { ok: false, pollId: "", created: false, error: "story_id required" };
  }
  const now = new Date().toISOString();
  const existing = await getPollByStoryId(input.storyId);
  if (existing) {
    await run(
      `UPDATE polls
       SET question = ?, option_a_text = ?, option_b_text = ?, enabled = ?, category = ?, updated_at = ?
       WHERE id = ?`,
      [
        v.cleaned.question,
        v.cleaned.optionA,
        v.cleaned.optionB,
        input.enabled ? 1 : 0,
        input.category,
        now,
        existing.id,
      ],
    );
    console.info("[polls repo] update", {
      poll_id: existing.id,
      story_id: input.storyId,
      enabled: input.enabled,
    });
    return { ok: true, pollId: existing.id, created: false };
  }
  const id = randomUUID();
  await run(
    `INSERT INTO polls (id, story_id, question, option_a_text, option_b_text, enabled, category, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.storyId,
      v.cleaned.question,
      v.cleaned.optionA,
      v.cleaned.optionB,
      input.enabled ? 1 : 0,
      input.category,
      now,
      now,
    ],
  );
  console.info("[polls repo] create", {
    poll_id: id,
    story_id: input.storyId,
    enabled: input.enabled,
  });
  return { ok: true, pollId: id, created: true };
}

// ─── Writes (vote) ────────────────────────────────────────────────────────────

export interface RecordVoteInput {
  pollId: string;
  storyId: string;
  category: string | null;
  side: PollSide;
  cookieToken: string;
  /** Hex SHA-256 of (ip || '\n' || ua), kept only for the rate-limit
   *  bucket lookup and pruned by retention. Null disables the bucket. */
  ipUaHash: string | null;
}

export interface RecordVoteResult {
  ok: boolean;
  /** True when this insert created a new row (the cookie hadn't voted
   *  yet). False when the same cookie had already voted — the call is
   *  a no-op by design so stale tabs don't 409 the user. */
  inserted: boolean;
  error?: string;
}

/** Inserts a vote row, idempotent on (poll_id, cookie_token) — the
 *  partial unique index `idx_poll_votes_poll_cookie` is what makes
 *  the same browser re-clicking accepted-and-noop. The aggregate
 *  refresh cron picks the new row up within 5 minutes. */
export async function recordVote(
  input: RecordVoteInput,
): Promise<RecordVoteResult> {
  if (!input.pollId || !input.storyId || !input.cookieToken) {
    return { ok: false, inserted: false, error: "missing required fields" };
  }
  if (!isPollSide(input.side)) {
    return { ok: false, inserted: false, error: "side must be 'A' or 'B'" };
  }
  // Pre-check: if a row already exists for this (poll, cookie), the
  // unique index would reject the insert; rather than catch the driver
  // exception we read first. Cheap (single-row index probe) and gives
  // the caller a precise `inserted` boolean for the response shape +
  // observability log.
  const existing = await one<{ id: string }>(
    "SELECT id FROM poll_votes WHERE poll_id = ? AND cookie_token = ?",
    [input.pollId, input.cookieToken],
  );
  if (existing) {
    console.info("[polls vote duplicate]", {
      poll_id: input.pollId,
      story_id: input.storyId,
      side: input.side,
      cookie_prefix: input.cookieToken.slice(0, 8),
    });
    return { ok: true, inserted: false };
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO poll_votes (id, poll_id, story_id, category, side, cookie_token, ip_ua_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.pollId,
      input.storyId,
      input.category,
      input.side,
      input.cookieToken,
      input.ipUaHash,
      now,
    ],
  );
  console.info("[polls vote]", {
    poll_id: input.pollId,
    story_id: input.storyId,
    side: input.side,
    cookie_prefix: input.cookieToken.slice(0, 8),
  });
  return { ok: true, inserted: true };
}

// ─── Aggregate refresh ────────────────────────────────────────────────────────

/** Recompute the aggregate row for ONE story by counting the live
 *  poll_votes. Idempotent; safe to run on a story with no votes (writes
 *  zeros). The Vercel cron at /api/polls/refresh calls this in a loop
 *  over stories whose `last_vote_at` is older than `refreshed_at`. */
export async function refreshPollAggregateForStory(
  storyId: string,
): Promise<void> {
  if (!storyId) return;
  const poll = await getPollByStoryId(storyId);
  if (!poll) return;
  const counts = await all<{ side: string; c: number }>(
    "SELECT side, COUNT(*) AS c FROM poll_votes WHERE poll_id = ? GROUP BY side",
    [poll.id],
  );
  let votesA = 0;
  let votesB = 0;
  for (const row of counts) {
    const c = Number(row.c) || 0;
    if (row.side === "A") votesA = c;
    else if (row.side === "B") votesB = c;
  }
  const total = votesA + votesB;
  const div = divisiveness(votesA, votesB);
  const last = await one<{ last_vote_at: string | null }>(
    "SELECT MAX(created_at) AS last_vote_at FROM poll_votes WHERE poll_id = ?",
    [poll.id],
  );
  const now = new Date().toISOString();
  const existing = await getAggregateByStoryId(storyId);
  if (existing) {
    await run(
      `UPDATE poll_aggregates
       SET poll_id = ?, category = ?, votes_a = ?, votes_b = ?, total_votes = ?,
           divisiveness = ?, agreement = ?, last_vote_at = ?, refreshed_at = ?
       WHERE story_id = ?`,
      [
        poll.id,
        poll.category,
        votesA,
        votesB,
        total,
        div,
        1 - div,
        last?.last_vote_at ?? null,
        now,
        storyId,
      ],
    );
  } else {
    await run(
      `INSERT INTO poll_aggregates (story_id, poll_id, category, votes_a, votes_b, total_votes, divisiveness, agreement, last_vote_at, refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        storyId,
        poll.id,
        poll.category,
        votesA,
        votesB,
        total,
        div,
        1 - div,
        last?.last_vote_at ?? null,
        now,
      ],
    );
  }
  console.info("[polls aggregate refresh]", {
    story_id: storyId,
    poll_id: poll.id,
    total,
    divisiveness: Number(div.toFixed(4)),
  });
}

/** Look up the side this cookie voted for on this poll, if any. Used
 *  by the server-rendered PollWidget to decide whether to render the
 *  pre-vote buttons or the post-vote percentages on first paint —
 *  without a second hop after hydration. Returns null when the cookie
 *  hasn't voted on this poll (including the common "no cookie set
 *  yet" case where the caller passes an empty string). */
export async function getVoteSideForCookie(
  pollId: string,
  cookieToken: string | null,
): Promise<PollSide | null> {
  if (!pollId || !cookieToken) return null;
  const row = await one<{ side: string }>(
    "SELECT side FROM poll_votes WHERE poll_id = ? AND cookie_token = ?",
    [pollId, cookieToken],
  );
  if (!row) return null;
  return isPollSide(row.side) ? row.side : null;
}

// ─── Admin overview ───────────────────────────────────────────────────────────

export interface PollOverviewRow {
  poll: PollRow;
  /** Aggregate may be null for a freshly-created poll whose first
   *  refresh tick hasn't run yet. UI renders "—" in that case. */
  aggregate: PollAggregateRow | null;
  /** Joined from stories so the overview table doesn't N+1. */
  storyTitle: string | null;
  storyCategory: string | null;
}

/** Read every poll + its aggregate + the parent story's title in one
 *  trip. Used by /admin/polls. Ordered newest-edit-first so the row
 *  the admin just touched bubbles to the top. */
export async function listPollOverview(): Promise<PollOverviewRow[]> {
  const polls = await all<PollRow>(
    `SELECT ${POLL_COLS} FROM polls ORDER BY COALESCE(updated_at, created_at) DESC`,
  );
  if (polls.length === 0) return [];
  const ids = polls.map((p) => p.story_id);
  const placeholders = ids.map(() => "?").join(", ");
  const [aggs, stories] = await Promise.all([
    all<PollAggregateRow>(
      `SELECT ${AGG_COLS} FROM poll_aggregates WHERE story_id IN (${placeholders})`,
      ids,
    ),
    all<{ id: string; title: string | null; category: string | null }>(
      `SELECT id, title, category FROM stories WHERE id IN (${placeholders})`,
      ids,
    ),
  ]);
  const aggByStory = new Map(aggs.map((a) => [a.story_id, a]));
  const storyById = new Map(stories.map((s) => [s.id, s]));
  return polls.map((p) => ({
    poll: p,
    aggregate: aggByStory.get(p.story_id) ?? null,
    storyTitle: storyById.get(p.story_id)?.title ?? null,
    storyCategory: storyById.get(p.story_id)?.category ?? null,
  }));
}
