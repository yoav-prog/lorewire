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
  /** Caption text aligned 1:1 with `images`: one sentence per scene, sliced
   *  from the article body (then summary) and length-capped so cards stay
   *  uniform. Empty strings where no source text exists so the gallery degrades
   *  cleanly instead of going blank. */
  captions: string[];
  /** The article body for this story, so the public READ → Article view can
   *  render the real article for a live-only story (one not yet baked into
   *  src/data/published.ts, where `story.body` is absent on the client).
   *  Null when the story has no body. */
  body: string | null;
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

// Scene frame URLs from a done short's props. The short renders its doodle
// scenes to doodle_frames[].url; the gallery shows these when the applied
// video is a short.
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
    if (f && typeof f === "object" && typeof (f as { url?: unknown }).url === "string") {
      out.push((f as { url: string }).url);
    }
  }
  return out;
}

// Slice prose into one short caption per scene so a gallery without word-level
// alignment still captions every image evenly. One sentence per scene, capped
// so a single long sentence can't blow a card out of proportion. Mirrors the
// client _captionsFromBody so live and baked stories caption the same way.
function captionsFromText(
  text: string | null | undefined,
  count: number,
): string[] {
  if (!text || count <= 0) return [];
  const sentences =
    text
      .replace(/\s+/g, " ")
      .match(/[^.!?]+[.!?]+/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? [];
  if (sentences.length === 0) return [];
  const cap = (s: string) =>
    s.length > 160 ? s.slice(0, 157).replace(/\s+\S*$/, "") + "..." : s;
  return Array.from({ length: count }, (_, i) =>
    cap(
      sentences[
        Math.min(Math.floor((i * sentences.length) / count), sentences.length - 1)
      ],
    ),
  );
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
    captions: [],
    body: null,
    is_short: false,
    found: false,
  };
  if (!idOrSlug || typeof idOrSlug !== "string") return empty;

  // Try by id first — handles new pipeline UUIDs and legacy ids ("envelope").
  let row = await one<{
    id: string;
    video_url: string | null;
    images: string | null;
    body: string | null;
    summary: string | null;
  }>(
    "SELECT id, video_url, images, body, summary FROM stories " +
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
        body: bySlug.body,
        summary: bySlug.summary,
      };
    }
  }
  if (!row) return empty;

  const isShort = isShortVideoUrl(row.video_url);
  // Pick the scene images: a short shows its 9:16 doodle frames; everything
  // else shows the long-form stills. Then caption every scene by slicing the
  // article body (then summary) into one sentence each, so the gallery is
  // never text-less and the captions stay uniform across cards (the spoken
  // caption-chunk mapping produced wildly uneven lengths).
  let images: string[];
  if (isShort) {
    const propsJson = await latestDoneShortPropsForStory(row.id);
    const shortImages = parseShortFrameUrls(propsJson);
    images = shortImages.length > 0 ? shortImages : parseStoryImageList(row.images);
  } else {
    images = parseStoryImageList(row.images);
  }
  const captions = captionsFromText(row.body ?? row.summary, images.length);

  return {
    ok: true,
    video_url: row.video_url,
    images,
    captions,
    body: row.body,
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

// Slim story projection the homepage rails render off. Mirrors the fields
// the static `Story` interface in lib/stories ships (id, title, category,
// duration, hero artwork, ...) so the client adapter can build a Story
// without each rail component caring whether it came from the baked
// catalog or the live DB.
export interface LiveCatalogStory {
  id: string;
  slug: string | null;
  title: string | null;
  category: string | null;
  summary: string | null;
  duration: string | null;
  hero_image: string | null;
  hero_image_landscape: string | null;
  /** Python pipeline writes 1 when the hero artwork already has the
   *  title baked in so the CSS title overlay doesn't double up. */
  hero_has_baked_title: number | null;
  video_url: string | null;
  published_at: string | null;
  created_at: string | null;
}

export interface LiveCatalogResult {
  ok: boolean;
  stories: LiveCatalogStory[];
}

// Returns published, non-noindex stories most-recent first. Used by the
// homepage shells to render newly published stories that haven't been
// re-exported into src/data/published.ts yet — `python -m pipeline.export_app`
// is a deploy-required step; this fetch sidesteps it for live UX.
export async function getLiveCatalog(limit = 200): Promise<LiveCatalogResult> {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const rows = await all<LiveCatalogStory>(
    "SELECT id, slug, title, category, summary, duration, hero_image, " +
      "hero_image_landscape, hero_has_baked_title, video_url, " +
      "published_at, created_at FROM stories " +
      "WHERE status = 'published' AND published_at IS NOT NULL " +
      "AND (noindex IS NULL OR noindex = 0) " +
      "ORDER BY published_at DESC " +
      `LIMIT ${safeLimit}`,
  );
  return { ok: true, stories: rows };
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
