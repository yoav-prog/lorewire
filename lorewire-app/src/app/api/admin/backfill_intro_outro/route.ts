// Phase 5 of _plans/2026-06-15-cloud-run-intro-outro-splice.md.
//
// One-shot backfill: enqueues a force re-render for every story that
// already has a video, so the Cloud Run path produces a fresh MP4 with
// intro + outro spliced in (Phase 4 of the plan made that splice work).
// Without this backfill, every story rendered before the Phase 4 deploy
// keeps its body-only video_url until someone clicks Render on it.
//
// Auth: session-based admin check, same as every other route under
// /api/admin. NOT the CRON_SECRET bearer the render_video cron uses —
// this is a human-triggered backfill, not a machine drain.
//
// Two methods:
//
//   GET  /api/admin/backfill_intro_outro?dry=1  → dry-run: counts the
//        candidates (stories with video_url + at least one of
//        skip_intro=0 / skip_outro=0) without enqueueing anything.
//
//   POST /api/admin/backfill_intro_outro        → actually enqueues a
//        force re-render per candidate. Returns the list of enqueued
//        (story_id, render_id) tuples plus any failures so the caller
//        can audit.
//
// Idempotency: the force-enqueue helper attaches a millisecond suffix
// to the synthetic config hash, so re-running this endpoint creates
// MORE rows rather than merging with prior force-runs. That's safe —
// the cron drains them in FIFO order and each subsequent render writes
// the same (better) URL onto the story. But it does add cost, so the
// caller should prefer the dry-run first, then a single POST.
//
// Observability: every enqueue emits the standard `queued` event with a
// `backfill: true` payload tag so the render-history timeline shows
// which renders came from this backfill versus an editor click.

import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/dal";
import { listStories } from "@/lib/repo";
import {
  forceEnqueueRender,
  logVideoRenderEvent,
} from "@/lib/video-render-queue";

/** Stable synthetic hash all backfill rows share as their prefix —
 *  prefix grouping in render-history makes the backfill grepable. The
 *  force-enqueue helper appends `:force-<ISO timestamp>` so each row
 *  still gets a globally unique config_hash. */
const BACKFILL_HASH_PREFIX = "backfill-intro-outro";

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  console.info(
    `[backfill_intro_outro ${event}]`,
    JSON.stringify(fields),
  );
}

interface BackfillResult {
  candidates: number;
  enqueued: Array<{ story_id: string; render_id: string }>;
  failed: Array<{ story_id: string; error: string }>;
  skipped_both_flags: number;
}

/** A story is a candidate iff it already has a video_url (so the
 *  backfill has something to improve on) AND it doesn't have BOTH
 *  skip flags set (a story that opts out of intro AND outro wouldn't
 *  change). One-sided skips still count — the story might gain just an
 *  outro, for example. */
function isCandidate(story: {
  video_url?: string | null;
  skip_intro?: number | null;
  skip_outro?: number | null;
}): boolean {
  if (!story.video_url) return false;
  if (story.skip_intro && story.skip_outro) return false;
  return true;
}

async function runBackfill(dryRun: boolean): Promise<BackfillResult> {
  const stories = await listStories({});
  let bothSkipped = 0;
  const candidates: string[] = [];
  for (const s of stories) {
    if (!s.video_url) continue;
    if (s.skip_intro && s.skip_outro) {
      bothSkipped++;
      continue;
    }
    if (isCandidate(s)) candidates.push(s.id);
  }

  if (dryRun) {
    return {
      candidates: candidates.length,
      enqueued: [],
      failed: [],
      skipped_both_flags: bothSkipped,
    };
  }

  const enqueued: Array<{ story_id: string; render_id: string }> = [];
  const failed: Array<{ story_id: string; error: string }> = [];

  // Serial loop, not Promise.all: a Vercel cron-style burst against the
  // DB is gentler when we don't fire N inserts at once. N here is the
  // total number of rendered stories — currently ~dozens, so the loop
  // finishes well inside the function timeout.
  for (const storyId of candidates) {
    try {
      const row = await forceEnqueueRender(
        storyId,
        BACKFILL_HASH_PREFIX,
        "admin-backfill",
      );
      enqueued.push({ story_id: storyId, render_id: row.id });
      // Tag the row's render history with backfill: true so the editor
      // shows where this attempt came from. Best-effort — a logging
      // failure shouldn't block subsequent enqueues.
      try {
        await logVideoRenderEvent(row.id, "queued", {
          message: "Enqueued by intro/outro backfill.",
          payload: { backfill: true, source: BACKFILL_HASH_PREFIX },
        });
      } catch (logErr) {
        namespacedLog("event_log_fail", {
          story_id: storyId,
          render_id: row.id,
          error: logErr instanceof Error ? logErr.message : String(logErr),
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      failed.push({ story_id: storyId, error: msg });
      namespacedLog("enqueue_fail", { story_id: storyId, error: msg });
    }
  }

  namespacedLog("done", {
    candidates: candidates.length,
    enqueued: enqueued.length,
    failed: failed.length,
    skipped_both_flags: bothSkipped,
  });

  return {
    candidates: candidates.length,
    enqueued,
    failed,
    skipped_both_flags: bothSkipped,
  };
}

export async function GET(req: Request): Promise<NextResponse> {
  await requireCapability("content.manage");
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  if (!dry) {
    // GET is for dry-runs only — the actual enqueue is POST so a stray
    // browser visit can't fire writes by mistake.
    return NextResponse.json(
      { error: "use POST to actually enqueue, or pass ?dry=1 for a count" },
      { status: 400 },
    );
  }
  const result = await runBackfill(true);
  namespacedLog("dry_run", {
    candidates: result.candidates,
    skipped_both_flags: result.skipped_both_flags,
  });
  return NextResponse.json({ dry_run: true, ...result });
}

export async function POST(): Promise<NextResponse> {
  await requireCapability("content.manage");
  const result = await runBackfill(false);
  return NextResponse.json({ dry_run: false, ...result });
}

// Vercel function ceiling for the larger backfills. The serial loop is
// cheap (one INSERT + one event-log INSERT per story); 800 s is plenty
// for thousands of stories. Matches `render_video/route.ts` so prod
// budget settings stay consistent.
export const maxDuration = 800;
