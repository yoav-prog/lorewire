// Client-safe surface for the engagement-poll feature: constants,
// types, category presets, validation, and the pure divisiveness
// math. Both the admin PollEditor (client) and the public PollWidget
// (client) import from here, so this file is free of any
// "server-only" boundary OR db driver pull. The server-side storage
// helpers in lib/polls.ts re-export everything in this module so
// existing server callers can keep importing from "@/lib/polls" and
// the indirection stays invisible.
//
// Plan: _plans/2026-06-17-engagement-polls.md. Same shape as
// lib/homepage-curation-shared.ts — that file's split is the
// precedent.

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

/** Card shape rendered on the public rail pages AND on the homepage
 *  PollRail. Self-contained: carries every field the card needs so a
 *  consumer never has to look the story up in a static catalog.
 *
 *  Phase 4.5 of _plans/2026-06-17-engagement-polls.md. Moved into
 *  polls-shared so the client-side homepage rail hook + component
 *  can import the type without dragging the server-only db driver. */
export interface RailCardRow {
  storyId: string;
  slug: string | null;
  title: string | null;
  category: string | null;
  heroImage: string | null;
  question: string;
  optionAText: string;
  optionBText: string;
  votesA: number;
  votesB: number;
  totalVotes: number;
  divisiveness: number;
}

/** Three derived homepage rails computed from poll_aggregates. The
 *  three keys are stable for cross-process consumption (server
 *  action → client hook → component map). */
export const POLL_RAIL_KINDS = [
  "divisive",
  "agreed",
  "unpopular",
] as const;
export type PollRailKind = (typeof POLL_RAIL_KINDS)[number];

export interface HomepagePollRails {
  divisive: RailCardRow[];
  agreed: RailCardRow[];
  unpopular: RailCardRow[];
}

/** Cap per-rail. Homepage rails are horizontal scrollers; 6 cards is
 *  enough to feel populated without bloating the round trip or making
 *  the rail "list-like" instead of "highlight reel"-like. */
export const HOMEPAGE_RAIL_LIMIT = 6;

/** Settings keys for the three rails. Reading a value of "0" (or the
 *  literal string "false") forces the rail off; anything else keeps
 *  it on. Defaults to on when the key is unset so a fresh install
 *  doesn't have to flip anything to see the rails populate. */
export function railEnabledSettingKey(kind: PollRailKind): string {
  return `polls.rail.${kind}_enabled`;
}

export function isRailEnabledValue(v: string | null | undefined): boolean {
  if (v === null || v === undefined) return true;
  const trimmed = v.trim();
  if (trimmed === "") return true;
  if (trimmed === "0" || trimmed.toLowerCase() === "false") return false;
  return true;
}

// ─── Public floor ─────────────────────────────────────────────────────────────

/** Default minimum total votes before percentages are revealed. The
 *  number lives in code so the floor can ship behind a single deploy;
 *  the settings.polls.public_floor key (Phase 5) overrides it at
 *  runtime once the settings UI lands. */
export const DEFAULT_PUBLIC_FLOOR = 20;

// ─── Author-facing length caps ────────────────────────────────────────────────

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

export interface PollPreset {
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
