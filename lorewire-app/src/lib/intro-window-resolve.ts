// Server half of the Skip Intro feature: figure out where the brand intro
// sits inside an EXISTING story's rendered MP4. Rows rendered after the
// feature shipped carry the window explicitly on props (the dispatcher
// persists intro_start_ms / intro_end_ms at render-finish); everything older
// is derived from the same inputs the splice ran with:
//
//   which intro?   short_config._last_rendered_segments stamp (exact record
//                  of what was spliced) → the live resolver chain
//                  (lib/short-segments for shorts, pickSegmentPure with the
//                  story's aspect for legacy long-form) for pre-stamp rows
//   how long?      video_segments.duration_ms
//   where?         props.hook_end_ms / hook_tail_hold_ms classify the splice
//                  generation; lib/intro-window mirrors the timeline math
//
// Fail-closed everywhere: any missing/ambiguous input → null → the players
// show no button and never auto-seek. Plan: _plans/2026-07-04-skip-intro.md.

import "server-only";
import { assembledDurationMsFromPropsJson } from "@/lib/duration";
import {
  classifySpliceGeneration,
  deriveIntroWindow,
  hookEndMsFromPropsJson,
  hookTailHoldMsFromPropsJson,
  introWindowFromPropsJson,
  type IntroWindow,
} from "@/lib/intro-window";
import { getSegment, getSetting, type SegmentRow } from "@/lib/repo";
import { pickSegmentPure } from "@/lib/segment-resolver";
import { parseShortConfig, type ShortConfig } from "@/lib/short-config";
import { resolveShortSegments } from "@/lib/short-segments";
import { isShortVideoUrl } from "@/lib/short-video-url";
import type { VideoAspect } from "@/lib/aspect";

/** The columns a caller must select for the resolver to work. Matches the
 *  stories table (all already in StoryRow); listPublishedShorts widens its
 *  projection with these server-side and strips them before the client. */
export interface IntroWindowStoryRow {
  id: string;
  video_url: string | null;
  props: string | null;
  short_config: string | null;
  intro_segment_id: string | null;
  outro_segment_id: string | null;
  skip_intro: number | null;
  skip_outro: number | null;
  video_config: string | null;
}

/** Per-batch cache so a wires page resolving 12 rows hits video_segments
 *  once per distinct intro (in practice: once). */
export type SegmentCache = Map<string, Promise<SegmentRow | null>>;

export function createSegmentCache(): SegmentCache {
  return new Map();
}

function getSegmentCached(id: string, cache: SegmentCache): Promise<SegmentRow | null> {
  let hit = cache.get(id);
  if (!hit) {
    hit = getSegment(id);
    cache.set(id, hit);
  }
  return hit;
}

/** Read the dispatcher's render-finish stamp off short_config. Distinguishes
 *  "no stamp" (null — fall through to the live resolver chain) from "stamped
 *  with no intro" (a body-only render — the window is definitively null).
 *  duration.ts has parseLastRenderedSegments, but it collapses an all-null
 *  stamp to null, which would erase exactly that distinction. */
function stampedIntroId(
  shortConfig: string | null,
): { stamped: boolean; introId: string | null } {
  if (!shortConfig) return { stamped: false, introId: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(shortConfig);
  } catch {
    return { stamped: false, introId: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { stamped: false, introId: null };
  }
  const stamp = (parsed as Record<string, unknown>)._last_rendered_segments;
  if (!stamp || typeof stamp !== "object" || Array.isArray(stamp)) {
    return { stamped: false, introId: null };
  }
  const raw = (stamp as Record<string, unknown>).intro_segment_id;
  return {
    stamped: true,
    introId: typeof raw === "string" && raw ? raw : null,
  };
}

/** Which intro segment id was (most plausibly) spliced into this row's
 *  current video. Stamp first (exact), resolver chain second (the active
 *  pointer may have moved since an old render — best available answer). */
async function resolveIntroSegmentId(
  row: IntroWindowStoryRow,
  aspect: VideoAspect,
): Promise<string | null> {
  const stamp = stampedIntroId(row.short_config);
  if (stamp.stamped) return stamp.introId;

  if (isShortVideoUrl(row.video_url)) {
    let config: ShortConfig | null = null;
    if (row.short_config) {
      try {
        const parsed = parseShortConfig(JSON.parse(row.short_config));
        if (parsed.ok) config = parsed.config;
      } catch {
        // malformed column — resolve off the story columns alone
      }
    }
    const resolved = await resolveShortSegments(config, row);
    return resolved.intro.segment?.id ?? null;
  }

  // Legacy long-form video: the story-column chain at the story's own aspect.
  const pick = await pickSegmentPure("intro", row, aspect, getSetting, getSegment);
  return pick.segment?.id ?? null;
}

/** Resolve the intro window for one story row. `aspect` matters only for
 *  legacy long-form videos (shorts are always 9:16); callers that only ever
 *  handle shorts can omit it. */
export async function resolveIntroWindowForStory(
  row: IntroWindowStoryRow,
  opts: { aspect?: VideoAspect; segmentCache?: SegmentCache } = {},
): Promise<IntroWindow | null> {
  try {
    // Rows rendered after the feature shipped carry the exact window.
    const explicit = introWindowFromPropsJson(row.props);
    if (explicit) return explicit;

    const introId = await resolveIntroSegmentId(row, opts.aspect ?? "9:16");
    if (!introId) return null;
    const segment = await getSegmentCached(
      introId,
      opts.segmentCache ?? createSegmentCache(),
    );
    if (!segment) return null;

    const hookEndMs = hookEndMsFromPropsJson(row.props);
    const hookTailHoldMs = hookTailHoldMsFromPropsJson(row.props);
    return deriveIntroWindow({
      generation: classifySpliceGeneration(hookEndMs, hookTailHoldMs),
      hookEndMs,
      hookTailHoldMs,
      introDurationMs: segment.duration_ms,
      assembledDurationMs: assembledDurationMsFromPropsJson(row.props),
    });
  } catch (err) {
    // A resolver hiccup must never take down a public page — no window,
    // no button, and a log line so the miss is diagnosable.
    console.warn("[intro-window] resolve failed", {
      story_id: row.id,
      err: String(err),
    });
    return null;
  }
}

/** Batch resolver for the wires feed: one shared segment cache, one summary
 *  log line per page instead of one per row. */
export async function resolveIntroWindowsForStories(
  rows: IntroWindowStoryRow[],
): Promise<Map<string, IntroWindow | null>> {
  const cache = createSegmentCache();
  const entries = await Promise.all(
    rows.map(async (row) => {
      const window = await resolveIntroWindowForStory(row, {
        segmentCache: cache,
      });
      return [row.id, window] as const;
    }),
  );
  const map = new Map(entries);
  console.info("[intro-window] batch resolved", {
    rows: rows.length,
    with_window: entries.filter(([, w]) => w !== null).length,
  });
  return map;
}
