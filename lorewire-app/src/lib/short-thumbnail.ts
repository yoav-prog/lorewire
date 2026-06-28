// Resolve the per-story cover image URL for cross-platform publishing.
//
// Each social publisher (IG, YouTube, TikTok, FB) uses this same helper to
// look up a deterministic cover image so the grid tile / Reels cover / Shorts
// thumbnail is the unique cold-open scene per story, not the brand intro the
// platform's auto-picker would otherwise grab.
//
// Source: `short_config.doodle_frames[0].url` — the first scene staged by
// the renderer, designed by the hook-first prompt to depict the cold-open
// climax. Per _plans/2026-06-28-explicit-thumbnail-uploads.md.
//
// Returns null when:
//   - the story doesn't exist
//   - the story has no `short_config` yet (legacy / pre-shorts)
//   - the `short_config` is malformed
//   - `doodle_frames` is missing or empty
// The publisher reads `null` as "no explicit thumbnail; let the platform
// auto-pick" — never a hard failure.

import "server-only";
import { getStory } from "@/lib/repo";
import { parseShortConfig } from "@/lib/short-config";

export async function resolveShortThumbnailUrl(
  storyId: string,
): Promise<string | null> {
  if (!storyId) return null;
  const story = await getStory(storyId);
  if (!story?.short_config) return null;
  let parsed;
  try {
    parsed = parseShortConfig(JSON.parse(story.short_config));
  } catch {
    return null;
  }
  if (!parsed.ok) return null;
  const url = parsed.config.doodle_frames?.[0]?.url;
  if (typeof url !== "string" || url.length === 0) return null;
  return url;
}
