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
import { resolveMediaUrl } from "@/lib/media-url";
import { getSetting } from "@/lib/repo";
import {
  HOMEPAGE_SURFACES,
  listAllCuration,
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
import { readUserSession } from "@/lib/user-session";
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
  console.info("[homepage live catalog load]", {
    count: rows.length,
    limit: safeLimit,
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

type SsrSource = "curation" | "catalog" | "polls" | "session";

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

async function loadSession(): Promise<PublicSession | null> {
  // Read the lw_user JWT cookie. The helper validates signature +
  // expiry; a tampered or expired cookie returns null and the user is
  // treated as anonymous. Wrapped in safeLoad so a USER_SESSION_SECRET
  // misconfiguration on Vercel (the most likely root cause of a thrown
  // error here) doesn't take down the whole homepage.
  const data = await readUserSession();
  if (!data) return null;
  return { userId: data.userId, email: data.email };
}

export async function loadHomepageSSRData(): Promise<HomepageInitial> {
  const t0 = Date.now();
  const [curationResult, catalogResult, pollsResult, session] =
    await Promise.all([
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
    ]);
  const initial: HomepageInitial = {
    curation: curationResult?.curation ?? null,
    behavior: curationResult?.behavior ?? DEFAULT_BEHAVIOR,
    rawCurationCount: curationResult?.raw_curation_count ?? 0,
    liveRows: catalogResult.stories,
    pollRails: pollsResult,
    session,
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
    ms: Date.now() - t0,
  });
  return initial;
}
