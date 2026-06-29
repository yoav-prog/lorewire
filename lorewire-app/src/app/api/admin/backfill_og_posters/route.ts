// One-shot backfill for stories.short_config.og_poster_landscape_url.
//
// Phase 3 (per _plans/2026-06-29-phase-3-og-poster-cards.md). The
// publisher hook already triggers `ensureOgPoster` on every NEW
// publish; this route exists for the cold-start case (every story
// published before Phase 3 deploy) AND for the case where
// `POSTER_VERSION` is bumped (invalidates the cached URLs across
// the whole catalog).
//
// The chairman's verdict explicitly rejected a recurring cron for v1
// because the original "scan-the-whole-table every hour" shape
// re-attempts guard-rejected stories forever (Contrarian Failure Mode
// #1). This route uses the per-story `og_poster_attempted_at` stamp
// to skip stories that just failed — they wait the 7-day re-attempt
// window before another LLM token / Cloud Run cycle gets spent.
//
// Auth: session-based admin check, same shape as
// `/api/admin/backfill_short_durations`. NOT the CRON_SECRET bearer.
//
// Two methods:
//
//   GET  /api/admin/backfill_og_posters?dry=1&limit=N
//        → dry-run: lists what WOULD be processed (or skipped).
//        No LLM calls, no Cloud Run renders, no DB writes.
//
//   POST /api/admin/backfill_og_posters?limit=N[&force=1]
//        → actually calls `ensureOgPoster` for each candidate. Returns
//        per-row outcomes. Default limit: 30 (keeps batches small so a
//        Cloud Run hiccup doesn't blow the whole route's budget).
//        `force=1` bypasses the per-story 7-day re-attempt cooldown (but
//        NOT a per-story disable) — use after fixing a systemic cause
//        that stamped otherwise-good stories.

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/dal";
import { all } from "@/lib/db";
import { parseShortConfig } from "@/lib/short-config";
import {
  ensureOgPoster,
  shouldReattemptOgPoster,
} from "@/lib/short-poster";

/** Hard cap so a typo-ed `?limit=99999` can't melt the route. The
 *  per-row LLM + Cloud Run round-trip is ~3-5 s on cache miss; at 30
 *  per run the worst-case is ~2.5 min, well under Vercel's 800 s
 *  route timeout. Anything larger and we'd need streaming responses. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

export const maxDuration = 800;

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[backfill og-poster ${event}]`, JSON.stringify(fields));
}

type RowOutcome =
  | {
      story_id: string;
      outcome: "rendered";
      hash: string;
      url: string;
    }
  | {
      story_id: string;
      outcome: "cached";
      hash: string;
      url: string;
    }
  | {
      story_id: string;
      outcome: "skipped";
      reason:
        | "disabled_per_story"
        | "reattempt_window"
        | "helper_returned_null"
        | "would_render_dry_run";
    }
  | { story_id: string; outcome: "failed"; error: string };

export interface BackfillOgPosterResult {
  candidates: number;
  rendered: number;
  cached: number;
  skipped: number;
  failed: number;
  outcomes: RowOutcome[];
}

interface CandidateRow {
  storyId: string;
  shortConfigJson: string | null;
}

/** Pull every published story whose `short_config` either doesn't
 *  exist yet OR doesn't contain `og_poster_landscape_url`. The
 *  attempt-window filtering happens in TS (the `shouldReattemptOgPoster`
 *  call) so the SQL stays portable across SQLite + Postgres. */
async function loadCandidates(): Promise<CandidateRow[]> {
  const rows = await all<{ id: string; short_config: string | null }>(
    "SELECT id, short_config FROM stories WHERE status = 'published' " +
      "AND (short_config IS NULL " +
      "  OR short_config NOT LIKE '%og_poster_landscape_url%') " +
      "ORDER BY COALESCE(updated_at, created_at) DESC",
  );
  return rows.map((r) => ({
    storyId: r.id,
    shortConfigJson: r.short_config,
  }));
}

/** Decide whether a candidate is eligible RIGHT NOW. Returns null when
 *  the row passes; returns a skip reason when it doesn't. The reason
 *  flows into the response so an admin can see WHY the script left
 *  certain stories alone. */
function shouldProcess(
  row: CandidateRow,
  now: number,
  force: boolean,
): "disabled_per_story" | "reattempt_window" | null {
  if (!row.shortConfigJson) return null;
  let parsed;
  try {
    parsed = parseShortConfig(JSON.parse(row.shortConfigJson));
  } catch {
    // Malformed short_config — treat as eligible; ensureOgPoster
    // will short-circuit cleanly if needed.
    return null;
  }
  if (!parsed.ok) return null;
  // The per-story kill switch is honoured even under ?force — force only
  // bypasses the time-based cooldown, never an admin's explicit disable.
  if (parsed.config.og_poster_disabled) return "disabled_per_story";
  if (
    !force &&
    !shouldReattemptOgPoster(parsed.config.og_poster_attempted_at, now)
  ) {
    return "reattempt_window";
  }
  return null;
}

function parseLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

async function runBackfill(opts: {
  dryRun: boolean;
  limit: number;
  force: boolean;
}): Promise<BackfillOgPosterResult> {
  const { dryRun, limit, force } = opts;
  const t0 = Date.now();
  const candidates = await loadCandidates();
  const now = Date.now();
  const eligible: CandidateRow[] = [];
  const outcomes: RowOutcome[] = [];

  for (const row of candidates) {
    const skipReason = shouldProcess(row, now, force);
    if (skipReason) {
      outcomes.push({
        story_id: row.storyId,
        outcome: "skipped",
        reason: skipReason,
      });
      continue;
    }
    eligible.push(row);
    if (eligible.length >= limit) break;
  }

  let rendered = 0;
  let cached = 0;
  let failed = 0;

  for (const row of eligible) {
    if (dryRun) {
      outcomes.push({
        story_id: row.storyId,
        outcome: "skipped",
        reason: "would_render_dry_run",
      });
      continue;
    }
    try {
      const poster = await ensureOgPoster(row.storyId);
      if (!poster) {
        outcomes.push({
          story_id: row.storyId,
          outcome: "skipped",
          reason: "helper_returned_null",
        });
        continue;
      }
      if (poster.source === "rendered") rendered += 1;
      else cached += 1;
      outcomes.push({
        story_id: row.storyId,
        outcome: poster.source,
        hash: poster.hash,
        url: poster.url,
      });
    } catch (e) {
      failed += 1;
      outcomes.push({
        story_id: row.storyId,
        outcome: "failed",
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      });
    }
  }

  const skipped = outcomes.filter((o) => o.outcome === "skipped").length;
  namespacedLog(dryRun ? "dry_run" : "run", {
    candidates: candidates.length,
    eligible: eligible.length,
    force,
    rendered,
    cached,
    skipped,
    failed,
    elapsed_ms: Date.now() - t0,
  });

  return {
    candidates: candidates.length,
    rendered,
    cached,
    skipped,
    failed,
    outcomes,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  await requireCapability("content.manage");
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const force = url.searchParams.get("force") === "1";
  const limit = parseLimit(url);
  const result = await runBackfill({ dryRun: dry, limit, force });
  return NextResponse.json(result);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  await requireCapability("content.manage");
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const limit = parseLimit(url);
  const result = await runBackfill({ dryRun: false, limit, force });
  return NextResponse.json(result);
}
