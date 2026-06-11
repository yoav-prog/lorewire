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
import { getStory, setStoryConfigJson } from "@/lib/repo";
import {
  applyConfigPatch,
  defaultVideoConfig,
  parseVideoConfig,
  type ShortVideoConfig,
} from "@/lib/video-config";
import {
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
}

export async function queueRender(
  storyId: string,
): Promise<QueueRenderResult> {
  const session = await requireAdmin();

  const story = await getStory(storyId);
  if (!story) return { ok: false, error: "story-not-found" };

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
  });

  revalidatePath(`/admin/videos/${storyId}`);
  return { ok: true, render: existing, idempotentHit };
}
