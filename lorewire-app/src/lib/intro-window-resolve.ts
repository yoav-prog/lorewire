// Server half of the Skip Intro feature: figure out where the brand intro
// sits inside an EXISTING story's rendered MP4.
//
// The source of truth is the story's latest DONE `short_renders` row — its
// props blob is the DoodleShort render record (hook_end_ms /
// hook_tail_hold_ms / assembled_duration_ms, and intro_start_ms /
// intro_end_ms once the dispatcher has persisted a window). `stories.props`
// is deliberately NOT read: that column holds the story-world artwork list
// ({url,label,side} dicts — see pipeline/store.py:update_story_props), a
// completely different blob. Reading it was the 2026-07-04 bug where the
// button skipped the HOOK instead of the intro (no hook fields found →
// misclassified as intro-first → window [0, intro duration]).
//
// Resolution per row:
//   which intro?   short_config._last_rendered_segments stamp (exact record
//                  of what was spliced) → the live resolver chain
//                  (lib/short-segments for shorts, pickSegmentPure with the
//                  story's aspect for legacy long-form) for pre-stamp rows
//   how long?      video_segments.duration_ms
//   where?         explicit intro_start_ms/intro_end_ms on the render props,
//                  else derived: the render props' hook fields classify the
//                  splice generation and lib/intro-window mirrors the math
//
// Fail-closed everywhere: a SHORT with no render record can't be classified
// (assuming intro-first would recreate the hook-skipping bug), so it gets no
// window; same for any missing/ambiguous input. Long-form videos predate
// hooks entirely, so they classify as intro-first without a render record.
// Plan: _plans/2026-07-04-skip-intro.md.

import "server-only";
import { isVideoAspect, resolveAspect, type VideoAspect } from "@/lib/aspect";
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
import {
  latestDoneShortRenderForStory,
  latestDoneShortRenderPropsByStory,
} from "@/lib/short-render-queue";
import { resolveShortSegments } from "@/lib/short-segments";
import { isShortVideoUrl } from "@/lib/short-video-url";

/** The story columns the resolver reads. All already on StoryRow;
 *  listPublishedShorts widens its projection with these server-side and
 *  strips them before the client. */
export interface IntroWindowStoryRow {
  id: string;
  video_url: string | null;
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

export interface ResolveIntroWindowOpts {
  /** Aspect for the LEGACY LONG-FORM segment chain only (shorts are always
   *  9:16). Omitted → derived from video_config + the global default, the
   *  same chain the reader page uses. */
  aspect?: VideoAspect;
  /** The story's latest done short_renders.props, when the caller already
   *  has it (the wires batch). `null` means "known to have none";
   *  undefined means "fetch it here". */
  renderPropsJson?: string | null;
  /** Per-batch segment lookup cache. */
  segmentCache?: SegmentCache;
}

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

/** The aspect a LEGACY LONG-FORM row rendered at — per-story
 *  video_config.aspect → global default → legacy 9:16. Mirrors the reader
 *  page's resolveStoryAspect; only consulted when the caller didn't pass
 *  one (shorts never need it). */
async function resolveRowAspect(row: IntroWindowStoryRow): Promise<VideoAspect> {
  let configAspect: VideoAspect | undefined;
  if (row.video_config) {
    try {
      const parsed = JSON.parse(row.video_config);
      if (
        parsed &&
        typeof parsed === "object" &&
        isVideoAspect((parsed as { aspect?: unknown }).aspect)
      ) {
        configAspect = (parsed as { aspect: VideoAspect }).aspect;
      }
    } catch {
      // malformed config column — fall through to the global default
    }
  }
  const globalRaw = await getSetting("video.default_aspect");
  const global = isVideoAspect(globalRaw) ? globalRaw : undefined;
  return resolveAspect(configAspect, global);
}

/** Resolve the intro window for one story row. */
export async function resolveIntroWindowForStory(
  row: IntroWindowStoryRow,
  opts: ResolveIntroWindowOpts = {},
): Promise<IntroWindow | null> {
  try {
    const isShort = isShortVideoUrl(row.video_url);
    const renderProps =
      opts.renderPropsJson !== undefined
        ? opts.renderPropsJson
        : ((await latestDoneShortRenderForStory(row.id))?.props ?? null);

    // Rows rendered after the feature shipped carry the exact window.
    const explicit = introWindowFromPropsJson(renderProps);
    if (explicit) return explicit;

    // A short whose render record is gone can't be classified — assuming
    // intro-first here would skip the HOOK on a hook-first video.
    if (isShort && !renderProps) return null;

    const aspect = isShort
      ? "9:16"
      : (opts.aspect ?? (await resolveRowAspect(row)));
    const introId = await resolveIntroSegmentId(row, aspect);
    if (!introId) return null;
    const segment = await getSegmentCached(
      introId,
      opts.segmentCache ?? createSegmentCache(),
    );
    if (!segment) return null;

    // Long-form predates hooks — its render record isn't in short_renders,
    // and its splice was always [intro][body][outro].
    const hookEndMs = isShort ? hookEndMsFromPropsJson(renderProps) : null;
    const hookTailHoldMs = isShort
      ? hookTailHoldMsFromPropsJson(renderProps)
      : null;
    return deriveIntroWindow({
      generation: classifySpliceGeneration(hookEndMs, hookTailHoldMs),
      hookEndMs,
      hookTailHoldMs,
      introDurationMs: segment.duration_ms,
      assembledDurationMs: assembledDurationMsFromPropsJson(renderProps),
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

/** Batch resolver for the wires feed: one render-props query, one shared
 *  segment cache, one summary log line per page instead of one per row. */
export async function resolveIntroWindowsForStories(
  rows: IntroWindowStoryRow[],
): Promise<Map<string, IntroWindow | null>> {
  const cache = createSegmentCache();
  const renderPropsById = await latestDoneShortRenderPropsByStory(
    rows.map((r) => r.id),
  );
  const entries = await Promise.all(
    rows.map(async (row) => {
      const window = await resolveIntroWindowForStory(row, {
        renderPropsJson: renderPropsById.get(row.id) ?? null,
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
