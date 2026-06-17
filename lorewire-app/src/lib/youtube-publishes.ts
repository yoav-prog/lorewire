// TS-app-owned query layer for the youtube_publishes ledger (Phase 1).
//
// One row per publish attempt of a short_render to YouTube. The route inserts an
// in_flight row, then flips it to published (with the video id + URL) or failed.
// Mirrors the per-feature query-module pattern (lib/voice-render-queue.ts).
// Plan: _plans/2026-06-16-multi-platform-shorts-publisher.md sections 6, 3.F7.

import "server-only";
import { randomUUID } from "node:crypto";
import { one, run } from "@/lib/db";

export type YoutubePublishStatus = "in_flight" | "published" | "failed";

export interface YoutubePublishRow {
  id: string;
  short_id: string;
  account_id: string;
  external_post_id: string | null;
  public_url: string | null;
  status: YoutubePublishStatus;
  last_error: string | null;
  audio_clearance: string;
  started_at: string;
  finished_at: string | null;
}

const COLS =
  "id, short_id, account_id, external_post_id, public_url, status, last_error, audio_clearance, started_at, finished_at";

// The publish that currently owns this short: a successful one (do not
// re-publish) or one mid-flight (do not double-upload). Failed rows are skipped
// so a retry can start fresh. This closes the common re-click case; the fully
// race-proof guarantee arrives with the Phase 2 publish_jobs partial index.
export async function getActiveYoutubePublishForShort(
  shortId: string,
): Promise<YoutubePublishRow | null> {
  return one<YoutubePublishRow>(
    `SELECT ${COLS} FROM youtube_publishes
       WHERE short_id = ? AND status IN ('in_flight', 'published')
       ORDER BY started_at DESC LIMIT 1`,
    [shortId],
  );
}

// The latest publish row for a short regardless of status, so the editor can
// show the last outcome (published URL, or the last error to retry from).
export async function latestYoutubePublishForShort(
  shortId: string,
): Promise<YoutubePublishRow | null> {
  return one<YoutubePublishRow>(
    `SELECT ${COLS} FROM youtube_publishes
       WHERE short_id = ? ORDER BY started_at DESC LIMIT 1`,
    [shortId],
  );
}

export async function insertInFlightYoutubePublish(input: {
  shortId: string;
  accountId: string;
  audioClearance: string;
}): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO youtube_publishes
       (id, short_id, account_id, external_post_id, public_url, status,
        last_error, audio_clearance, started_at, finished_at)
     VALUES (?, ?, ?, NULL, NULL, 'in_flight', NULL, ?, ?, NULL)`,
    [id, input.shortId, input.accountId, input.audioClearance, now],
  );
  return id;
}

export async function markYoutubePublished(
  id: string,
  externalPostId: string,
  publicUrl: string,
): Promise<void> {
  const now = new Date().toISOString();
  await run(
    `UPDATE youtube_publishes
       SET status = 'published', external_post_id = ?, public_url = ?,
           last_error = NULL, finished_at = ?
     WHERE id = ?`,
    [externalPostId, publicUrl, now, id],
  );
}

export async function markYoutubePublishFailed(
  id: string,
  error: string,
): Promise<void> {
  const now = new Date().toISOString();
  await run(
    `UPDATE youtube_publishes
       SET status = 'failed', last_error = ?, finished_at = ?
     WHERE id = ?`,
    [error.slice(0, 1000), now, id],
  );
}
