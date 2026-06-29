// Vercel cron drain for the bulk Refresh assets state machine.
//
// The /admin/content "Refresh assets" bulk action enqueues a fresh
// voice render and sets stories.refresh_assets_state='voice_pending'.
// This cron watches flagged stories on a 1-minute cadence and walks
// each through three stages:
//
//   voice_pending  → wait for voice_renders.finished_at >
//                    refresh_assets_started_at. Then call
//                    enqueueShortRender(force=true) to kick off a
//                    fresh short generation (which will pick up the
//                    new voice). Advance to short_pending.
//
//   short_pending  → wait for short_renders.finished_at >
//                    refresh_assets_started_at on a status='done'
//                    row. Then flip the latest story_jobs row's
//                    finisher_status to 'pending' so the
//                    /api/run_hero_thumbnail_finisher cron picks it
//                    up and regenerates hero + the 5 thumbnail
//                    variants from the NEW short's character.
//                    Advance to hero_pending.
//
//   hero_pending   → wait for story_jobs.finisher_status='done'
//                    (or for the latest hero image_renders.finished_at
//                    > started_at as a fallback signal for manual
//                    seeds with no story_jobs row). Clear the
//                    state column → done.
//
// Per-story retry counter increments on every tick that doesn't
// advance. Past the cap the flag clears + a giveup log fires so a
// stage stuck waiting on a failed render doesn't pile up infinite
// cron work.
//
// Auth: CRON_SECRET Bearer (same as auto_complete_publish and the
// retry crons).
//
// Plan: _plans/2026-06-25-bulk-complete-and-publish.md follow-up.

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { all, one, run } from "@/lib/db";
import { getSetting } from "@/lib/repo";
import {
  enqueueShortRender,
  latestDoneShortRenderForStory,
} from "@/lib/short-render-queue";

const BATCH_LIMIT = 25;
const DEFAULT_MAX_ATTEMPTS = 30; // 30 ticks × 1min = ~30min budget
const SETTING_KILL_SWITCH = "refresh_assets.enabled";
const SETTING_MAX_ATTEMPTS = "refresh_assets.max_attempts";

type RefreshState = "voice_pending" | "short_pending" | "hero_pending";

function namespacedLog(event: string, fields: Record<string, unknown>): void {
  console.info(`[refresh-assets-cron ${event}]`, JSON.stringify(fields));
}

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  return header === `Bearer ${expected}`;
}

interface FlaggedRow {
  id: string;
  reddit_id: string | null;
  refresh_assets_state: string | null;
  refresh_assets_started_at: string | null;
  narration_style_baseline: string | null;
  length_preset_baseline: string | null;
}

async function serve(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    namespacedLog("auth_fail", {
      ip: req.headers.get("x-forwarded-for") ?? "unknown",
    });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const killSwitch = await getSetting(SETTING_KILL_SWITCH);
  if (killSwitch === "0" || killSwitch === "false") {
    namespacedLog("disabled", { reason: "kill switch" });
    return NextResponse.json({ disabled: true });
  }

  const maxAttempts = await resolveMaxAttempts();

  // Pull every flagged story plus the LATEST short's narration_style +
  // length_preset (needed when advancing voice_pending → short_pending
  // because enqueueShortRender's idempotency key is the (storyId,
  // narration+length) hash). Stories with no baseline short can't be
  // refreshed via this path; they fall through to the giveup branch.
  const flagged = await all<FlaggedRow>(
    `SELECT s.id, s.reddit_id,
            s.refresh_assets_state,
            s.refresh_assets_started_at,
            sr.narration_style AS narration_style_baseline,
            sr.length_preset AS length_preset_baseline
     FROM stories s
     LEFT JOIN (
       SELECT story_id, narration_style, length_preset,
              ROW_NUMBER() OVER (
                PARTITION BY story_id
                ORDER BY requested_at DESC
              ) AS rn
       FROM short_renders
       WHERE status = 'done'
     ) sr ON sr.story_id = s.id AND sr.rn = 1
     WHERE s.refresh_assets_state IS NOT NULL
     ORDER BY s.refresh_assets_started_at ASC
     LIMIT ?`,
    [BATCH_LIMIT],
  );

  namespacedLog("tick", {
    flaggedCount: flagged.length,
    max_attempts: maxAttempts,
  });

  let advanced = 0;
  let stillWaiting = 0;
  let cleared = 0;
  let gaveUp = 0;
  let errored = 0;

  for (const row of flagged) {
    try {
      const state = row.refresh_assets_state as RefreshState | null;
      const startedAt = row.refresh_assets_started_at;
      if (!state || !startedAt) {
        // Defensive — should be impossible given the WHERE clause.
        // Clear so the row doesn't loop forever.
        await clearState(row.id, "invalid_state_or_no_started_at");
        cleared += 1;
        continue;
      }

      const result = await advance(row, state, startedAt);
      namespacedLog("step", {
        story_id: row.id,
        from_state: state,
        result: result.kind,
        ...(result.message ? { message: result.message } : {}),
      });

      switch (result.kind) {
        case "advanced":
          advanced += 1;
          break;
        case "waiting":
          await bumpAttempts(row.id);
          {
            const attempts = await currentAttempts(row.id);
            if (maxAttempts > 0 && attempts >= maxAttempts) {
              await clearState(row.id, `max_attempts (${attempts})`);
              gaveUp += 1;
              namespacedLog("giveup", {
                story_id: row.id,
                attempts,
                last_state: state,
              });
            } else {
              stillWaiting += 1;
            }
          }
          break;
        case "cleared":
          cleared += 1;
          revalidatePath(`/admin/stories/${row.id}`);
          revalidatePath("/admin/content");
          break;
        case "errored":
          await clearState(row.id, result.message ?? "errored");
          errored += 1;
          break;
      }
    } catch (e) {
      errored += 1;
      const message = e instanceof Error ? e.message : String(e);
      namespacedLog("exception", {
        story_id: row.id,
        message: message.slice(0, 500),
      });
      // Don't clear the flag on a throw — could be a transient driver
      // hiccup. Cap-via-attempts will give up eventually.
    }
  }

  namespacedLog("done", {
    drained: flagged.length,
    advanced,
    still_waiting: stillWaiting,
    cleared,
    gave_up: gaveUp,
    errored,
  });

  return NextResponse.json({
    drained: flagged.length,
    advanced,
    still_waiting: stillWaiting,
    cleared,
    gave_up: gaveUp,
    errored,
  });
}

// ─── State transitions ───────────────────────────────────────────────────────

type StepResult =
  | { kind: "advanced"; message?: string }
  | { kind: "waiting"; message?: string }
  | { kind: "cleared"; message?: string }
  | { kind: "errored"; message?: string };

async function advance(
  row: FlaggedRow,
  state: RefreshState,
  startedAt: string,
): Promise<StepResult> {
  switch (state) {
    case "voice_pending":
      return advanceVoicePending(row, startedAt);
    case "short_pending":
      return advanceShortPending(row, startedAt);
    case "hero_pending":
      return advanceHeroPending(row, startedAt);
  }
}

async function advanceVoicePending(
  row: FlaggedRow,
  startedAt: string,
): Promise<StepResult> {
  const voice = await one<{ status: string; finished_at: string | null }>(
    `SELECT status, finished_at FROM voice_renders
     WHERE story_id = ?
     ORDER BY requested_at DESC LIMIT 1`,
    [row.id],
  );
  if (!voice) {
    return { kind: "waiting", message: "no voice_renders row yet" };
  }
  if (voice.status === "error" || voice.status === "cancelled") {
    return { kind: "errored", message: `voice ${voice.status}` };
  }
  if (
    voice.status !== "done" ||
    !voice.finished_at ||
    voice.finished_at <= startedAt
  ) {
    return { kind: "waiting", message: `voice ${voice.status}` };
  }
  // Voice is done AND newer than started_at — kick the short render
  // with force=true so the existing done short_renders row resets +
  // re-generates from scratch (picking up the new voice). Use the
  // baseline's narration_style + length_preset so the idempotency
  // key matches the existing row and force resets it instead of
  // creating a parallel duplicate.
  await enqueueShortRender(
    row.id,
    row.narration_style_baseline,
    row.length_preset_baseline,
    "refresh-assets-cron",
    { force: true },
  );
  await run(
    "UPDATE stories SET refresh_assets_state = 'short_pending' WHERE id = ?",
    [row.id],
  );
  return { kind: "advanced", message: "short render kicked" };
}

async function advanceShortPending(
  row: FlaggedRow,
  startedAt: string,
): Promise<StepResult> {
  const short = await latestDoneShortRenderForStory(row.id);
  if (!short || !short.finished_at || short.finished_at <= startedAt) {
    return { kind: "waiting", message: "short still generating" };
  }
  // Short is done AND newer than started_at — trigger the
  // hero+thumbnail finisher by flipping the latest story_jobs row's
  // finisher_status back to 'pending'. The
  // /api/run_hero_thumbnail_finisher cron picks it up on its next
  // 2-min tick and regenerates hero + the 5 thumbnail variants from
  // the NEW short's character.
  if (!row.reddit_id) {
    // Manual-seed story with no story_jobs row to flip. We can't
    // trigger the finisher; clear the flag with a note so the
    // operator knows the hero+thumbnails won't auto-refresh.
    return {
      kind: "cleared",
      message:
        "no reddit_id / story_jobs row — hero+thumbnails not auto-refreshed",
    };
  }
  // CRITICAL: the finisher in pipeline/media.py has a resume
  // optimization — it sees the existing hero / thumbnail URLs on
  // the story row and emits `variant_resumed ... already persisted
  // — skipping i2i` instead of regenerating. For our refresh chain
  // that's exactly the wrong behavior: the whole point is fresh
  // variants from the NEW short's character. NULL the 5 columns
  // before flipping finisher_status so the finisher treats every
  // variant as a fresh i2i call.
  await run(
    "UPDATE stories SET hero_image = NULL, hero_image_landscape = NULL, " +
      "thumbnail_image = NULL, thumbnail_image_landscape = NULL, " +
      "thumbnail_image_square = NULL WHERE id = ?",
    [row.id],
  );
  await run(
    "UPDATE story_jobs SET finisher_status = 'pending' " +
      "WHERE id = (SELECT id FROM story_jobs WHERE reddit_id = ? " +
      "ORDER BY requested_at DESC LIMIT 1)",
    [row.reddit_id],
  );
  await run(
    "UPDATE stories SET refresh_assets_state = 'hero_pending' WHERE id = ?",
    [row.id],
  );
  return { kind: "advanced", message: "hero variants cleared + finisher flagged" };
}

async function advanceHeroPending(
  row: FlaggedRow,
  startedAt: string,
): Promise<StepResult> {
  // The finisher writes hero+thumbnails directly onto the stories
  // row and flips story_jobs.finisher_status to 'done'. We watch
  // both signals — story_jobs.finisher_status='done' is the cleanest
  // when reddit_id is set; for manual seeds we'd have fallen out
  // earlier so this branch is reddit-row-only.
  if (!row.reddit_id) {
    return {
      kind: "cleared",
      message: "no reddit_id at hero_pending (shouldn't happen)",
    };
  }
  const job = await one<{
    finisher_status: string | null;
    finished_at: string | null;
  }>(
    `SELECT finisher_status, finished_at FROM story_jobs
     WHERE reddit_id = ?
     ORDER BY requested_at DESC LIMIT 1`,
    [row.reddit_id],
  );
  if (!job) {
    return { kind: "cleared", message: "story_jobs row vanished" };
  }
  if (
    job.finisher_status === "done" &&
    job.finished_at &&
    job.finished_at > startedAt
  ) {
    return { kind: "cleared", message: "finisher done" };
  }
  if (job.finisher_status === "failed") {
    return { kind: "errored", message: "finisher failed" };
  }
  return { kind: "waiting", message: `finisher ${job.finisher_status ?? "pending"}` };
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function clearState(storyId: string, reason: string): Promise<void> {
  await run(
    "UPDATE stories SET refresh_assets_state = NULL, " +
      "refresh_assets_started_at = NULL, refresh_assets_attempts = 0 " +
      "WHERE id = ?",
    [storyId],
  );
  namespacedLog("clear", { story_id: storyId, reason });
}

async function bumpAttempts(storyId: string): Promise<void> {
  await run(
    "UPDATE stories SET refresh_assets_attempts = " +
      "COALESCE(refresh_assets_attempts, 0) + 1 WHERE id = ?",
    [storyId],
  );
}

async function currentAttempts(storyId: string): Promise<number> {
  const row = await one<{ n: number | null }>(
    "SELECT refresh_assets_attempts AS n FROM stories WHERE id = ?",
    [storyId],
  );
  return row?.n ?? 0;
}

async function resolveMaxAttempts(): Promise<number> {
  const raw = await getSetting(SETTING_MAX_ATTEMPTS);
  if (!raw) return DEFAULT_MAX_ATTEMPTS;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_ATTEMPTS;
  return n;
}

// ─── Route handlers ──────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export const maxDuration = 300;
