// Server-only helpers for the video_renders queue.
//
// The /admin/videos/[id] Render button calls `enqueueRender`, which is the
// idempotent-by-(story_id, config_hash) INSERT pattern matching
// pipeline/store.py:enqueue_render. The Python worker
// (pipeline/render_worker.py) is what actually drains the queue.
//
// `hashConfig` is the canonical JSON SHA-256 used as the second half of the
// idempotency key. It deliberately skips editor-only metadata (`_locks`,
// `_edit_session`, `config_version`) — those don't affect the rendered MP4,
// so a lock change shouldn't kick off a fresh render. Same canonical form
// would let a future Python writer compute matching hashes; we don't share
// the implementation across languages today because TS is the only producer.

import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";
import type { ShortVideoConfig } from "@/lib/video-config";

export type RenderStatus =
  | "queued"
  | "rendering"
  | "done"
  | "error"
  // 2026-06-14: 'cancelled' has always been writable to this table via
  // direct SQL (the Python sibling queues all define a 'cancelled'
  // lifecycle), but the TS type pretended it couldn't happen. That
  // pretense pinned at least one editor session: when a stuck row was
  // manually cancelled to clear the queue, every subsequent Render
  // click returned the existing cancelled row idempotently and the UI
  // had no escape hatch. The type now reflects reality; enqueueRender
  // treats cancelled the same as error (reset to queued) so a click
  // means "retry" regardless of how the row got stuck.
  | "cancelled";

export interface RenderRow {
  id: string;
  story_id: string;
  config_hash: string;
  status: RenderStatus;
  progress: number;
  error: string | null;
  output_url: string | null;
  requested_by: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const COLS =
  "id, story_id, config_hash, status, progress, error, output_url, requested_by, requested_at, started_at, finished_at";

// Hash the config in canonical form. Sort keys, recurse into objects/arrays,
// skip editor-only metadata. Two configs that produce byte-identical MP4s
// hash the same; lock changes alone don't.
export function hashConfig(config: ShortVideoConfig): string {
  const canonical = canonicalize(config as unknown);
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "number" || t === "boolean") return JSON.stringify(value);
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter(
        (k) => k !== "_locks" && k !== "_edit_session" && k !== "config_version",
      )
      .sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
        .join(",") +
      "}"
    );
  }
  // Unreachable for our schema (no Dates / Maps / etc.), but be defensive
  // — JSON.stringify falls back to undefined → "null" via the canonical
  // path above.
  return "null";
}

// Insert a queued row OR return the existing one for (story_id, config_hash).
// Uses SQLite's INSERT OR IGNORE / Postgres's ON CONFLICT DO NOTHING pattern
// behind a single portable SQL: write attempt, then SELECT. The Python
// `enqueue_render` uses the same approach.
//
// One special case: if the existing row is `status='error'`, reset it back
// to `queued` so the user can retry the same (story, config) without having
// to change the config first. Without this, a failed render permanently
// blocks re-rendering until the config hash changes, which the user has no
// natural reason to trigger after a transient infra failure (Cloud Run
// down, image bug, etc.). The reset preserves the row id and requested_at
// (it's still the same request) and bumps requested_at to `now` so the
// cron orchestrator picks it up in FIFO order.
export async function enqueueRender(
  storyId: string,
  configHash: string,
  requestedBy: string | null,
): Promise<RenderRow> {
  const existing = await one<RenderRow>(
    `SELECT ${COLS} FROM video_renders WHERE story_id = ? AND config_hash = ?`,
    [storyId, configHash],
  );
  if (existing) {
    // `error` and `cancelled` are both "settled but unsuccessful" states.
    // A click on Render after either means "retry" — we reset the row to
    // queued and emit a `reset_from_error` / `reset_from_cancelled` event
    // so the timeline tells the user what we did. The conditional UPDATE
    // (`AND status = ?`) is the race guard: if a concurrent claim raced
    // ahead of us and the row already moved, the UPDATE matches 0 rows
    // and the re-SELECT below returns whatever the racer left.
    if (existing.status === "error" || existing.status === "cancelled") {
      const fromStatus = existing.status;
      const retryNow = new Date().toISOString();
      await run(
        `UPDATE video_renders
           SET status = 'queued', progress = 0, error = NULL,
               output_url = NULL, requested_by = ?, requested_at = ?,
               started_at = NULL, finished_at = NULL
         WHERE id = ? AND status = ?`,
        [requestedBy, retryNow, existing.id, fromStatus],
      );
      const reset = await one<RenderRow>(
        `SELECT ${COLS} FROM video_renders WHERE id = ?`,
        [existing.id],
      );
      if (!reset) {
        throw new Error(
          "[video render queue] reset succeeded but row missing",
        );
      }
      const eventName =
        fromStatus === "error" ? "reset_from_error" : "reset_from_cancelled";
      const eventMessage =
        fromStatus === "error"
          ? "Previous render errored — reset to queued for retry."
          : "Previous render was cancelled — reset to queued for retry.";
      await logVideoRenderEvent(reset.id, eventName, {
        message: eventMessage,
        payload: {
          previous_status: fromStatus,
          previous_error: existing.error,
          previous_requested_at: existing.requested_at,
        },
      });
      return reset;
    }
    // Idempotent hit on an in-flight or done row. Log it so the user
    // sees that their click was received but no new work was kicked
    // off (this is the most common cause of "nothing happens when I
    // click Render" — the row is already done at the current config
    // hash, and only Force re-render produces a fresh attempt).
    await logVideoRenderEvent(existing.id, "idempotent_hit", {
      message: `Existing ${existing.status} render at this config — no new work queued.`,
      payload: { status: existing.status },
    });
    return existing;
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO video_renders
      (id, story_id, config_hash, status, progress, error, output_url,
       requested_by, requested_at, started_at, finished_at)
     VALUES (?, ?, ?, 'queued', 0, NULL, NULL, ?, ?, NULL, NULL)`,
    [id, storyId, configHash, requestedBy, now],
  );
  const fresh = await one<RenderRow>(
    `SELECT ${COLS} FROM video_renders WHERE id = ?`,
    [id],
  );
  if (!fresh) {
    // Shouldn't happen — INSERT just succeeded. If it does, surface the
    // race so it doesn't silently swallow.
    throw new Error("[video render queue] insert succeeded but row missing");
  }
  await logVideoRenderEvent(fresh.id, "queued", {
    message: "Render request received. Waiting for the next cron tick.",
    payload: { config_hash_prefix: configHash.slice(0, 12) },
  });
  return fresh;
}

// Insert a *new* video_renders row regardless of any existing row for
// the same (story, config_hash). Used by the "Force re-render" button
// in the editor for cases when the user wants a fresh attempt without
// touching the config (e.g. the existing row is `done` but the result
// looked wrong, or they want to re-test the pipeline). The new row gets
// a different (story_id, config_hash + suffix) tuple so the idempotency
// path doesn't merge them. The suffix is a millisecond-precision ISO
// stamp — readable in logs and globally unique per click.
export async function forceEnqueueRender(
  storyId: string,
  configHash: string,
  requestedBy: string | null,
): Promise<RenderRow> {
  const id = randomUUID();
  const now = new Date().toISOString();
  // The suffix lets the same logical config produce N distinct rows
  // (one per Force click). We keep the original hash as the prefix so
  // a future tooling pass can still group attempts that share a config.
  const forcedHash = `${configHash}:force-${now}`;
  await run(
    `INSERT INTO video_renders
      (id, story_id, config_hash, status, progress, error, output_url,
       requested_by, requested_at, started_at, finished_at)
     VALUES (?, ?, ?, 'queued', 0, NULL, NULL, ?, ?, NULL, NULL)`,
    [id, storyId, forcedHash, requestedBy, now],
  );
  const fresh = await one<RenderRow>(
    `SELECT ${COLS} FROM video_renders WHERE id = ?`,
    [id],
  );
  if (!fresh) {
    throw new Error(
      "[video render queue] force-insert succeeded but row missing",
    );
  }
  await logVideoRenderEvent(fresh.id, "queued", {
    message: "Force re-render: fresh row queued, bypassing idempotency.",
    payload: {
      config_hash_prefix: configHash.slice(0, 12),
      forced: true,
    },
  });
  return fresh;
}

// Phase 2 of _plans/2026-06-14-cloud-run-render.md. Atomic claim of the
// oldest queued render. Mirrors `pipeline/store.py:claim_next_render`:
// flips status to 'rendering' AND sets started_at in a single UPDATE
// so two concurrent cron invocations can't both pick the same row.
//
// Returns the claimed row, or null when the queue is empty. The Vercel
// orchestrator (`api/render_video.ts`) calls this once per cron tick.
// Postgres path uses FOR UPDATE SKIP LOCKED for clean concurrency; the
// SQLite path uses a conditional UPDATE (status='queued') so a losing
// racer simply gets 0 affected rows and tries again on the next tick.
export async function claimNextRender(): Promise<RenderRow | null> {
  // Two-step claim that works identically on both engines (matches the
  // enqueue / finish pattern elsewhere in this file): peek the oldest
  // queued id, conditional-UPDATE it to 'rendering', read the row back.
  // The conditional `AND status = 'queued'` is the race guard — a
  // losing concurrent claimer simply finds the row already moved and
  // gets 0 affected rows, so a re-peek picks the next queued row.
  const now = new Date().toISOString();
  const peek = await one<{ id: string }>(
    `SELECT id FROM video_renders WHERE status = 'queued'
     ORDER BY requested_at ASC LIMIT 1`,
  );
  if (!peek) return null;
  // The conditional UPDATE is the race guard. If another tick claimed
  // this id between peek and update, run() returns silently — we read
  // the row back below to detect the loss (status will be 'rendering'
  // but started_at won't match `now`).
  await run(
    `UPDATE video_renders SET status = 'rendering', started_at = ?
     WHERE id = ? AND status = 'queued'`,
    [now, peek.id],
  );
  const fresh = await one<RenderRow>(
    `SELECT ${COLS} FROM video_renders WHERE id = ?`,
    [peek.id],
  );
  if (!fresh) return null;
  // Detect race loss: if another tick claimed this row first, our
  // UPDATE matched 0 rows AND the row is now 'rendering' with a
  // started_at that isn't ours. Returning null sends the orchestrator
  // back through the loop next tick.
  if (fresh.status !== "rendering" || fresh.started_at !== now) {
    return null;
  }
  await logVideoRenderEvent(fresh.id, "claimed", {
    message: "Cron orchestrator claimed the row; preparing dispatch.",
  });
  return fresh;
}

export async function getRender(renderId: string): Promise<RenderRow | null> {
  return one<RenderRow>(
    `SELECT ${COLS} FROM video_renders WHERE id = ?`,
    [renderId],
  );
}

export async function latestRenderForStory(
  storyId: string,
): Promise<RenderRow | null> {
  return one<RenderRow>(
    `SELECT ${COLS} FROM video_renders WHERE story_id = ?
     ORDER BY requested_at DESC LIMIT 1`,
    [storyId],
  );
}

export async function recentRendersForStory(
  storyId: string,
  limit = 5,
): Promise<RenderRow[]> {
  return all<RenderRow>(
    `SELECT ${COLS} FROM video_renders WHERE story_id = ?
     ORDER BY requested_at DESC LIMIT ?`,
    [storyId, limit],
  );
}

// Counts renders requested for `storyId` since `sinceIso`. Used by the
// queueRender action to enforce the `video.daily_renders_per_story` cap so
// a stuck Render button (or an admin in a render-button-spam mood) can't
// drain the worker's day. Idempotent rows count exactly once because we
// query by (story_id, requested_at >= sinceIso) — a previous-day row is
// excluded even if it shares the same config_hash as today's request.
export async function countRendersSince(
  storyId: string,
  sinceIso: string,
): Promise<number> {
  const rows = await all<{ c: number | string }>(
    "SELECT COUNT(*) AS c FROM video_renders WHERE story_id = ? AND requested_at >= ?",
    [storyId, sinceIso],
  );
  return Number(rows[0]?.c ?? 0);
}

// Phase 2 of _plans/2026-06-14-cloud-run-render.md. Mark a render done
// AND publish the URL onto the story row in one logical step. Two
// UPDATE statements (no transaction wrapping today — Neon's
// transaction-mode pooler complicates that). The video_renders row
// flips first so a subsequent orchestrator tick can't re-claim it
// even if the stories write fails. Conditional on status='rendering'
// so a duplicate writeback after a successful first one is a no-op.
export async function finishRender(
  renderId: string,
  storyId: string,
  outputUrl: string,
): Promise<void> {
  const now = new Date().toISOString();
  await run(
    `UPDATE video_renders SET status = 'done', progress = 1.0,
       output_url = ?, finished_at = ?
     WHERE id = ? AND status = 'rendering'`,
    [outputUrl, now, renderId],
  );
  await run(
    `UPDATE stories SET video_url = ?, updated_at = ? WHERE id = ?`,
    [outputUrl, now, storyId],
  );
  console.info("[video render queue] finished", {
    render_id: renderId,
    story_id: storyId,
    bytes_in_url: outputUrl.length,
  });
  await logVideoRenderEvent(renderId, "finished", {
    message: "Render done. Story video_url updated to Cloud Run output.",
    payload: { url: outputUrl },
  });
}

// Phase 2 of _plans/2026-06-14-cloud-run-render.md. Mark a render
// failed with the error message Cloud Run returned (or our local
// dispatcher's network-error string). Cap to 2000 chars so a giant
// stack trace can't bloat the column. Conditional on status='rendering'
// so a late-arriving retry can't overwrite a row already settled by a
// previous tick.
export async function failRender(
  renderId: string,
  error: string,
): Promise<void> {
  const now = new Date().toISOString();
  const capped = (error ?? "unknown error").slice(0, 2000);
  await run(
    `UPDATE video_renders SET status = 'error', error = ?, finished_at = ?
     WHERE id = ? AND status = 'rendering'`,
    [capped, now, renderId],
  );
  console.info("[video render queue] failed", {
    render_id: renderId,
    error_chars: capped.length,
  });
  await logVideoRenderEvent(renderId, "failed", {
    level: "error",
    message: "Render failed. Click Render again to retry (resets to queued).",
    payload: { error: capped },
  });
}

// ─── per-row event timeline (2026-06-14 progress log) ────────────────────────
// Mirrors image_render_events on the image-render side: one row per
// checkpoint along the render lifecycle so the editor's RenderControl can
// surface a live timeline under the Render button. Writers live on both
// sides of the orchestrator — `queueRender` (server action) for the click
// event, and `/api/render_video` for every cron-tick phase. Reader is the
// `listVideoRenderEvents` helper below + the matching server action.
//
// Why a separate events table vs piling everything onto the video_renders
// row: the row reflects the LATEST state (one error string, one progress
// fraction), not history. The events table is append-only and ordered, so
// the user sees the sequence: "click → reset_from_error → claim → dispatch
// → cloud_run_response → finish". When something goes wrong the failing
// step's payload (HTTP status, error text) is preserved.

export type VideoRenderEventLevel = "info" | "warn" | "error";

export interface VideoRenderEventRow {
  id: string;
  render_id: string;
  ts: string;
  level: VideoRenderEventLevel;
  event: string;
  message: string | null;
  /** JSON-encoded structured payload; UI parses + displays inline. */
  payload: string | null;
}

const EVENT_COLS = "id, render_id, ts, level, event, message, payload";

/**
 * Append one event to the timeline for a render row. Cheap (~1 ms on
 * SQLite, ~5 ms on Postgres), so we don't batch — every meaningful
 * checkpoint gets its own row so a partial failure still preserves the
 * trail up to the failure point. Swallows write errors (catch + log)
 * because event logging must never break the orchestrator's main path.
 *
 * `payload` is stringified once at the boundary so callers don't have to
 * remember JSON.stringify, and so the column always holds either a valid
 * JSON string or NULL.
 */
export async function logVideoRenderEvent(
  renderId: string,
  event: string,
  opts: {
    message?: string;
    level?: VideoRenderEventLevel;
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
      `INSERT INTO video_render_events
         (id, render_id, ts, level, event, message, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, renderId, ts, level, event, message, payload],
    );
  } catch (e) {
    // Don't let logging take down the render path. The bracketed
    // console log still fires elsewhere on the call site so the data
    // isn't lost — only the user-facing timeline misses a row.
    // eslint-disable-next-line no-console -- rule 14
    console.warn("[video render queue] event log failed", {
      render_id: renderId,
      event,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Read the event timeline for one render row in chronological order
 * (oldest first). 200 is more than enough for a render's lifecycle
 * (typical: 6-8 events; failed-and-retried: ~15).
 */
export async function listVideoRenderEvents(
  renderId: string,
  limit = 200,
): Promise<VideoRenderEventRow[]> {
  return all<VideoRenderEventRow>(
    `SELECT ${EVENT_COLS} FROM video_render_events
     WHERE render_id = ?
     ORDER BY ts ASC LIMIT ?`,
    [renderId, limit],
  );
}

// ─── Stale-render detection (Phase 4) ────────────────────────────────────────
//
// The video editor's frame regen (frame:<id>) writes new image URLs into
// stories.video_config WITHOUT triggering a fresh MP4 render. That's a
// deliberate cheap path — the user can swap a single frame's image for
// pennies instead of re-rendering the whole video. But it leaves the
// already-rendered MP4 stale: the URL on stories.video_url still points
// at the OLD frames.
//
// `isVideoRenderStale` returns true when the most recent completed frame
// regen happened AFTER the most recent video render was requested.
// The header surfaces this as a "stale render" badge with a one-click
// "Re-render video" CTA so the user knows they need to kick a fresh
// render after editing frames.

export async function isVideoRenderStale(storyId: string): Promise<boolean> {
  const lastVideoRender = await latestRenderForStory(storyId);
  if (!lastVideoRender) return false; // never rendered, not "stale"

  const row = await one<{ finished_at: string | null }>(
    `SELECT finished_at FROM image_renders
     WHERE owner_kind = 'story'
       AND owner_id = ?
       AND asset LIKE 'frame:%'
       AND status = 'done'
       AND finished_at IS NOT NULL
     ORDER BY finished_at DESC LIMIT 1`,
    [storyId],
  );
  const lastFrameRegen = row?.finished_at;
  if (!lastFrameRegen) return false;

  return new Date(lastFrameRegen) > new Date(lastVideoRender.requested_at);
}
