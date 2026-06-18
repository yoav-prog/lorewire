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
import { type HomepageSurface } from "@/lib/homepage-curation";
import {
  loadHomepageCuration,
  loadHomepagePolls,
  loadLiveCatalog,
} from "@/lib/homepage-data";
import type { HomepagePollRails, PollRailKind } from "@/lib/polls";
import { isShortVideoUrl, SHORT_VIDEO_URL_LIKE } from "@/lib/short-video-url";

export interface LiveStoryMediaResult {
  ok: boolean;
  video_url: string | null;
  /** Scene images to render in the article body + gallery. When the story's
   *  video is the applied short, these come from short_renders.props
   *  doodle_frames[].url and should be rendered at 9:16. When it's the
   *  long-form video (or no video), this falls back to stories.images
   *  and the caller should render at 16:9. */
  images: string[];
  /** The story's article body, sourced from stories.body. The
   *  LiveCatalogStory projection deliberately drops body to keep the
   *  homepage rails payload small, so without surfacing it here the
   *  Read tab's `story.body` check stays false for every live-only
   *  story and the article falls into the hardcoded envelope sample.
   *  Null means no row / empty body → caller falls back to story.body. */
  body: string | null;
  /** LONG-FORM narration audio for the Read-along surface, sourced from
   *  stories.audio_url — the voice_renders_worker writes this whenever
   *  the admin clicks "Regenerate voiceover" in the VoicePicker (with
   *  whichever narrator they picked). This is deliberately NOT the
   *  short's voiceover_url: Read-along reads the full article text, and
   *  the short is a condensed retelling. Null means no DB row / no live
   *  audio yet → caller falls back to the baked story.audioUrl. */
  audio_url: string | null;
  /** Long-form per-word alignment matching `audio_url`, sourced from
   *  stories.alignment. Empty array means no live alignment yet → caller
   *  falls back to the baked story.alignment. */
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

// stories.alignment is the JSON the voice_renders_worker writes after a
// long-form regen — `[{word, start, end}, ...]` in seconds, same shape the
// baked Story type carries. Parses defensively because (a) a malformed row
// shouldn't crash an unauth public read and (b) callers can fall back to
// the baked alignment when this returns empty.
function parseStoryAlignment(
  raw: string | null | undefined,
): Array<{ word: string; start: number; end: number }> {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Array<{ word: string; start: number; end: number }> = [];
  for (const w of parsed) {
    if (!w || typeof w !== "object") continue;
    const word = (w as { word?: unknown }).word;
    const start = (w as { start?: unknown }).start;
    const end = (w as { end?: unknown }).end;
    if (
      typeof word === "string" &&
      typeof start === "number" &&
      typeof end === "number"
    ) {
      out.push({ word, start, end });
    }
  }
  return out;
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
    body: null,
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
    body: string | null;
    audio_url: string | null;
    alignment: string | null;
  }>(
    "SELECT id, video_url, images, body, audio_url, alignment FROM stories " +
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
        audio_url: bySlug.audio_url,
        alignment: bySlug.alignment,
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

  // Long-form audio + alignment come straight off the stories row — these
  // are what the voice_renders_worker writes when the admin clicks
  // "Regenerate voiceover" in the VoicePicker. Pointedly NOT pulled from
  // the short's voiceover_url: Read-along must follow the article text,
  // and the short is a different (condensed) script.
  return {
    ok: true,
    video_url: row.video_url,
    images,
    body: row.body,
    audio_url: row.audio_url,
    alignment: parseStoryAlignment(row.alignment),
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
  video_url: string | null;
  published_at: string | null;
  created_at: string | null;
}

export interface LiveCatalogResult {
  ok: boolean;
  stories: LiveCatalogStory[];
}

// Public client entry: client components import this through "use server"
// as an RPC. The body lives in @/lib/homepage-data so src/app/page.tsx can
// run the same fetch at request time and seed the client shells' initial
// render. Plan: _plans/2026-06-18-homepage-no-flash-ssr.md.
export async function getLiveCatalog(limit = 200): Promise<LiveCatalogResult> {
  return loadLiveCatalog(limit);
}

// ─── Reels feed: published shorts, cursor-paginated ──────────────────────────
// The Reels surface streams ONLY 9:16 short renders (the doodle shorts), most
// recent first, one page at a time. A "short" is identified by its video_url
// suffix (lib/short-video-url) — the long-form pipeline writes a different
// path, so the same `stories` table serves both and this query filters in SQL
// so pagination counts shorts, not all published stories. Public + unauthen-
// ticated like its siblings: the published / non-noindex / has-slug filter is
// load-bearing and mirrors listPublishedStories exactly.

export interface ListShortsOpts {
  /** Page size, clamped to 1..50. */
  limit?: number;
  /** Cursor: return shorts published strictly BEFORE this timestamp. Pass the
   *  previous page's `nextCursor`; omit for the first page. */
  beforePublishedAt?: string | null;
}

export interface ListShortsResult {
  ok: boolean;
  /** One page of shorts, newest first. Same projection the homepage rails use
   *  (LiveCatalogStory) so the Reels card and the catalog adapter share a shape. */
  shorts: LiveCatalogStory[];
  /** Cursor for the next page (the published_at of the last row), or null when
   *  this was the final page. */
  nextCursor: string | null;
}

export async function listPublishedShorts(
  opts: ListShortsOpts = {},
): Promise<ListShortsResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 12, 50));
  // Match the loosened public-visibility gate from getLiveCatalog: any story
  // that's rendered (status ready or published) and has a slug surfaces.
  // The previous strict gate dropped reels whose published_at was NULL
  // because the publish action hadn't backfilled the timestamp yet.
  const where: string[] = [
    "status IN ('ready', 'published')",
    "slug IS NOT NULL",
    "(noindex IS NULL OR noindex = 0)",
    // Shorts only — match the `<id>-short/video.mp4` object path in SQL.
    "video_url LIKE ?",
  ];
  const params: unknown[] = [SHORT_VIDEO_URL_LIKE];
  if (opts.beforePublishedAt) {
    where.push("COALESCE(published_at, updated_at, created_at) < ?");
    params.push(opts.beforePublishedAt);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  // Over-fetch by one so we know whether a further page exists without a second
  // COUNT round-trip. id is the deterministic tiebreak so the sort is stable
  // across equal published_at values. Columns dropped vs feat/reels-feed:
  // hero_image_landscape and hero_has_baked_title don't exist on this
  // branch's schema yet (this branch never picked up that migration); the
  // ReelCard treats them as optional so absent fields are harmless.
  const rows = await all<LiveCatalogStory>(
    "SELECT id, slug, title, category, summary, duration, hero_image, " +
      "video_url, published_at, created_at FROM stories " +
      `${clause} ` +
      "ORDER BY COALESCE(published_at, updated_at, created_at) DESC, id DESC " +
      `LIMIT ${limit + 1}`,
    params,
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  // Belt and braces: the SQL LIKE already filters, but re-assert the exact
  // suffix in JS so a URL that merely contains the substring mid-path can't
  // slip a non-short into the feed (the regex anchors it to the end).
  const shorts = page.filter((s) => isShortVideoUrl(s.video_url));
  // Cursor matches the SQL COALESCE order so a row with NULL published_at
  // still produces a usable next-page key (uses created_at instead).
  const last = page[page.length - 1];
  const nextCursor = hasMore
    ? last?.published_at ?? last?.created_at ?? null
    : null;
  return { ok: true, shorts, nextCursor };
}

// Public client entry: see getLiveCatalog comment. Body lives in
// @/lib/homepage-data.
export async function getHomepageCuration(): Promise<HomepageCurationResult> {
  return loadHomepageCuration();
}

// Phase 4.5 of _plans/2026-06-17-engagement-polls.md. Three derived
// homepage rails computed from poll_aggregates: divisive, agreed,
// unpopular. Each respects its own settings flag — when explicitly
// disabled the rail returns an empty array regardless of available
// data; when enabled (the default) it returns up to
// HOMEPAGE_RAIL_LIMIT cards.
//
// `unpopular` is cookie-personalized: a returning voter sees the
// stories they themselves picked the minority on. A fresh visitor
// without history hits the "smaller side under 15%" fallback (see
// topUnpopular).
//
// Empty rails are returned as empty arrays — the consumer skips the
// section rather than rendering a placeholder. Errors fall back to
// empty arrays too: a busted rail query must NEVER take the
// homepage down with it.

export interface HomepagePollRailsResult {
  ok: boolean;
  rails: HomepagePollRails;
  /** Per-rail enabled flag so the consumer can distinguish "off by
   *  setting" from "on but no data yet". Not used by the renderer
   *  today (we just check array length); kept on the response so
   *  future admin UI can surface "you have it ENABLED but no data
   *  meets the floor" without a second round trip. */
  enabled: Record<PollRailKind, boolean>;
}

// Public client entry: see getLiveCatalog comment. Body lives in
// @/lib/homepage-data.
export async function getHomepagePolls(): Promise<HomepagePollRailsResult> {
  return loadHomepagePolls();
}

// (Empty-state sentinel for the client hook lives in
// lib/homepage-rails.ts. Next.js 16 forbids non-async exports from
// "use server" files — even a plain object would be wrapped into a
// server-function reference that can't be read during initial
// render. Sentinel + hook stay co-located on the client side.)

// 2026-06-18 polls plan extension: per-story poll fetch for client-
// rendered surfaces that didn't go through the server-rendered reader.
// The homepage DetailModal (DesktopShell + AppShell) renders inside a
// client component, so it can't await the poll repo helpers directly.
// This action returns the same shape a server reader resolves so the
// PollWidget renders identically on every surface.
//
// Best-effort — any failure returns { ok: false } so the modal
// degrades gracefully (no poll shown) instead of crashing.
export interface StoryPollView {
  pollId: string;
  question: string;
  optionA: string;
  optionB: string;
  result: import("@/lib/polls-shared").PollResultView;
  votedSide: "A" | "B" | null;
}

/** Optional seed passed by the client so the server can lazy-autodraft
 *  a poll on first DetailModal open for a story that doesn't have one
 *  yet. Honors the "every story has a poll by default" invariant
 *  without requiring a backfill run or admin re-save first. The autodraft
 *  is idempotent + race-safe (SELECT-then-INSERT with re-read), so
 *  concurrent first-views collapse to a single insert. */
export interface StoryPollSeed {
  title: string;
  body: string;
  category: string;
}

export interface StoryPollViewResult {
  ok: boolean;
  /** Null when there's no enabled poll OR resolution failed. The
   *  consumer treats this as "render nothing" without distinguishing
   *  the two cases — both produce identical UX. */
  view: StoryPollView | null;
}

export async function getPollForStoryView(
  storyId: string,
  seed?: StoryPollSeed,
): Promise<StoryPollViewResult> {
  if (!storyId) return { ok: true, view: null };
  try {
    const polls = await import("@/lib/polls");
    const cookie = await import("@/lib/poll-cookie");
    let poll = await polls.getPollByStoryId(storyId);

    // Lazy autodraft on read: if no poll exists yet AND the client
    // sent seed context, draft one inline so the modal shows a poll
    // on first open. One-time per story (subsequent loads hit the
    // cached row). Logs the outcome for [getPollForStoryView] traces.
    if (!poll && seed) {
      const { autoDraftPollForSubject } = await import(
        "@/lib/poll-autodraft"
      );
      const r = await autoDraftPollForSubject({
        kind: "story",
        storyId,
        title: seed.title || null,
        body: seed.body || null,
        category: seed.category || null,
      });
      console.info("[getPollForStoryView lazy autodraft]", {
        story_id: storyId,
        ok: r.ok,
        ai: r.ai,
        fallback: r.fallbackReason ?? null,
      });
      poll = await polls.getPollByStoryId(storyId);
    }

    // "Every story must have a poll, always visible" (2026-06-18 plan
    // extension). We render enabled=0 fallback drafts too — the category
    // preset is a real engagement question, and hiding it leaves the
    // section empty for any story whose LLM autodraft fell back. The
    // admin still controls the wording via PollEditor; the only way to
    // hide a poll now is to delete the row.
    if (!poll) {
      return { ok: true, view: null };
    }
    const [voteToken, aggregate, floor] = await Promise.all([
      cookie.readVoteToken(),
      polls.getAggregateByStoryId(storyId),
      polls.resolvePublicFloor(),
    ]);
    const votedSide = await polls.getVoteSideForCookie(poll.id, voteToken);
    return {
      ok: true,
      view: {
        pollId: poll.id,
        question: poll.question,
        optionA: poll.option_a_text,
        optionB: poll.option_b_text,
        result: polls.toResultView(aggregate, floor),
        votedSide,
      },
    };
  } catch (err) {
    console.warn("[getPollForStoryView failed]", {
      story_id: storyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, view: null };
  }
}
