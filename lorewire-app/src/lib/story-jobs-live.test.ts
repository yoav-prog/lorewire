// Unit tests for the live runs view data layer.
//
// Mirrors the pattern of story-jobs.test.ts: integration-style against the
// SQLite seam wired up by tests/setup.ts, with helpers to seed
// reddit_source / story_jobs / story_job_events directly so we can control
// timestamps and statuses without going through the enqueue path.
//
// Plan: _plans/2026-06-28-reddit-sources-live-runs-page.md.

import { beforeEach, describe, expect, it } from "vitest";

import { all, run } from "@/lib/db";
import {
  FINISHED_GRACE_MS,
  MAX_ACTIVE_JOBS,
  MAX_EVENTS_PER_JOB,
  isJobActive,
  isJobFinished,
  listActiveJobsWithEvents,
} from "@/lib/story-jobs-live";

// Fixed reference clock used by the grace-window assertions. Any time
// derived from this is deterministic across test runs.
const NOW = new Date("2026-06-28T12:00:00.000Z");
const NOW_MS = NOW.getTime();

function isoFromNow(offsetMs: number): string {
  return new Date(NOW_MS + offsetMs).toISOString();
}

async function clear(): Promise<void> {
  await run("DELETE FROM story_job_events", []);
  await run("DELETE FROM story_jobs", []);
  await run("DELETE FROM reddit_source", []);
}

async function seedSource(redditId: string, title = "t"): Promise<void> {
  await run(
    "INSERT INTO reddit_source " +
      "(reddit_id, subreddit, date_written, title, full_text, comments, status, first_synced, last_synced) " +
      "VALUES (?, 'AITAH', '2026-01-01T00:00:00+00:00', ?, 'f', 1, 'queued', " +
      "'2026-06-14T00:00:00+00:00', '2026-06-14T00:00:00+00:00')",
    [redditId, title],
  );
}

async function seedJob(opts: {
  id: string;
  redditId: string;
  status: string;
  requestedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  progress?: number | null;
  error?: string | null;
  storyId?: string | null;
}): Promise<void> {
  await run(
    "INSERT INTO story_jobs " +
      "(id, reddit_id, status, progress, error, story_id, with_media, " +
      " requested_by, requested_at, started_at, finished_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)",
    [
      opts.id,
      opts.redditId,
      opts.status,
      opts.progress ?? 0,
      opts.error ?? null,
      opts.storyId ?? null,
      opts.requestedAt,
      opts.startedAt ?? null,
      opts.finishedAt ?? null,
    ],
  );
}

async function seedEvent(opts: {
  id: string;
  jobId: string;
  redditId: string;
  ts: string;
  event: string;
  level?: string;
  message?: string | null;
  payload?: string | null;
}): Promise<void> {
  await run(
    "INSERT INTO story_job_events " +
      "(id, job_id, reddit_id, ts, level, event, message, payload) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      opts.id,
      opts.jobId,
      opts.redditId,
      opts.ts,
      opts.level ?? "info",
      opts.event,
      opts.message ?? null,
      opts.payload ?? null,
    ],
  );
}

beforeEach(clear);

describe("listActiveJobsWithEvents", () => {
  it("returns an empty array when nothing is in flight", async () => {
    const result = await listActiveJobsWithEvents({ now: NOW });
    expect(result).toEqual([]);
  });

  it("returns queued and processing jobs as active", async () => {
    await seedSource("a", "Title A");
    await seedSource("b", "Title B");
    await seedJob({
      id: "job-a",
      redditId: "a",
      status: "queued",
      requestedAt: isoFromNow(-1000),
    });
    await seedJob({
      id: "job-b",
      redditId: "b",
      status: "processing",
      requestedAt: isoFromNow(-2000),
      startedAt: isoFromNow(-1500),
    });

    const result = await listActiveJobsWithEvents({ now: NOW });

    expect(result).toHaveLength(2);
    // Ordered by requested_at DESC: a (newer) first.
    expect(result[0]).toMatchObject({
      job_id: "job-a",
      reddit_id: "a",
      status: "queued",
      title: "Title A",
      subreddit: "AITAH",
    });
    expect(result[1]).toMatchObject({
      job_id: "job-b",
      reddit_id: "b",
      status: "processing",
    });
    expect(result.every((j) => isJobActive(j))).toBe(true);
  });

  it("includes finished jobs within the grace window", async () => {
    await seedSource("a");
    await seedJob({
      id: "job-a",
      redditId: "a",
      status: "done",
      requestedAt: isoFromNow(-10 * 60 * 1000),
      finishedAt: isoFromNow(-5 * 60 * 1000), // 5 min ago, inside 15min window
    });

    const result = await listActiveJobsWithEvents({ now: NOW });

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("done");
    expect(isJobFinished(result[0])).toBe(true);
  });

  it("excludes finished jobs older than the grace window", async () => {
    await seedSource("a");
    await seedJob({
      id: "job-a",
      redditId: "a",
      status: "done",
      requestedAt: isoFromNow(-30 * 60 * 1000),
      finishedAt: isoFromNow(-20 * 60 * 1000), // 20 min ago, outside 15min
    });

    const result = await listActiveJobsWithEvents({ now: NOW });
    expect(result).toEqual([]);
  });

  it("includes error and cancelled jobs in the grace window", async () => {
    await seedSource("a");
    await seedSource("b");
    await seedJob({
      id: "job-a",
      redditId: "a",
      status: "error",
      requestedAt: isoFromNow(-10 * 60 * 1000),
      finishedAt: isoFromNow(-1 * 60 * 1000),
      error: "LLM 500",
    });
    await seedJob({
      id: "job-b",
      redditId: "b",
      status: "cancelled",
      requestedAt: isoFromNow(-10 * 60 * 1000),
      finishedAt: isoFromNow(-2 * 60 * 1000),
    });

    const result = await listActiveJobsWithEvents({ now: NOW });
    const statuses = result.map((j) => j.status).sort();
    expect(statuses).toEqual(["cancelled", "error"]);
    const errJob = result.find((j) => j.status === "error");
    expect(errJob?.error).toBe("LLM 500");
  });

  it("attaches events oldest-first per job", async () => {
    await seedSource("a");
    await seedJob({
      id: "job-a",
      redditId: "a",
      status: "processing",
      requestedAt: isoFromNow(-1000),
    });
    await seedEvent({
      id: "ev-1",
      jobId: "job-a",
      redditId: "a",
      ts: isoFromNow(-900),
      event: "queued",
      message: "Enqueued",
    });
    await seedEvent({
      id: "ev-2",
      jobId: "job-a",
      redditId: "a",
      ts: isoFromNow(-600),
      event: "claimed",
      message: "Worker claimed",
    });
    await seedEvent({
      id: "ev-3",
      jobId: "job-a",
      redditId: "a",
      ts: isoFromNow(-300),
      event: "idea_done",
    });

    const result = await listActiveJobsWithEvents({ now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0].events.map((e) => e.event)).toEqual([
      "queued",
      "claimed",
      "idea_done",
    ]);
  });

  it("caps events per job at MAX_EVENTS_PER_JOB (keeping the most recent)", async () => {
    await seedSource("a");
    await seedJob({
      id: "job-a",
      redditId: "a",
      status: "processing",
      requestedAt: isoFromNow(-1000),
    });
    // Seed MAX_EVENTS_PER_JOB + 10 events spread across a window. The
    // oldest 10 should drop; the most recent MAX should survive in
    // chronological order.
    const total = MAX_EVENTS_PER_JOB + 10;
    for (let i = 0; i < total; i++) {
      await seedEvent({
        id: `ev-${String(i).padStart(3, "0")}`,
        jobId: "job-a",
        redditId: "a",
        ts: isoFromNow(-(total - i) * 1000),
        event: `phase-${i}`,
      });
    }

    const result = await listActiveJobsWithEvents({ now: NOW });
    expect(result[0].events).toHaveLength(MAX_EVENTS_PER_JOB);
    // First surviving event is phase-10 (the first 10 dropped); last is
    // phase-(total-1).
    expect(result[0].events[0].event).toBe("phase-10");
    expect(result[0].events.at(-1)?.event).toBe(`phase-${total - 1}`);
  });

  it("caps total active jobs at MAX_ACTIVE_JOBS", async () => {
    // Seed MAX + 5 active queued jobs. Only MAX should come back. The
    // ORDER BY requested_at DESC means the newest survive.
    for (let i = 0; i < MAX_ACTIVE_JOBS + 5; i++) {
      const rid = `r-${String(i).padStart(3, "0")}`;
      await seedSource(rid);
      await seedJob({
        id: `job-${i}`,
        redditId: rid,
        status: "queued",
        requestedAt: isoFromNow(-i * 1000),
      });
    }

    const result = await listActiveJobsWithEvents({ now: NOW });
    expect(result).toHaveLength(MAX_ACTIVE_JOBS);
    // Newest (smallest negative offset) first.
    expect(result[0].job_id).toBe("job-0");
  });

  it("survives a missing reddit_source row (defensive LEFT JOIN)", async () => {
    // Job row references a reddit_id that doesn't exist in reddit_source.
    // Shouldn't happen in practice but the LEFT JOIN keeps the row.
    await seedJob({
      id: "job-orphan",
      redditId: "ghost",
      status: "processing",
      requestedAt: isoFromNow(-1000),
    });

    const result = await listActiveJobsWithEvents({ now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBeNull();
    expect(result[0].subreddit).toBeNull();
  });

  it("respects the graceMs override", async () => {
    await seedSource("a");
    await seedJob({
      id: "job-a",
      redditId: "a",
      status: "done",
      requestedAt: isoFromNow(-10 * 60 * 1000),
      finishedAt: isoFromNow(-2 * 60 * 1000), // 2 min ago
    });

    // 1-minute grace excludes the 2-min-old finished job...
    const tight = await listActiveJobsWithEvents({
      now: NOW,
      graceMs: 1 * 60 * 1000,
    });
    expect(tight).toEqual([]);

    // ...30-minute grace includes it.
    const loose = await listActiveJobsWithEvents({
      now: NOW,
      graceMs: 30 * 60 * 1000,
    });
    expect(loose).toHaveLength(1);
  });

  it("normalizes unknown event levels to 'info'", async () => {
    await seedSource("a");
    await seedJob({
      id: "job-a",
      redditId: "a",
      status: "processing",
      requestedAt: isoFromNow(-1000),
    });
    await seedEvent({
      id: "ev-1",
      jobId: "job-a",
      redditId: "a",
      ts: isoFromNow(-500),
      event: "noisy",
      level: "debug", // not in the enum
    });

    const result = await listActiveJobsWithEvents({ now: NOW });
    expect(result[0].events[0].level).toBe("info");
  });

  it("exposes the default grace window as 15 minutes", () => {
    expect(FINISHED_GRACE_MS).toBe(15 * 60 * 1000);
  });

  it("queries against actual reddit_source rows in the join", async () => {
    // Sanity check: a sourced row + a sourceless row in the same response.
    await seedSource("good", "Good Title");
    await seedJob({
      id: "job-good",
      redditId: "good",
      status: "queued",
      requestedAt: isoFromNow(-500),
    });
    await seedJob({
      id: "job-orphan",
      redditId: "ghost",
      status: "queued",
      requestedAt: isoFromNow(-200),
    });

    const result = await listActiveJobsWithEvents({ now: NOW });
    expect(result).toHaveLength(2);
    const good = result.find((j) => j.job_id === "job-good");
    const orphan = result.find((j) => j.job_id === "job-orphan");
    expect(good?.title).toBe("Good Title");
    expect(orphan?.title).toBeNull();
  });

  it("returns events as an empty array when no events are recorded", async () => {
    await seedSource("a");
    await seedJob({
      id: "job-a",
      redditId: "a",
      status: "queued",
      requestedAt: isoFromNow(-1000),
    });

    const result = await listActiveJobsWithEvents({ now: NOW });
    expect(result[0].events).toEqual([]);
  });
});

describe("isJobActive / isJobFinished", () => {
  it("recognises queued and processing as active", () => {
    expect(
      isJobActive({
        job_id: "j",
        reddit_id: "r",
        status: "queued",
        progress: null,
        error: null,
        story_id: null,
        requested_at: NOW.toISOString(),
        started_at: null,
        finished_at: null,
        title: null,
        subreddit: null,
        events: [],
      }),
    ).toBe(true);
  });

  it("recognises done / error / cancelled as finished", () => {
    for (const status of ["done", "error", "cancelled"]) {
      expect(
        isJobFinished({
          job_id: "j",
          reddit_id: "r",
          status,
          progress: null,
          error: null,
          story_id: null,
          requested_at: NOW.toISOString(),
          started_at: null,
          finished_at: NOW.toISOString(),
          title: null,
          subreddit: null,
          events: [],
        }),
      ).toBe(true);
    }
  });
});

describe("listActiveJobsWithEvents cross-driver assumptions", () => {
  // The SQL uses only portable constructs. This test is here so a future
  // edit that adds DISTINCT ON or a window function gets caught — the
  // assertions verify the shape we promise the client, not the SQL.
  it("returns the documented row shape (no extra keys, no missing keys)", async () => {
    await seedSource("a");
    await seedJob({
      id: "job-a",
      redditId: "a",
      status: "queued",
      requestedAt: isoFromNow(-500),
    });

    const result = await listActiveJobsWithEvents({ now: NOW });
    expect(result).toHaveLength(1);
    const keys = Object.keys(result[0]).sort();
    expect(keys).toEqual(
      [
        "error",
        "events",
        "finished_at",
        "job_id",
        "progress",
        "reddit_id",
        "requested_at",
        "started_at",
        "status",
        "story_id",
        "subreddit",
        "title",
      ].sort(),
    );
  });

  it("returns rows ordered by requested_at DESC across active + finished mix", async () => {
    await seedSource("a");
    await seedSource("b");
    await seedSource("c");
    await seedJob({
      id: "active-newest",
      redditId: "a",
      status: "queued",
      requestedAt: isoFromNow(-1000),
    });
    await seedJob({
      id: "finished-newer",
      redditId: "b",
      status: "done",
      requestedAt: isoFromNow(-2000),
      finishedAt: isoFromNow(-100),
    });
    await seedJob({
      id: "active-oldest",
      redditId: "c",
      status: "processing",
      requestedAt: isoFromNow(-5000),
    });

    const result = await listActiveJobsWithEvents({ now: NOW });
    expect(result.map((j) => j.job_id)).toEqual([
      "active-newest",
      "finished-newer",
      "active-oldest",
    ]);
  });

  it("data sanity: no rows leak from prior tests", async () => {
    // beforeEach cleared the tables; verify direct SELECTs see no rows.
    const jobs = await all<{ id: string }>("SELECT id FROM story_jobs", []);
    expect(jobs).toEqual([]);
    const events = await all<{ id: string }>(
      "SELECT id FROM story_job_events",
      [],
    );
    expect(events).toEqual([]);
  });
});
