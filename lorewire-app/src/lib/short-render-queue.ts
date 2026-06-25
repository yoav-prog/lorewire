// Server-only helpers for the short_renders queue (article shorts).
//
// The TS mirror of pipeline/store.py's short_renders helpers, modelled on
// video-render-queue.ts. The "Generate short" admin action calls
// enqueueShortRender; the Python worker (pipeline/short_render_worker.py) and
// the Vercel cron drain the queue.
//
// Idempotency key is (story_id, config_hash) where config_hash is a hash of the
// creation options (narration vibe + length preset). Picking a different vibe or
// length is a genuinely different short, so it gets its own row and they can
// coexist for the same story. A click that matches an existing error/cancelled
// row resets it to queued (retry); a match on a queued/rendering/done row is an
// idempotent no-op.

import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";
import {
  bodyDurationMsFromPropsJson,
  formatDurationMs,
  fullDurationMsFromParts,
  parseLastRenderedSegments,
} from "@/lib/duration";

export type ShortRenderStatus =
  | "queued"
  | "generating" // generation drain is building script + frames + voice
  | "rendering"
  | "done"
  | "error"
  | "cancelled";

export interface ShortRenderRow {
  id: string;
  story_id: string;
  config_hash: string;
  narration_style: string | null;
  length_preset: string | null;
  status: ShortRenderStatus;
  phase: string | null;
  progress: number;
  error: string | null;
  output_url: string | null;
  /** The generated DoodleShort props JSON (set by the generation drain). Null
   *  until generation completes; the render cron only claims rows where this is
   *  set, then POSTs it to Cloud Run /render as inputProps. */
  props: string | null;
  requested_by: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** Phase-3 partial-re-render dispatch marker (lib/schema.ts comment).
   *  NULL = full generation; 'A' = assembly-only; 'B' = voice + assembly. */
  lane: string | null;
  /** Lane B initialization payload (JSON). */
  lane_inputs: string | null;
}

const COLS =
  "id, story_id, config_hash, narration_style, length_preset, status, phase, progress, error, output_url, props, requested_by, requested_at, started_at, finished_at, lane, lane_inputs";

// Hash the creation options into the idempotency key. Same narration vibe +
// length preset means "the same short", so repeat clicks coalesce; a different
// pick produces a different hash and its own row.
export function hashShortConfig(
  narrationStyle: string | null,
  lengthPreset: string | null,
): string {
  const canonical = JSON.stringify({
    narration_style: narrationStyle ?? "",
    length_preset: lengthPreset ?? "",
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// Insert a queued row OR return/reset the existing one for (story_id,
// config_hash). error/cancelled rows reset to queued so a click means "retry".
// `force` (the Regenerate button) also resets a DONE row and clears its props
// so it re-runs the FULL generation (new images + voice), not just a re-render
// of the old props — that's how the admin makes a genuinely new short for the
// same vibe + length. An in-flight row (queued/generating/rendering) is never
// reset, even with force, so a click can't interrupt a running generation.
export async function enqueueShortRender(
  storyId: string,
  narrationStyle: string | null,
  lengthPreset: string | null,
  requestedBy: string | null,
  opts: { force?: boolean } = {},
): Promise<ShortRenderRow> {
  const force = opts.force ?? false;
  const configHash = hashShortConfig(narrationStyle, lengthPreset);
  const existing = await one<ShortRenderRow>(
    `SELECT ${COLS} FROM short_renders WHERE story_id = ? AND config_hash = ?`,
    [storyId, configHash],
  );
  if (existing) {
    const isFailed =
      existing.status === "error" || existing.status === "cancelled";
    const isDone = existing.status === "done";
    if (isFailed || (force && isDone)) {
      const retryNow = new Date().toISOString();
      // force = "make a brand new one": clear props so the row goes back
      // through the generation drain. A plain failed-row retry keeps props so a
      // render-stage failure re-renders without paying to re-generate.
      const propsClause = force ? ", props = NULL" : "";
      const previousStatus = existing.status;
      await run(
        `UPDATE short_renders
           SET status = 'queued', phase = NULL, progress = 0, error = NULL,
               output_url = NULL, requested_by = ?, requested_at = ?,
               started_at = NULL, finished_at = NULL, attempts = 0${propsClause}
         WHERE id = ? AND status = ?`,
        [requestedBy, retryNow, existing.id, previousStatus],
      );
      const reset = await one<ShortRenderRow>(
        `SELECT ${COLS} FROM short_renders WHERE id = ?`,
        [existing.id],
      );
      if (!reset) throw new Error("[short render queue] reset row missing");
      // Emit the right reset event so the timeline shows what just happened.
      // `forced_done_reset` is its own event because "the user wanted a brand
      // new short" is a different signal from "retry a failure"; both bypass
      // idempotency but the cost story is different (force reruns generation).
      const event = force && isDone
        ? "forced_done_reset"
        : existing.status === "error"
          ? "reset_from_error"
          : "reset_from_cancelled";
      await logShortRenderEvent(reset.id, event, {
        message: `Reset from ${previousStatus} to queued`,
        payload: { previous_status: previousStatus, force, cleared_props: force },
      });
      return reset;
    }
    if (force && (existing.status === "queued" || existing.status === "generating" || existing.status === "rendering")) {
      // Force on an in-flight row is the surface the Restart button hits when
      // the user clicks twice. Don't reset, but log the no-op so the timeline
      // surfaces "I tried to restart while already running."
      await logShortRenderEvent(existing.id, "idempotent_hit", {
        message: "Restart click ignored (already in flight)",
        payload: { current_status: existing.status, current_phase: existing.phase },
      });
    }
    return existing; // idempotent hit on in-flight, or done without force
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO short_renders
      (id, story_id, config_hash, narration_style, length_preset, status, phase,
       progress, error, output_url, requested_by, requested_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, 'queued', NULL, 0, NULL, NULL, ?, ?, NULL, NULL)`,
    [id, storyId, configHash, narrationStyle, lengthPreset, requestedBy, now],
  );
  const fresh = await one<ShortRenderRow>(
    `SELECT ${COLS} FROM short_renders WHERE id = ?`,
    [id],
  );
  if (!fresh) throw new Error("[short render queue] insert row missing");
  await logShortRenderEvent(id, "queued", {
    message: "Short render request received",
    payload: {
      narration_style: narrationStyle,
      length_preset: lengthPreset,
      config_hash_prefix: configHash.slice(0, 8),
    },
  });
  return fresh;
}

// Atomic claim of the oldest queued short render (for the Vercel cron). Mirrors
// pipeline/store.py:claim_next_short_render. Two-step peek + conditional UPDATE
// works identically on SQLite and Postgres; a losing racer gets 0 rows.
export async function claimNextShortRender(): Promise<ShortRenderRow | null> {
  const now = new Date().toISOString();
  // Only claim rows the generation drain has finished (props set). Queued rows
  // without props are still waiting on the generation drain.
  const peek = await one<{ id: string }>(
    `SELECT id FROM short_renders WHERE status = 'queued' AND props IS NOT NULL
     ORDER BY requested_at ASC LIMIT 1`,
  );
  if (!peek) return null;
  await run(
    `UPDATE short_renders SET status = 'rendering', started_at = ?
     WHERE id = ? AND status = 'queued'`,
    [now, peek.id],
  );
  const fresh = await one<ShortRenderRow>(
    `SELECT ${COLS} FROM short_renders WHERE id = ?`,
    [peek.id],
  );
  if (!fresh) return null;
  if (fresh.status !== "rendering" || fresh.started_at !== now) return null;
  await logShortRenderEvent(fresh.id, "claimed", {
    message: "Render claimed by cron",
    payload: { started_at: now },
  });
  return fresh;
}

export async function getShortRender(
  renderId: string,
): Promise<ShortRenderRow | null> {
  return one<ShortRenderRow>(
    `SELECT ${COLS} FROM short_renders WHERE id = ?`,
    [renderId],
  );
}

export async function latestShortRenderForStory(
  storyId: string,
): Promise<ShortRenderRow | null> {
  return one<ShortRenderRow>(
    `SELECT ${COLS} FROM short_renders WHERE story_id = ?
     ORDER BY requested_at DESC LIMIT 1`,
    [storyId],
  );
}

// Latest SUCCESSFUL render — the row Lane A / B / C use as the baseline to
// diff edits against and to seed their new props from. Lane A's first
// click queues a new short_renders row whose status is initially `queued`;
// without this filter `latestShortRenderForStory` would return THAT row on
// the second click and the lane actions would reject with "no baseline
// render". Defense-in-depth filter on `props IS NOT NULL` because the
// builders read props as the merge floor.
export async function latestDoneShortRenderForStory(
  storyId: string,
): Promise<ShortRenderRow | null> {
  return one<ShortRenderRow>(
    `SELECT ${COLS} FROM short_renders
     WHERE story_id = ? AND status = 'done' AND props IS NOT NULL
     ORDER BY requested_at DESC LIMIT 1`,
    [storyId],
  );
}

// Counts short renders requested for a story since `sinceIso`, for the daily cap.
export async function countShortRendersSince(
  storyId: string,
  sinceIso: string,
): Promise<number> {
  const rows = await all<{ c: number | string }>(
    "SELECT COUNT(*) AS c FROM short_renders WHERE story_id = ? AND requested_at >= ?",
    [storyId, sinceIso],
  );
  return Number(rows[0]?.c ?? 0);
}

// Progress update (0..1) + optional phase label. Used by the Vercel cron path.
export async function updateShortRenderProgress(
  renderId: string,
  progress: number,
  phase: string | null = null,
): Promise<void> {
  if (phase !== null) {
    await run(
      `UPDATE short_renders SET progress = ?, phase = ? WHERE id = ?`,
      [progress, phase, renderId],
    );
  } else {
    await run(`UPDATE short_renders SET progress = ? WHERE id = ?`, [
      progress,
      renderId,
    ]);
  }
}

export async function finishShortRender(
  renderId: string,
  outputUrl: string,
): Promise<void> {
  const now = new Date().toISOString();
  await run(
    `UPDATE short_renders SET status = 'done', progress = 1.0, phase = 'done',
       output_url = ?, finished_at = ?
     WHERE id = ? AND status = 'rendering'`,
    [outputUrl, now, renderId],
  );
  await logShortRenderEvent(renderId, "finished", {
    message: "Short render done",
    payload: { url: outputUrl },
  });
}

export async function failShortRender(
  renderId: string,
  error: string,
): Promise<void> {
  const now = new Date().toISOString();
  const capped = (error ?? "unknown error").slice(0, 2000);
  await run(
    `UPDATE short_renders SET status = 'error', error = ?, finished_at = ?
     WHERE id = ? AND status = 'rendering'`,
    [capped, now, renderId],
  );
  await logShortRenderEvent(renderId, "failed", {
    level: "error",
    message: "Short render failed",
    payload: { error: capped },
  });
}

// Point the story's published video at a finished short, so the article serves
// the 9:16 short instead of the long-form video. The long-form MP4 still exists
// at its own GCS key (<story>/video.mp4 vs <story>-short/video.mp4), so this is
// just a pointer swap and is reversible by re-rendering the long-form video.
//
// Also writes stories.duration (M:SS) as the FULL assembled length — body +
// intro + outro segments — so the rail thumbnail badge matches what the
// `<video>` element reports. The intro/outro contribution comes from the
// `_last_rendered_segments` stamp render_short/route.ts writes onto
// stories.short_config after a successful render; when the stamp is missing
// or a segment row was deleted, that side contributes 0 and we fall back to
// body-only (legacy-safe). Overwrites unconditionally — stories.duration's
// contract is "duration of whatever currently plays at video_url", not
// "admin's free-form note". Pass `null` for `propsJson` to skip the duration
// write entirely.
export async function applyShortToStory(
  storyId: string,
  outputUrl: string,
  propsJson: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  const bodyMs = bodyDurationMsFromPropsJson(propsJson);
  const duration = bodyMs !== null
    ? await formatFullDurationForStory(storyId, bodyMs)
    : null;
  if (duration) {
    await run(
      `UPDATE stories SET video_url = ?, duration = ?, updated_at = ? WHERE id = ?`,
      [outputUrl, duration, now, storyId],
    );
  } else {
    await run(`UPDATE stories SET video_url = ?, updated_at = ? WHERE id = ?`, [
      outputUrl,
      now,
      storyId,
    ]);
  }
}

// Resolve "body_ms + spliced intro/outro" to a M:SS string for the writer
// path. Mirrors the read-side fan-out in homepage-data.loadShortDurationsForStories
// but for a single story: pull the short_config stamp, look up segment
// duration_ms for any referenced ids, sum, format. Body-only when the
// stamp is missing/empty so legacy rows still produce a duration.
async function formatFullDurationForStory(
  storyId: string,
  bodyMs: number,
): Promise<string | null> {
  const stampRow = await one<{ short_config: string | null }>(
    "SELECT short_config FROM stories WHERE id = ?",
    [storyId],
  );
  const stamp = parseLastRenderedSegments(stampRow?.short_config ?? null);
  const segIds: string[] = [];
  if (stamp?.intro_segment_id) segIds.push(stamp.intro_segment_id);
  if (stamp?.outro_segment_id) segIds.push(stamp.outro_segment_id);
  const segmentMsById = new Map<string, number>();
  if (segIds.length > 0) {
    const placeholders = segIds.map(() => "?").join(", ");
    const segRows = await all<{ id: string; duration_ms: number | null }>(
      `SELECT id, duration_ms FROM video_segments WHERE id IN (${placeholders})`,
      segIds,
    );
    for (const s of segRows) {
      const n = Number(s.duration_ms);
      if (Number.isFinite(n) && n > 0) segmentMsById.set(s.id, n);
    }
  }
  const introMs = stamp?.intro_segment_id
    ? segmentMsById.get(stamp.intro_segment_id) ?? 0
    : 0;
  const outroMs = stamp?.outro_segment_id
    ? segmentMsById.get(stamp.outro_segment_id) ?? 0
    : 0;
  const totalMs = fullDurationMsFromParts(bodyMs, introMs, outroMs);
  console.info("[short apply duration]", {
    story_id: storyId,
    body_ms: bodyMs,
    intro_ms: introMs,
    outro_ms: outroMs,
    total_ms: totalMs,
  });
  return formatDurationMs(totalMs);
}

// ─── per-row event timeline (2026-06-15 progress log + Stop / Restart) ───────
// Direct port of the video-render-events helpers (lib/video-render-queue.ts:
// 395-486). One row per phase transition along the short's lifecycle —
// queued, script_built, character_built, scene_generated, voice_synth_done,
// render_started, render_done, cancelled, failed. The TS UI reads via
// listShortRenderEvents and renders a timelapse log under the
// ShortRenderControl progress bar.
//
// Writers live on both sides of the orchestrator: TS server actions write
// click-side events (queued, idempotent_hit, reset_from_error, cancelled,
// restart) and the Python worker (pipeline/short_render_worker.py) writes
// every phase transition during generation + render.
//
// Why a separate events table vs piling everything onto the short_renders
// row: the row reflects LATEST state (one error string, one progress
// fraction), not history. The events table is append-only and ordered, so
// the user sees the sequence: "click → reset → claim → script_built →
// scene 5/12 → render_started → finish". When something goes wrong the
// failing step's payload (HTTP status, error text) is preserved.

export type ShortRenderEventLevel = "info" | "warn" | "error";

export interface ShortRenderEventRow {
  id: string;
  render_id: string;
  ts: string;
  level: ShortRenderEventLevel;
  event: string;
  message: string | null;
  /** JSON-encoded structured payload; UI parses + displays inline. */
  payload: string | null;
}

const EVENT_COLS = "id, render_id, ts, level, event, message, payload";

/**
 * Append one event to the timeline for a short_render row. Cheap (~1 ms on
 * SQLite, ~5 ms on Postgres). Swallows write errors because event logging
 * must never break the orchestrator's main path. Mirrors
 * `logVideoRenderEvent` exactly.
 */
export async function logShortRenderEvent(
  renderId: string,
  event: string,
  opts: {
    message?: string;
    level?: ShortRenderEventLevel;
    payload?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const id = randomUUID();
  const ts = new Date().toISOString();
  const level = opts.level ?? "info";
  const message = opts.message ?? null;
  const payload =
    opts.payload === undefined ? null : JSON.stringify(opts.payload);
  try {
    await run(
      `INSERT INTO short_render_events
         (id, render_id, ts, level, event, message, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, renderId, ts, level, event, message, payload],
    );
  } catch (e) {
    // Don't let logging take down the render path. The bracketed console
    // log on the call site still fires elsewhere so the data isn't lost —
    // only the user-facing timeline misses a row.
    // eslint-disable-next-line no-console -- rule 14
    console.warn("[short render queue] event log failed", {
      render_id: renderId,
      event,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Read the event timeline for one short_render row in chronological order
 * (oldest first). 200 is more than enough for a short's lifecycle (typical:
 * 15-25 events; failed-and-retried: ~35).
 */
export async function listShortRenderEvents(
  renderId: string,
  limit = 200,
): Promise<ShortRenderEventRow[]> {
  return all<ShortRenderEventRow>(
    `SELECT ${EVENT_COLS} FROM short_render_events
     WHERE render_id = ?
     ORDER BY ts ASC LIMIT ?`,
    [renderId, limit],
  );
}

/**
 * Cancel a queued or in-flight short_render. Status-gated: only flips
 * `queued` and `generating` rows to `cancelled`; `rendering` (Cloud Run
 * has the MP4 in flight, no clean abort), `done`, `error`, and already
 * `cancelled` are no-ops that return their existing status. Idempotent.
 *
 * Returns the row's status AFTER the call so the caller (server action /
 * Python worker) can decide whether to log an event or refuse a button
 * press. Logs a `cancelled` event on the transition.
 *
 * Mirrors the image-render cancel pattern (lib/image-render-queue.ts:
 * cancelImageRender) — same idiom, scoped to shorts.
 */
export async function cancelShortRender(
  renderId: string,
): Promise<ShortRenderRow | null> {
  const row = await getShortRender(renderId);
  if (!row) return null;
  if (row.status !== "queued" && row.status !== "generating") {
    // Outside the cancel window. Caller decides how to render the button
    // state from the returned row (hide / disable / show "already done").
    return row;
  }
  const now = new Date().toISOString();
  await run(
    `UPDATE short_renders
       SET status = 'cancelled', finished_at = ?
     WHERE id = ? AND status IN ('queued', 'generating')`,
    [now, renderId],
  );
  const after = await getShortRender(renderId);
  if (after && after.status === "cancelled") {
    await logShortRenderEvent(renderId, "cancelled", {
      message: "Cancelled by admin",
      payload: { previous_status: row.status, previous_phase: row.phase },
    });
  }
  return after;
}
