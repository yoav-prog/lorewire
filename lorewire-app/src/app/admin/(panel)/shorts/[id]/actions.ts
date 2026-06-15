"use server";

// Server actions for the short editor at /admin/(panel)/shorts/[id].
// Phase 1 of _plans/2026-06-16-short-editor-full-parity.md ships:
//   - loadShortEditorState: read+seed the short_config for the page server render
//   - saveShortConfigPatch: apply a dotted-path patch through applyShortConfigPatch
//   - regenShortScene: enqueue an image_renders row (owner_kind='short_scene') for
//     one frame, with the latest prompt + a prev_image snapshot for undo
//   - setFrameIsPinned: explicit toggle (the regen path sets it; this is for
//     the admin's "I'm happy with this image, do not overwrite it" gesture)
//   - revertShortScene: roll a frame's url back to prev_image.url
//
// Every action goes through requireAdmin; every action revalidates the editor
// path so the next paint reads fresh data. Logs are namespaced
// [short editor ...] per rule 14.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/dal";
import {
  getStory,
  getStoryShortConfigJson,
  setStoryShortConfigJson,
} from "@/lib/repo";
import {
  latestShortRenderForStory,
  logShortRenderEvent,
  type ShortRenderRow,
} from "@/lib/short-render-queue";
import { enqueueImageRegen, type ImageRenderRow } from "@/lib/image-render-queue";
import { createHash, randomUUID } from "node:crypto";
import { run, one } from "@/lib/db";
import {
  applyShortConfigPatch,
  defaultShortConfig,
  parseShortConfig,
  type ShortConfig,
} from "@/lib/short-config";
import {
  planShortRender,
  type ShortRenderPlan,
} from "@/lib/short-render-plan";

// ─── shared helpers ──────────────────────────────────────────────────────────

async function loadCurrentConfig(
  storyId: string,
): Promise<{ ok: true; config: ShortConfig } | { ok: false; error: string }> {
  const story = await getStory(storyId);
  if (!story) return { ok: false, error: "story-not-found" };
  const raw = await getStoryShortConfigJson(storyId);
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: "short_config-unparseable-json" };
    }
    const result = parseShortConfig(parsed);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, config: result.config };
  }
  // Cold start — seed from the most recent successful short_render.
  const latest = await latestShortRenderForStory(storyId);
  if (!latest || latest.status !== "done") {
    return { ok: false, error: "no-short-yet" };
  }
  const seeded = defaultShortConfig(
    { id: story.id },
    {
      id: latest.id,
      narration_style: latest.narration_style,
      length_preset: latest.length_preset,
      props: latest.props,
    },
  );
  if (!seeded) return { ok: false, error: "short_renders-props-empty" };
  // Persist the seeded config so future loads skip the parse.
  await setStoryShortConfigJson(storyId, JSON.stringify(seeded));
  // eslint-disable-next-line no-console -- rule 14
  console.info("[short editor seed]", {
    story_id: storyId,
    source_render_id: latest.id,
    frame_count: seeded.doodle_frames.length,
  });
  return { ok: true, config: seeded };
}

// ─── actions ─────────────────────────────────────────────────────────────────

export interface LoadShortEditorResult {
  ok: boolean;
  error?: string;
  config?: ShortConfig;
  latestRender?: ShortRenderRow | null;
}

export async function loadShortEditorState(
  storyId: string,
): Promise<LoadShortEditorResult> {
  await requireAdmin();
  if (!storyId) return { ok: false, error: "missing story_id" };
  const cfg = await loadCurrentConfig(storyId);
  if (!cfg.ok) return { ok: false, error: cfg.error };
  const latestRender = await latestShortRenderForStory(storyId);
  return { ok: true, config: cfg.config, latestRender };
}

export async function saveShortConfigPatch(
  storyId: string,
  patch: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; config?: ShortConfig }> {
  await requireAdmin();
  if (!storyId) return { ok: false, error: "missing story_id" };
  if (!patch || typeof patch !== "object") {
    return { ok: false, error: "patch must be an object" };
  }
  const current = await loadCurrentConfig(storyId);
  if (!current.ok) return { ok: false, error: current.error };
  const patched = applyShortConfigPatch(current.config, patch);
  const validated = parseShortConfig(patched);
  if (!validated.ok) {
    // eslint-disable-next-line no-console -- rule 14
    console.warn("[short editor patch reject]", {
      story_id: storyId,
      error: validated.error,
      patch_paths: Object.keys(patch),
    });
    return { ok: false, error: validated.error };
  }
  await setStoryShortConfigJson(storyId, JSON.stringify(validated.config));
  // eslint-disable-next-line no-console -- rule 14
  console.info("[short editor patch]", {
    story_id: storyId,
    patch_paths: Object.keys(patch),
  });
  revalidatePath(`/admin/shorts/${storyId}`);
  return { ok: true, config: validated.config };
}

export interface RegenSceneResult {
  ok: boolean;
  error?: string;
  render?: ImageRenderRow;
}

export async function regenShortScene(
  storyId: string,
  frameId: string,
  newPrompt: string,
): Promise<RegenSceneResult> {
  const session = await requireAdmin();
  if (!storyId) return { ok: false, error: "missing story_id" };
  if (!frameId) return { ok: false, error: "missing frame_id" };
  const trimmed = (newPrompt ?? "").trim();
  if (!trimmed) {
    return { ok: false, error: "prompt cannot be empty" };
  }

  const current = await loadCurrentConfig(storyId);
  if (!current.ok) return { ok: false, error: current.error };
  const frame = current.config.doodle_frames.find((f) => f.id === frameId);
  if (!frame) return { ok: false, error: "frame_id not found in short_config" };
  if (!current.config.character_base_url) {
    return {
      ok: false,
      error: "short has no character_base_url — needs a full regenerate first",
    };
  }

  // Snapshot the prior frame BEFORE the worker overwrites it — the worker
  // also writes prev_image, but stamping it here means the column reflects
  // the user's intent the moment they click Regen, even if the queue takes
  // a while to drain. The worker overwrites this snapshot with its own
  // (identical-shaped) one on completion; idempotent.
  const prevSnapshot = {
    url: frame.url,
    image_prompt: frame.image_prompt,
    replaced_at: new Date().toISOString(),
  };
  const next = applyShortConfigPatch(current.config, {
    [`doodle_frames.${frameId}.image_prompt`]: trimmed,
  });
  const nextFrames = next.doodle_frames.map((f) =>
    f.id === frameId ? { ...f, prev_image: prevSnapshot } : f,
  );
  const nextConfig: ShortConfig = { ...next, doodle_frames: nextFrames };
  await setStoryShortConfigJson(storyId, JSON.stringify(nextConfig));

  // The Python worker reads image_prompt off the persisted config and
  // calls kie i2i. Hash the prompt so the queue is idempotent within a
  // burst (avoids 10 clicks → 10 paid renders for the same prompt).
  const promptHash = createHash("sha256")
    .update(`${frameId}:${trimmed}`)
    .digest("hex")
    .slice(0, 32);

  const render = await enqueueImageRegen({
    ownerKind: "short_scene",
    ownerId: storyId,
    asset: `frame:${frameId}`,
    promptHash,
    requestedBy: session.userId,
  });

  // eslint-disable-next-line no-console -- rule 14
  console.info("[short editor scene-regen]", {
    story_id: storyId,
    frame_id: frameId,
    prompt_chars: trimmed.length,
    render_id: render.id,
  });
  revalidatePath(`/admin/shorts/${storyId}`);
  return { ok: true, render };
}

export async function setFrameIsPinned(
  storyId: string,
  frameId: string,
  pinned: boolean,
): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const result = await saveShortConfigPatch(storyId, {
    [`doodle_frames.${frameId}.is_pinned`]: pinned,
  });
  if (!result.ok) return { ok: false, error: result.error };
  // eslint-disable-next-line no-console -- rule 14
  console.info("[short editor pin]", {
    story_id: storyId,
    frame_id: frameId,
    pinned,
  });
  return { ok: true };
}

// ─── Lane A render (Phase 2 — captions-only assembly re-render) ─────────────

export async function previewRenderPlan(storyId: string): Promise<{
  ok: boolean;
  error?: string;
  plan?: ShortRenderPlan;
  baselineRenderId?: string;
}> {
  await requireAdmin();
  if (!storyId) return { ok: false, error: "missing story_id" };
  const cfg = await loadCurrentConfig(storyId);
  if (!cfg.ok) return { ok: false, error: cfg.error };
  const baseline = await latestShortRenderForStory(storyId);
  if (!baseline || baseline.status !== "done" || !baseline.props) {
    return {
      ok: false,
      error: "no baseline render to diff against — generate a short first",
    };
  }
  const plan = planShortRender(cfg.config, baseline.props);
  return { ok: true, plan, baselineRenderId: baseline.id };
}

// Bypass the generation drain: a Lane A render reuses everything from the
// baseline's props EXCEPT the captions array. We INSERT a fresh short_renders
// row with status='queued' AND props pre-baked, so the render drain claims
// it directly (filter is `props IS NOT NULL AND status='queued'`).
//
// Caller is the "Render after edits" button in the short editor; the action
// double-checks via planShortRender that Lane A is actually the right call
// (Lane B / C surfaces refuse Lane A so a stale UI can't ship an audio-mismatched
// render).
export async function renderShortLaneA(
  storyId: string,
): Promise<{
  ok: boolean;
  error?: string;
  renderId?: string;
  plan?: ShortRenderPlan;
}> {
  const session = await requireAdmin();
  if (!storyId) return { ok: false, error: "missing story_id" };
  const cfg = await loadCurrentConfig(storyId);
  if (!cfg.ok) return { ok: false, error: cfg.error };
  const baseline = await latestShortRenderForStory(storyId);
  if (!baseline || baseline.status !== "done" || !baseline.props) {
    return { ok: false, error: "no baseline render — generate a short first" };
  }
  const plan = planShortRender(cfg.config, baseline.props);
  if (plan.lane === "noop") {
    return { ok: false, error: "no edits since the last render", plan };
  }
  if (plan.lane !== "A") {
    return {
      ok: false,
      error: `lane ${plan.lane} requires the matching phase (B=3, C=4) — current edits include more than just captions`,
      plan,
    };
  }

  let baselineProps: Record<string, unknown>;
  try {
    const parsed = JSON.parse(baseline.props);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "baseline props is not a JSON object" };
    }
    baselineProps = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: "baseline props is unparseable JSON" };
  }

  // Lane A swap: the renderer needs the new captions; everything else (frames,
  // voiceover_url, character, duration_ms, style) stays exactly as the baseline
  // shipped, because Lane A is "edit captions and re-render the same MP4."
  const newProps = {
    ...baselineProps,
    captions: cfg.config.captions,
  };

  // Distinct config_hash so this row coexists with the baseline (the same
  // story may have multiple "edit and re-render" runs from the same vibe +
  // length pair). Including the lane + a digest of captions keeps it stable
  // across identical re-clicks (idempotent if the user clicks twice without
  // editing in between).
  const captionsDigest = createHash("sha256")
    .update(JSON.stringify(cfg.config.captions))
    .digest("hex")
    .slice(0, 16);
  const configHash = `${baseline.config_hash}:laneA:${captionsDigest}`;

  // Idempotency: if a row with this exact captions-digest already exists in
  // queued / rendering / done status, we surface it instead of inserting a
  // duplicate. Re-clicking the button is a no-op until the captions change.
  const existing = await one<{ id: string; status: string }>(
    "SELECT id, status FROM short_renders WHERE story_id = ? AND config_hash = ?",
    [storyId, configHash],
  );
  if (existing) {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[short editor laneA dupe]", {
      story_id: storyId,
      existing_render_id: existing.id,
      existing_status: existing.status,
    });
    await logShortRenderEvent(existing.id, "idempotent_hit", {
      message: "Lane A render click coalesced with existing row",
      payload: { lane: "A", current_status: existing.status },
    });
    return {
      ok: true,
      renderId: existing.id,
      plan,
    };
  }

  const renderId = randomUUID();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO short_renders
       (id, story_id, config_hash, narration_style, length_preset, status,
        phase, progress, error, output_url, props, requested_by,
        requested_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, 'queued', NULL, 0, NULL, NULL, ?, ?, ?, NULL, NULL)`,
    [
      renderId,
      storyId,
      configHash,
      baseline.narration_style,
      baseline.length_preset,
      JSON.stringify(newProps),
      session.userId,
      now,
    ],
  );
  await logShortRenderEvent(renderId, "queued", {
    message: "Lane A assembly-only re-render queued",
    payload: {
      lane: "A",
      baseline_render_id: baseline.id,
      caption_count: cfg.config.captions.length,
      estimated_cost_cents: plan.estimated_cost_cents,
    },
  });
  // eslint-disable-next-line no-console -- rule 14
  console.info("[short editor laneA queued]", {
    story_id: storyId,
    user_id: session.userId,
    render_id: renderId,
    baseline_render_id: baseline.id,
    caption_count: cfg.config.captions.length,
  });
  revalidatePath(`/admin/shorts/${storyId}`);
  return { ok: true, renderId, plan };
}

export async function revertShortScene(
  storyId: string,
  frameId: string,
): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const current = await loadCurrentConfig(storyId);
  if (!current.ok) return { ok: false, error: current.error };
  const frame = current.config.doodle_frames.find((f) => f.id === frameId);
  if (!frame) return { ok: false, error: "frame_id not found" };
  if (!frame.prev_image) {
    return { ok: false, error: "no prior image to revert to" };
  }
  const restored = {
    ...frame,
    url: frame.prev_image.url,
    image_prompt: frame.prev_image.image_prompt ?? frame.image_prompt,
    // Drop prev_image once consumed — single-step revert by design.
    prev_image: undefined,
  };
  const nextConfig: ShortConfig = {
    ...current.config,
    doodle_frames: current.config.doodle_frames.map((f) =>
      f.id === frameId ? restored : f,
    ),
  };
  await setStoryShortConfigJson(storyId, JSON.stringify(nextConfig));
  // eslint-disable-next-line no-console -- rule 14
  console.info("[short editor revert]", {
    story_id: storyId,
    frame_id: frameId,
  });
  revalidatePath(`/admin/shorts/${storyId}`);
  return { ok: true };
}
