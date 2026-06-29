// User-submitted stories + dilemmas (_plans/2026-06-29-user-submitted-stories.md).
// Data layer for the `submissions` table: typed accessors, boundary validation,
// the per-user cap, and the single status-transition chokepoint that writes the
// append-only submission_events audit row (mirrors lib/comments.ts
// setCommentStatus, so the audit trail can never drift from the state).
//
// Phase 1 scope: a signed-in user can save a draft or submit for review, edit a
// draft/rejected submission, and read their own submissions in the dashboard.
// There is no moderation (Phase 2) and no render (Phase 3) yet, so a submit lands
// directly in 'pending_review'. setSubmissionStatus exists for Phases 2-4 to call.

import "server-only";
import { randomUUID } from "node:crypto";

import { all, one, run } from "@/lib/db";
import { getSetting } from "@/lib/repo";
import { getUserById } from "@/lib/users";

// Closed enum carried in code (the DB column is plain TEXT). Lifecycle:
//   draft -> pending_text_check -> pending_review -> rejected | approved
//   approved -> rendering -> published ; published -> unpublished | erased
// Phase 1 uses only draft, pending_review, and (for display) rejected.
export type SubmissionStatus =
  | "draft"
  | "pending_text_check"
  | "pending_review"
  | "rejected"
  | "quarantined"
  | "approved"
  | "rendering"
  | "published"
  | "unpublished"
  | "erased";

export type SubmissionLang = "en" | "he";

export interface SubmissionRow {
  id: string;
  user_id: string;
  display_name: string;
  lang: string | null;
  title: string;
  body: string;
  dilemma_question: string;
  option_a_text: string;
  option_b_text: string;
  status: string;
  reject_category: string | null;
  reject_reason: string | null;
  moderation_source: string | null;
  moderation_confidence: number | null;
  ai_signal: string | null;
  resubmit_count: number | null;
  story_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  render_choice: string | null;
  created_at: string;
  updated_at: string;
}

const SUBMISSION_COLS =
  "id, user_id, display_name, lang, title, body, dilemma_question, " +
  "option_a_text, option_b_text, status, reject_category, reject_reason, " +
  "moderation_source, moderation_confidence, ai_signal, resubmit_count, story_id, " +
  "approved_by, approved_at, render_choice, created_at, updated_at";

// "Active" = consuming a review/render slot. Drives the per-user pending cap.
const ACTIVE_STATUSES: SubmissionStatus[] = [
  "pending_text_check",
  "pending_review",
  "approved",
  "rendering",
];

// The author may edit content only while it is a draft or after a rejection.
const EDITABLE_STATUSES: SubmissionStatus[] = ["draft", "rejected"];

/** Validation + cap failures surfaced to the user. The API route maps
 *  kind 'invalid' -> 400 and 'cap' -> 429. */
export class SubmissionError extends Error {
  constructor(
    public readonly kind: "invalid" | "cap",
    message: string,
  ) {
    super(message);
    this.name = "SubmissionError";
  }
}

// Length bounds enforced at the boundary (never trust the client). Tuned so an
// honest dilemma fits comfortably while empty/abuse input is rejected. The body
// floor matches the eval's low-effort threshold.
const LIMITS = {
  title: { min: 4, max: 120 },
  body: { min: 40, max: 5000 },
  question: { min: 6, max: 200 },
  option: { min: 1, max: 60 },
} as const;

export interface SubmissionInput {
  title: string;
  body: string;
  question: string;
  optionA: string;
  optionB: string;
  lang: SubmissionLang;
}

function field(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function lengthError(
  label: string,
  value: string,
  b: { min: number; max: number },
): string | null {
  if (value.length < b.min) return `${label} is too short.`;
  if (value.length > b.max) return `${label} is too long (max ${b.max} characters).`;
  return null;
}

/** Validate + normalize raw client input into a clean SubmissionInput, or throw
 *  SubmissionError('invalid') with a user-facing message. */
export function parseSubmissionInput(raw: {
  title?: unknown;
  body?: unknown;
  question?: unknown;
  optionA?: unknown;
  optionB?: unknown;
  lang?: unknown;
}): SubmissionInput {
  const title = field(raw.title);
  const body = field(raw.body);
  const question = field(raw.question);
  const optionA = field(raw.optionA);
  const optionB = field(raw.optionB);
  const lang: SubmissionLang = raw.lang === "he" ? "he" : "en";

  const err =
    lengthError("Title", title, LIMITS.title) ??
    lengthError("Story", body, LIMITS.body) ??
    lengthError("Dilemma question", question, LIMITS.question) ??
    lengthError("Option A", optionA, LIMITS.option) ??
    lengthError("Option B", optionB, LIMITS.option);
  if (err) throw new SubmissionError("invalid", err);

  if (optionA.toLowerCase() === optionB.toLowerCase()) {
    throw new SubmissionError("invalid", "The two options need to be different.");
  }

  return { title, body, question, optionA, optionB, lang };
}

// --- reads ---------------------------------------------------------------

export async function getSubmissionById(
  id: string,
): Promise<SubmissionRow | null> {
  if (!id) return null;
  return one<SubmissionRow>(
    `SELECT ${SUBMISSION_COLS} FROM submissions WHERE id = ?`,
    [id],
  );
}

/** A user's own submissions, newest first, for the dashboard. */
export async function listUserSubmissions(
  userId: string,
): Promise<SubmissionRow[]> {
  if (!userId) return [];
  return all<SubmissionRow>(
    `SELECT ${SUBMISSION_COLS} FROM submissions
      WHERE user_id = ? ORDER BY created_at DESC`,
    [userId],
  );
}

/** The admin review queue: submissions awaiting a human decision
 *  (pending_review) plus the non-discretionary quarantine, oldest first (FIFO). */
export async function listSubmissionQueue(
  limit = 200,
): Promise<SubmissionRow[]> {
  return all<SubmissionRow>(
    `SELECT ${SUBMISSION_COLS} FROM submissions
      WHERE status IN ('pending_review', 'quarantined')
      ORDER BY created_at ASC
      LIMIT ?`,
    [limit],
  );
}

// --- per-user cap --------------------------------------------------------

async function settingInt(key: string, fallback: number): Promise<number> {
  const raw = (await getSetting(key))?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DEFAULT_MAX_PENDING = 3;
const DEFAULT_MAX_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Throw SubmissionError('cap') if the user is at their pending or daily limit.
 *  Pending counts active (awaiting-outcome) rows; daily counts non-draft rows
 *  created in the last 24h (a draft hasn't entered the queue, so it doesn't
 *  count). Defaults (3 pending, 5/day) are overridable via the settings table —
 *  set with Amit against the cost table before launch. */
export async function assertWithinCap(
  userId: string,
  now = Date.now(),
): Promise<void> {
  const [maxPending, maxPerDay] = await Promise.all([
    settingInt("submissions.cap.max_pending", DEFAULT_MAX_PENDING),
    settingInt("submissions.cap.max_per_day", DEFAULT_MAX_PER_DAY),
  ]);

  const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
  const pending = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM submissions
      WHERE user_id = ? AND status IN (${placeholders})`,
    [userId, ...ACTIVE_STATUSES],
  );
  if ((pending?.n ?? 0) >= maxPending) {
    throw new SubmissionError(
      "cap",
      `You already have ${maxPending} submissions waiting. Give those a moment before sending another.`,
    );
  }

  const dayCutoff = new Date(now - DAY_MS).toISOString();
  const today = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM submissions
      WHERE user_id = ? AND status != 'draft' AND created_at >= ?`,
    [userId, dayCutoff],
  );
  if ((today?.n ?? 0) >= maxPerDay) {
    throw new SubmissionError(
      "cap",
      `That's ${maxPerDay} submissions today. Come back tomorrow to send more.`,
    );
  }
}

// --- writes --------------------------------------------------------------

async function resolveDisplayName(userId: string): Promise<string> {
  const user = await getUserById(userId);
  const name = user?.name?.trim();
  if (name) return name;
  // Fall back to the email local-part so a published credit is never blank.
  const local = (user?.email ?? "").split("@")[0]?.trim();
  return local || "Anonymous";
}

async function insertEvent(
  submissionId: string,
  actor: string,
  fromStatus: string | null,
  toStatus: string,
  category: string | null,
  reason: string | null,
  now: string,
): Promise<void> {
  await run(
    `INSERT INTO submission_events
       (id, submission_id, actor, from_status, to_status, category, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), submissionId, actor, fromStatus, toStatus, category, reason, now],
  );
}

export interface CreateSubmissionArgs {
  userId: string;
  input: SubmissionInput;
  /** 'submit' enters the review queue (cap-checked); 'draft' just saves. */
  action: "submit" | "draft";
}

/** Create a new submission. A 'submit' is cap-checked and lands in
 *  'pending_review' (Phase 1 has no text-check/render yet); a 'draft' is saved
 *  uncapped. Writes the opening submission_events row. */
export async function createSubmission(
  args: CreateSubmissionArgs,
): Promise<SubmissionRow> {
  const { userId, input, action } = args;
  if (!userId) throw new SubmissionError("invalid", "You need to be signed in.");
  if (action === "submit") await assertWithinCap(userId);

  const id = randomUUID();
  const now = new Date().toISOString();
  const status: SubmissionStatus =
    action === "submit" ? "pending_review" : "draft";
  const displayName = await resolveDisplayName(userId);

  await run(
    `INSERT INTO submissions
       (id, user_id, display_name, lang, title, body, dilemma_question,
        option_a_text, option_b_text, status, resubmit_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      userId,
      displayName,
      input.lang,
      input.title,
      input.body,
      input.question,
      input.optionA,
      input.optionB,
      status,
      0,
      now,
      now,
    ],
  );

  await insertEvent(
    id,
    "author",
    null,
    status,
    null,
    action === "submit" ? "submitted for review" : "saved draft",
    now,
  );

  const created = await getSubmissionById(id);
  if (!created) {
    throw new SubmissionError("invalid", "Could not save your submission. Try again.");
  }
  return created;
}

export interface UpdateSubmissionArgs {
  id: string;
  userId: string;
  input: SubmissionInput;
  action: "submit" | "draft";
}

/** Edit the author's own draft or rejected submission. On 'submit' it re-enters
 *  'pending_review' (cap-checked), clears the prior rejection, and bumps
 *  resubmit_count when it was a rejection. Refuses a submission that isn't the
 *  caller's or isn't in an editable state. */
export async function updateSubmission(
  args: UpdateSubmissionArgs,
): Promise<SubmissionRow> {
  const { id, userId, input, action } = args;
  const current = await getSubmissionById(id);
  if (!current || current.user_id !== userId) {
    throw new SubmissionError("invalid", "That submission isn't available.");
  }
  if (!EDITABLE_STATUSES.includes(current.status as SubmissionStatus)) {
    throw new SubmissionError("invalid", "This submission can no longer be edited.");
  }

  const wasRejected = current.status === "rejected";
  if (action === "submit") await assertWithinCap(userId);

  const now = new Date().toISOString();
  const status: SubmissionStatus =
    action === "submit" ? "pending_review" : "draft";
  const resubmitCount =
    (current.resubmit_count ?? 0) + (action === "submit" && wasRejected ? 1 : 0);

  await run(
    `UPDATE submissions SET
        lang = ?, title = ?, body = ?, dilemma_question = ?,
        option_a_text = ?, option_b_text = ?, status = ?,
        reject_category = NULL, reject_reason = NULL,
        resubmit_count = ?, updated_at = ?
      WHERE id = ?`,
    [
      input.lang,
      input.title,
      input.body,
      input.question,
      input.optionA,
      input.optionB,
      status,
      resubmitCount,
      now,
      id,
    ],
  );

  await insertEvent(
    id,
    "author",
    current.status,
    status,
    null,
    action === "submit"
      ? wasRejected
        ? "edited and resubmitted"
        : "submitted for review"
      : "saved draft",
    now,
  );

  const updated = await getSubmissionById(id);
  if (!updated) {
    throw new SubmissionError("invalid", "Could not save your changes. Try again.");
  }
  return updated;
}

export interface SubmissionStatusFields {
  category?: string | null;
  reason?: string | null;
  moderationSource?: string | null;
  moderationConfidence?: number | null;
  aiSignal?: string | null;
  storyId?: string | null;
  approvedBy?: string | null;
  renderChoice?: string | null;
}

/** The single chokepoint for every status change after creation (AI/human
 *  verdict, approval, render, takedown). Writes the immutable submission_events
 *  row so the audit trail can never drift from the state — mirrors
 *  lib/comments.ts setCommentStatus. Fields merge in JS (not SQL COALESCE) to
 *  bind concrete values and avoid the Postgres untyped-null error. `actor` is
 *  'system' | 'ai' | an admin user id. Phases 2-4 call this; Phase 1 does not. */
export async function setSubmissionStatus(
  id: string,
  toStatus: SubmissionStatus,
  fields: SubmissionStatusFields,
  actor: string,
): Promise<SubmissionRow | null> {
  const current = await getSubmissionById(id);
  if (!current) return null;
  const from = current.status;
  const now = new Date().toISOString();

  const next = {
    category: fields.category ?? current.reject_category,
    reason: fields.reason ?? current.reject_reason,
    source: fields.moderationSource ?? current.moderation_source,
    confidence: fields.moderationConfidence ?? current.moderation_confidence,
    aiSignal: fields.aiSignal ?? current.ai_signal,
    storyId: fields.storyId ?? current.story_id,
    approvedBy: fields.approvedBy ?? current.approved_by,
    renderChoice: fields.renderChoice ?? current.render_choice,
  };
  const approvedAt =
    toStatus === "approved" && from !== "approved" ? now : current.approved_at;

  await run(
    `UPDATE submissions SET
        status = ?, reject_category = ?, reject_reason = ?,
        moderation_source = ?, moderation_confidence = ?, ai_signal = ?, story_id = ?,
        approved_by = ?, approved_at = ?, render_choice = ?, updated_at = ?
      WHERE id = ?`,
    [
      toStatus,
      next.category,
      next.reason,
      next.source,
      next.confidence,
      next.aiSignal,
      next.storyId,
      next.approvedBy,
      approvedAt,
      next.renderChoice,
      now,
      id,
    ],
  );

  await insertEvent(id, actor, from, toStatus, next.category, next.reason, now);
  return getSubmissionById(id);
}
