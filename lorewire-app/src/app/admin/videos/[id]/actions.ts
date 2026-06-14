"use server";

// Server actions for /admin/videos/[id]. Edits flow through
// `saveVideoConfigPatch` — a single generic action that takes a partial
// config + the dotted paths the user touched, merges them onto the current
// persisted (or derived) config, stamps each touched path into `_locks`,
// re-validates the result, and persists. Per-field server actions would
// scale badly across the 5 editor tabs; this one action carries every
// future patch shape with no schema-bifurcation risk.
//
// `queueRender` enqueues a render request into video_renders. The Python
// worker (pipeline/render_worker.py) drains the queue. Idempotency on
// (story_id, config_hash) means concurrent admin clicks at the same edit
// state coalesce into one render.
//
// Security (rule 13): requireAdmin() on every entry point, validates the
// patch through parseVideoConfig() so a malformed input can't corrupt the
// column. Lock paths are filtered against the patch keys to keep them in
// sync.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/dal";
import { getSetting, getStory, setStoryConfigJson } from "@/lib/repo";
import {
  applyConfigPatch,
  defaultVideoConfig,
  parseVideoConfig,
  type ShortVideoConfig,
} from "@/lib/video-config";
import {
  countRendersSince,
  enqueueRender,
  forceEnqueueRender,
  hashConfig,
  listVideoRenderEvents,
  logVideoRenderEvent,
  type RenderRow,
  type VideoRenderEventRow,
} from "@/lib/video-render-queue";
import {
  canEnqueueImageRegen,
  enqueueImageRegen,
  type ImageRenderRow,
  latestRenderForAsset,
} from "@/lib/image-render-queue";
import {
  planFrameRegen,
  planFrameRevert,
  type RegenError,
  type RevertError,
} from "@/lib/frame-regen";
import { canQueueFrameRegenForSession } from "@/lib/frame-session-spend";

export interface PatchResult {
  ok: boolean;
  error?: string;
}

export async function saveVideoConfigPatch(
  storyId: string,
  patch: Record<string, unknown>,
  lockPaths: string[],
  unlockPaths: string[] = [],
): Promise<PatchResult> {
  const session = await requireAdmin();

  const story = await getStory(storyId);
  if (!story) return { ok: false, error: "story-not-found" };

  // Resolve the base config: persisted JSON when valid, derived default
  // otherwise. Either way we get a guaranteed-valid ShortVideoConfig to
  // patch against — never a partial shape.
  const base: ShortVideoConfig = resolveBaseConfig(story.video_config) ??
    defaultVideoConfig(story);

  const patched = applyConfigPatch(base, patch, lockPaths, unlockPaths);

  // Final validation: a patch that creates an invalid full config (e.g.
  // clip_end_ms below clip_start_ms) gets rejected before the column is
  // touched. The editor surfaces the error string to the user.
  const validated = parseVideoConfig(patched);
  if (!validated.ok) {
    // eslint-disable-next-line no-console -- rule 14
    console.warn("[video editor patch reject]", {
      story_id: storyId,
      user_id: session.userId,
      error: validated.error,
      patch_keys: Object.keys(patch),
      lock_paths: lockPaths,
    });
    return { ok: false, error: validated.error };
  }

  await setStoryConfigJson(storyId, JSON.stringify(validated.config));

  // eslint-disable-next-line no-console -- rule 14
  console.info("[video editor patch save]", {
    story_id: storyId,
    user_id: session.userId,
    patch_keys: Object.keys(patch),
    lock_paths: lockPaths,
    unlock_paths: unlockPaths,
    locked_total: Object.keys(validated.config._locks ?? {}).length,
  });

  revalidatePath(`/admin/videos/${storyId}`);
  revalidatePath(`/admin/stories/${storyId}`);
  return { ok: true };
}

function resolveBaseConfig(raw: string | null): ShortVideoConfig | null {
  if (!raw) return null;
  try {
    const parsed = parseVideoConfig(JSON.parse(raw));
    return parsed.ok ? parsed.config : null;
  } catch {
    return null;
  }
}

// ─── queueRender ──────────────────────────────────────────────────────────────

export interface QueueRenderResult {
  ok: boolean;
  error?: string;
  render?: RenderRow;
  /** True when the row already existed for this (story, config) pair. */
  idempotentHit?: boolean;
  /** Used-of-cap when an enqueue is rejected on the daily limit. */
  capCount?: number;
  capLimit?: number;
}

// Default daily render cap per story. Overridable via the settings table
// key `video.daily_renders_per_story` so an admin can bump it for a busy
// day. The window is rolling 24h from `now`, not calendar day, so the cap
// can't be reset by clock midnight tricks.
const DEFAULT_DAILY_CAP = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

async function resolveDailyCap(): Promise<number> {
  const raw = await getSetting("video.daily_renders_per_story");
  if (!raw) return DEFAULT_DAILY_CAP;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_CAP;
}

export async function queueRender(
  storyId: string,
  opts: { force?: boolean } = {},
): Promise<QueueRenderResult> {
  const session = await requireAdmin();

  const story = await getStory(storyId);
  if (!story) return { ok: false, error: "story-not-found" };

  // Daily cap check (plan §Render queue). A 24h rolling window of all
  // rows requested for this story — done/error rows count too because
  // they cost worker time. Idempotent hits don't bump the count because
  // they don't create a new row.
  const cap = await resolveDailyCap();
  const sinceIso = new Date(Date.now() - DAY_MS).toISOString();
  const recentCount = await countRendersSince(storyId, sinceIso);
  if (recentCount >= cap) {
    // eslint-disable-next-line no-console -- rule 14
    console.warn("[render queue cap reject]", {
      story_id: storyId,
      user_id: session.userId,
      recent_count: recentCount,
      cap,
    });
    return {
      ok: false,
      error: "daily-cap-exceeded",
      capCount: recentCount,
      capLimit: cap,
    };
  }

  // Hash the *current* persisted config — not the editor's draft. If the
  // user hasn't saved their trim yet, the render will reflect the last
  // saved state. This is intentional: we don't want unsaved edits to
  // silently ship to a render. Save → Render is the contract.
  const base: ShortVideoConfig =
    resolveBaseConfig(story.video_config) ?? defaultVideoConfig(story);
  const configHash = hashConfig(base);

  // Force re-render: produce a fresh row even when an existing
  // (story, config_hash) row would normally be returned. Used when
  // the user wants to retry an in-flight or already-done render
  // without editing the config first.
  const existing = opts.force
    ? await forceEnqueueRender(storyId, configHash, session.userId)
    : await enqueueRender(storyId, configHash, session.userId);
  // `enqueueRender` returns the row regardless — distinguishing first
  // insert from idempotent hit needs a status check. The PERFECT marker
  // would be a returning clause, but since we can't get it portably,
  // use status === 'queued' AND requested_by === this user as a heuristic
  // and let the UI tolerate both as "fine".
  const idempotentHit =
    !opts.force &&
    (existing.status !== "queued" || existing.requested_by !== session.userId);

  // eslint-disable-next-line no-console -- rule 14
  console.info("[render queue enqueue]", {
    story_id: storyId,
    user_id: session.userId,
    config_hash: configHash.slice(0, 12),
    render_id: existing.id,
    idempotent_hit: idempotentHit,
    existing_status: existing.status,
    recent_count: recentCount,
    cap,
    force: Boolean(opts.force),
  });

  revalidatePath(`/admin/videos/${storyId}`);
  return { ok: true, render: existing, idempotentHit };
}

// Server action wrapper for the editor's progress-log panel. Polls the
// timeline every few seconds while the row is in flight. Cheap query
// (one render's events = ~6-30 rows with a render_id-indexed lookup).
export async function listVideoRenderEventsAction(
  renderId: string,
): Promise<VideoRenderEventRow[]> {
  await requireAdmin();
  if (!renderId) return [];
  return listVideoRenderEvents(renderId);
}

// Server action: write one client-side checkpoint into the timeline.
// The RenderControl uses this to record "click_received" the moment a
// user clicks Render — so even when the existing-row idempotency path
// makes the action LOOK like nothing happened, the timeline shows the
// click hit the server and was processed. Diagnostic, not load-bearing.
export async function logVideoRenderEventAction(
  renderId: string,
  event: string,
  message?: string,
): Promise<void> {
  await requireAdmin();
  if (!renderId || !event) return;
  await logVideoRenderEvent(renderId, event, { message });
}

// ─── editSession actions (concurrency banner / heartbeat) ─────────────────────
// Lightweight presence: write { user_id, started_at, heartbeat_at } onto the
// config's _edit_session field on mount and re-stamp heartbeat_at every
// `video.editor.heartbeat_interval_ms`. The page's server render computes
// whether the session is foreign + still fresh; the client just decides what
// banner to show.
//
// `claim` writes a new session (started_at = heartbeat_at = now), used on
// mount and when the take-over button is clicked. `heartbeat` only bumps
// heartbeat_at, keeping started_at stable so audit logs can see when the
// admin first opened the editor. Both round-trip through the config so the
// JSON column stays consistent with what the editor reads.

export interface EditSessionResult {
  ok: boolean;
  error?: string;
}

export async function claimEditSession(
  storyId: string,
): Promise<EditSessionResult> {
  const session = await requireAdmin();
  const story = await getStory(storyId);
  if (!story) return { ok: false, error: "story-not-found" };

  const base: ShortVideoConfig =
    resolveBaseConfig(story.video_config) ?? defaultVideoConfig(story);

  const now = new Date().toISOString();
  const next: ShortVideoConfig = {
    ...base,
    _edit_session: {
      user_id: session.userId,
      started_at: now,
      heartbeat_at: now,
    },
  };

  await setStoryConfigJson(storyId, JSON.stringify(next));
  // eslint-disable-next-line no-console -- rule 14
  console.info("[video editor session claim]", {
    story_id: storyId,
    user_id: session.userId,
  });
  return { ok: true };
}

// ─── Per-frame image regen (Phase 3) ──────────────────────────────────────────
//
// queueFrameImageRegen writes the new prompt + snapshot prev_image into the
// frame, then enqueues an IMAGE_RENDERS row with `asset='frame:<id>'`. The
// pipeline's regen_one() handler (Phase 3 part 2) picks the row up and
// writes the new url back. revertFrameImage flips prev_image back into the
// live fields for free (no model call).
//
// Auth model: requireAdmin + edit-session lock. Only the admin currently
// holding the session can queue regens — prevents two-tab races on the
// same story from double-charging. A stale session falls through as
// "session-stolen" so the editor surfaces the take-over banner.
//
// Soft idempotency: before inserting a new queue row we check the latest
// row for this (story, frame) asset. If it's still queued/generating AND
// its prompt_hash matches the new prompt, we return that row instead of
// creating another one. Catches double-clicks + form retries without
// requiring a new DB column. Full key-based dedup can land in Phase 3.5
// if the soft check proves insufficient.

export type FrameRegenError =
  | "story-not-found"
  | "config-invalid"
  | "session-stolen"
  | "no-session"
  | "budget-exceeded"
  | "session-cap-exceeded"
  | RegenError;

export interface FrameRegenResult {
  ok: boolean;
  error?: FrameRegenError;
  /** Estimated USD cents for this regen — surfaced to the UI for the
   *  "regen will cost ~5¢" inline label. */
  estimateCents?: number;
  /** Session-spend-so-far in cents. Set when error === "session-cap-exceeded"
   *  so the UI can show "you've spent $X of $Y this session". */
  sessionSpentCents?: number;
  /** Session cap in cents. Set when error === "session-cap-exceeded". */
  sessionCapCents?: number;
  /** The queued row. When idempotentHit is true this is the existing
   *  in-flight row rather than a fresh insert. */
  render?: ImageRenderRow;
  idempotentHit?: boolean;
}

export async function queueFrameImageRegen(
  storyId: string,
  frameId: string,
  newPrompt?: string,
): Promise<FrameRegenResult> {
  const session = await requireAdmin();

  const story = await getStory(storyId);
  if (!story) return { ok: false, error: "story-not-found" };

  const base: ShortVideoConfig =
    resolveBaseConfig(story.video_config) ?? defaultVideoConfig(story);

  // Edit-session lock: only the current session owner can queue regens.
  // No session = we never claimed this editor (action invoked from a
  // page that didn't mount the heartbeat) — also reject.
  const sessionOwner = base._edit_session;
  if (!sessionOwner) {
    return { ok: false, error: "no-session" };
  }
  if (sessionOwner.user_id !== session.userId) {
    return { ok: false, error: "session-stolen" };
  }

  // Pre-flight: pure planning. Resolves the prompt, validates it,
  // snapshots prev_image, and returns the next config. No persistence
  // or external calls yet.
  const plan = planFrameRegen({
    base,
    frameId,
    newPrompt,
    now: new Date().toISOString(),
    sceneFallbackPrompt: null, // Phase 3 part 2 wires scene fallback
  });
  if (!plan.ok) return { ok: false, error: plan.error };

  // Daily budget check (mirrors the article-side regen flow). Cap is
  // shared across all image regens through the same setting.
  const asset = `frame:${frameId}`;
  const budget = await canEnqueueImageRegen(asset);
  if (!budget.ok) {
    // eslint-disable-next-line no-console -- rule 14
    console.warn("[video editor regen] budget_exceeded", {
      story_id: storyId,
      frame_id: frameId,
      user_id: session.userId,
      estimate_cents: budget.estimateCents,
      remaining_cents: budget.budget.remainingCents,
    });
    return {
      ok: false,
      error: "budget-exceeded",
      estimateCents: budget.estimateCents,
    };
  }

  // Per-session cap (Phase 4). Hard cap on (story, admin) spend since
  // the current edit-session started. Counts completed regens at their
  // actual cost_cents plus in-flight regens at the current estimate,
  // so the cap stays honest under double-click bursts.
  const sessionCap = await canQueueFrameRegenForSession({
    storyId,
    userId: session.userId,
    sessionStartedAt: sessionOwner.started_at,
  });
  if (!sessionCap.ok) {
    // eslint-disable-next-line no-console -- rule 14
    console.warn("[video editor regen] session_cap_exceeded", {
      story_id: storyId,
      frame_id: frameId,
      user_id: session.userId,
      spent_cents: sessionCap.spentCents,
      cap_cents: sessionCap.capCents,
      estimate_cents: sessionCap.estimateCents,
    });
    return {
      ok: false,
      error: "session-cap-exceeded",
      estimateCents: sessionCap.estimateCents,
      sessionSpentCents: sessionCap.spentCents,
      sessionCapCents: sessionCap.capCents,
    };
  }

  // Final validation of the planned config — defence-in-depth against a
  // future planner bug producing a shape parseVideoConfig would reject.
  const validated = parseVideoConfig(plan.nextConfig);
  if (!validated.ok) return { ok: false, error: "config-invalid" };

  // Persist the prompt + snapshot BEFORE enqueueing. Order matters: if
  // the worker picks up the row between insert and config write, it
  // would read a stale prompt. Writing the config first means the queue
  // row references state that's already on disk.
  await setStoryConfigJson(storyId, JSON.stringify(validated.config));

  // Soft idempotency: an in-flight row with a matching prompt_hash is
  // probably this same click (double-tap, optimistic retry). Reuse it
  // rather than charging twice.
  const inFlight = await latestRenderForAsset("story", storyId, asset);
  if (
    inFlight &&
    (inFlight.status === "queued" || inFlight.status === "generating") &&
    inFlight.prompt_hash === plan.promptHash
  ) {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[video editor regen] idempotent_dedup", {
      story_id: storyId,
      frame_id: frameId,
      user_id: session.userId,
      render_id: inFlight.id,
      status: inFlight.status,
    });
    return {
      ok: true,
      render: inFlight,
      idempotentHit: true,
      estimateCents: budget.estimateCents,
    };
  }

  const render = await enqueueImageRegen({
    ownerKind: "story",
    ownerId: storyId,
    asset,
    promptHash: plan.promptHash,
    requestedBy: session.userId,
  });

  // eslint-disable-next-line no-console -- rule 14
  console.info("[video editor regen] enqueued", {
    story_id: storyId,
    frame_id: frameId,
    frame_index: plan.frameIndex,
    user_id: session.userId,
    render_id: render.id,
    prompt_source: plan.promptSource,
    prompt_hash: plan.promptHash.slice(0, 12),
    estimate_cents: budget.estimateCents,
  });

  revalidatePath(`/admin/videos/${storyId}`);
  return {
    ok: true,
    render,
    idempotentHit: false,
    estimateCents: budget.estimateCents,
  };
}

export type FrameRevertResult = {
  ok: boolean;
  error?:
    | "story-not-found"
    | "config-invalid"
    | "session-stolen"
    | "no-session"
    | RevertError;
  /** The url restored from prev_image — surfaced so the UI can swap the
   *  thumbnail without a refresh. */
  restoredUrl?: string;
};

export async function revertFrameImage(
  storyId: string,
  frameId: string,
): Promise<FrameRevertResult> {
  const session = await requireAdmin();

  const story = await getStory(storyId);
  if (!story) return { ok: false, error: "story-not-found" };

  const base: ShortVideoConfig =
    resolveBaseConfig(story.video_config) ?? defaultVideoConfig(story);

  const sessionOwner = base._edit_session;
  if (!sessionOwner) return { ok: false, error: "no-session" };
  if (sessionOwner.user_id !== session.userId) {
    return { ok: false, error: "session-stolen" };
  }

  const plan = planFrameRevert(base, frameId);
  if (!plan.ok) return { ok: false, error: plan.error };

  const validated = parseVideoConfig(plan.nextConfig);
  if (!validated.ok) return { ok: false, error: "config-invalid" };

  await setStoryConfigJson(storyId, JSON.stringify(validated.config));

  // eslint-disable-next-line no-console -- rule 14
  console.info("[video editor revert] action_invoked", {
    story_id: storyId,
    frame_id: frameId,
    frame_index: plan.frameIndex,
    user_id: session.userId,
    restored_url: plan.restoredUrl,
  });

  revalidatePath(`/admin/videos/${storyId}`);
  return { ok: true, restoredUrl: plan.restoredUrl };
}

export async function heartbeatEditSession(
  storyId: string,
): Promise<EditSessionResult> {
  const session = await requireAdmin();
  const story = await getStory(storyId);
  if (!story) return { ok: false, error: "story-not-found" };

  const base: ShortVideoConfig =
    resolveBaseConfig(story.video_config) ?? defaultVideoConfig(story);

  // Only bump heartbeat if this user owns the session — if a different
  // admin took over, we don't want to silently steal the session back via
  // the heartbeat tick. The banner will surface the foreign session on
  // next page render.
  const current = base._edit_session;
  if (current && current.user_id !== session.userId) {
    return { ok: false, error: "session-stolen" };
  }

  const now = new Date().toISOString();
  const next: ShortVideoConfig = {
    ...base,
    _edit_session: {
      user_id: session.userId,
      started_at: current?.started_at ?? now,
      heartbeat_at: now,
    },
  };

  await setStoryConfigJson(storyId, JSON.stringify(next));
  return { ok: true };
}

