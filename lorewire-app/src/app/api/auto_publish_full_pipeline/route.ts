// Vercel cron drain for the Full Pipeline auto-publish queue.
//
// The Python story_jobs_worker flips story_jobs.auto_publish_status to
// 'pending' when:
//   1. The job's source was opted in (reddit_source.full_pipeline=1
//      at enqueue time, propagated onto story_jobs.full_pipeline).
//   2. Every stage of the pipeline succeeded — the worker only calls
//      pipeline/store.py::request_story_job_auto_publish AFTER
//      finish_story_job lands successfully.
//
// This cron picks those rows up and runs the same publish gate the admin
// uses (lib/auto-publish.ts::publishStoryIfReady). On success: row to
// 'done', story.status flips to 'published', autocurate fires, the
// Facebook publisher cron catches the new published row on its next
// tick. On not-ready: row to 'failed' with the missing-list captured so
// the admin can see why and re-process.
//
// Auth: CRON_SECRET Bearer (same as retry_facebook_publishes /
// render_short). Race: two concurrent firings COULD pick up the same row
// and double-flip it to 'published' — harmless because setStatus is
// idempotent on the second call and autoCurateOnPublish is application-
// level idempotent. Tighter guarantee (atomic claim via UPDATE...
// RETURNING) is a follow-up if observability shows it matters.
//
// Plan: _plans/2026-06-24-reddit-source-full-pipeline-toggle.md.

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { all, run } from "@/lib/db";
import { publishStoryIfReady } from "@/lib/auto-publish";

// Cap per cron firing. Each row is a publish + autocurate + 5 revalidate
// paths; 25 is generous for the realistic queue depth (a Process-N of
// 200 Full-Pipeline-armed sources still drains in ~4 cron ticks at this
// cap, well inside an hour).
const BATCH_LIMIT = 25;

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[auto_publish_full_pipeline ${event}]`, JSON.stringify(fields));
}

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  return header === `Bearer ${expected}`;
}

interface PendingRow {
  id: string;
  reddit_id: string;
  story_id: string | null;
}

async function serve(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    namespacedLog("auth_fail", {
      ip: req.headers.get("x-forwarded-for") ?? "unknown",
    });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Pending rows are ones the worker flipped after every stage succeeded.
  // We require status='done' as a belt-and-braces against a worker bug
  // that ever set auto_publish_status='pending' on an unfinished job; the
  // request_story_job_auto_publish helper already guards on that, but
  // costing a publish on an unfinished story would be worse than a
  // wasted cron read so the duplication is intentional.
  const pending = await all<PendingRow>(
    `SELECT id, reddit_id, story_id
     FROM story_jobs
     WHERE auto_publish_status = 'pending'
       AND status = 'done'
     ORDER BY finished_at ASC
     LIMIT ?`,
    [BATCH_LIMIT],
  );

  namespacedLog("scan", { pending: pending.length, cap: BATCH_LIMIT });

  let published = 0;
  let blocked = 0;
  let errored = 0;

  for (const row of pending) {
    try {
      const result = await publishStoryIfReady(row.reddit_id);
      if (result.ok) {
        await run(
          "UPDATE story_jobs SET auto_publish_status='done' WHERE id=?",
          [row.id],
        );
        published += 1;
        namespacedLog("published", {
          job_id: row.id,
          reddit_id: row.reddit_id,
          story_id: result.storyId,
        });
      } else {
        // Capture the missing-list in the error column so the admin can
        // see why the auto-publish gate rejected the row when reviewing
        // /admin/reddit-sources/[reddit_id]. Mirrors the publish_blocked
        // URL param the manual path emits.
        const reason =
          result.reason === "not_ready"
            ? `auto_publish_blocked: ${(result.missing ?? []).join(" | ")}`
            : `auto_publish_blocked: ${result.reason}`;
        await run(
          "UPDATE story_jobs SET auto_publish_status='failed', " +
            "error=COALESCE(error || ' || ' || ?, ?) WHERE id=?",
          [reason, reason, row.id],
        );
        blocked += 1;
        namespacedLog("blocked", {
          job_id: row.id,
          reddit_id: row.reddit_id,
          reason: result.reason,
          missing: result.reason === "not_ready" ? result.missing : undefined,
        });
      }
    } catch (e) {
      // Unexpected error from publishStoryIfReady — leave the row at
      // 'pending' so the next cron tick retries. Log loud enough that
      // an infinitely-pending row gets noticed in observability.
      errored += 1;
      const message = e instanceof Error ? e.message : String(e);
      namespacedLog("error", {
        job_id: row.id,
        reddit_id: row.reddit_id,
        message: message.slice(0, 500),
      });
    }
  }

  namespacedLog("done", {
    drained: pending.length,
    published,
    blocked,
    errored,
  });

  return NextResponse.json({
    drained: pending.length,
    published,
    blocked,
    errored,
  });
}

// Vercel cron calls GET; POST is a manual kick. Both wire to serve().
export async function GET(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export const maxDuration = 300;
