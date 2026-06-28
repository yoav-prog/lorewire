// One-shot backfill for stories.duration (M:SS).
//
// Iteration 1 (PR #107) shipped the body+intro+outro derivation
// (lib/duration + homepage-data.loadShortDurationsForStories +
// short-render-queue.formatFullDurationForStory). This route closed the
// gap by retroactively rewriting stories.duration using that sum for
// every short with a _last_rendered_segments stamp.
//
// Iteration 2 (_plans/2026-06-29-actual-mp4-duration.md): the sum still
// misses the splice's post-roll hold + ffmpeg re-encode rounding. Cloud
// Run now ffprobes the spliced MP4 and stamps props.assembled_duration_ms;
// new renders self-correct. For existing rows whose props lack the
// assembled value, we POST the MP4 URL to Cloud Run's `/probe-mp4`
// endpoint, get the actual duration, merge it into props, then write the
// formatted M:SS to stories.duration. Order of preference per candidate:
//   1. props.assembled_duration_ms (already present → no remote call).
//   2. POST /probe-mp4 with stories.video_url → assembled_duration_ms.
//   3. Legacy body+intro+outro sum (current behavior).
//
// Safe-overwrite heuristic kept identical to iteration 1: write the
// recomputed full duration ONLY when the existing stories.duration is
// NULL / "" or equals the formatted body-only value. A hand-typed
// admin override is preserved.
//
// Auth: session-based admin check, same as every other route under
// /api/admin. NOT the CRON_SECRET bearer.
//
// Two methods:
//
//   GET  /api/admin/backfill_short_durations?dry=1  → dry-run: counts
//        candidates and lists what would change without writing. Probes
//        are NOT issued during dry-run; rows that would need a probe are
//        listed with `would_probe: true` so admins can size the eventual
//        POST cost.
//
//   POST /api/admin/backfill_short_durations        → actually writes
//        the updates AND issues `/probe-mp4` calls for rows that need
//        them. Returns counts + per-row outcomes.

import { NextResponse } from "next/server";
import { Agent, fetch as undiciFetch } from "undici";
import { requireCapability } from "@/lib/dal";
import { all, run } from "@/lib/db";
import {
  assembledDurationMsFromPropsJson,
  bodyDurationMsFromPropsJson,
  formatDurationMs,
} from "@/lib/duration";
import {
  formatFullDurationForStory,
  mergeAssembledDurationIntoProps,
} from "@/lib/short-render-queue";

/** Cloud Run /probe-mp4 takes ~5-15 s per call (download + ffprobe) for a
 *  typical short. With a 200-row backfill we want a generous timeout so a
 *  slow individual probe doesn't kill the batch — the route's overall
 *  budget is bounded by `maxDuration = 800` below. */
const PROBE_TIMEOUT_MS = 60_000;

const probeAgent = new Agent({
  headersTimeout: PROBE_TIMEOUT_MS,
  bodyTimeout: PROBE_TIMEOUT_MS,
  keepAliveTimeout: 30_000,
});

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  console.info(
    `[backfill_short_durations ${event}]`,
    JSON.stringify(fields),
  );
}

type RowSource = "assembled-cached" | "assembled-probed" | "sum";

type RowOutcome =
  | {
      story_id: string;
      outcome: "updated";
      from: string | null;
      to: string;
      source: RowSource;
    }
  | {
      story_id: string;
      outcome: "skipped";
      reason:
        | "admin-override"
        | "body-ms-missing"
        | "full-duration-unparseable"
        | "no-change"
        | "would-probe-dry-run";
      current?: string | null;
      body_only?: string | null;
      computed?: string | null;
      would_probe?: boolean;
    }
  | { story_id: string; outcome: "failed"; error: string };

export interface BackfillResult {
  candidates: number;
  updated: number;
  skipped: number;
  failed: number;
  probed: number;
  outcomes: RowOutcome[];
}

interface CandidateRow {
  id: string;
  duration: string | null;
  /** Public MP4 URL the row currently serves. Needed by the probe path
   *  when props lacks `assembled_duration_ms`. */
  videoUrl: string | null;
  /** Latest done short_renders row's props. */
  props: string | null;
  /** Render id of that latest done row — needed so the probe path can
   *  merge `assembled_duration_ms` back onto the source row in
   *  short_renders.props. */
  renderId: string;
}

// Pull every story that has at least one done short_render with non-null
// props. The body-ms / assembled-ms read uses the latest one (matching
// the writer's "latest done" contract); a story with multiple done
// renders only triggers one UPDATE.
async function loadCandidates(): Promise<CandidateRow[]> {
  // Pick the latest done render per story by ordering DESC and deduping
  // in TS. SQL-level GROUP-BY-with-latest is dialect-specific (SQLite vs
  // Postgres); the in-memory dedupe keeps the route portable across both
  // drivers the project ships, same as loadShortDurationsForStories.
  const rows = await all<{
    story_id: string;
    duration: string | null;
    video_url: string | null;
    props: string | null;
    render_id: string;
  }>(
    "SELECT sr.story_id, s.duration, s.video_url, sr.props, sr.id AS render_id " +
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
    out.push({
      id: r.story_id,
      duration: r.duration,
      videoUrl: r.video_url,
      props: r.props,
      renderId: r.render_id,
    });
  }
  return out;
}

/** POST to Cloud Run /probe-mp4 to get the actual MP4 duration in ms.
 *  Returns null on any failure (HTTP error, malformed response, missing
 *  env). Logs the failure so an admin can chase it. The route caller
 *  treats null as "can't probe this row" and falls through to the
 *  legacy sum. */
async function probeMp4DurationMs(url: string): Promise<number | null> {
  const cloudRunUrl = process.env.CLOUD_RUN_RENDER_URL;
  const cronSecret = process.env.CRON_SECRET;
  if (!cloudRunUrl || !cronSecret) {
    namespacedLog("probe_env_missing", {
      cloud_run_url_set: Boolean(cloudRunUrl),
      cron_secret_set: Boolean(cronSecret),
    });
    return null;
  }
  try {
    const resp = await undiciFetch(
      `${cloudRunUrl.replace(/\/$/, "")}/probe-mp4`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cronSecret}`,
        },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        dispatcher: probeAgent,
      },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      namespacedLog("probe_http_error", {
        url,
        status: resp.status,
        body: text.slice(0, 200),
      });
      return null;
    }
    const data = (await resp.json().catch(() => null)) as
      | { duration_ms?: unknown }
      | null;
    const ms = Number(data?.duration_ms);
    if (!Number.isFinite(ms) || ms <= 0) {
      namespacedLog("probe_malformed", { url, data });
      return null;
    }
    return ms;
  } catch (e) {
    namespacedLog("probe_exception", {
      url,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    });
    return null;
  }
}

async function runBackfill(dryRun: boolean): Promise<BackfillResult> {
  const candidates = await loadCandidates();
  const outcomes: RowOutcome[] = [];
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let probed = 0;
  const now = new Date().toISOString();

  for (const c of candidates) {
    try {
      const bodyMs = bodyDurationMsFromPropsJson(c.props);
      const bodyOnly = bodyMs !== null ? formatDurationMs(bodyMs) : null;

      // Resolve the canonical duration through the source-preference
      // chain: cached assembled → fresh probe → legacy sum. Each
      // branch carries the source tag so the response makes clear
      // which path each row took, and so live ops can grep.
      let computed: string | null = null;
      let source: RowSource | null = null;
      const cachedAssembledMs = assembledDurationMsFromPropsJson(c.props);
      if (cachedAssembledMs !== null) {
        computed = formatDurationMs(cachedAssembledMs);
        source = "assembled-cached";
      } else if (c.videoUrl && c.videoUrl.length > 0) {
        // The row's MP4 exists in storage. Probe it via Cloud Run.
        // Dry-run mode never issues the probe (it would still cost
        // Cloud Run time + ffmpeg work); we just flag the row so the
        // admin sees what the real run would touch.
        if (dryRun) {
          outcomes.push({
            story_id: c.id,
            outcome: "skipped",
            reason: "would-probe-dry-run",
            current: c.duration,
            body_only: bodyOnly,
            would_probe: true,
          });
          skipped++;
          continue;
        }
        const probedMs = await probeMp4DurationMs(c.videoUrl);
        if (probedMs !== null) {
          probed++;
          // Merge the probed value back onto the source render's
          // props so future reader paths skip the probe entirely.
          // Best-effort: a merge failure logs but doesn't block the
          // stories.duration write, since the formatted value is
          // already correct.
          try {
            const mergedProps = mergeAssembledDurationIntoProps(
              c.props,
              Math.round(probedMs),
            );
            await run(
              "UPDATE short_renders SET props = ? WHERE id = ?",
              [mergedProps, c.renderId],
            );
          } catch (e) {
            namespacedLog("merge_props_failed", {
              story_id: c.id,
              render_id: c.renderId,
              error: e instanceof Error ? e.message : String(e),
            });
          }
          computed = formatDurationMs(probedMs);
          source = "assembled-probed";
        }
      }
      // Fall back to the legacy sum if neither cached nor probed gave
      // us a value (probe failed, no video_url to probe, or
      // cached-assembled was absent). Body-only is the final floor —
      // never a worse badge than what's shipping today.
      if (computed === null) {
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
        const sumComputed = await formatFullDurationForStory(c.id, bodyMs);
        if (!sumComputed) {
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
        computed = sumComputed;
        source = "sum";
      }

      // Safe-overwrite gate: only touch the row when the existing
      // value is functionally empty (NULL or "" — the admin UI persists
      // an empty input as either depending on the path) OR matches the
      // body-only formula (clearly auto-written by the pre-PR-107
      // writer). A non-empty value that differs from body-only is
      // treated as admin override and left alone. The "" branch is the
      // 2026-06-25 fix for the dry-run that skipped 2/40 stale rows
      // because the column carried "" not NULL.
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
        source: source ?? "sum",
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
    probed,
  });

  return {
    candidates: candidates.length,
    updated,
    skipped,
    failed,
    probed,
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
