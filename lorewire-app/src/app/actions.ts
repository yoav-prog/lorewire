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
import {
  HOMEPAGE_RAIL_LIMIT,
  isRailEnabledValue,
  POLL_RAIL_KINDS,
  railEnabledSettingKey,
  topAgreed,
  topDivisive,
  topUnpopular,
  type HomepagePollRails,
  type PollRailKind,
  type RailCardRow,
} from "@/lib/polls";
import { readVoteToken } from "@/lib/poll-cookie";
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
  }>(
    "SELECT id, video_url, images, body FROM stories " +
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
  video_url: string | null;
  published_at: string | null;
  created_at: string | null;
}

export interface LiveCatalogResult {
  ok: boolean;
  stories: LiveCatalogStory[];
}

// Returns any story the admin has finished rendering (status ready or
// published) and not explicitly hidden. ORIGINAL filter required both
// status = 'published' AND published_at IS NOT NULL — that silently
// dropped stories whose status was flipped before the publish action
// learned to backfill published_at, leaving the homepage blank of real
// reels even when the admin saw them as published. We now accept
// 'ready' as well (the story has a rendered MP4 and a slug) and order
// by COALESCE(published_at, updated_at, created_at) so a published_at
// of NULL doesn't bury the row. noindex stays a hard cut — that's the
// admin opting OUT of public visibility on purpose.
export async function getLiveCatalog(limit = 200): Promise<LiveCatalogResult> {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const rows = await all<LiveCatalogStory>(
    "SELECT id, slug, title, category, summary, duration, hero_image, " +
      "video_url, published_at, created_at FROM stories " +
      "WHERE status IN ('ready', 'published') " +
      "AND slug IS NOT NULL " +
      "AND (noindex IS NULL OR noindex = 0) " +
      "ORDER BY COALESCE(published_at, updated_at, created_at) DESC " +
      `LIMIT ${safeLimit}`,
  );
  console.info("[homepage live catalog load]", {
    count: rows.length,
    limit: safeLimit,
  });
  return { ok: true, stories: rows };
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
  // Curated rails honour the admin's explicit pick: a story the admin
  // hand-placed on a rail is surfaced as long as it exists and isn't
  // marked noindex. The previous filter additionally required
  // status='published' AND published_at IS NOT NULL — that silently
  // hid stories whose status flipped before the publish flow learned
  // to backfill the timestamp, leaving the rail blank of real picks
  // and falling back to the static sample. If the admin curated it,
  // trust the admin. noindex stays a hard cut — that's an explicit
  // opt-out from public visibility.
  let publishedSet = new Set<string>();
  if (curatedIds.size > 0) {
    const ids = Array.from(curatedIds);
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await all<{ id: string }>(
      `SELECT id FROM stories WHERE id IN (${placeholders}) ` +
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

const EMPTY_RAILS: HomepagePollRails = {
  divisive: [],
  agreed: [],
  unpopular: [],
};

export async function getHomepagePolls(): Promise<HomepagePollRailsResult> {
  // Pull all four reads in one round trip — three settings + the
  // cookie token (the cookie read is the cheap one but still serial
  // if we don't parallelize). Settings are decoded through the
  // shared isRailEnabledValue helper so absent = enabled.
  const [
    divisiveEnabledRaw,
    agreedEnabledRaw,
    unpopularEnabledRaw,
    voteToken,
  ] = await Promise.all([
    getSetting(railEnabledSettingKey("divisive")),
    getSetting(railEnabledSettingKey("agreed")),
    getSetting(railEnabledSettingKey("unpopular")),
    readVoteToken(),
  ]);
  const enabled: Record<PollRailKind, boolean> = {
    divisive: isRailEnabledValue(divisiveEnabledRaw),
    agreed: isRailEnabledValue(agreedEnabledRaw),
    unpopular: isRailEnabledValue(unpopularEnabledRaw),
  };

  // Three queries in parallel — same shape, different sort, isolated
  // failure handling so one slow / broken rail can't stall the others.
  const safeQuery = async (
    kind: PollRailKind,
  ): Promise<RailCardRow[]> => {
    if (!enabled[kind]) return [];
    try {
      if (kind === "divisive") {
        return await topDivisive({ limit: HOMEPAGE_RAIL_LIMIT });
      }
      if (kind === "agreed") {
        return await topAgreed({ limit: HOMEPAGE_RAIL_LIMIT });
      }
      return await topUnpopular({
        cookieToken: voteToken,
        limit: HOMEPAGE_RAIL_LIMIT,
      });
    } catch (err) {
      console.warn("[homepage polls query failed]", {
        rail: kind,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  };
  const [divisive, agreed, unpopular] = await Promise.all(
    POLL_RAIL_KINDS.map((k) => safeQuery(k)),
  );

  const rails: HomepagePollRails = { divisive, agreed, unpopular };
  console.info("[homepage polls load]", {
    counts: {
      divisive: rails.divisive.length,
      agreed: rails.agreed.length,
      unpopular: rails.unpopular.length,
    },
    enabled,
    has_cookie: voteToken !== null,
  });

  return { ok: true, rails, enabled };
}

// (Empty-state sentinel for the client hook lives in
// lib/homepage-rails.ts. Next.js 16 forbids non-async exports from
// "use server" files — even a plain object would be wrapped into a
// server-function reference that can't be read during initial
// render. Sentinel + hook stay co-located on the client side.)
