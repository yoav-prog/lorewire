// Pipeline-side mirror: resolves the scene count the pipeline WILL ask
// for when generating or regenerating scene images for a story. Matches
// `pipeline/media.py:_resolve_scene_count` so the admin's cost estimates
// quote the same number the backend will burn. Anything that drifts
// here vs. there means the budget gate trips at the wrong time.
//
// Keep the constants + the formula in sync with pipeline/media.py. The
// parity is enforced by hand for now — small surface, two callers.

import "server-only";
import { getSetting } from "@/lib/repo";

export const SCENE_COUNT_MIN = 6;
export const SCENE_COUNT_MAX = 60;
export const SCENE_COUNT_DEFAULT = 30;
export const SCENE_TARGET_SECONDS_PER_SCENE_DEFAULT = 5;
export const SCENE_TARGET_SECONDS_PER_SCENE_MIN = 1;
export const SCENE_TARGET_SECONDS_PER_SCENE_MAX = 30;

/** Parse a `M:SS` or `H:MM:SS` duration string. Returns null on missing
 *  / malformed input so the caller can fall through to a coarser
 *  estimate (word count). */
export function parseDurationToSeconds(
  duration: string | null | undefined,
): number | null {
  if (!duration) return null;
  const parts = duration.trim().split(":");
  if (parts.length === 0) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = Number.parseInt(p, 10);
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  return null;
}

/** Pick the best duration estimate: parsed duration string > word
 *  count at ~150 wpm > 0 (unknown). */
export function estimateDurationSeconds(
  body: string | null | undefined,
  duration: string | null | undefined,
): number {
  const parsed = parseDurationToSeconds(duration);
  if (parsed && parsed > 0) return parsed;
  if (body) {
    const words = body.trim().split(/\s+/).filter(Boolean).length;
    if (words > 0) return words / 2.5;
  }
  return 0;
}

function clampSceneCount(n: number): number {
  return Math.max(
    SCENE_COUNT_MIN,
    Math.min(SCENE_COUNT_MAX, Math.round(n)),
  );
}

function clampTargetSeconds(n: number): number {
  return Math.max(
    SCENE_TARGET_SECONDS_PER_SCENE_MIN,
    Math.min(SCENE_TARGET_SECONDS_PER_SCENE_MAX, n),
  );
}

export type SceneCountMode = "auto" | "manual";

/** Read the admin's mode setting; defaults to "auto". */
export async function readSceneCountMode(): Promise<SceneCountMode> {
  const raw = ((await getSetting("media.scene_count_mode")) ?? "")
    .trim()
    .toLowerCase();
  return raw === "manual" ? "manual" : "auto";
}

/** Read the admin's per-scene target setting, clamped to safe range. */
export async function readSceneTargetSecondsPerScene(): Promise<number> {
  const raw = await getSetting("media.scene_count_target_seconds_per_scene");
  if (raw === null) return SCENE_TARGET_SECONDS_PER_SCENE_DEFAULT;
  const v = Number.parseFloat(raw);
  if (!Number.isFinite(v)) return SCENE_TARGET_SECONDS_PER_SCENE_DEFAULT;
  return clampTargetSeconds(v);
}

/** Resolve the scene count for a given story. Mirrors pipeline media.py's
 *  precedence chain:
 *    1. mode=manual + media.scene_count setting
 *    2. mode=auto + duration / target (auto formula)
 *    3. fall back to SCENE_COUNT_DEFAULT when duration is unknown
 *  Both branches clamp to [SCENE_COUNT_MIN, SCENE_COUNT_MAX]. */
export async function resolveSceneCount(opts: {
  body: string | null | undefined;
  duration: string | null | undefined;
}): Promise<number> {
  const mode = await readSceneCountMode();
  if (mode === "manual") {
    const raw = await getSetting("media.scene_count");
    if (raw) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) return clampSceneCount(n);
    }
    return SCENE_COUNT_DEFAULT;
  }
  const target = await readSceneTargetSecondsPerScene();
  const durationS = estimateDurationSeconds(opts.body, opts.duration);
  if (durationS <= 0) return SCENE_COUNT_DEFAULT;
  return clampSceneCount(Math.round(durationS / target));
}
