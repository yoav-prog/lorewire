// Phase 4 of _plans/2026-06-14-voiceover-picker.md.
//
// TS-side helpers for the voice_renders queue: enqueue + status lookup.
// Mirrors lib/image-render-queue.ts's shape — same nominal types
// (snake_case columns), same ON CONFLICT idempotency, same observability
// at every meaningful step. The Python worker (pipeline/voice_renders_worker.py)
// is the writer of `output_url` and the column-level updates on
// stories.audio_url + alignment + video_config; this file is the
// reader (status) + the enqueue surface the server action calls.

import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { run, one } from "@/lib/db";

export interface VoiceRenderRow {
  id: string;
  story_id: string;
  voice_provider: string | null;
  voice_id: string | null;
  text_hash: string;
  status:
    | "queued"
    | "processing"
    | "done"
    | "error"
    | "cancelled";
  progress: number | null;
  error: string | null;
  output_url: string | null;
  cost_cents: number | null;
  requested_by: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const COLS =
  "id, story_id, voice_provider, voice_id, text_hash, status, progress, error, output_url, cost_cents, requested_by, requested_at, started_at, finished_at";

/** sha256 hex of the narration text. Mirrors the Python helper in
 *  pipeline/voice_renders_worker.py — both sides MUST agree so a
 *  Python-side enqueue + a TS-side enqueue for the same body coalesce
 *  via the partial unique index. */
export function textHash(text: string): string {
  return createHash("sha256").update(text ?? "", "utf8").digest("hex");
}

export interface EnqueueVoiceRenderOpts {
  storyId: string;
  body: string;
  voiceProvider: string | null;
  voiceId: string | null;
  requestedBy: string | null;
}

export type EnqueueVoiceRenderResult =
  | { ok: true; renderId: string }
  | { ok: false; error: "race-loss" | "empty-body" };

/** Insert one queued voice_render row. Returns the id on success, or
 *  a 'race-loss' error code when the partial unique index trips
 *  (an active render for the same story + text + voice already exists
 *  — the picker UI surfaces this as "Already in progress" rather than
 *  enqueueing a second copy that would burn TTS credit on identical
 *  output). */
export async function enqueueVoiceRender(
  opts: EnqueueVoiceRenderOpts,
): Promise<EnqueueVoiceRenderResult> {
  const body = (opts.body ?? "").trim();
  if (!body) {
    console.warn("[voice regen enqueue] rejected: empty body", {
      story_id: opts.storyId,
    });
    return { ok: false, error: "empty-body" };
  }
  const id = randomUUID();
  const hash = textHash(body);
  const now = new Date().toISOString();
  await run(
    `INSERT INTO voice_renders
       (id, story_id, voice_provider, voice_id, text_hash, status, progress,
        error, output_url, cost_cents, requested_by, requested_at,
        started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, ?, ?, NULL, NULL)
     ON CONFLICT (story_id, text_hash, voice_provider, voice_id)
       WHERE status IN ('queued', 'processing') DO NOTHING`,
    [
      id,
      opts.storyId,
      opts.voiceProvider,
      opts.voiceId,
      hash,
      opts.requestedBy,
      now,
    ],
  );
  // Read back: if the insert was a race-loser, no row with our id will
  // exist. Surfacing this as a typed error code lets the picker react
  // ("Already in progress") instead of optimistically waiting for an
  // output_url that's never coming.
  const written = await one<{ id: string }>(
    "SELECT id FROM voice_renders WHERE id = ?",
    [id],
  );
  if (!written) {
    console.info("[voice regen enqueue] race-loss", {
      story_id: opts.storyId,
      voice_provider: opts.voiceProvider,
      voice_id: opts.voiceId,
    });
    return { ok: false, error: "race-loss" };
  }
  console.info("[voice regen enqueue] ok", {
    story_id: opts.storyId,
    render_id: id,
    voice_provider: opts.voiceProvider,
    voice_id: opts.voiceId,
    chars: body.length,
  });
  return { ok: true, renderId: id };
}

/** Most recent voice_render row for a story, regardless of status.
 *  The picker UI reads this to surface in-flight state ("Synthesizing
 *  voiceover...") and the last error message when the previous attempt
 *  failed. Mirrors latestRenderForStory in lib/video-render-queue.ts. */
export async function latestVoiceRenderForStory(
  storyId: string,
): Promise<VoiceRenderRow | null> {
  return one<VoiceRenderRow>(
    `SELECT ${COLS} FROM voice_renders WHERE story_id = ? ORDER BY requested_at DESC LIMIT 1`,
    [storyId],
  );
}

/** True when the story has a queued OR processing voice_render. The
 *  picker uses this to gray out the "Regenerate voiceover" button
 *  while a prior render is still running, so the admin doesn't fire
 *  two TTS calls back-to-back by mistake. */
export async function hasActiveVoiceRender(
  storyId: string,
): Promise<boolean> {
  const r = await one<{ n: number }>(
    `SELECT count(*) AS n FROM voice_renders WHERE story_id = ? AND status IN ('queued', 'processing')`,
    [storyId],
  );
  return (r?.n ?? 0) > 0;
}
