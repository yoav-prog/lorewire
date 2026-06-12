// Pure logic for per-frame image regen and one-step Revert. Phase 3 of
// the video editor overhaul (_plans/2026-06-12-video-editor-overhaul.md).
//
// Two server-action helpers live here:
//   planFrameRegen — given a base config + frame id + (optional) new
//     prompt + fallback scene prompt, validate the prompt, snapshot the
//     pre-regen state into prev_image, write the new prompt into the
//     frame, and return the next config to persist plus the SHA-256
//     prompt hash for IMAGE_RENDERS.prompt_hash.
//   planFrameRevert — given a base config + frame id, restore prev_image
//     onto the live url + image_prompt fields and clear prev_image.
//
// Keeping the validation + mutation + hashing pure means we can unit-
// test every branch without mocking Next's server-only surface. The
// server actions in actions.ts wire these with `requireAdmin`,
// `setStoryConfigJson`, and `enqueueImageRegen` — auth and persistence
// stay in the action layer.

import { createHash } from "node:crypto";
import type { DoodleFrame, ShortVideoConfig } from "@/lib/video-config";

// Security caps (rule 13, plan §Security):
//   - 2000 chars is well above any realistic image prompt and well below
//     what the kie API rejects, but it's also the soft guardrail against
//     a paste-in-a-novel attack burning budget.
//   - control chars beyond tab + newline have no business in a prompt
//     and are the easiest way to smuggle terminal escapes into logs.
export const MAX_PROMPT_LEN = 2000;
// eslint-disable-next-line no-control-regex -- intentional: we're rejecting them
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

// ─── Prompt hash ─────────────────────────────────────────────────────────────

// SHA-256 hex digest. Used both for IMAGE_RENDERS.prompt_hash (so a
// worker can recognise an identical regen) AND for the Phase 3
// soft-idempotency check in the server action (dedup an in-flight row
// with the same frame + prompt).
export function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

// ─── Prompt validation ───────────────────────────────────────────────────────

export type PromptValidationError =
  | "prompt-empty"
  | "prompt-too-long"
  | "prompt-control-chars";

export function validatePrompt(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: PromptValidationError } {
  if (typeof raw !== "string") return { ok: false, error: "prompt-empty" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: "prompt-empty" };
  if (trimmed.length > MAX_PROMPT_LEN) {
    return { ok: false, error: "prompt-too-long" };
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    return { ok: false, error: "prompt-control-chars" };
  }
  return { ok: true, value: trimmed };
}

// ─── Regen planning ──────────────────────────────────────────────────────────

export type RegenError =
  | "frame-not-found"
  | "no-prompt-available"
  | PromptValidationError;

export interface RegenPlan {
  ok: true;
  /** Config to persist BEFORE enqueueing the queue row. */
  nextConfig: ShortVideoConfig;
  /** 0-based index of the frame in doodle_frames. Logged for observability. */
  frameIndex: number;
  /** The prompt that will be used for regen. */
  prompt: string;
  /** Hex sha256 — written to IMAGE_RENDERS.prompt_hash. */
  promptHash: string;
  /** Where the prompt came from. Drives the [regen frame] logs. */
  promptSource: "user" | "existing" | "scene-fallback";
  /** Snapshot of the pre-regen state. Already written into nextConfig's
   *  doodle_frames[i].prev_image; surfaced here for the audit log. */
  snapshottedFrom: { url: string; image_prompt: string };
}

export type RegenResult = RegenPlan | { ok: false; error: RegenError };

export function planFrameRegen(args: {
  base: ShortVideoConfig;
  frameId: string;
  /** When supplied, the user edited the prompt before clicking Regenerate. */
  newPrompt?: string;
  /** ISO-8601 timestamp to stamp into prev_image.replaced_at. Injected so
   *  tests can pin the value. */
  now: string;
  /** The story scene prompt for this frame, when known. Used as the
   *  fallback when the frame has no image_prompt of its own (i.e. legacy
   *  pre-Phase-2 config that hasn't been regenerated since). */
  sceneFallbackPrompt?: string | null;
}): RegenResult {
  const { base, frameId, newPrompt, now, sceneFallbackPrompt } = args;

  const frameIndex = base.doodle_frames.findIndex((f) => f.id === frameId);
  if (frameIndex < 0) return { ok: false, error: "frame-not-found" };
  const frame = base.doodle_frames[frameIndex];

  // Resolve the prompt to use. User-supplied > frame's existing >
  // scene fallback. Whichever wins gets the same validation pass.
  let candidate: string | undefined;
  let promptSource: RegenPlan["promptSource"] = "user";
  if (newPrompt !== undefined) {
    candidate = newPrompt;
    promptSource = "user";
  } else if (frame.image_prompt && frame.image_prompt.length > 0) {
    candidate = frame.image_prompt;
    promptSource = "existing";
  } else if (sceneFallbackPrompt && sceneFallbackPrompt.length > 0) {
    candidate = sceneFallbackPrompt;
    promptSource = "scene-fallback";
  }
  if (candidate === undefined) {
    return { ok: false, error: "no-prompt-available" };
  }

  const validated = validatePrompt(candidate);
  if (!validated.ok) return { ok: false, error: validated.error };
  const prompt = validated.value;

  // Snapshot the pre-regen state into prev_image. We snapshot the
  // *current* url + image_prompt (whatever they were) so a Revert
  // restores exactly what the user saw before clicking Regenerate.
  // Empty existing image_prompt is preserved as empty in the snapshot —
  // restoring an empty prompt means "fall back to scene prompt" next time.
  const snapshottedFrom = {
    url: frame.url,
    image_prompt: frame.image_prompt ?? "",
  };

  const nextFrame: DoodleFrame = {
    ...frame,
    // url stays pointing at the OLD image until the worker writes the new
    // one. The editor's polling loop swaps it on render completion.
    image_prompt: prompt,
    prev_image: {
      url: snapshottedFrom.url,
      image_prompt: snapshottedFrom.image_prompt,
      replaced_at: now,
    },
  };

  const nextConfig: ShortVideoConfig = {
    ...base,
    doodle_frames: base.doodle_frames.map((f, i) =>
      i === frameIndex ? nextFrame : f,
    ),
  };

  return {
    ok: true,
    nextConfig,
    frameIndex,
    prompt,
    promptHash: promptHash(prompt),
    promptSource,
    snapshottedFrom,
  };
}

// ─── Revert planning ─────────────────────────────────────────────────────────

export type RevertError = "frame-not-found" | "no-snapshot";

export interface RevertPlan {
  ok: true;
  nextConfig: ShortVideoConfig;
  frameIndex: number;
  restoredUrl: string;
  restoredPrompt: string;
}

export type RevertResult = RevertPlan | { ok: false; error: RevertError };

export function planFrameRevert(
  base: ShortVideoConfig,
  frameId: string,
): RevertResult {
  const frameIndex = base.doodle_frames.findIndex((f) => f.id === frameId);
  if (frameIndex < 0) return { ok: false, error: "frame-not-found" };
  const frame = base.doodle_frames[frameIndex];
  const snapshot = frame.prev_image;
  if (!snapshot) return { ok: false, error: "no-snapshot" };

  // Restore url + image_prompt; clear prev_image so a second Revert
  // (without an intervening Regenerate) returns no-snapshot rather than
  // silently no-oping. Single-step history is deliberate (plan §Phase 2:
  // deeper history is out of scope for v1).
  const nextFrame: DoodleFrame = {
    ...frame,
    url: snapshot.url,
    image_prompt:
      snapshot.image_prompt.length > 0 ? snapshot.image_prompt : undefined,
    prev_image: undefined,
  };
  // Manually drop the undefined keys so the persisted JSON stays minimal.
  if (nextFrame.image_prompt === undefined) delete nextFrame.image_prompt;
  delete nextFrame.prev_image;

  const nextConfig: ShortVideoConfig = {
    ...base,
    doodle_frames: base.doodle_frames.map((f, i) =>
      i === frameIndex ? nextFrame : f,
    ),
  };

  return {
    ok: true,
    nextConfig,
    frameIndex,
    restoredUrl: snapshot.url,
    restoredPrompt: snapshot.image_prompt,
  };
}
