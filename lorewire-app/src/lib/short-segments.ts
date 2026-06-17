// Per-short resolver for intro/outro segments. Wraps the general
// resolveSegmentsForStory chain (lib/segment-resolver) with a higher-
// precedence "short_config override" tier so the admin can pick a
// different 9:16 intro for THIS short without changing the per-story
// columns the long-form video also uses.
//
// Resolution chain (first match wins):
//   1. short_config.skip_<kind>        -> null (reason: "skip-flag", source: "short_config")
//   2. short_config.<kind>_segment_id  -> that row (reason: "pinned", source: "short_config")
//                                          (aspect filter still applies)
//   3. fall through to resolveSegmentsForStory(story, "9:16")
//      (skip_flag / pinned / master / global-active on the STORY row)
//
// Returns the same SegmentPick shape so the editor + render path can
// stay agnostic about which tier matched — only the new `source` field
// tells them whether it was the per-short override or a story-level
// fallback. Used by:
//   - lib/short-render-segments.ts (route-side wrapper for api/render_short)
//   - admin/(panel)/shorts/[id]/page.tsx (editor status card)

import "server-only";
import {
  pickSegmentPure,
  type SegmentKind,
  type SegmentPick,
  type SegmentResolverStory,
} from "@/lib/segment-resolver";
import { getSetting, getSegment } from "@/lib/repo";
import type { ShortConfig } from "@/lib/short-config";

export type SegmentSource = "short_config" | "story";

export interface ShortSegmentPick extends SegmentPick {
  source: SegmentSource;
}

export interface ResolvedShortSegments {
  intro: ShortSegmentPick;
  outro: ShortSegmentPick;
}

function pickFromShortConfig(
  kind: SegmentKind,
  config: ShortConfig,
): { skip?: true; segmentId?: string } {
  if (kind === "intro") {
    if (config.skip_intro) return { skip: true };
    if (config.intro_segment_id) return { segmentId: config.intro_segment_id };
  } else {
    if (config.skip_outro) return { skip: true };
    if (config.outro_segment_id) return { segmentId: config.outro_segment_id };
  }
  return {};
}

async function pickOne(
  kind: SegmentKind,
  config: ShortConfig | null,
  story: SegmentResolverStory,
): Promise<ShortSegmentPick> {
  if (config) {
    const override = pickFromShortConfig(kind, config);
    if (override.skip) {
      return { segment: null, reason: "skip-flag", source: "short_config" };
    }
    if (override.segmentId) {
      // Reuse pickSegmentPure's aspect-aware acceptance by spoofing a
      // story-like input that pins the override id. The fetchSegment +
      // aspect filter logic stays in one place; we just relabel the
      // source.
      const spoofed: SegmentResolverStory = {
        ...story,
        intro_segment_id: kind === "intro" ? override.segmentId : null,
        outro_segment_id: kind === "outro" ? override.segmentId : null,
        skip_intro: 0,
        skip_outro: 0,
      };
      const pick = await pickSegmentPure(
        kind,
        spoofed,
        "9:16",
        getSetting,
        getSegment,
      );
      return { ...pick, source: "short_config" };
    }
  }
  // No short_config override -> walk the general chain (story columns +
  // global active), but FORCE 9:16. A short is always vertical, so we must
  // NOT let the resolver derive the aspect from the story's long-form
  // video_config: a story whose long-form is 16:9 would otherwise resolve its
  // short's intro/outro against the WIDE active pointer and miss the 9:16 one
  // entirely. Calling pickSegmentPure directly pins the aspect the way the
  // short_config-override path above already does.
  const pick = await pickSegmentPure(kind, story, "9:16", getSetting, getSegment);
  return { ...pick, source: "story" };
}

export async function resolveShortSegments(
  config: ShortConfig | null,
  story: SegmentResolverStory,
): Promise<ResolvedShortSegments> {
  const [intro, outro] = await Promise.all([
    pickOne("intro", config, story),
    pickOne("outro", config, story),
  ]);
  return { intro, outro };
}
