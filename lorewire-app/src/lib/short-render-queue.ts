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

export type ShortRenderStatus =
  | "queued"
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
}

const COLS =
  "id, story_id, config_hash, narration_style, length_preset, status, phase, progress, error, output_url, props, requested_by, requested_at, started_at, finished_at";

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
export async function enqueueShortRender(
  storyId: string,
  narrationStyle: string | null,
  lengthPreset: string | null,
  requestedBy: string | null,
): Promise<ShortRenderRow> {
  const configHash = hashShortConfig(narrationStyle, lengthPreset);
  const existing = await one<ShortRenderRow>(
    `SELECT ${COLS} FROM short_renders WHERE story_id = ? AND config_hash = ?`,
    [storyId, configHash],
  );
  if (existing) {
    if (existing.status === "error" || existing.status === "cancelled") {
      const retryNow = new Date().toISOString();
      await run(
        `UPDATE short_renders
           SET status = 'queued', phase = NULL, progress = 0, error = NULL,
               output_url = NULL, requested_by = ?, requested_at = ?,
               started_at = NULL, finished_at = NULL
         WHERE id = ? AND status = ?`,
        [requestedBy, retryNow, existing.id, existing.status],
      );
      const reset = await one<ShortRenderRow>(
        `SELECT ${COLS} FROM short_renders WHERE id = ?`,
        [existing.id],
      );
      if (!reset) throw new Error("[short render queue] reset row missing");
      return reset;
    }
    return existing; // idempotent hit on queued/rendering/done
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
}
