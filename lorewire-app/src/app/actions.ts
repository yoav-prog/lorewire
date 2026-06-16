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
import { all, one } from "@/lib/db";
import { getSetting } from "@/lib/repo";
import {
  HOMEPAGE_SURFACES,
  listAllCuration,
  type HomepageSurface,
} from "@/lib/homepage-curation";

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
  /** Narration audio for the read-along surface. When the applied video is
   *  the short, this comes from short_renders.props.voiceover_url so the
   *  read-along plays the same voice the Watch tab plays. Null falls the
   *  read-along back to stories.audio_url (the long-form narration). */
  audio_url: string | null;
  /** Per-word timings for the read-along karaoke highlight, in seconds.
   *  For shorts: flattened from short_renders.props.captions[].words[]
   *  (each chunk carries per-word start_ms/end_ms). Empty array means
   *  "use the baked story.alignment". */
  alignment: Array<{ word: string; start: number; end: number }>;
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

// Pulls the short's narration URL out of its props blob. The renderer stores
// it as `voiceover_url` (a GCS URL when remote=True, a staticFile-relative
// path when local); the read-along surface just hands the value to <audio
// src>, so either shape works without extra handling here.
function parseShortVoiceoverUrl(propsJson: string | null): string | null {
  if (!propsJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(propsJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const url = (parsed as { voiceover_url?: unknown }).voiceover_url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

// Flattens the short's caption chunks into the word-level alignment shape
// the read-along uses (`{word, start, end}` in seconds). Each chunk carries
// its own per-word start_ms/end_ms — the same data the long-form alignment
// stores, just bucketed by caption — so we just unwrap and convert units.
function parseShortAlignment(
  propsJson: string | null,
): Array<{ word: string; start: number; end: number }> {
  if (!propsJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(propsJson);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const captions = (parsed as { captions?: unknown }).captions;
  if (!Array.isArray(captions)) return [];
  const out: Array<{ word: string; start: number; end: number }> = [];
  for (const c of captions) {
    if (!c || typeof c !== "object") continue;
    const words = (c as { words?: unknown }).words;
    if (!Array.isArray(words)) continue;
    for (const w of words) {
      if (!w || typeof w !== "object") continue;
      const word = (w as { word?: unknown }).word;
      const startMs = (w as { start_ms?: unknown }).start_ms;
      const endMs = (w as { end_ms?: unknown }).end_ms;
      if (
        typeof word === "string" &&
        typeof startMs === "number" &&
        typeof endMs === "number"
      ) {
        out.push({ word, start: startMs / 1000, end: endMs / 1000 });
      }
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
    audio_url: null,
    alignment: [],
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
  // 9:16 doodle visual story instead of mixing styles. Read-along audio
  // + alignment come from the same props row so the karaoke surface
  // plays the short's narration verbatim — without this, Watch shows
  // the short while Read-along plays the unrelated long-form voice.
  let images: string[];
  let audioUrl: string | null = null;
  let alignment: Array<{ word: string; start: number; end: number }> = [];
  if (isShort) {
    const propsJson = await latestDoneShortPropsForStory(row.id);
    const shortImages = parseShortFrameUrls(propsJson);
    images = shortImages.length > 0 ? shortImages : parseStoryImageList(row.images);
    audioUrl = parseShortVoiceoverUrl(propsJson);
    alignment = parseShortAlignment(propsJson);
  } else {
    images = parseStoryImageList(row.images);
  }

  return {
    ok: true,
    video_url: row.video_url,
    images,
    audio_url: audioUrl,
    alignment,
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

// Homepage curation: which stories appear on each rail. Returns the
// public view — only published, non-noindex stories survive the filter
// even if an unpublished or unknown id sits in the curation table.
// The admin surface uses listAllCuration directly so it can show stale
// rows with a "(unpublished)" chip; this public action silently drops
// them and lets DesktopShell fall back to its hardcoded constants when
// the resulting rail comes back empty.
export type HomepageCuration = Record<HomepageSurface, string[]>;

export type EmptyRailBehavior = "fallback" | "hide";

export interface HomepageCurationBehavior {
  /** When an empty curated rail meets the homepage: "fallback" uses the
   *  hardcoded constants in stories.ts so the page stays populated;
   *  "hide" skips the rail entirely. Default: "fallback" so a fresh
   *  install renders today's visual without any setup. */
  emptyRailBehavior: EmptyRailBehavior;
  /** When true, the hero pick must come from the curation (empty
   *  curation -> hide the hero). When false, the homepage falls back
   *  to today's hardcoded envelope hero. Default: false so a new
   *  install doesn't render blank-where-the-hero-should-be before any
   *  curation has been set up. */
  heroRequired: boolean;
}

export interface HomepageCurationResult {
  ok: boolean;
  /** Per-surface lists of story ids in position order, with stale/
   *  unpublished rows dropped. Empty arrays mean "no curation set" OR
   *  "all curated rows are currently unpublished" — DesktopShell can't
   *  distinguish, which is intentional (both cases should fall back to
   *  the same default). */
  curation: HomepageCuration;
  /** Total curated story-ids seen in the table, ignoring publish state.
   *  Lets DesktopShell decide whether "empty" means "no curation yet"
   *  (use hardcoded constants) or "curation exists but is all stale"
   *  (still fall back, but log so the admin notices). */
  raw_curation_count: number;
  /** Settings-driven render behaviour. Bundled here so the homepage
   *  client component doesn't need a second round trip just to know
   *  whether to fall back or hide an empty rail. */
  behavior: HomepageCurationBehavior;
}

export async function getHomepageCuration(): Promise<HomepageCurationResult> {
  const grouped = await listAllCuration();
  // Collect every curated story id across all surfaces, dedupe, ask the
  // DB which of them are publishable. One round-trip beats N per-id reads.
  const curatedIds = new Set<string>();
  let rawCount = 0;
  for (const surface of HOMEPAGE_SURFACES) {
    for (const r of grouped[surface]) {
      curatedIds.add(r.story_id);
      rawCount++;
    }
  }
  let publishedSet = new Set<string>();
  if (curatedIds.size > 0) {
    const ids = Array.from(curatedIds);
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await all<{ id: string }>(
      `SELECT id FROM stories WHERE id IN (${placeholders}) ` +
        "AND status = 'published' AND published_at IS NOT NULL " +
        "AND (noindex IS NULL OR noindex = 0)",
      ids,
    );
    publishedSet = new Set(rows.map((r) => r.id));
  }
  const curation: HomepageCuration = {
    hero: [],
    top10: [],
    continue: [],
    new_row: [],
    entitled_row: [],
    humor_row: [],
    wholesome_row: [],
    dating_row: [],
    roommate_row: [],
    drama_row: [],
  };
  for (const surface of HOMEPAGE_SURFACES) {
    for (const r of grouped[surface]) {
      if (publishedSet.has(r.story_id)) {
        curation[surface].push(r.story_id);
      }
    }
  }
  // Pull both behaviour settings in parallel — single round trip cost is
  // ~2 ms on SQLite and the same on Postgres pooled.
  const [emptyRailRaw, heroRequiredRaw] = await Promise.all([
    getSetting("curation.empty_rail_behavior"),
    getSetting("curation.hero_required"),
  ]);
  const behavior: HomepageCurationBehavior = {
    emptyRailBehavior:
      emptyRailRaw === "hide" ? "hide" : "fallback",
    heroRequired: heroRequiredRaw === "true",
  };
  return {
    ok: true,
    curation,
    raw_curation_count: rawCount,
    behavior,
  };
}
