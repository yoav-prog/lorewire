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
  hashConfig,
  type RenderRow,
} from "@/lib/video-render-queue";

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

  const existing = await enqueueRender(storyId, configHash, session.userId);
  // `enqueueRender` returns the row regardless — distinguishing first
  // insert from idempotent hit needs a status check. The PERFECT marker
  // would be a returning clause, but since we can't get it portably,
  // use status === 'queued' AND requested_by === this user as a heuristic
  // and let the UI tolerate both as "fine".
  const idempotentHit =
    existing.status !== "queued" || existing.requested_by !== session.userId;

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
  });

  revalidatePath(`/admin/videos/${storyId}`);
  return { ok: true, render: existing, idempotentHit };
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

