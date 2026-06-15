// TS mirror of pipeline/segments.py:pick_segment. Resolves which intro or
// outro segment will splice on render for a given story so the video editor's
// Remotion preview can play the same clips inline.
//
// Resolution chain (first match wins, parity with the Python resolver):
//   1. `story.skip_<kind>` truthy                    -> null  (hard opt-out)
//   2. `story.<kind>_segment_id` pinned              -> that row (pinning is
//      strong — wins even when the row is soft-disabled; only the aspect
//      filter at the bottom can still drop it)
//   3. `video.intro_outro_enabled` explicitly off    -> null
//   4. `video.active_<kind>_id_<aspect>` row + enabled -> that row
//   5. otherwise                                     -> null
//
// Per-aspect active (Phase of 2026-06-15-intro-outro-per-aspect-active.md): the
// global active pointer is keyed by the STORY's aspect, so a 9:16 and a 16:9
// segment can both be live and each render reads its own slot. The aspect
// filter below still runs — it's redundant for this global path (the slot is
// keyed by aspect) but load-bearing for the pinned path (an admin can pin a
// wrong-aspect segment) and for a slot left stale by a worker re-probe.
//
// Aspect filter (Phase 3 of 2026-06-12-video-aspect-ratio.md): the picked
// segment's `aspect` must match the story's resolved aspect, or it's dropped
// with a reason so the editor surfaces "intro skipped — wrong aspect" instead
// of silently letterboxing.
//
// Stays pure: callers inject `getSetting` + `fetchSegment` so tests can stub.

import "server-only";
import {
  LEGACY_DEFAULT_ASPECT,
  activeSegmentSettingKey,
  isVideoAspect,
  resolveAspect,
  type VideoAspect,
} from "@/lib/aspect";
import type { SegmentRow } from "@/lib/repo";

export type SegmentKind = "intro" | "outro";

/** A subset of `StoryRow` the resolver actually reads. Kept narrow so the
 *  resolver can be unit-tested without minting a full StoryRow each time. */
export interface SegmentResolverStory {
  intro_segment_id?: string | null;
  outro_segment_id?: string | null;
  skip_intro?: number | null;
  skip_outro?: number | null;
  /** Serialized ShortVideoConfig JSON — we only read .aspect off it. */
  video_config?: string | null;
}

/** Why the resolver returned what it did. Logged + surfaced in the editor
 *  so an admin sees "intro skipped: aspect-mismatch" instead of guessing. */
export type SegmentPickReason =
  | "skip-flag"
  | "pinned"
  | "pinned-missing"
  | "master-disabled"
  | "global-active"
  | "global-active-missing"
  | "no-default"
  | "aspect-mismatch";

export interface SegmentPick {
  segment: SegmentRow | null;
  reason: SegmentPickReason;
}

type GetSettingFn = (key: string) => Promise<string | null>;
type FetchSegmentFn = (id: string) => Promise<SegmentRow | null>;

/**
 * Pure resolver. Does NOT touch the data layer directly — the caller
 * passes in `getSetting` + `fetchSegment`. The route-level helpers below
 * wire in the repo functions.
 */
export async function pickSegmentPure(
  kind: SegmentKind,
  story: SegmentResolverStory,
  storyAspect: VideoAspect,
  getSetting: GetSettingFn,
  fetchSegment: FetchSegmentFn,
): Promise<SegmentPick> {
  // 1. Hard skip per story.
  const skipFlag =
    kind === "intro" ? story.skip_intro : story.skip_outro;
  if (skipFlag) return { segment: null, reason: "skip-flag" };

  // 2. Per-story pinned id. Pinning is strong: returned even if soft-
  //    disabled. The aspect filter below can still drop it.
  const pinnedId =
    kind === "intro" ? story.intro_segment_id : story.outro_segment_id;
  if (pinnedId) {
    const seg = await fetchSegment(pinnedId);
    if (!seg) return { segment: null, reason: "pinned-missing" };
    return acceptIfAspectMatches(seg, storyAspect, "pinned");
  }

  // 3. Master switch. Defaults to ON when unset; only an explicit
  //    "off" / "0" / "false" disables.
  const masterRaw = (await getSetting("video.intro_outro_enabled")) ?? "";
  if (isExplicitlyOff(masterRaw))
    return { segment: null, reason: "master-disabled" };

  // 4. Global active id for this story's aspect. Each aspect has its own
  //    pointer (2026-06-15) so a wide and a tall segment can both be live.
  const activeId = (
    (await getSetting(activeSegmentSettingKey(kind, storyAspect))) ?? ""
  ).trim();
  if (!activeId) return { segment: null, reason: "no-default" };
  const seg = await fetchSegment(activeId);
  if (!seg || !seg.enabled)
    return { segment: null, reason: "global-active-missing" };
  return acceptIfAspectMatches(seg, storyAspect, "global-active");
}

function acceptIfAspectMatches(
  seg: SegmentRow,
  storyAspect: VideoAspect,
  source: "pinned" | "global-active",
): SegmentPick {
  // A segment with no aspect column is treated as 9:16 — same fallback the
  // Python resolver uses for rows that predate the column.
  const segAspect: VideoAspect = isVideoAspect(seg.aspect)
    ? seg.aspect
    : LEGACY_DEFAULT_ASPECT;
  if (segAspect === storyAspect) {
    return {
      segment: seg,
      reason: source === "pinned" ? "pinned" : "global-active",
    };
  }
  return { segment: null, reason: "aspect-mismatch" };
}

function isExplicitlyOff(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

// ─── Convenience: resolve both intro AND outro at once for a story ─────────

import { getSetting } from "@/lib/repo";
import { getSegment } from "@/lib/repo";

export interface ResolvedSegments {
  intro: SegmentPick;
  outro: SegmentPick;
}

/**
 * Resolve both intro and outro for one story, walking the same chain the
 * Python renderer walks. `globalDefaultAspect` is the
 * `video.default_aspect` setting (or LEGACY_DEFAULT_ASPECT when unset) —
 * caller fetches it once and passes it in to avoid two extra DB reads
 * per editor render.
 */
export async function resolveSegmentsForStory(
  story: SegmentResolverStory,
  globalDefaultAspect: VideoAspect,
): Promise<ResolvedSegments> {
  const storyAspect = extractStoryAspect(story, globalDefaultAspect);
  const [intro, outro] = await Promise.all([
    pickSegmentPure("intro", story, storyAspect, getSetting, getSegment),
    pickSegmentPure("outro", story, storyAspect, getSetting, getSegment),
  ]);
  return { intro, outro };
}

function extractStoryAspect(
  story: SegmentResolverStory,
  globalDefault: VideoAspect,
): VideoAspect {
  if (!story.video_config) return resolveAspect(undefined, globalDefault);
  try {
    const parsed = JSON.parse(story.video_config);
    if (parsed && typeof parsed === "object") {
      const candidate = (parsed as { aspect?: unknown }).aspect;
      if (isVideoAspect(candidate))
        return resolveAspect(candidate, globalDefault);
    }
  } catch {
    // Falls through to the global default; the editor's other parsers
    // handle malformed video_config separately.
  }
  return resolveAspect(undefined, globalDefault);
}
