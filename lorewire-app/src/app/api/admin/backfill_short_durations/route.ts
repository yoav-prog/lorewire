// One-shot backfill for stories.duration (M:SS).
//
// After PR #107 shipped the body+intro+outro derivation (lib/duration +
// homepage-data.loadShortDurationsForStories + short-render-queue.
// formatFullDurationForStory), existing rows kept showing the stale
// body-only badge: the reader path skips non-null stories.duration per
// the "admin override wins" precedence, and the writer path only
// recomputes on the next applyShortToStory call. This route closes the
// gap by retroactively rewriting stories.duration for every short with a
// _last_rendered_segments stamp.
//
// Safe-overwrite heuristic: write the recomputed full duration ONLY when
// the existing stories.duration is NULL or equals the formatted body-only
// value (i.e. looks auto-written by the pre-PR-107 writer). Anything else
// is left alone — treated as a real admin override so we never silently
// nuke a hand-typed M:SS. The cost of false-negative (admin happened to
// type a value matching body-only) is small: badge stays "wrong" until
// admin retypes; the cost of false-positive (overwriting an intentional
// override) is worse.
//
// Auth: session-based admin check, same as every other route under
// /api/admin. NOT the CRON_SECRET bearer.
//
// Two methods:
//
//   GET  /api/admin/backfill_short_durations?dry=1  → dry-run: counts
//        candidates and lists what would change without writing.
//
//   POST /api/admin/backfill_short_durations        → actually writes
//        the updates. Returns counts + per-row outcomes.

import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/dal";
import { all, run } from "@/lib/db";
import {
  bodyDurationMsFromPropsJson,
  formatDurationMs,
} from "@/lib/duration";
import { formatFullDurationForStory } from "@/lib/short-render-queue";

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  console.info(
    `[backfill_short_durations ${event}]`,
    JSON.stringify(fields),
  );
}

type RowOutcome =
  | { story_id: string; outcome: "updated"; from: string | null; to: string }
  | {
      story_id: string;
      outcome: "skipped";
      reason:
        | "admin-override"
        | "body-ms-missing"
        | "full-duration-unparseable"
        | "no-change";
      current?: string | null;
      body_only?: string | null;
      computed?: string | null;
    }
  | { story_id: string; outcome: "failed"; error: string };

export interface BackfillResult {
  candidates: number;
  updated: number;
  skipped: number;
  failed: number;
  outcomes: RowOutcome[];
}

interface CandidateRow {
  id: string;
  duration: string | null;
  props: string | null;
}

// Pull every story that has at least one done short_render with non-null
// props. The body-ms read uses the latest one (matching the writer's
// "latest done" contract); a story with multiple done renders only
// triggers one UPDATE.
async function loadCandidates(): Promise<CandidateRow[]> {
  // Pick the latest done render per story by ordering DESC and deduping
  // in TS. SQL-level GROUP-BY-with-latest is dialect-specific (SQLite vs
  // Postgres); the in-memory dedupe keeps the route portable across both
  // drivers the project ships, same as loadShortDurationsForStories.
  const rows = await all<{
    story_id: string;
    duration: string | null;
    props: string | null;
  }>(
    "SELECT sr.story_id, s.duration, sr.props " +
      "FROM short_renders sr " +
      "JOIN stories s ON s.id = sr.story_id " +
      "WHERE sr.status = 'done' AND sr.props IS NOT NULL " +
      "ORDER BY COALESCE(sr.finished_at, sr.started_at, sr.requested_at) DESC",
  );
  const seen = new Set<string>();
  const out: CandidateRow[] = [];
  for (const r of rows) {
    if (seen.has(r.story_id)) continue;
    seen.add(r.story_id);
    out.push({ id: r.story_id, duration: r.duration, props: r.props });
  }
  return out;
}

async function runBackfill(dryRun: boolean): Promise<BackfillResult> {
  const candidates = await loadCandidates();
  const outcomes: RowOutcome[] = [];
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const now = new Date().toISOString();

  for (const c of candidates) {
    try {
      const bodyMs = bodyDurationMsFromPropsJson(c.props);
      if (bodyMs === null) {
        outcomes.push({
          story_id: c.id,
          outcome: "skipped",
          reason: "body-ms-missing",
          current: c.duration,
        });
        skipped++;
        continue;
      }
      const bodyOnly = formatDurationMs(bodyMs);
      const computed = await formatFullDurationForStory(c.id, bodyMs);
      if (!computed) {
        outcomes.push({
          story_id: c.id,
          outcome: "skipped",
          reason: "full-duration-unparseable",
          current: c.duration,
          body_only: bodyOnly,
        });
        skipped++;
        continue;
      }
      // Safe-overwrite gate: only touch the row when the existing value
      // is functionally empty (NULL or "" — both mean "no admin override
      // has ever been stored"; the admin UI persists an empty input as
      // either depending on the path) OR matches body-only (clearly
      // auto-written by the pre-PR-107 writer). A non-empty value that
      // differs from body-only is treated as admin override and left
      // alone. The "" branch is the 2026-06-25 fix for the dry-run
      // that skipped 2/40 stale rows because the column carried "" not
      // NULL.
      const isEmpty = c.duration === null || c.duration === "";
      const isAutoWritten = isEmpty || c.duration === bodyOnly;
      if (!isAutoWritten) {
        outcomes.push({
          story_id: c.id,
          outcome: "skipped",
          reason: "admin-override",
          current: c.duration,
          body_only: bodyOnly,
          computed,
        });
        skipped++;
        continue;
      }
      if (c.duration === computed) {
        outcomes.push({
          story_id: c.id,
          outcome: "skipped",
          reason: "no-change",
          current: c.duration,
          computed,
        });
        skipped++;
        continue;
      }
      if (!dryRun) {
        await run(
          "UPDATE stories SET duration = ?, updated_at = ? WHERE id = ?",
          [computed, now, c.id],
        );
      }
      outcomes.push({
        story_id: c.id,
        outcome: "updated",
        from: c.duration,
        to: computed,
      });
      updated++;
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      outcomes.push({ story_id: c.id, outcome: "failed", error: msg });
      failed++;
      namespacedLog("row_failed", { story_id: c.id, error: msg });
    }
  }

  namespacedLog(dryRun ? "dry_run" : "done", {
    candidates: candidates.length,
    updated,
    skipped,
    failed,
  });

  return {
    candidates: candidates.length,
    updated,
    skipped,
    failed,
    outcomes,
  };
}

export async function GET(req: Request): Promise<NextResponse> {
  await requireCapability("content.manage");
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  if (!dry) {
    // GET is dry-only — actual writes go through POST so a stray browser
    // visit can't mutate the DB. Matches the backfill_intro_outro
    // contract.
    return NextResponse.json(
      { error: "use POST to actually backfill, or pass ?dry=1 for a preview" },
      { status: 400 },
    );
  }
  const result = await runBackfill(true);
  return NextResponse.json({ dry_run: true, ...result });
}

export async function POST(): Promise<NextResponse> {
  await requireCapability("content.manage");
  const result = await runBackfill(false);
  return NextResponse.json({ dry_run: false, ...result });
}

// Matches the backfill_intro_outro budget so production limits stay
// consistent across the admin one-shot endpoints.
export const maxDuration = 800;
