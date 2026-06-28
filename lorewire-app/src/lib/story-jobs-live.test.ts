// Integration tests for the live runs view data layer.
//
// Mirrors story-jobs.test.ts: hit the real SQLite seam from tests/setup.ts,
// seed reddit_source / story_jobs / story_job_events / short_renders rows
// directly so we can control timestamps + per-stage state independent of
// the worker.
//
// 2026-06-28 expanded scope: tests pin down the multi-stage pipeline
// truth model (computePipelineState on the server, surfaced as
// view.stages / view.overall / view.last_settled_at). The previous
// single-stage assertions ("status=done within grace → finished")
// became wrong as soon as we added the short / hero / publish stages
// — a story_jobs.status='done' row whose short is still rendering is
// NOT finished, and the dashboard now tells the truth.
//
// Plans:
//   _plans/2026-06-28-live-runs-multistage-pipeline.md (this scope)
//   _plans/2026-06-28-reddit-sources-live-runs-page.md (PR #129)

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
  await run("DELETE FROM short_renders", []);
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

interface SeedJobOpts {
  id: string;
  redditId: string;
  status: string;
  requestedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  progress?: number | null;
  error?: string | null;
  storyId?: string | null;
  withMedia?: number;
  fullPipeline?: number;
  finisherStatus?: string | null;
  autoPublishStatus?: string | null;
}

async function seedJob(opts: SeedJobOpts): Promise<void> {
  await run(
    "INSERT INTO story_jobs " +
      "(id, reddit_id, status, progress, error, story_id, with_media, " +
      " requested_by, requested_at, started_at, finished_at, full_pipeline, " +
      " auto_publish_status, finisher_status) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
    [
      opts.id,
      opts.redditId,
      opts.status,
      opts.progress ?? 0,
      opts.error ?? null,
      opts.storyId ?? null,
      opts.withMedia ?? 1,
      opts.requestedAt,
      opts.startedAt ?? null,
      opts.finishedAt ?? null,
      opts.fullPipeline ?? 0,
      opts.autoPublishStatus ?? null,
      opts.finisherStatus ?? null,
    ],
  );
}

interface SeedShortOpts {
  id: string;
  storyId: string;
  status: string;
  phase?: string | null;
  requestedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  outputUrl?: string | null;
}

async function seedShort(opts: SeedShortOpts): Promise<void> {
  await run(
    "INSERT INTO short_renders " +
      "(id, story_id, config_hash, narration_style, length_preset, status, phase, " +
      " progress, error, output_url, props, requested_by, requested_at, started_at, finished_at) " +
      "VALUES (?, ?, ?, 'suspense', 'standard', ?, ?, 0, NULL, ?, NULL, NULL, ?, ?, ?)",
    [
      opts.id,
      opts.storyId,
      `cfg-${opts.id}`,
      opts.status,
      opts.phase ?? null,
      opts.outputUrl ?? null,
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

describe("listActiveJobsWithEvents — basics", () => {
  it("returns an empty array when nothing is in flight", async () => {
    const result = await listActiveJobsWithEvents({ now: NOW });
    expect(result).toEqual([]);
  });

  it("surfaces queued and processing jobs as overall='queued'/'running'", async () => {
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
    expect(result[0]).toMatchObject({
      job_id: "job-a",
      reddit_id: "a",
      title: "Title A",
      subreddit: "AITAH",
      overall: "queued",
    });
    expect(result[1]).toMatchObject({
      job_id: "job-b",
      overall: "running",
    });
    expect(result.every((j) => isJobActive(j))).toBe(true);
  });
});

describe("listActiveJobsWithEvents — multi-stage in-flight", () => {
  it("keeps the row active when story is done but short is rendering", async () => {
    // This is the lie PR #138 fixes: previously the row showed DONE
    // because story_jobs.status='done', even though the short hadn't
    // rendered. With the multi-stage view, the SHORT stage is RUNNING
    // and the overall state is 'running'.
    await seedSource("a");
    await seedJob({
      id: "job-a",
      redditId: "a",
      status: "done",
      storyId: "story-a",
      requestedAt: isoFromNow(-10 * 60 * 1000),
      finishedAt: isoFromNow(-5 * 60 * 1000),
    });
    await seedShort({
      id: "short-a",
      storyId: "story-a",
      status: "rendering",
      requestedAt: isoFromNow(-4 * 60 * 1000),
      startedAt: isoFromNow(-3 * 60 * 1000),
    });

    const [view] = await listActiveJobsWithEvents({ now: NOW });
    expect(view.overall).toBe("running");
    expect(isJobActive(view)).toBe(true);
    const states = Object.fromEntries(
      view.stages.map((s) => [s.id, s.state]),
    );
    expect(states.story).toBe("done");
    expect(states.short).toBe("running");
    expect(states.hero).toBe("pending");
  });

  it("keeps the row active when finisher is pending after short done", async () => {
    await seedSource("a");
    await seedJob({
      id: "job-a",
      redditId: "a",
      status: "done",
      storyId: "story-a",
      requestedAt: isoFromNow(-10 * 60 * 1000),
      finishedAt: isoFromNow(-7 * 60 * 1000),
      finisherStatus: "pending",
    });
    await seedShort({
      id: "short-a",
      storyId: "story-a",
      status: "done",
      requestedAt: isoFromNow(-6 * 60 * 1000),
      finishedAt: isoFromNow(-4 * 60 * 1000),
      outputUrl: "https://example.com/short.mp4",
    });

    const [view] = await listActiveJobsWithEvents({ now: NOW });
    expect(view.overall).toBe("running");
    expect(view.stages.find((s) => s.id === "hero")?.state).toBe("pending");
  });

  it("keeps a full_pipeline row active until auto_publish settles", async () => {
    await seedSource("a");
    await seedJob({
      id: "job-a",
      redditId: "a",
      status: "done",
      storyId: "story-a",
      fullPipeline: 1,
      finisherStatus: "done",
      autoPublishStatus: "pending",
      requestedAt: isoFromNow(-12 * 60 * 1000),
      finishedAt: isoFromNow(-10 * 60 * 1000),
    });
    await seedShort({
      id: "short-a",
      storyId: "story-a",
      status: "done",
      requestedAt: isoFromNow(-9 * 60 * 1000),
      finishedAt: isoFromNow(-7 * 60 * 1000),
      outputUrl: "https://example.com/short.mp4",
    });

    const [view] = await listActiveJobsWithEvents({ now: NOW });
    expect(view.overall).toBe("running");
    expect(view.stages.find((s) => s.id === "publish")?.state).toBe("running");
  });
});

describe("listActiveJobsWithEvents — grace window applies to LAST stage", () => {
  it("includes a fully-done job within 15 min of the latest stage settling", async () => {
    // Story done 10 min ago, short done 5 min ago, finisher done.
    // last_settled_at = short.finished_at (5 min ago) → within grace.
    await seedSource("a");
    await seedJob({
      id: "job-a",
      redditId: "a",
      status: "done",
      storyId: "story-a",
      finisherStatus: "done",
      requestedAt: isoFromNow(-15 * 60 * 1000),
      finishedAt: isoFromNow(-10 * 60 * 1000),
    });
    await seedShort({
      id: "short-a",
      storyId: "story-a",
      status: "done",
      requestedAt: isoFromNow(-9 * 60 * 1000),
      finishedAt: isoFromNow(-5 * 60 * 1000),
      outputUrl: "https://example.com/short.mp4",
    });

    const result = await listActiveJobsWithEvents({ now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0].overall).toBe("done");
    expect(isJobFinished(result[0])).toBe(true);
  });

  it("excludes a fully-done job whose last stage settled past the grace window", async () => {
    await seedSource("a");
    await seedJob({
      id: "job-a",
      redditId: "a",
      status: "done",
      storyId: "story-a",
      finisherStatus: "done",
      requestedAt: isoFromNow(-30 * 60 * 1000),
      finishedAt: isoFromNow(-25 * 60 * 1000),
    });
    await seedShort({
      id: "short-a",
      storyId: "story-a",
      status: "done",
      requestedAt: isoFromNow(-24 * 60 * 1000),
      finishedAt: isoFromNow(-20 * 60 * 1000),
      outputUrl: "https://example.com/short.mp4",
    });

    const result = await listActiveJobsWithEvents({ now: NOW });
    expect(result).toEqual([]);
  });

  it("with_media=0: legacy story-only job settles immediately on story done", async () => {
    await seedSource("a");
    await seedJob({
      id: "job-a",
      redditId: "a",
      status: "done",
      storyId: "story-a",
      withMedia: 0,
      requestedAt: isoFromNow(-10 * 60 * 1000),
      finishedAt: isoFromNow(-5 * 60 * 1000),
    });

    const [view] = await listActiveJobsWithEvents({ now: NOW });
    expect(view.overall).toBe("done");
    expect(isJobFinished(view)).toBe(true);
    const states = Object.fromEntries(
      view.stages.map((s) => [s.id, s.state]),
    );
    expect(states.short).toBe("skipped");
    expect(states.hero).toBe("skipped");
  });

  it("error and cancelled jobs surface as overall='failed'/'cancelled'", async () => {
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
    const byOverall = Object.fromEntries(
      result.map((r) => [r.job_id, r.overall]),
    );
    expect(byOverall["job-a"]).toBe("failed");
    expect(byOverall["job-b"]).toBe("cancelled");
    const errJob = result.find((j) => j.job_id === "job-a");
    expect(errJob?.error).toBe("LLM 500");
  });
});

describe("listActiveJobsWithEvents — events + caps", () => {
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
    expect(result[0].events[0].event).toBe("phase-10");
    expect(result[0].events.at(-1)?.event).toBe(`phase-${total - 1}`);
  });

  it("caps total active jobs at MAX_ACTIVE_JOBS", async () => {
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
    expect(result[0].job_id).toBe("job-0");
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
      level: "debug",
    });

    const result = await listActiveJobsWithEvents({ now: NOW });
    expect(result[0].events[0].level).toBe("info");
  });
});

describe("listActiveJobsWithEvents — defensive paths", () => {
  it("survives a missing reddit_source row (LEFT JOIN)", async () => {
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
      storyId: "story-a",
      withMedia: 0,
      requestedAt: isoFromNow(-10 * 60 * 1000),
      finishedAt: isoFromNow(-2 * 60 * 1000),
    });

    const tight = await listActiveJobsWithEvents({
      now: NOW,
      graceMs: 1 * 60 * 1000,
    });
    expect(tight).toEqual([]);

    const loose = await listActiveJobsWithEvents({
      now: NOW,
      graceMs: 30 * 60 * 1000,
    });
    expect(loose).toHaveLength(1);
  });

  it("queries against actual reddit_source rows in the join", async () => {
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

  it("exposes the default grace window as 15 minutes", () => {
    expect(FINISHED_GRACE_MS).toBe(15 * 60 * 1000);
  });
});

describe("listActiveJobsWithEvents — shape + ordering contract", () => {
  it("returns the documented row shape (pipeline-aware keys)", async () => {
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
        "auto_publish_status",
        "error",
        "events",
        "finished_at",
        "full_pipeline",
        "finisher_status",
        "job_id",
        "last_settled_at",
        "overall",
        "progress",
        "reddit_id",
        "requested_at",
        "short",
        "stages",
        "started_at",
        "status",
        "story_id",
        "subreddit",
        "title",
        "with_media",
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
      storyId: "story-b",
      withMedia: 0,
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
    const jobs = await all<{ id: string }>("SELECT id FROM story_jobs", []);
    expect(jobs).toEqual([]);
    const events = await all<{ id: string }>(
      "SELECT id FROM story_job_events",
      [],
    );
    expect(events).toEqual([]);
    const shorts = await all<{ id: string }>(
      "SELECT id FROM short_renders",
      [],
    );
    expect(shorts).toEqual([]);
  });
});
