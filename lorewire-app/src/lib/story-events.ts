// 2026-06-25 Phase 1 of _plans/2026-06-25-top10-ranking.md. Server-side
// recorder for anonymous engagement events that feed Phase 2's Top 10
// scoring. No UI is exposed in Phase 1 — events accumulate silently for
// at least 48 hours so the scoring algorithm has real-not-cold-start
// data on its first render.
//
// Surface contract:
//   - `recordStoryEvent` is the server-only entry. It bakes the weight
//     for the event type into the row at write time so future tuning
//     doesn't retroactively rewrite history.
//   - Consent gate is the first thing checked. With consent NOT
//     accepted, the writer no-ops and logs — events never persist
//     pre-consent.
//   - The lw_anon cookie is HttpOnly (see lib/anon.ts), so the writer
//     reads it itself from the request context. Callers don't pass it.
//   - `recordEvent` (the public wrapper) takes a server action callback
//     so client UIs can fire-and-forget without awaiting the network
//     round trip.

import "server-only";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";

import { all, run } from "@/lib/db";
import { readAnonToken } from "@/lib/anon";

export type StoryEventType =
  | "play_started"
  | "play_completed"
  | "save_added"
  | "rating_submitted"
  | "poll_vote"
  | "share_initiated";

/** Per-event weight baked into the row at write time. Tuning these
 *  values takes effect for NEW events only — historical rows keep the
 *  weight they were written with, which keeps the ranking honest
 *  ("today's Top 10 reflects today's rules"). Subject to council
 *  review before Phase 2 ships. */
export const STORY_EVENT_WEIGHTS: Record<StoryEventType, number> = {
  play_started: 0.05,
  play_completed: 0.45,
  save_added: 0.2,
  rating_submitted: 0.15,
  poll_vote: 0.1,
  share_initiated: 0.05,
};

const STORY_EVENT_TYPES = new Set<StoryEventType>(
  Object.keys(STORY_EVENT_WEIGHTS) as StoryEventType[],
);

/** Per-anon-id rate limit. Prevents a misbehaving client (a stuck
 *  timeupdate listener, a scripted spammer) from skewing the ranking.
 *  60/min is generous — a real viewer can't credibly trigger that many
 *  events in 60s across all event types. */
const RATE_LIMIT_PER_MIN = 60;

// In-process rate-limit window. Acceptable for single-region serverless
// (each function instance keeps its own counter; a misbehaving client
// can burst slightly higher across regions but not enough to matter).
// Promote to the runtime cache or a DB-backed counter if event volume
// climbs and the cross-region burst becomes noticeable.
const rateBuckets = new Map<string, { windowStart: number; count: number }>();

function consentAccepted(cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false;
  for (const pair of cookieHeader.split("; ")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== "lw_consent") continue;
    return decodeURIComponent(pair.slice(eq + 1)) === "accepted";
  }
  return false;
}

export type RecordResult =
  | { ok: true; id: string }
  | { ok: false; reason: "consent_rejected" | "invalid_type" | "rate_limited" | "write_error" };

export interface RecordStoryEventArgs {
  storyId: string;
  type: StoryEventType;
}

/** Server-side recorder. Honors the consent gate, applies a per-anon
 *  rate limit, bakes the weight, inserts the row. Never throws — a
 *  failed write must not propagate to the UI path. */
export async function recordStoryEvent(
  args: RecordStoryEventArgs,
): Promise<RecordResult> {
  if (!STORY_EVENT_TYPES.has(args.type)) {
    // eslint-disable-next-line no-console -- rule 14
    console.warn("[lorewire event write reject]", {
      reason: "invalid_type",
      type: args.type,
    });
    return { ok: false, reason: "invalid_type" };
  }
  if (!args.storyId || typeof args.storyId !== "string") {
    return { ok: false, reason: "invalid_type" };
  }

  const store = await cookies();
  const cookieHeader = store
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  if (!consentAccepted(cookieHeader)) {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[lorewire event drop]", {
      reason: "consent_rejected",
      story_id: args.storyId,
      type: args.type,
    });
    return { ok: false, reason: "consent_rejected" };
  }

  const anonId = await readAnonToken();
  if (anonId && !checkRateLimit(anonId)) {
    // eslint-disable-next-line no-console -- rule 14
    console.warn("[lorewire event drop]", {
      reason: "rate_limited",
      anon_id_short: anonId.slice(0, 8),
      type: args.type,
    });
    return { ok: false, reason: "rate_limited" };
  }

  const id = randomUUID();
  const occurredAt = new Date().toISOString();
  const weight = STORY_EVENT_WEIGHTS[args.type];

  try {
    await run(
      "INSERT INTO story_events (id, story_id, event_type, anon_id, occurred_at, weight) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
      [id, args.storyId, args.type, anonId, occurredAt, weight],
    );
  } catch (err) {
    // eslint-disable-next-line no-console -- rule 14
    console.warn("[lorewire event write error]", {
      story_id: args.storyId,
      type: args.type,
      err: String(err),
    });
    return { ok: false, reason: "write_error" };
  }

  // eslint-disable-next-line no-console -- rule 14
  console.info("[lorewire event write]", {
    id,
    story_id: args.storyId,
    type: args.type,
    weight,
    anon_id_short: anonId?.slice(0, 8) ?? null,
  });
  return { ok: true, id };
}

function checkRateLimit(anonId: string): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const bucket = rateBuckets.get(anonId);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    rateBuckets.set(anonId, { windowStart: now, count: 1 });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_PER_MIN) return false;
  bucket.count += 1;
  return true;
}

/** Test-only: clear the rate-limit window. NOT exported as a server
 *  action — callers must import directly in test files. */
export function _resetRateLimitForTests(): void {
  rateBuckets.clear();
}

/** Test-only: read aggregated event counts so unit tests can verify
 *  the recorder wrote what it claimed without coupling to the DB
 *  driver. Mirrors the shape Phase 2's scoring will read. */
export async function _readEventsForTests(
  storyId: string,
): Promise<Array<{ event_type: string; weight: number; anon_id: string | null }>> {
  return (await all(
    "SELECT event_type, weight, anon_id FROM story_events WHERE story_id = ? ORDER BY occurred_at ASC",
    [storyId],
  )) as Array<{ event_type: string; weight: number; anon_id: string | null }>;
}
