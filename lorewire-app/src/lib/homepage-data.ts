// Server-only homepage data loaders. Lifted verbatim from the bodies of
// `getHomepageCuration`, `getLiveCatalog`, and `getHomepagePolls` in
// src/app/actions.ts so the homepage Server Component (src/app/page.tsx)
// can run the same fetches at request time and seed the client shells'
// initial render — killing the 1-2s window where the static sample
// catalog flashed before the live data landed.
//
// The "use server" actions in actions.ts now delegate to these helpers,
// keeping the public RPC surface identical for every existing client
// caller while letting page.tsx await the same logic without crossing
// the action boundary.
//
// Plan: _plans/2026-06-18-homepage-no-flash-ssr.md.

import "server-only";
import { all } from "@/lib/db";
import {
  assembledDurationMsFromPropsJson,
  bodyDurationMsFromPropsJson,
  formatDurationMs,
  fullDurationMsFromParts,
  parseLastRenderedSegments,
} from "@/lib/duration";
import { resolveMediaUrl } from "@/lib/media-url";
import { getSetting } from "@/lib/repo";
import {
  HOMEPAGE_SURFACES,
  listAllCuration,
} from "@/lib/homepage-curation";
import {
  COLD_START_FLOOR_DEFAULT,
  coldStartFloorSettingKey,
  parseColdStartFloor,
  resolveRotatingCategorySurface,
  rotatingCategoryEnabledSettingKey,
  rotatingCategoryOverrideSettingKey,
  type RotatingCategorySurface,
} from "@/lib/homepage-curation-shared";
import {
  countMinorityVotesByCookie,
  DEFAULT_PUBLIC_FLOOR,
  getAggregatesByStoryIds,
  getEnabledPollQuestionsByStoryIds,
  getPollsByStoryIds,
  HOMEPAGE_RAIL_LIMIT,
  isRailEnabledValue,
  listVotedStoryIdsByCookie,
  pctA,
  POLL_RAIL_KINDS,
  railEnabledSettingKey,
  resolveMinorityVoteThreshold,
  topAgreed,
  topDivisive,
  topUnpopular,
  type HeroVerdictBadge,
  type HomepagePollRails,
  type PollRailKind,
  type RailCardRow,
} from "@/lib/polls";
import { readVoteToken } from "@/lib/poll-cookie";
import { readUserSession } from "@/lib/user-session";
import { resolveImpersonation } from "@/lib/impersonation";
import { getUserById } from "@/lib/users";
import { one } from "@/lib/db";
import { commentsEnabledForArticle } from "@/lib/comments";
import {
  countPublishedComments,
  loadCommentThread,
  type CommentThreadPage,
} from "@/lib/comments-read";
import { readCommentToken } from "@/lib/comment-cookie";
import type {
  HomepageCuration,
  HomepageCurationBehavior,
  HomepageCurationResult,
  HomepagePollRailsResult,
  LiveCatalogResult,
  LiveCatalogStory,
} from "@/app/actions";

// ─── live catalog ───────────────────────────────────────────────────────────

export async function loadLiveCatalog(limit = 200): Promise<LiveCatalogResult> {
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
  // stories.duration is admin-editable (M:SS string) and rarely set for shorts —
  // the writer path that auto-applies a short as the story's video only swaps
  // video_url, leaving duration NULL. Backfill from the latest done short_render's
  // props.duration_ms so rail thumbnails show the real ~30-60s length instead of
  // the historical "2:00" long-form fallback.
  const enrichedDurations = await loadShortDurationsForStories(
    rows.filter((r) => !r.duration).map((r) => r.id),
  );
  for (const r of rows) {
    if (!r.duration) {
      const real = enrichedDurations.get(r.id);
      if (real) r.duration = real;
    }
  }
  console.info("[homepage live catalog load]", {
    count: rows.length,
    limit: safeLimit,
    durations_backfilled: enrichedDurations.size,
  });
  // Resolve hero/video onto the delivery base (lib/media-url); passthrough when
  // MEDIA_PUBLIC_BASE is unset.
  const stories = rows.map((s) => ({
    ...s,
    hero_image: resolveMediaUrl(s.hero_image),
    video_url: resolveMediaUrl(s.video_url),
  }));
  return { ok: true, stories };
}

// Compute the public-facing duration of each story's latest done short and
// format as "M:SS". Story ids whose renders are missing / errored / carry
// neither an assembled nor a body duration are absent from the returned
// map so the caller's fallback path can decide what to do.
//
// Source preference (matches lib/short-render-queue.resolveStoryDurationFromProps
// so the writer + reader can never drift):
//   1. props.assembled_duration_ms — ground truth from Cloud Run's
//      ffprobe of the final spliced MP4. Plan:
//      _plans/2026-06-29-actual-mp4-duration.md.
//   2. body + intro + outro sum from props.duration_ms +
//      stories.short_config._last_rendered_segments. Legacy math, missing
//      ~1.5 s of post-roll hold + any ffmpeg re-encode rounding.
//   3. body-only — fallback when the stamp is missing (legacy rows,
//      stamp write failed) or the segment row was deleted. Never a worse
//      badge than before _plans/2026-06-29 shipped.
async function loadShortDurationsForStories(
  storyIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (storyIds.length === 0) return out;
  const placeholders = storyIds.map(() => "?").join(", ");
  // Fan out the three reads in parallel: render props (carries both
  // assembled and body durations), per-story short_config stamp, and the
  // segment library rows. The segment query is conditional on the stamps
  // having referenced anything, so empty-stamp story sets pay one fewer
  // round trip.
  const [renderRows, storyConfigRows] = await Promise.all([
    all<{ story_id: string; props: string | null }>(
      "SELECT story_id, props FROM short_renders " +
        `WHERE story_id IN (${placeholders}) ` +
        "AND status = 'done' AND props IS NOT NULL " +
        "ORDER BY COALESCE(finished_at, started_at, requested_at) DESC",
      storyIds,
    ),
    all<{ id: string; short_config: string | null }>(
      `SELECT id, short_config FROM stories WHERE id IN (${placeholders})`,
      storyIds,
    ),
  ]);
  // Latest props per story id (dedupe by first-seen, matching the
  // historical ORDER BY ... DESC + skip-if-seen contract). Both
  // assembled + body get pulled off the same row so the writer + reader
  // see the same render.
  interface PerStoryProps {
    assembledMs: number | null;
    bodyMs: number | null;
  }
  const propsByStory = new Map<string, PerStoryProps>();
  for (const r of renderRows) {
    if (propsByStory.has(r.story_id)) continue;
    propsByStory.set(r.story_id, {
      assembledMs: assembledDurationMsFromPropsJson(r.props),
      bodyMs: bodyDurationMsFromPropsJson(r.props),
    });
  }
  // Stamp per story id -> segment ids actually spliced into the assembled
  // MP4. Null when no stamp; we treat that as body-only (legacy sum path).
  const stampByStory = new Map<
    string,
    ReturnType<typeof parseLastRenderedSegments>
  >();
  const segmentIds = new Set<string>();
  for (const r of storyConfigRows) {
    const stamp = parseLastRenderedSegments(r.short_config);
    stampByStory.set(r.id, stamp);
    if (stamp?.intro_segment_id) segmentIds.add(stamp.intro_segment_id);
    if (stamp?.outro_segment_id) segmentIds.add(stamp.outro_segment_id);
  }
  // Segment durations lookup. Only fire the query if any stamp referenced
  // a segment id at all — most legacy rows won't, and post-_plans/2026-06-29
  // rows that have assembled_duration_ms don't need it either.
  const segmentMsById = new Map<string, number>();
  if (segmentIds.size > 0) {
    const segIds = Array.from(segmentIds);
    const segPlaceholders = segIds.map(() => "?").join(", ");
    const segRows = await all<{ id: string; duration_ms: number | null }>(
      `SELECT id, duration_ms FROM video_segments WHERE id IN (${segPlaceholders})`,
      segIds,
    );
    for (const s of segRows) {
      const n = Number(s.duration_ms);
      if (Number.isFinite(n) && n > 0) segmentMsById.set(s.id, n);
    }
  }
  // Pick the best source per story and format. Logs the chosen source so
  // we can grep what fraction of badges are still on the legacy sum.
  for (const storyId of storyIds) {
    const props = propsByStory.get(storyId);
    if (!props) continue;
    let source: "assembled" | "sum" | "body_only";
    let totalMs: number;
    if (props.assembledMs !== null) {
      source = "assembled";
      totalMs = props.assembledMs;
    } else if (props.bodyMs !== null) {
      const stamp = stampByStory.get(storyId) ?? null;
      const introMs = stamp?.intro_segment_id
        ? segmentMsById.get(stamp.intro_segment_id) ?? 0
        : 0;
      const outroMs = stamp?.outro_segment_id
        ? segmentMsById.get(stamp.outro_segment_id) ?? 0
        : 0;
      totalMs = fullDurationMsFromParts(props.bodyMs, introMs, outroMs);
      source = introMs > 0 || outroMs > 0 ? "sum" : "body_only";
    } else {
      continue;
    }
    const formatted = formatDurationMs(totalMs);
    if (formatted) {
      out.set(storyId, formatted);
      console.info("[homepage live catalog duration]", {
        story_id: storyId,
        source,
        total_ms: totalMs,
        formatted,
      });
    }
  }
  return out;
}

// ─── curation ───────────────────────────────────────────────────────────────

export async function loadHomepageCuration(): Promise<HomepageCurationResult> {
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

// ─── poll rails ─────────────────────────────────────────────────────────────

const EMPTY_POLL_RAILS: HomepagePollRails = {
  divisive: [],
  agreed: [],
  unpopular: [],
};

export async function loadHomepagePolls(): Promise<HomepagePollRailsResult> {
  // Pull all five reads in one round trip — three rail enables, the
  // minority-vote threshold, and the cookie token. Settings are decoded
  // through the shared isRailEnabledValue helper so absent = enabled.
  // The minority threshold goes through parseMinorityVoteThreshold via
  // resolveMinorityVoteThreshold so blank/malformed values fall back to
  // the default.
  const [
    divisiveEnabledRaw,
    agreedEnabledRaw,
    unpopularEnabledRaw,
    minorityThreshold,
    voteToken,
  ] = await Promise.all([
    getSetting(railEnabledSettingKey("divisive")),
    getSetting(railEnabledSettingKey("agreed")),
    getSetting(railEnabledSettingKey("unpopular")),
    resolveMinorityVoteThreshold(),
    readVoteToken(),
  ]);
  const enabled: Record<PollRailKind, boolean> = {
    divisive: isRailEnabledValue(divisiveEnabledRaw),
    agreed: isRailEnabledValue(agreedEnabledRaw),
    unpopular: isRailEnabledValue(unpopularEnabledRaw),
  };

  // 2026-06-26 (slice A of _plans/2026-06-26-homepage-redesign-v1.md):
  // the `unpopular` rail is being repurposed as the personalized
  // "You Voted With the Minority" rail. The semantic stays — topUnpopular
  // already returns the cookie's minority-vote stories when given a
  // cookieToken. What changes is the SURFACING contract:
  //  - No cookie → rail hides (no fallback to "smaller side under 15%")
  //  - Cookie present but minority-vote count below threshold → rail hides
  //  - Cookie present + threshold met → topUnpopular personalized path
  // The threshold gate keeps the rail from surfacing to a viewer with
  // one or two minority votes — not enough signal to label them "the
  // kind of person who often disagrees with the crowd," which is the
  // rail's whole reason to exist.
  const minorityCount = enabled.unpopular
    ? await countMinorityVotesByCookie(voteToken)
    : 0;
  const minorityEligible =
    enabled.unpopular &&
    voteToken !== null &&
    minorityCount >= minorityThreshold;

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
      // unpopular: gated by the minority-vote threshold above.
      if (!minorityEligible) return [];
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
    minority_count: minorityCount,
    minority_threshold: minorityThreshold,
    minority_eligible: minorityEligible,
  });

  return { ok: true, rails, enabled };
}

// ─── SSR fan-out ────────────────────────────────────────────────────────────

// Single seed the homepage Server Component passes to the client shells so
// the first paint already shows the correct hero, Continue Watching, and
// rails. Each field maps 1:1 to what a client hook would have fetched on
// mount, just resolved server-side. Per-source isolation: if one loader
// throws, the other two still seed; the failing field falls back to its
// safe sentinel (null curation / default behavior / empty live rows /
// empty poll rails) and the client renders against the static catalog as
// it did before this change. That's the agreed "render with static
// catalog" failure mode — better a degraded homepage than a broken one.
/** Minimal public-user session shape passed to client shells. Mirrors
 *  the lib/user-session.ts UserSessionData fields the UI needs — userId
 *  for telemetry, email for the header avatar fallback. No tokens, no
 *  PII beyond email which the user has already entrusted to us. Null
 *  when the visitor is anonymous (no lw_user cookie). */
export interface PublicSession {
  userId: string;
  email: string;
}

export interface HomepageInitial {
  curation: HomepageCuration | null;
  behavior: HomepageCurationBehavior;
  rawCurationCount: number;
  liveRows: LiveCatalogStory[];
  pollRails: HomepagePollRailsResult;
  /** 2026-06-21 Phase 5: server-resolved sign-in state. SSR reads the
   *  lw_user cookie once and passes the redacted shape to the shells so
   *  the header chip + nudge can render correct state on first paint
   *  without a client-side fetch. */
  session: PublicSession | null;
  /** When the homepage URL carried `?story=X`, this is the pre-fetched
   *  Comments thread for that story (resolved through articles.story_id
   *  if there's a linked published article). The shells thread it down
   *  to CommentsTab, which skips its client-side fetch when the seed
   *  matches the open story id. Null when no `?story=` was on the
   *  request, or when the lookup failed. */
  seededModalComments: SeededModalComments | null;
  /** 2026-06-26 slice C of _plans/2026-06-26-homepage-redesign-v1.md:
   *  story ids this viewer's cookie has voted on. Used by the
   *  homepage "You Didn't Vote Yet" rail (the reframed Continue
   *  Watching) to filter out stories the viewer already voted on.
   *  Empty array for anonymous visitors / cookies with no vote
   *  history — the shells' `filterIdsByNotVoted` collapses to a
   *  no-op so the rail keeps showing every watched story. */
  votedStoryIds: string[];
  /** 2026-06-26 slice D of _plans/2026-06-26-homepage-redesign-v1.md:
   *  top story ids by current divisiveness, capped at the hero pool
   *  size. Feeds resolveHeroPool's new auto-fill source — when the
   *  admin hasn't curated the hero, the carousel auto-fills with the
   *  most-debated stories rather than the most-recent. Curated picks
   *  still pin at the front (admin override stays authoritative).
   *  Empty array on a cold catalog falls through to the existing
   *  recency fallback so the hero is never blank. */
  heroDivisiveIds: string[];
  /** 2026-06-26 slice D: poll question text keyed by story id. Used
   *  by the hero carousel's question-hint overlay — only the
   *  question is surfaced, never the option labels (locked decision
   *  on the spoiler tradeoff). Covers every enabled-poll story in the
   *  live catalog so the overlay paints on whatever composition
   *  resolveHeroPool ends up with (curated, divisive, or recency). */
  heroPollQuestions: Record<string, string>;
  /** 2026-06-26 slice E of _plans/2026-06-26-homepage-redesign-v1.md:
   *  which category surface fills the homepage rotating slot today.
   *  Resolution order (server-side):
   *    1. Kill switch off → null. Shells render every category rail
   *       (pre-slice-E behaviour).
   *    2. Admin override pinned → that surface.
   *    3. Otherwise → deterministic modulo over UTC day.
   *  Null here is the explicit "fall back to all six rails" signal so
   *  the shells don't need to second-guess it. */
  rotatingCategoryToday: RotatingCategorySurface | null;
  /** 2026-06-26 slice F of _plans/2026-06-26-homepage-redesign-v1.md:
   *  minimum published cards a floor-eligible rail must have before
   *  rendering. Defaults to COLD_START_FLOOR_DEFAULT (4); admins can
   *  set 0 to disable the floor (legacy `> 0` gate). Eligibility is
   *  decided in the shells — personalized (continue, unpopular) and
   *  special-render (hero, top10) rails skip the floor entirely so
   *  thin personalized signals still surface. */
  coldStartFloor: number;
  /** 2026-06-26 slice H of _plans/2026-06-26-homepage-redesign-v1.md:
   *  the "audience verdict" badge for the homepage hero, keyed by
   *  story id. Replaces the Netflix-style "% Match" position with a
   *  LoreWire-specific signal (what the audience decided). Only
   *  populated for stories whose poll has crossed the public floor
   *  (>= 20 votes by default); below that the entry is absent so
   *  the hero overlay can quietly skip the badge. */
  heroVerdicts: Record<string, HeroVerdictBadge>;
  /** 2026-06-26 slice H: poster vote counts keyed by story id. Used
   *  by the rail PosterCard to render a small "234 votes" corner
   *  chip. Same floor as heroVerdicts — entries below
   *  DEFAULT_PUBLIC_FLOOR are omitted so the chip doesn't surface on
   *  freshly-launched polls where the count is meaningless. */
  posterVoteCounts: Record<string, number>;
}

const EMPTY_POLL_RAILS_RESULT: HomepagePollRailsResult = {
  ok: false,
  rails: EMPTY_POLL_RAILS,
  enabled: { divisive: true, agreed: true, unpopular: true },
};

const DEFAULT_BEHAVIOR: HomepageCurationBehavior = {
  emptyRailBehavior: "fallback",
  heroRequired: false,
};

type SsrSource =
  | "curation"
  | "catalog"
  | "polls"
  | "session"
  | "seededModalComments"
  | "votedStoryIds"
  | "heroDivisiveIds"
  | "rotatingCategory"
  | "coldStartFloor"
  | "catalogPollData";

async function safeLoad<T>(
  source: SsrSource,
  loader: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await loader();
  } catch (err) {
    console.warn("[lorewire homepage ssr error]", {
      source,
      err: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}

/** Hero pool capacity — must match `SURFACE_CAPACITY.hero` in
 *  homepage-curation-shared.ts and `HERO_FALLBACK_CAP` in
 *  homepage-rails.ts. The three live in different layers (admin
 *  curation cap, client-side fallback cap, and now this SSR loader)
 *  so the constant is duplicated rather than imported — each layer
 *  carries the bound it actually needs. If the capacity ever changes,
 *  flip all three together. */
const HERO_POOL_CAP = 8;

/** Resolve the story ids this viewer has already voted on. Feeds the
 *  homepage "You Didn't Vote Yet" rail filter so the reframed Continue
 *  Watching surface drops anything the viewer has cast a verdict on.
 *
 *  Anonymous-first: cookie-token is the attribution primitive (per the
 *  Anonymous-first auth strategy memory and existing poll_votes
 *  contract). Signed-in users still have a cookie token because
 *  setVoteToken runs on the first vote regardless of sign-in state.
 *  Empty cookie / read failure → empty list, treated by the filter as
 *  a no-op.
 *
 *  Plan: _plans/2026-06-26-homepage-redesign-v1.md (slice C). */
async function loadVotedStoryIds(): Promise<string[]> {
  const voteToken = await readVoteToken();
  return listVotedStoryIdsByCookie(voteToken);
}

/** Top hero-pool candidates by current divisiveness. Re-uses the
 *  rail-side `topDivisive` so the hero ranking and the
 *  "The Internet Can't Agree" rail draw from the same projection
 *  table — no divergence between "what the hero promotes" and
 *  "what the rail promotes," just different caps.
 *
 *  Returns the cards (not just ids) so the SSR loader can pull both
 *  the divisive id list AND the per-story question text from a
 *  single round-trip. The caller splits the result into
 *  heroDivisiveIds + heroPollQuestions before sealing the SSR
 *  payload.
 *
 *  Plan: _plans/2026-06-26-homepage-redesign-v1.md (slice D). */
async function loadHeroDivisiveCards(): Promise<RailCardRow[]> {
  return topDivisive({ limit: HERO_POOL_CAP });
}

/** Resolve which category surface the homepage rotating slot lands on
 *  today. Reads the kill-switch + admin-override settings keys in
 *  parallel and hands off to the pure resolver in
 *  homepage-curation-shared.ts.
 *
 *  isRailEnabledValue is reused for the kill-switch parse (matches
 *  the per-rail toggle convention: blank/missing reads as ON, "0" /
 *  "false" reads as OFF). Returns null when the feature is disabled
 *  so the shells render every category rail instead.
 *
 *  Plan: _plans/2026-06-26-homepage-redesign-v1.md (slice E). */
async function loadRotatingCategorySurface(): Promise<RotatingCategorySurface | null> {
  const [enabledRaw, overrideRaw] = await Promise.all([
    getSetting(rotatingCategoryEnabledSettingKey()),
    getSetting(rotatingCategoryOverrideSettingKey()),
  ]);
  const enabled = isRailEnabledValue(enabledRaw);
  const surface = resolveRotatingCategorySurface(enabled, overrideRaw);
  console.info("[homepage rotating category]", {
    enabled,
    override: overrideRaw ?? null,
    resolved: surface,
  });
  return surface;
}

/** Resolve the homepage cold-start floor from settings. Reuses the
 *  parse helper's trust boundary so blank / malformed / negative
 *  values fall through to the default and 0 is honoured (disables
 *  the floor). See parseColdStartFloor for the rationale and the
 *  PR #66 historical context.
 *
 *  Plan: _plans/2026-06-26-homepage-redesign-v1.md (slice F). */
async function loadColdStartFloor(): Promise<number> {
  const raw = await getSetting(coldStartFloorSettingKey());
  return parseColdStartFloor(raw);
}

interface CatalogPollDataResult {
  heroVerdicts: Record<string, HeroVerdictBadge>;
  posterVoteCounts: Record<string, number>;
}

/** Resolve the per-story poll signals the homepage needs for the
 *  audience-verdict hero badge and the poster vote-count chip.
 *
 *  Reads polls + poll_aggregates in parallel for the given story ids
 *  and composes two maps:
 *
 *  - `heroVerdicts` — only populated for stories whose total_votes
 *    has crossed DEFAULT_PUBLIC_FLOOR. The majority side and pct are
 *    computed via the existing `pctA` math; the badge string is
 *    rendered client-side from divisiveness + majorityPct so the
 *    copy can evolve without a server deploy.
 *
 *  - `posterVoteCounts` — keyed by story id with `total_votes` for
 *    every story whose count has crossed the floor. Same floor on
 *    both maps so the same set of polls drives both surfaces.
 *
 *  Empty input short-circuits to empty maps (no SQL round trip).
 *  Plan: _plans/2026-06-26-homepage-redesign-v1.md (slice H). */
async function loadCatalogPollData(
  storyIds: string[],
): Promise<CatalogPollDataResult> {
  if (storyIds.length === 0) {
    return { heroVerdicts: {}, posterVoteCounts: {} };
  }
  const [polls, aggregates] = await Promise.all([
    getPollsByStoryIds(storyIds),
    getAggregatesByStoryIds(storyIds),
  ]);
  const heroVerdicts: Record<string, HeroVerdictBadge> = {};
  const posterVoteCounts: Record<string, number> = {};
  for (const [storyId, agg] of aggregates) {
    if (agg.total_votes < DEFAULT_PUBLIC_FLOOR) continue;
    const poll = polls.get(storyId);
    if (!poll) continue;
    posterVoteCounts[storyId] = agg.total_votes;
    // Use pctA + complement so the displayed percentages always sum
    // to 100 even on a perfect 50/50 (rounding both halves
    // independently can produce 101 or 99).
    const aPct = pctA(agg.votes_a, agg.votes_b);
    const bPct = 100 - aPct;
    const majorityIsA = aPct >= bPct;
    heroVerdicts[storyId] = {
      totalVotes: agg.total_votes,
      divisiveness: agg.divisiveness,
      majorityPct: majorityIsA ? aPct : bPct,
      majorityLabel: majorityIsA ? poll.option_a_text : poll.option_b_text,
    };
  }
  console.info("[homepage catalog poll data]", {
    requested: storyIds.length,
    polls_resolved: polls.size,
    aggregates_resolved: aggregates.size,
    verdicts: Object.keys(heroVerdicts).length,
    vote_counts: Object.keys(posterVoteCounts).length,
  });
  return { heroVerdicts, posterVoteCounts };
}

async function loadSession(): Promise<PublicSession | null> {
  // Admin "view as" overlay: if an admin with users.impersonate is actively
  // impersonating, the reader renders for the target member instead. This only
  // affects the personalization READ — public writes use readActiveUserSession
  // (the lw_user cookie, which the impersonating admin doesn't have), so this
  // grants no write power. resolveImpersonation is bulletproof (returns null on
  // any error), so it can't take down the homepage.
  const imp = await resolveImpersonation();
  if (imp) {
    const target = await getUserById(imp.targetId);
    // Only ever impersonate a public member, never a staff account.
    if (target && target.role === "user") {
      return { userId: target.id, email: target.email };
    }
    return null;
  }

  // Read the lw_user JWT cookie. The helper validates signature +
  // expiry; a tampered or expired cookie returns null and the user is
  // treated as anonymous. Wrapped in safeLoad so a USER_SESSION_SECRET
  // misconfiguration on Vercel (the most likely root cause of a thrown
  // error here) doesn't take down the whole homepage.
  const data = await readUserSession();
  if (!data) return null;
  return { userId: data.userId, email: data.email };
}

// ─── seeded modal comments (deep-link SSR) ─────────────────────────────────
//
// When the homepage URL carries `?story=X` (a permalink shared from the
// Comments tab's "Link" button), pre-fetch the comments thread + count
// + kill-switch + resolved articleId on the server so the modal opens
// with comments ALREADY in the DOM — no "Loading comments…" flash on
// the URL the recipient just clicked. Falls through cleanly to null
// when story is missing or the resolve / fetch errors.

export interface SeededModalComments {
  /** The original story id from the URL — used to match the seed to
   *  the open modal client-side (don't apply this seed to a different
   *  story even if both happened to load). */
  storyId: string;
  /** Resolved comments article_id (== article.id when articles.story_id
   *  links to storyId; == storyId otherwise). */
  articleId: string;
  count: number;
  enabled: boolean;
  thread: CommentThreadPage;
}

async function resolveCommentArticleIdForStory(storyId: string): Promise<string> {
  const row = await one<{ id: string }>(
    "SELECT id FROM articles WHERE story_id = ? AND status = 'published' LIMIT 1",
    [storyId],
  );
  return row?.id ?? storyId;
}

export async function loadSeededModalComments(
  storyId: string,
): Promise<SeededModalComments | null> {
  if (!storyId) return null;
  try {
    const session = await readUserSession();
    const cookieToken = await readCommentToken();
    const articleId = await resolveCommentArticleIdForStory(storyId);
    const [thread, count, enabled] = await Promise.all([
      loadCommentThread({
        articleId,
        sort: "newest",
        viewerUserId: session?.userId ?? null,
        viewerCookieToken: cookieToken,
      }),
      countPublishedComments(articleId),
      commentsEnabledForArticle(articleId),
    ]);
    console.info("[homepage seeded modal comments]", {
      story_id: storyId,
      resolved_article_id: articleId,
      unified: articleId !== storyId,
      count,
      enabled,
      page_nodes: thread.nodes.length,
    });
    return { storyId, articleId, count, enabled, thread };
  } catch (err) {
    console.warn("[homepage seeded modal comments fail]", {
      story_id: storyId,
      err: String(err),
    });
    return null;
  }
}

export async function loadHomepageSSRData(opts?: {
  /** When the request carried `?story=X`, pass it here so the SSR fetch
   *  also pre-loads the Comments thread for that story (deep-link
   *  permalink path). Omit for a normal homepage visit — the seed
   *  comes back null and the modal Comments tab fetches client-side
   *  when opened, same as before. */
  seededModalStoryId?: string;
}): Promise<HomepageInitial> {
  const t0 = Date.now();
  const [
    curationResult,
    catalogResult,
    pollsResult,
    session,
    seededModalComments,
    votedStoryIds,
    heroDivisiveCards,
    rotatingCategoryToday,
    coldStartFloor,
  ] = await Promise.all([
    safeLoad<HomepageCurationResult | null>(
      "curation",
      loadHomepageCuration,
      null,
    ),
    safeLoad<LiveCatalogResult>(
      "catalog",
      () => loadLiveCatalog(),
      { ok: false, stories: [] },
    ),
    safeLoad<HomepagePollRailsResult>(
      "polls",
      loadHomepagePolls,
      EMPTY_POLL_RAILS_RESULT,
    ),
    safeLoad<PublicSession | null>("session", loadSession, null),
    opts?.seededModalStoryId
      ? safeLoad<SeededModalComments | null>(
          "seededModalComments",
          () => loadSeededModalComments(opts.seededModalStoryId!),
          null,
        )
      : Promise.resolve(null),
    // 2026-06-26 slice C of _plans/2026-06-26-homepage-redesign-v1.md.
    // Failure path returns [] so the "You Didn't Vote Yet" filter
    // degrades to a no-op (rail still shows the raw watched list)
    // rather than blanking out for everyone if the poll_votes read
    // throws.
    safeLoad<string[]>("votedStoryIds", loadVotedStoryIds, []),
    // 2026-06-26 slice D of _plans/2026-06-26-homepage-redesign-v1.md.
    // Failure path returns [] so the hero pool falls through to its
    // existing recency-based auto-fill rather than going blank.
    safeLoad<RailCardRow[]>("heroDivisiveIds", loadHeroDivisiveCards, []),
    // 2026-06-26 slice E of _plans/2026-06-26-homepage-redesign-v1.md.
    // Failure path returns null so the shells fall back to rendering
    // every category rail (legacy behaviour) rather than swallowing
    // the category section entirely on a settings_kv read error.
    safeLoad<RotatingCategorySurface | null>(
      "rotatingCategory",
      loadRotatingCategorySurface,
      null,
    ),
    // 2026-06-26 slice F of _plans/2026-06-26-homepage-redesign-v1.md.
    // Failure path returns the in-code default so the floor stays in
    // effect at the canonical value rather than silently dropping to
    // 0 (which would let half-built rails through).
    safeLoad<number>(
      "coldStartFloor",
      loadColdStartFloor,
      COLD_START_FLOOR_DEFAULT,
    ),
  ]);

  // 2026-06-26 slice D: split the divisive cards into the id-ordered
  // list resolveHeroPool consumes and the per-story question map the
  // overlay reads. Done client-side of the SSR boundary (still server-
  // executed; "client" here means "after the parallel fan-out") so
  // the on-wire shape matches what the carousel actually needs —
  // resolveHeroPool deals in story ids, the overlay reads questions
  // by id, neither needs the full RailCardRow.
  //
  // Curated hero picks (admin override) get a question lookup too, so
  // the overlay paints on those slides even when they aren't in the
  // divisive set. Recency-fallback picks naturally lack a poll most of
  // the time — no question, no overlay, the slide reads as a normal
  // hero. That's the graceful degradation contract.
  const heroDivisiveIds: string[] = [];
  const heroPollQuestions: Record<string, string> = {};
  for (const card of heroDivisiveCards) {
    heroDivisiveIds.push(card.storyId);
    if (card.question) heroPollQuestions[card.storyId] = card.question;
  }
  const curatedHeroIds = curationResult?.curation?.hero ?? [];
  const extraQuestionIds = curatedHeroIds.filter(
    (id) => !(id in heroPollQuestions),
  );
  if (extraQuestionIds.length > 0) {
    const extra = await safeLoad<Record<string, string>>(
      "heroDivisiveIds",
      () => getEnabledPollQuestionsByStoryIds(extraQuestionIds),
      {},
    );
    for (const [id, q] of Object.entries(extra)) {
      heroPollQuestions[id] = q;
    }
  }

  // 2026-06-26 slice H: poll aggregates for the hero verdict badge
  // (replaces "% Match") and the rail poster vote-count chip. Runs
  // AFTER the catalog load because the query needs the catalog's
  // story ids — adding a separate eager query would scan polls /
  // poll_aggregates without knowing which rows the shells actually
  // surface. The catalog cap (200) bounds the work; the helper
  // composes both maps from one read.
  const catalogPollData = await safeLoad<CatalogPollDataResult>(
    "catalogPollData",
    () => loadCatalogPollData(catalogResult.stories.map((s) => s.id)),
    { heroVerdicts: {}, posterVoteCounts: {} },
  );

  const initial: HomepageInitial = {
    curation: curationResult?.curation ?? null,
    behavior: curationResult?.behavior ?? DEFAULT_BEHAVIOR,
    rawCurationCount: curationResult?.raw_curation_count ?? 0,
    liveRows: catalogResult.stories,
    pollRails: pollsResult,
    session,
    seededModalComments,
    votedStoryIds,
    heroDivisiveIds,
    heroPollQuestions,
    rotatingCategoryToday,
    coldStartFloor,
    heroVerdicts: catalogPollData.heroVerdicts,
    posterVoteCounts: catalogPollData.posterVoteCounts,
  };
  console.info("[lorewire homepage ssr]", {
    curation_count: initial.rawCurationCount,
    surface_counts: initial.curation
      ? Object.fromEntries(
          Object.entries(initial.curation).map(([k, v]) => [k, v.length]),
        )
      : null,
    live_count: initial.liveRows.length,
    polls_counts: {
      divisive: initial.pollRails.rails.divisive.length,
      agreed: initial.pollRails.rails.agreed.length,
      unpopular: initial.pollRails.rails.unpopular.length,
    },
    signed_in: initial.session !== null,
    voted_story_ids: initial.votedStoryIds.length,
    hero_divisive_ids: initial.heroDivisiveIds.length,
    hero_poll_questions: Object.keys(initial.heroPollQuestions).length,
    rotating_category: initial.rotatingCategoryToday,
    cold_start_floor: initial.coldStartFloor,
    hero_verdicts: Object.keys(initial.heroVerdicts).length,
    poster_vote_counts: Object.keys(initial.posterVoteCounts).length,
    ms: Date.now() - t0,
  });
  return initial;
}
