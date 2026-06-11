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
