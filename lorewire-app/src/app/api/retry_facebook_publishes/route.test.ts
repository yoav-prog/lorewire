// @vitest-environment node

// Tests for the Facebook publish retry cron. The HTTP call to Facebook
// is fully stubbed via the publish-to-facebook fetch injection point
// (we spy on attemptFacebookPublishForRow itself for the route-level
// cases). The pure backoff function gets direct math tests.
//
// Coverage:
//   - GET without CRON_SECRET Bearer → 401, no DB read
//   - isEligibleForRetry: 0 attempts is immediate; 1 needs 1min;
//     2 needs 2min; ...; cap at MAX_ATTEMPTS
//   - GET with valid auth: scans failed rows, drains eligible,
//     reports posted/failed/skipped counts in the JSON body
//
// Plan: _plans/2026-06-23-facebook-auto-publish.md.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { run } from "@/lib/db";
import * as publishMod from "@/lib/publish-to-facebook";
import { GET, isEligibleForRetry } from "./route";

const ORIGINAL_CRON = process.env.CRON_SECRET;

async function reset(): Promise<void> {
  await run("DELETE FROM facebook_posts WHERE 1=1", []);
}

function makeReq(authHeader?: string): Parameters<typeof GET>[0] {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers.Authorization = authHeader;
  return new Request("http://localhost/api/retry_facebook_publishes", {
    headers,
  }) as unknown as Parameters<typeof GET>[0];
}

async function seedFailedRow(args: {
  storyId: string;
  createdAtIso: string;
  attempts: number;
}): Promise<string> {
  const id = randomUUID();
  await run(
    `INSERT INTO facebook_posts (
       id, story_id, render_id, page_id, trigger, video_url, caption,
       status, attempts, created_at, error_message, fb_error_code
     ) VALUES (?, ?, ?, ?, 'auto', ?, ?, 'failed', ?, ?, ?, ?)`,
    [
      id,
      args.storyId,
      "render-x",
      "911708085365160",
      "https://storage.googleapis.com/lw/x.mp4",
      "test caption",
      args.attempts,
      args.createdAtIso,
      "previous error",
      503,
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

// --- isEligibleForRetry pure backoff math ----------------------------------

describe("isEligibleForRetry", () => {
  const NOW = Date.parse("2026-06-23T20:00:00.000Z");
  const ISO = (offsetMin: number): string =>
    new Date(NOW - offsetMin * 60_000).toISOString();

  it("attempts=0 is eligible immediately (no wait)", () => {
    expect(isEligibleForRetry(0, ISO(0), NOW)).toBe(true);
  });

  it("attempts=1 waits 1 minute", () => {
    expect(isEligibleForRetry(1, ISO(0.5), NOW)).toBe(false);
    expect(isEligibleForRetry(1, ISO(1), NOW)).toBe(true);
  });

  it("attempts=2 waits 2 minutes", () => {
    expect(isEligibleForRetry(2, ISO(1), NOW)).toBe(false);
    expect(isEligibleForRetry(2, ISO(2), NOW)).toBe(true);
  });

  it("attempts=3 waits 4 minutes", () => {
    expect(isEligibleForRetry(3, ISO(3), NOW)).toBe(false);
    expect(isEligibleForRetry(3, ISO(4), NOW)).toBe(true);
  });

  it("attempts=4 waits 8 minutes", () => {
    expect(isEligibleForRetry(4, ISO(7), NOW)).toBe(false);
    expect(isEligibleForRetry(4, ISO(8), NOW)).toBe(true);
  });

  it("attempts=5 is at the cap, never retries", () => {
    // Even if backed off forever, the cap holds.
    expect(isEligibleForRetry(5, ISO(60), NOW)).toBe(false);
    expect(isEligibleForRetry(99, ISO(60), NOW)).toBe(false);
  });

  it("bad timestamp falls through to eligible (don't strand the row)", () => {
    expect(isEligibleForRetry(2, "not-a-date", NOW)).toBe(true);
  });
});

// --- Route handler ---------------------------------------------------------

describe("GET /api/retry_facebook_publishes", () => {
  it("rejects requests without the CRON_SECRET Bearer", async () => {
    const resp = await GET(makeReq());
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.error).toBe("unauthorized");
  });

  it("rejects requests with the wrong Bearer", async () => {
    const resp = await GET(makeReq("Bearer wrong-secret"));
    expect(resp.status).toBe(401);
  });

  it("returns 0 drained when no failed rows exist", async () => {
    const resp = await GET(makeReq("Bearer test-cron-secret"));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toEqual({ drained: 0, posted: 0, failed: 0, skipped: 0 });
  });

  it("retries eligible failed rows and reports the outcome", async () => {
    const oldEnough = new Date(Date.now() - 30 * 60_000).toISOString();
    const tooRecent = new Date(Date.now() - 10_000).toISOString();
    const successId = await seedFailedRow({
      storyId: "story-success",
      createdAtIso: oldEnough,
      attempts: 2, // needs 2 min, has 30 → eligible
    });
    const failAgainId = await seedFailedRow({
      storyId: "story-fail-again",
      createdAtIso: oldEnough,
      attempts: 3, // needs 4 min, has 30 → eligible
    });
    const cappedId = await seedFailedRow({
      storyId: "story-capped",
      createdAtIso: oldEnough,
      attempts: 5, // at the cap, excluded from the candidate SQL
    });
    const tooSoonId = await seedFailedRow({
      storyId: "story-too-soon",
      createdAtIso: tooRecent,
      attempts: 2, // needs 2 min, only 10 seconds elapsed → filtered out
    });

    // Spy on the per-row attempt so we don't actually call Facebook.
    const spy = vi
      .spyOn(publishMod, "attemptFacebookPublishForRow")
      .mockImplementation(async (rowId) => {
        if (rowId === successId) {
          return {
            status: "posted",
            row: {
              id: successId,
            } as unknown as publishMod.FacebookPostRow,
          };
        }
        if (rowId === failAgainId) {
          return {
            status: "failed",
            row: {
              id: failAgainId,
            } as unknown as publishMod.FacebookPostRow,
          };
        }
        return { status: "skipped", reason: "unexpected" };
      });

    const resp = await GET(makeReq("Bearer test-cron-secret"));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.drained).toBe(2);
    expect(body.posted).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.skipped).toBe(0);

    // Verify the right rows were attempted.
    const calls = spy.mock.calls.map((c) => c[0]);
    expect(calls).toContain(successId);
    expect(calls).toContain(failAgainId);
    expect(calls).not.toContain(cappedId); // excluded by SQL
    expect(calls).not.toContain(tooSoonId); // excluded by backoff filter
  });
});
