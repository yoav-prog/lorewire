// Client-safe types + pure helpers for the live runs view. This module
// deliberately does NOT import "server-only" or @/lib/db, because the
// LiveRunsClient + LiveJobCard "use client" modules need ActiveJobView
// and the isJobActive / isJobFinished predicates at import time.
// Turbopack pulls every transitive import into the client bundle, so a
// single `import "server-only"` here would drag the postgres driver
// (which references fs/net/tls/perf_hooks) into the browser and fail
// the build — exactly what tripped the first preview deploy on
// 2026-06-28.
//
// The server-only DB function listActiveJobsWithEvents lives in
// ./story-jobs-live.ts, which re-exports everything below so existing
// server callers keep their single import site.

export const MAX_ACTIVE_JOBS = 50;
export const MAX_EVENTS_PER_JOB = 50;
export const FINISHED_GRACE_MS = 15 * 60 * 1000;

export const ACTIVE_STATUSES = ["queued", "processing"] as const;
export const FINISHED_STATUSES = ["done", "error", "cancelled"] as const;

export interface ActiveJobEvent {
  id: string;
  ts: string;
  level: "info" | "warn" | "error";
  event: string;
  message: string | null;
  /** JSON-encoded structured payload. Client parses + displays inline. */
  payload: string | null;
}

export interface ActiveJobView {
  job_id: string;
  reddit_id: string;
  /** Job status as written by the worker / cancel path. May include
   *  'cancelled' even though StoryJobStatus in story-jobs.ts narrows
   *  finished states to done/error — we surface the raw column so the
   *  card can render a 'Stopped' chip honestly. */
  status: string;
  progress: number | null;
  error: string | null;
  story_id: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** From reddit_source. NULL when the source row was deleted between
   *  enqueue and now (defensive; should not happen). */
  title: string | null;
  subreddit: string | null;
  /** Per-row pipeline columns the multi-stage view depends on. All
   *  already present on story_jobs (no schema work in PR #138). */
  with_media: number | null;
  full_pipeline: number | null;
  finisher_status: string | null;
  auto_publish_status: string | null;
  /** Latest short_renders row for this job's story_id. NULL when
   *  story_id is NULL (story stage didn't reach 'story_persisted') or
   *  no short was ever enqueued (e.g. with_media=0). */
  short: ActiveJobShortView | null;
  /** Per-stage pipeline state. Computed from the raw columns above by
   *  computePipelineState; the array length is 4 (story / short / hero
   *  / publish) and order is stable. The publish stage is always
   *  present in the array — the UI hides it when state='skipped' so
   *  that "no full_pipeline opt-in" jobs don't add a fourth pill that
   *  reads `SKIPPED`. */
  stages: PipelineStage[];
  /** One-word summary of where the pipeline as a whole is. Drives the
   *  card's headline chip and the dashboard counters. */
  overall: PipelineOverallState;
  /** ISO timestamp of the LAST stage settlement (or null if any stage
   *  is still in flight). Used by the server query to decide whether
   *  the job falls inside the finished-grace window. */
  last_settled_at: string | null;
  /** Latest MAX_EVENTS_PER_JOB events, oldest-first. */
  events: ActiveJobEvent[];
}

/** Subset of short_renders columns the live view cares about. */
export interface ActiveJobShortView {
  id: string;
  status: string;
  phase: string | null;
  progress: number | null;
  error: string | null;
  output_url: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** Discrete pipeline stages a reddit-source job moves through. Order
 *  matches the worker → cron → cron handoff sequence and is the order
 *  the UI renders pills in. */
export type PipelineStageId = "story" | "short" | "hero" | "publish";

/** Per-stage state.
 *  - pending:  the stage hasn't started yet but will (e.g. SHORT before
 *              the article persists)
 *  - running:  the stage is mid-flight
 *  - done:     terminal success
 *  - failed:   terminal failure (story=error, short=error, finisher=failed,
 *              auto_publish=failed)
 *  - skipped:  the stage doesn't apply (e.g. SHORT/HERO when with_media=0,
 *              PUBLISH when full_pipeline=0)
 *  - cancelled: only used for STORY when the admin hit Stop; everything
 *              downstream short-circuits to skipped because the article
 *              was discarded.
 */
export type PipelineStageState =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "cancelled";

export interface PipelineStage {
  id: PipelineStageId;
  state: PipelineStageState;
  /** Short human label shown on the pill and in the headline chip when
   *  this is the active stage (e.g. "Short", "Hero & thumb"). */
  label: string;
  /** Optional sub-label used by the headline chip to say WHAT is
   *  happening inside the stage (e.g. short phase='generating'). */
  sub_label?: string;
}

/** Overall pipeline summary.
 *  - queued:    story stage is queued and nothing further has started
 *  - running:   ANY stage is pending or running
 *  - done:      every applicable stage is done
 *  - failed:    ANY applicable stage has failed
 *  - cancelled: story stage was cancelled
 */
export type PipelineOverallState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export interface ListActiveJobsOpts {
  /** Override the wall clock for deterministic tests. */
  now?: Date;
  /** Override the grace window for tests. */
  graceMs?: number;
}

/**
 * Returns true if ANY pipeline stage is still in flight (pending or
 * running). Replaces the old single-stage check that only looked at
 * story_jobs.status — a job whose story stage is done but whose short
 * is still rendering is still in flight.
 */
export function isJobActive(view: ActiveJobView): boolean {
  return view.overall === "queued" || view.overall === "running";
}

/**
 * Returns true if every applicable stage is terminal. Mirrors the
 * server query's grace-window branch; used by the ?finished=hide URL
 * toggle to drop settled cards from the rendered list.
 */
export function isJobFinished(view: ActiveJobView): boolean {
  return (
    view.overall === "done" ||
    view.overall === "failed" ||
    view.overall === "cancelled"
  );
}

/**
 * Normalises the raw `level` column from story_job_events to the
 * documented enum. Anything unrecognised falls back to 'info' so the
 * client never has to defend against unknown levels — the worker
 * could decide to write 'debug' tomorrow and the UI wouldn't crash.
 *
 * Exported because listActiveJobsWithEvents applies it on the server
 * before handing rows to the client.
 */
export function normalizeEventLevel(raw: string): "info" | "warn" | "error" {
  if (raw === "warn" || raw === "error") return raw;
  return "info";
}

// ---------- pipeline stage computation ----------
// Pure functions, no IO. The server passes joined columns in; the UI
// reads the computed `stages` + `overall` out. Same function on both
// sides guarantees the dashboard and the (future) story editor agree
// on "what state is this pipeline in."

/** Input to computePipelineState. Mirrors the columns the server
 *  query selects; flat shape so tests can construct it without a real
 *  ActiveJobView. */
export interface PipelineStateInput {
  story_status: string;
  with_media: number | null;
  full_pipeline: number | null;
  finisher_status: string | null;
  auto_publish_status: string | null;
  short: {
    status: string;
    phase: string | null;
  } | null;
}

const STORY_RUNNING = new Set(["queued", "processing"]);
const STORY_DONE = "done";
const STORY_ERROR = "error";
const STORY_CANCELLED = "cancelled";

const SHORT_RUNNING = new Set(["queued", "generating", "rendering"]);
const SHORT_DONE = "done";
const SHORT_ERROR = new Set(["error", "cancelled"]);

/**
 * Derive the per-stage pipeline state from the raw row. The output
 * is always a 4-element array in [story, short, hero, publish] order
 * so the UI can render pills positionally without lookups.
 */
export function computePipelineState(
  input: PipelineStateInput,
): PipelineStage[] {
  const story = computeStoryStage(input);
  const short = computeShortStage(input, story.state);
  const hero = computeHeroStage(input, story.state, short.state);
  const publish = computePublishStage(input, story.state, hero.state);
  return [story, short, hero, publish];
}

function computeStoryStage(input: PipelineStateInput): PipelineStage {
  const s = input.story_status;
  if (s === STORY_DONE) {
    return { id: "story", state: "done", label: "Story" };
  }
  if (s === STORY_ERROR) {
    return { id: "story", state: "failed", label: "Story" };
  }
  if (s === STORY_CANCELLED) {
    return { id: "story", state: "cancelled", label: "Story" };
  }
  if (s === "processing") {
    return { id: "story", state: "running", label: "Story" };
  }
  if (s === "queued" || STORY_RUNNING.has(s)) {
    return { id: "story", state: "pending", label: "Story" };
  }
  // Unknown story status — defensive default. Treat as pending so the
  // card doesn't claim "done" for an unrecognised state.
  return { id: "story", state: "pending", label: "Story" };
}

function computeShortStage(
  input: PipelineStateInput,
  storyState: PipelineStageState,
): PipelineStage {
  // with_media=0 means the admin opted out of the visual pipeline;
  // SHORT and HERO are intentionally skipped.
  if (input.with_media === 0) {
    return { id: "short", state: "skipped", label: "Short" };
  }
  // Story cancelled → nothing was enqueued → skipped.
  if (storyState === "cancelled" || storyState === "failed") {
    return { id: "short", state: "skipped", label: "Short" };
  }
  // Story still in flight → short hasn't been enqueued yet.
  if (storyState === "pending" || storyState === "running") {
    return { id: "short", state: "pending", label: "Short" };
  }
  // Story done. The short row either exists or doesn't yet (the worker
  // enqueues it at the tail end of finish_story_job; there's a small
  // window where story.status='done' but short hasn't been written).
  const short = input.short;
  if (!short) {
    return { id: "short", state: "pending", label: "Short" };
  }
  if (short.status === SHORT_DONE) {
    return { id: "short", state: "done", label: "Short" };
  }
  if (SHORT_ERROR.has(short.status)) {
    return {
      id: "short",
      state: "failed",
      label: "Short",
      sub_label: short.status,
    };
  }
  if (SHORT_RUNNING.has(short.status)) {
    return {
      id: "short",
      state: "running",
      label: "Short",
      sub_label: short.phase ?? short.status,
    };
  }
  // Unknown short status — treat as pending defensively.
  return { id: "short", state: "pending", label: "Short" };
}

function computeHeroStage(
  input: PipelineStateInput,
  storyState: PipelineStageState,
  shortState: PipelineStageState,
): PipelineStage {
  // Hero finisher is i2i over the short's scenes. Without a short
  // there's nothing to finish.
  if (shortState === "skipped") {
    return { id: "hero", state: "skipped", label: "Hero & thumb" };
  }
  if (storyState === "cancelled" || storyState === "failed") {
    return { id: "hero", state: "skipped", label: "Hero & thumb" };
  }
  // Short still in flight or pending → hero pending.
  if (shortState === "pending" || shortState === "running") {
    return { id: "hero", state: "pending", label: "Hero & thumb" };
  }
  if (shortState === "failed") {
    return { id: "hero", state: "skipped", label: "Hero & thumb" };
  }
  // Short done. Now drive off finisher_status.
  const f = input.finisher_status;
  if (f === "done") {
    return { id: "hero", state: "done", label: "Hero & thumb" };
  }
  if (f === "failed") {
    return { id: "hero", state: "failed", label: "Hero & thumb" };
  }
  if (f === "running") {
    return { id: "hero", state: "running", label: "Hero & thumb" };
  }
  // 'pending' or NULL → finisher cron hasn't claimed yet.
  return { id: "hero", state: "pending", label: "Hero & thumb" };
}

function computePublishStage(
  input: PipelineStateInput,
  storyState: PipelineStageState,
  heroState: PipelineStageState,
): PipelineStage {
  if (input.full_pipeline !== 1) {
    return { id: "publish", state: "skipped", label: "Publish" };
  }
  if (storyState === "cancelled" || storyState === "failed") {
    return { id: "publish", state: "skipped", label: "Publish" };
  }
  // Auto-publish only fires after the hero finisher succeeds (the
  // finisher is the writer of auto_publish_status='pending'). If hero
  // isn't done yet, publish is upstream-pending.
  if (heroState === "skipped") {
    return { id: "publish", state: "skipped", label: "Publish" };
  }
  if (heroState !== "done") {
    return { id: "publish", state: "pending", label: "Publish" };
  }
  const a = input.auto_publish_status;
  if (a === "done") {
    return { id: "publish", state: "done", label: "Publish" };
  }
  if (a === "failed") {
    return { id: "publish", state: "failed", label: "Publish" };
  }
  if (a === "pending") {
    return { id: "publish", state: "running", label: "Publish" };
  }
  // NULL — cron hasn't been signalled yet (transient between hero done
  // and finisher writing 'pending'). Treat as pending.
  return { id: "publish", state: "pending", label: "Publish" };
}

/**
 * One-word summary of where the whole pipeline is. Drives the card's
 * headline chip and the counters at the top of the page.
 *
 * Order of precedence:
 *   1. cancelled → story stage cancelled
 *   2. failed    → any applicable stage failed
 *   3. running   → any stage running
 *   4. queued    → story stage pending and nothing further started
 *   5. done      → every applicable stage settled green
 */
export function computeOverallState(
  stages: PipelineStage[],
): PipelineOverallState {
  const story = stages.find((s) => s.id === "story");
  if (story?.state === "cancelled") return "cancelled";
  if (stages.some((s) => s.state === "failed")) return "failed";
  if (stages.some((s) => s.state === "running")) return "running";
  // No running, no failed. If the story stage is still pending (not
  // even claimed), the whole pipeline is queued. If pending exists
  // anywhere downstream of a started story, it's still running (we
  // already know nothing's actively running, so this is the
  // "between-stages" lull — surface it as running, not queued, so the
  // admin knows movement is expected soon).
  if (story?.state === "pending") return "queued";
  if (stages.some((s) => s.state === "pending")) return "running";
  return "done";
}

/**
 * True when any stage is pending or running. Drives the
 * server-side WHERE clause (via the same predicate applied per row)
 * and the client-side `?finished=hide` filter.
 */
export function isPipelineInFlight(stages: PipelineStage[]): boolean {
  return stages.some(
    (s) => s.state === "pending" || s.state === "running",
  );
}

/**
 * Latest terminal timestamp across the stages with persisted
 * timestamps. Returns NULL when any stage is still in flight (the
 * caller should treat that as "still active"). Used by the server
 * query to apply the 15-minute grace window to the WHOLE pipeline,
 * not just the story stage.
 *
 * We anchor to story_jobs.finished_at + short_renders.finished_at only,
 * because the hero/publish stages don't have their own finished_at
 * columns — and the 15-minute grace is loose enough that approximating
 * by the upstream stage's timestamp loses at most ~2 minutes of card
 * dwell time. Treating finished_at as the anchor keeps the formula
 * portable across drivers (no event-table scan in the WHERE clause).
 */
export function computeLastSettledAt(input: {
  stages: PipelineStage[];
  storyJobFinishedAt: string | null;
  shortFinishedAt: string | null;
}): string | null {
  if (isPipelineInFlight(input.stages)) return null;
  const candidates: (string | null)[] = [
    input.storyJobFinishedAt,
    input.shortFinishedAt,
  ];
  let latest: string | null = null;
  for (const c of candidates) {
    if (c == null) continue;
    if (latest == null || c > latest) latest = c;
  }
  return latest;
}
