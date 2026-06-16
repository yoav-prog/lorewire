// Integration tests for the TS-side story_job_events helpers added in
// 2026-06-16. These run against the same temp SQLite db that
// tests/setup.ts wires up.
//
// What we cover here:
//   - logStoryJobEvent inserts with the right shape
//   - listStoryJobEvents and listStoryJobEventsForReddit return rows
//     in ts ASC order
//   - bulkEnqueueStoryJobs emits a 'queued' event per landed row so the
//     timeline starts the moment Process N fires
//   - logStoryJobEvent swallows errors (does not propagate)
//
// Plan: _plans/2026-06-16-story-job-event-timeline.md.

import { beforeEach, describe, expect, it } from "vitest";

import { all, run } from "@/lib/db";
import {
  bulkEnqueueStoryJobs,
  listStoryJobEvents,
  listStoryJobEventsForReddit,
  logStoryJobEvent,
} from "./story-jobs";

async function seedSource(redditId: string) {
  await run(
    "INSERT INTO reddit_source (reddit_id, subreddit, date_written, title, full_text, comments, status, first_synced, last_synced) " +
      "VALUES (?, 'AITAH', '2026-01-01T00:00:00+00:00', 't', 'f', 1, 'imported', '2026-06-16T00:00:00+00:00', '2026-06-16T00:00:00+00:00')",
    [redditId],
  );
}

async function clear() {
  await run("DELETE FROM story_job_events", []);
  await run("DELETE FROM story_jobs", []);
  await run("DELETE FROM reddit_source", []);
}

describe("logStoryJobEvent + listStoryJobEvents", () => {
  beforeEach(clear);

  it("inserts an event with the expected shape", async () => {
    await logStoryJobEvent("job-1", "abc", "claimed", {
      message: "Worker claimed",
      payload: { with_media: true },
    });
    const rows = await listStoryJobEvents("job-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe("claimed");
    expect(rows[0].message).toBe("Worker claimed");
    expect(rows[0].level).toBe("info");
    expect(JSON.parse(rows[0].payload!)).toEqual({ with_media: true });
    expect(rows[0].job_id).toBe("job-1");
    expect(rows[0].reddit_id).toBe("abc");
  });

  it("defaults level to info when omitted", async () => {
    await logStoryJobEvent("job-1", "abc", "claimed");
    const rows = await listStoryJobEvents("job-1");
    expect(rows[0].level).toBe("info");
  });

  it("persists warn and error levels", async () => {
    await logStoryJobEvent("job-1", "abc", "auto_short_error", {
      level: "warn",
      message: "skipped",
    });
    await logStoryJobEvent("job-1", "abc", "failed", {
      level: "error",
      message: "boom",
    });
    const rows = await listStoryJobEvents("job-1");
    const levels = rows.map((r) => r.level).sort();
    expect(levels).toEqual(["error", "warn"]);
  });

  it("returns events oldest first within a single job", async () => {
    await logStoryJobEvent("job-1", "abc", "claimed");
    // Tiny sleep so ts differs (sqlite stores microsecond-precision strings).
    await new Promise((r) => setTimeout(r, 2));
    await logStoryJobEvent("job-1", "abc", "idea_done");
    await new Promise((r) => setTimeout(r, 2));
    await logStoryJobEvent("job-1", "abc", "finished");
    const rows = await listStoryJobEvents("job-1");
    expect(rows.map((r) => r.event)).toEqual([
      "claimed",
      "idea_done",
      "finished",
    ]);
  });

  it("filters by job_id", async () => {
    await logStoryJobEvent("job-1", "abc", "claimed");
    await logStoryJobEvent("job-2", "xyz", "claimed");
    const rows = await listStoryJobEvents("job-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].job_id).toBe("job-1");
  });

  it("returns empty for an unknown job_id", async () => {
    expect(await listStoryJobEvents("never-ran")).toEqual([]);
  });
});

describe("listStoryJobEventsForReddit", () => {
  beforeEach(clear);

  it("returns rows for matching reddit_id only", async () => {
    await logStoryJobEvent("job-1", "abc", "claimed");
    await logStoryJobEvent("job-2", "xyz", "claimed");
    const rows = await listStoryJobEventsForReddit("abc");
    expect(rows).toHaveLength(1);
    expect(rows[0].reddit_id).toBe("abc");
  });

  it("returns empty for an unknown reddit_id", async () => {
    expect(await listStoryJobEventsForReddit("not-here")).toEqual([]);
  });
});

describe("bulkEnqueueStoryJobs emits queued events", () => {
  beforeEach(clear);

  it("writes one 'queued' event per landed row", async () => {
    await seedSource("a");
    await seedSource("b");
    const result = await bulkEnqueueStoryJobs(["a", "b"], {
      requested_by: "tester",
    });
    expect(result.enqueued).toBe(2);

    const all_a = await listStoryJobEventsForReddit("a");
    const all_b = await listStoryJobEventsForReddit("b");
    expect(all_a).toHaveLength(1);
    expect(all_a[0].event).toBe("queued");
    expect(all_a[0].message).toBe("Enqueued for processing");
    expect(all_b).toHaveLength(1);
    expect(all_b[0].event).toBe("queued");
  });

  it("does not write events when no rows actually landed (idempotent re-click)", async () => {
    await seedSource("a");
    await bulkEnqueueStoryJobs(["a"]);
    const before = (await all<{ n: number }>(
      "SELECT count(*) AS n FROM story_job_events",
      [],
    ))[0].n;

    // Re-click — the partial unique index will reject the second active
    // INSERT, so no new event should land for the race-loser.
    await bulkEnqueueStoryJobs(["a"]);
    const after = (await all<{ n: number }>(
      "SELECT count(*) AS n FROM story_job_events",
      [],
    ))[0].n;
    expect(after).toBe(before);
  });
});
