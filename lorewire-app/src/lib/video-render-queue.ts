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
  // 2026-06-14 Phase 2 of _plans/2026-06-14-remotion-lambda-render.md.
  // Lambda-render bookkeeping. NULL = local-worker render (the
  // pre-Lambda flow); all three populated = a Vercel kick endpoint
  // called renderMediaOnLambda and the drain will poll
  // getRenderProgress against them.
  lambda_render_id: string | null;
  lambda_bucket_name: string | null;
  lambda_function_name: string | null;
}

const COLS =
  "id, story_id, config_hash, status, progress, error, output_url, requested_by, requested_at, started_at, finished_at, lambda_render_id, lambda_bucket_name, lambda_function_name";

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
