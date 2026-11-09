// @vitest-environment happy-dom

// Render tests for LiveRunsClient (the unified runs board). Uses
// renderToString so the polling useEffect never fires — what we're
// locking down is the initial paint contract: empty state copy, the
// kind groups + badges, filter chips, selection affordances, stop
// buttons, and the legacy ?finished=hide mapping onto the Active chip.
//
// The polling behaviour (timer start/stop on visibilitychange) is
// covered by the data-layer tests + manual QA; trying to assert it
// from renderToString would test the wrong layer.

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import type {
  ActiveJobView,
  PipelineOverallState,
  PipelineStage,
} from "@/lib/story-jobs-live-shared";
import type { UnifiedRun } from "@/lib/runs";

// The component pulls in Server Actions; stub them so the test doesn't
// need a server runtime. The polling tick never fires from SSR anyway,
// but the imports must resolve.
vi.mock("@/app/admin/actions", () => ({
  listAllRunsAction: vi.fn(async () => ({ jobs: [], runs: [] })),
  stopLiveRunAction: vi.fn(async () => ({ ok: true, stoppedStages: [] })),
  stopUnifiedRunAction: vi.fn(async () => ({ ok: true, changed: true })),
  stopAllActiveLiveRunsAction: vi.fn(async () => ({
    ok: true,
    scanned: 0,
    stopped: 0,
  })),
}));

import LiveRunsClient from "./LiveRunsClient";

const NOW = "2026-06-28T12:00:00.000Z";

const DEFAULT_STAGES: PipelineStage[] = [
  { id: "story", state: "pending", label: "Story" },
  { id: "short", state: "pending", label: "Short" },
  { id: "hero", state: "pending", label: "Hero & thumb" },
  { id: "publish", state: "skipped", label: "Publish" },
];

function makeJob(over: Partial<ActiveJobView> = {}): ActiveJobView {
  return {
    job_id: "job-1",
    reddit_id: "r-1",
    status: "queued",
    progress: 0,
    error: null,
    story_id: null,
    requested_at: NOW,
    started_at: null,
    finished_at: null,
    title: "A real reddit title",
    subreddit: "AITAH",
    with_media: 1,
    full_pipeline: 0,
    finisher_status: null,
    auto_publish_status: null,
    short: null,
    stages: DEFAULT_STAGES,
    overall: "queued" as PipelineOverallState,
    last_settled_at: null,
    events: [],
    ...over,
  };
}

function makeRun(over: Partial<UnifiedRun> = {}): UnifiedRun {
  return {
    kind: "image",
    id: "run-1",
    storyId: "story-1",
    storyTitle: "A story title",
    label: "hero",
    status: "queued",
    progress: null,
    requestedAt: NOW,
    startedAt: null,
    finishedAt: null,
    error: null,
    ...over,
  };
}

describe("LiveRunsClient", () => {
  it("renders the empty state when there is nothing at all", () => {
    const html = renderToString(
      <LiveRunsClient initialJobs={[]} initialRuns={[]} hideFinished={false} />,
    );
    expect(html).toContain("No active runs");
  });

  it("renders one pipeline card per job from the initial snapshot", () => {
    const html = renderToString(
      <LiveRunsClient
        initialJobs={[
          makeJob({ job_id: "j-a", reddit_id: "r-a", title: "Aaa" }),
          makeJob({
            job_id: "j-b",
            reddit_id: "r-b",
            title: "Bbb",
            status: "processing",
            overall: "running",
          }),
        ]}
        initialRuns={[]}
        hideFinished={false}
      />,
    );
    expect(html).toContain("Aaa");
    expect(html).toContain("Bbb");
    expect(html).toContain("/admin/reddit-sources/r-a");
    expect(html).toContain("/admin/reddit-sources/r-b");
  });

  it("groups unified runs by kind with badges, titles, and stop buttons", () => {
    const html = renderToString(
      <LiveRunsClient
        initialJobs={[]}
        initialRuns={[
          makeRun({ kind: "image", id: "i1", storyTitle: "Image story" }),
          makeRun({
            kind: "voice",
            id: "v1",
            status: "running",
            storyTitle: "Voice story",
            label: "elevenlabs · abc",
          }),
          makeRun({
            kind: "short",
            id: "s1",
            status: "running",
            progress: 40,
            storyTitle: "Short story",
          }),
          makeRun({
            kind: "finisher",
            id: "f1",
            storyTitle: "Finisher story",
            label: "hero + thumbnails",
          }),
          makeRun({
            kind: "refresh",
            id: "r1",
            status: "running",
            storyTitle: "Refresh story",
            label: "refresh · short_pending",
          }),
        ]}
        hideFinished={false}
      />,
    );
    for (const group of ["Images", "Voice", "Shorts", "Hero+thumb", "Refresh"]) {
      expect(html).toContain(group);
    }
    for (const title of [
      "Image story",
      "Voice story",
      "Short story",
      "Finisher story",
      "Refresh story",
    ]) {
      expect(html).toContain(title);
    }
    // Story links + progress + per-row Stop for stoppable rows. The
    // progress percent crosses an SSR text-node boundary ("40<!-- -->%"),
    // so assert the number alone.
    expect(html).toContain("/admin/stories/story-1");
    expect(html).toContain(">40<");
    expect(html).toContain(">Stop<");
  });

  it("does not offer Stop on settled unified runs", () => {
    const html = renderToString(
      <LiveRunsClient
        initialJobs={[]}
        initialRuns={[
          makeRun({ id: "done-1", status: "done", finishedAt: NOW }),
        ]}
        hideFinished={false}
      />,
    );
    expect(html).not.toContain(">Stop<");
  });

  it("maps the legacy ?finished=hide onto the Active status filter", () => {
    const html = renderToString(
      <LiveRunsClient
        initialJobs={[
          makeJob({
            job_id: "done",
            reddit_id: "r-done",
            title: "Done job",
            status: "done",
            overall: "done",
            finished_at: NOW,
          }),
        ]}
        initialRuns={[
          makeRun({ id: "done-run", status: "done", storyTitle: "Done run" }),
        ]}
        hideFinished={true}
      />,
    );
    expect(html).not.toContain("Done job");
    expect(html).not.toContain("Done run");
  });

  it("renders the filter bar with kind counts and the search box", () => {
    const html = renderToString(
      <LiveRunsClient
        initialJobs={[makeJob()]}
        initialRuns={[makeRun(), makeRun({ id: "i2" })]}
        hideFinished={false}
      />,
    );
    expect(html).toContain("Search title, story id, asset");
    expect(html).toContain("All 3");
    expect(html).toContain("Pipeline 1");
    expect(html).toContain("Images 2");
  });

  it("offers select-all over stoppable rows and the pipeline Stop all", () => {
    const html = renderToString(
      <LiveRunsClient
        initialJobs={[
          makeJob({ status: "processing", overall: "running" }),
          makeJob({ job_id: "b", reddit_id: "rb" }),
        ]}
        initialRuns={[makeRun()]}
        hideFinished={false}
      />,
    );
    // 2 active pipeline jobs + 1 queued image run.
    expect(html).toContain("Select all 3 stoppable");
    expect(html).toContain("Stop all pipeline 2");
    // 3 active runs total in the status bar.
    expect(html).toContain("<strong>3</strong> active");
  });

  it("does not render Stop all when nothing is active", () => {
    const html = renderToString(
      <LiveRunsClient
        initialJobs={[
          makeJob({ status: "done", overall: "done", finished_at: NOW }),
        ]}
        initialRuns={[]}
        hideFinished={false}
      />,
    );
    expect(html).not.toContain("Stop all");
  });
});
