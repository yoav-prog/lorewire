"use server";

// Public-facing server actions for the main app shell. Keep this surface
// tightly scoped — anything callable from the homepage's client component
// runs unauthenticated, so it MUST only read data that's already public
// (status='published' + non-null published_at + non-null slug).
//
// getLiveStoryMedia exists so the main-page DetailModal can show the
// CURRENT video + scene images instead of the ones baked into
// src/data/published.ts at the last export. The Apply Short to Story
// action updates stories.video_url live in the DB; this fetch picks up
// the new value plus the short's doodle scene images so the article
// surface renders the 9:16 illustrations from the short instead of the
// long-form 16:9 stills.

import { getPublishedStoryBySlug } from "@/lib/stories-public";
import { one } from "@/lib/db";

// The short renderer writes its MP4 to GCS at `<storyId>-short/video.mp4`
// (suffix from pipeline/shorts_render.SHORT_ID_SUFFIX). Anything else is
// the long-form path. We detect the apply by matching this suffix on the
// URL itself so we don't need to round-trip a separate flag column.
const SHORT_VIDEO_PATH_RE = /-short\/video\.mp4(?:[?#].*)?$/;

function isShortVideoUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && SHORT_VIDEO_PATH_RE.test(url);
}

export interface LiveStoryMediaResult {
  ok: boolean;
  video_url: string | null;
  /** Scene images to render in the article body + gallery. When the story's
   *  video is the applied short, these come from short_renders.props
   *  doodle_frames[].url and should be rendered at 9:16. When it's the
   *  long-form video (or no video), this falls back to stories.images
   *  and the caller should render at 16:9. */
  images: string[];
  /** True when video_url points at the applied short (GCS suffix match).
   *  Drives the 9:16 aspect on the article images so the doodle scenes
   *  don't render letter-boxed inside a 16:9 frame. */
  is_short: boolean;
  /** True when the story exists in the DB and is publicly readable.
   *  False when the id doesn't match any published row (e.g. the
   *  catalog still has a legacy sample story that isn't in the DB).
   *  Callers should fall back to the baked URL/images on `found=false`. */
  found: boolean;
}

// Latest done short_renders row for this story, so we can pull doodle_frames
// out of its props when the article should render short-style scenes.
async function latestDoneShortPropsForStory(
  storyId: string,
): Promise<string | null> {
  const row = await one<{ props: string | null }>(
    "SELECT props FROM short_renders WHERE story_id = ? AND status = 'done' " +
      "AND props IS NOT NULL ORDER BY requested_at DESC LIMIT 1",
    [storyId],
  );
  return row?.props ?? null;
}

function parseShortFrameUrls(propsJson: string | null): string[] {
  if (!propsJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(propsJson);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const frames = (parsed as { doodle_frames?: unknown }).doodle_frames;
  if (!Array.isArray(frames)) return [];
  const out: string[] = [];
  for (const f of frames) {
    if (
      f &&
      typeof f === "object" &&
      typeof (f as { url?: unknown }).url === "string"
    ) {
      out.push((f as { url: string }).url);
    }
  }
  return out;
}

function parseStoryImageList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((s): s is string => typeof s === "string");
    }
  } catch {
    /* legacy comma-separated or freeform — give up cleanly */
  }
  return [];
}

// idOrSlug accepts either the stories.id (UUIDs from the pipeline, slug-like
// for legacy seeds) or stories.slug. Static catalog entries usually carry
// `id` matching the DB id, but legacy samples may pre-date the slug
// migration — we try id first, then slug, and return found=false if
// neither matches a published row.
export async function getLiveStoryMedia(
  idOrSlug: string,
): Promise<LiveStoryMediaResult> {
  const empty: LiveStoryMediaResult = {
    ok: true,
    video_url: null,
    images: [],
    is_short: false,
    found: false,
  };
  if (!idOrSlug || typeof idOrSlug !== "string") return empty;

  // Try by id first — handles new pipeline UUIDs and legacy ids ("envelope").
  let row = await one<{
    id: string;
    video_url: string | null;
    images: string | null;
  }>(
    "SELECT id, video_url, images FROM stories " +
      "WHERE id = ? AND status = 'published' AND published_at IS NOT NULL",
    [idOrSlug],
  );
  // Fall back to slug lookup so the action works regardless of which
  // identifier the homepage card has on hand.
  if (!row) {
    const bySlug = await getPublishedStoryBySlug(idOrSlug);
    if (bySlug) {
      row = {
        id: bySlug.id,
        video_url: bySlug.video_url,
        images: bySlug.images,
      };
    }
  }
  if (!row) return empty;

  const isShort = isShortVideoUrl(row.video_url);
  // When the applied video is a short, replace the long-form image list
  // with the short's doodle scene frames so the article reads as the
  // 9:16 doodle visual story instead of mixing styles.
  let images: string[];
  if (isShort) {
    const propsJson = await latestDoneShortPropsForStory(row.id);
    const shortImages = parseShortFrameUrls(propsJson);
    images = shortImages.length > 0 ? shortImages : parseStoryImageList(row.images);
  } else {
    images = parseStoryImageList(row.images);
  }

  return {
    ok: true,
    video_url: row.video_url,
    images,
    is_short: isShort,
    found: true,
  };
}

// Back-compat thin wrapper: the previous WatchDoodle call site only needed
// the URL. Kept so a partial rollout still compiles; new code should use
// getLiveStoryMedia directly.
export interface LiveStoryVideoUrlResult {
  ok: boolean;
  video_url: string | null;
  found: boolean;
}
export async function getLiveStoryVideoUrl(
  idOrSlug: string,
): Promise<LiveStoryVideoUrlResult> {
  const r = await getLiveStoryMedia(idOrSlug);
  return { ok: r.ok, video_url: r.video_url, found: r.found };
}
