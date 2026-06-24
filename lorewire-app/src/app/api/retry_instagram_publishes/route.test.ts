// @vitest-environment node

// Tests for the Instagram publish retry cron. Mirrors the FB retry tests
// plus IG-specific:
//   - Pending rows with container_id are eligible WITHOUT backoff (they
//     resume publishing, they're not "retrying a failure")
//   - Failed rows still observe exponential backoff
//
// Plan: _plans/2026-06-24-instagram-auto-publish.md.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { run } from "@/lib/db";
import * as publishMod from "@/lib/publish-to-instagram";
import { GET, isEligibleForRetry } from "./route";

const ORIGINAL_CRON = process.env.CRON_SECRET;

async function reset(): Promise<void> {
  await run("DELETE FROM instagram_posts WHERE 1=1", []);
}

function makeReq(authHeader?: string): Parameters<typeof GET>[0] {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers.Authorization = authHeader;
  return new Request("http://localhost/api/retry_instagram_publishes", {
    headers,
  }) as unknown as Parameters<typeof GET>[0];
}

async function seedRow(args: {
  storyId: string;
  status: "failed" | "pending";
  createdAtIso: string;
  attempts: number;
  containerId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await run(
    `INSERT INTO instagram_posts (
       id, story_id, render_id, ig_account_id, trigger, video_url, caption,
       container_id, status, attempts, created_at
     ) VALUES (?, ?, ?, ?, 'auto', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      args.storyId,
      "render-x",
      "17841413922168686",
      "https://storage.googleapis.com/lw/x.mp4",
      "test caption",
      args.containerId ?? null,
      args.status,
      args.attempts,
      args.createdAtIso,
    ],
  );
  return id;
}

beforeEach(async () => {
  await reset();
  process.env.CRON_SECRET = "test-cron-secret";
  vi.restoreAllMocks();
});

afterEach(() => {
  if (ORIGINAL_CRON === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_CRON;
});

// --- isEligibleForRetry pure -----------------------------------------------

describe("isEligibleForRetry (IG)", () => {
  const NOW = Date.parse("2026-06-24T20:00:00.000Z");
  const ISO = (offsetMin: number): string =>
    new Date(NOW - offsetMin * 60_000).toISOString();

  it("pending with container_id is always eligible (no backoff)", () => {
    expect(isEligibleForRetry("pending", 0, ISO(0), "c1", NOW)).toBe(true);
    expect(isEligibleForRetry("pending", 2, ISO(0), "c1", NOW)).toBe(true);
  });

  it("pending WITHOUT container_id is NOT eligible (would need to start over)", () => {
    // The TS retry path handles this case but the SQL pre-filter
    // already excludes it. Belt and braces on the pure function too.
    expect(isEligibleForRetry("pending", 0, ISO(0), null, NOW)).toBe(false);
  });

  it("failed observes exponential backoff like FB", () => {
    expect(isEligibleForRetry("failed", 0, ISO(0), null, NOW)).toBe(true);
    expect(isEligibleForRetry("failed", 1, ISO(0.5), null, NOW)).toBe(false);
    expect(isEligibleForRetry("failed", 1, ISO(1), null, NOW)).toBe(true);
    expect(isEligibleForRetry("failed", 3, ISO(3), null, NOW)).toBe(false);
    expect(isEligibleForRetry("failed", 3, ISO(4), null, NOW)).toBe(true);
  });

  it("cap at MAX_ATTEMPTS for both pending and failed", () => {
    expect(isEligibleForRetry("failed", 5, ISO(60), null, NOW)).toBe(false);
    expect(isEligibleForRetry("pending", 5, ISO(60), "c1", NOW)).toBe(false);
  });

  it("posted / deleted never eligible", () => {
    expect(isEligibleForRetry("posted", 1, ISO(60), null, NOW)).toBe(false);
    expect(isEligibleForRetry("deleted", 1, ISO(60), null, NOW)).toBe(false);
  });
});

// --- Route handler ---------------------------------------------------------

describe("GET /api/retry_instagram_publishes", () => {
  it("rejects requests without the CRON_SECRET Bearer", async () => {
    const resp = await GET(makeReq());
    expect(resp.status).toBe(401);
  });

  it("returns 0 drained when no eligible rows exist", async () => {
    const resp = await GET(makeReq("Bearer test-cron-secret"));
    const body = await resp.json();
    expect(body).toEqual({
      drained: 0,
      posted: 0,
      still_pending: 0,
      failed: 0,
      skipped: 0,
    });
  });

  it("retries eligible rows + reports outcome (mix of pending-with-container + failed-eligible + failed-too-soon)", async () => {
    const oldEnough = new Date(Date.now() - 30 * 60_000).toISOString();
    const tooRecent = new Date(Date.now() - 10_000).toISOString();

    const pendingResumeId = await seedRow({
      storyId: "story-pending",
      status: "pending",
      createdAtIso: tooRecent, // no backoff for pending+container
      attempts: 1,
      containerId: "container_abc",
    });
    const failedReadyId = await seedRow({
      storyId: "story-failed-ready",
      status: "failed",
      createdAtIso: oldEnough, // attempts=2 needs 2 min, has 30 → eligible
      attempts: 2,
    });
    const failedTooSoonId = await seedRow({
      storyId: "story-failed-too-soon",
      status: "failed",
      createdAtIso: tooRecent, // attempts=2 needs 2 min, only 10 sec
      attempts: 2,
    });
    const cappedId = await seedRow({
      storyId: "story-capped",
      status: "failed",
      createdAtIso: oldEnough,
      attempts: 5, // at cap, excluded by SQL
    });

    const spy = vi
      .spyOn(publishMod, "attemptInstagramPublishForRow")
      .mockImplementation(async (rowId) => {
        if (rowId === pendingResumeId) {
          return {
            status: "posted",
            row: { id: pendingResumeId } as unknown as publishMod.InstagramPostRow,
          };
        }
        if (rowId === failedReadyId) {
          return {
            status: "failed",
            row: { id: failedReadyId } as unknown as publishMod.InstagramPostRow,
          };
        }
        return { status: "skipped", reason: "unexpected" };
      });

    const resp = await GET(makeReq("Bearer test-cron-secret"));
    const body = await resp.json();
    expect(body.drained).toBe(2);
    expect(body.posted).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.still_pending).toBe(0);

    const calls = spy.mock.calls.map((c) => c[0]);
    expect(calls).toContain(pendingResumeId);
    expect(calls).toContain(failedReadyId);
    expect(calls).not.toContain(failedTooSoonId);
    expect(calls).not.toContain(cappedId);
  });

  it("attempt that returns 'pending' increments still_pending count", async () => {
    const oldEnough = new Date(Date.now() - 30 * 60_000).toISOString();
    const id = await seedRow({
      storyId: "story-still-pending",
      status: "pending",
      createdAtIso: oldEnough,
      attempts: 0,
      containerId: "c-still",
    });

    vi.spyOn(publishMod, "attemptInstagramPublishForRow").mockResolvedValue({
      status: "pending",
      row: { id } as unknown as publishMod.InstagramPostRow,
    });

    const resp = await GET(makeReq("Bearer test-cron-secret"));
    const body = await resp.json();
    expect(body.still_pending).toBe(1);
    expect(body.posted).toBe(0);
    expect(body.failed).toBe(0);
  });
});
