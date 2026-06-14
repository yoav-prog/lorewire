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

export type RenderStatus = "queued" | "rendering" | "done" | "error";

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
export async function enqueueRender(
  storyId: string,
  configHash: string,
  requestedBy: string | null,
): Promise<RenderRow> {
  const existing = await one<RenderRow>(
    `SELECT ${COLS} FROM video_renders WHERE story_id = ? AND config_hash = ?`,
    [storyId, configHash],
  );
  if (existing) return existing;

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
