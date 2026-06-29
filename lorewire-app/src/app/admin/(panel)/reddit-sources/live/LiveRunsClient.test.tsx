// @vitest-environment happy-dom

// Render tests for LiveRunsClient. Uses renderToString so the polling
// useEffect never fires — what we're locking down is the initial paint
// contract: empty state copy, populated state structure, ?finished=hide
// behaviour, and the "active vs recently finished" counts.
//
// The polling behaviour (timer start/stop on visibilitychange) is
// covered by the data-layer + sidebar-badge tests + manual QA; trying
// to assert it from renderToString would test the wrong layer.

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import type {
  ActiveJobView,
  PipelineOverallState,
  PipelineStage,
} from "@/lib/story-jobs-live-shared";

// The component pulls in a Server Action; stub it so the test doesn't
// need a server runtime. The polling tick never fires from SSR anyway,
// but the import must resolve.
vi.mock("@/app/admin/actions", () => ({
  listActiveJobsWithEventsAction: vi.fn(async () => []),
  stopLiveRunAction: vi.fn(async () => ({ ok: true, stoppedStages: [] })),
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

describe("LiveRunsClient", () => {
  it("renders the empty state when there are no jobs", () => {
    const html = renderToString(
      <LiveRunsClient initialJobs={[]} hideFinished={false} />,
    );
    expect(html).toContain("No active runs");
    // The empty state always links back to the candidate list.
    expect(html).toContain("/admin/reddit-sources");
  });

  it("renders the active-only empty copy when hideFinished is true", () => {
    const html = renderToString(
      <LiveRunsClient initialJobs={[]} hideFinished={true} />,
    );
    expect(html).toContain("No active runs right now");
  });

  it("renders one card per job from the initial snapshot", () => {
    const html = renderToString(
      <LiveRunsClient
        initialJobs={[
          makeJob({
            job_id: "j-a",
            reddit_id: "r-a",
            title: "Aaa",
            overall: "queued",
          }),
          makeJob({
            job_id: "j-b",
            reddit_id: "r-b",
            title: "Bbb",
            status: "processing",
            overall: "running",
          }),
        ]}
        hideFinished={false}
      />,
    );
    expect(html).toContain("Aaa");
    expect(html).toContain("Bbb");
    expect(html).toContain("/admin/reddit-sources/r-a");
    expect(html).toContain("/admin/reddit-sources/r-b");
  });

  it("hides finished cards when hideFinished is true", () => {
    const html = renderToString(
      <LiveRunsClient
        initialJobs={[
          makeJob({
            job_id: "active",
            reddit_id: "r-active",
            title: "Active job",
            status: "processing",
            overall: "running",
          }),
          makeJob({
            job_id: "done",
            reddit_id: "r-done",
            title: "Done job",
            status: "done",
            overall: "done",
            finished_at: NOW,
          }),
        ]}
        hideFinished={true}
      />,
    );
    expect(html).toContain("Active job");
    expect(html).not.toContain("Done job");
  });

  it("includes finished cards when hideFinished is false", () => {
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
        hideFinished={false}
      />,
    );
    expect(html).toContain("Done job");
  });

  it("renders the active+finished counters in the status bar", () => {
    const html = renderToString(
      <LiveRunsClient
        initialJobs={[
          makeJob({
            job_id: "a",
            reddit_id: "ra",
            status: "queued",
            overall: "queued",
          }),
          makeJob({
            job_id: "b",
            reddit_id: "rb",
            status: "processing",
            overall: "running",
          }),
          makeJob({
            job_id: "c",
            reddit_id: "rc",
            status: "done",
            overall: "done",
            finished_at: NOW,
          }),
        ]}
        hideFinished={false}
      />,
    );
    expect(html).toContain("<strong>2</strong> active");
    expect(html).toContain("<strong>1</strong> recently finished");
  });

  it("does not render the recently-finished counter when hideFinished is true", () => {
    const html = renderToString(
      <LiveRunsClient
        initialJobs={[makeJob({ status: "queued", overall: "queued" })]}
        hideFinished={true}
      />,
    );
    expect(html).not.toContain("recently finished");
  });

  it("renders a Stop all button when there are active runs", () => {
    const html = renderToString(
      <LiveRunsClient
        initialJobs={[
          makeJob({ status: "processing", overall: "running" }),
          makeJob({
            job_id: "b",
            reddit_id: "rb",
            status: "queued",
            overall: "queued",
          }),
        ]}
        hideFinished={false}
      />,
    );
    expect(html).toContain("Stop all 2");
  });

  it("does not render a Stop all button when nothing is active", () => {
    const html = renderToString(
      <LiveRunsClient
        initialJobs={[
          makeJob({
            status: "done",
            overall: "done",
            finished_at: NOW,
          }),
        ]}
        hideFinished={false}
      />,
    );
    expect(html).not.toContain("Stop all");
  });

  it("renders the Tip footer with the inverse toggle link", () => {
    const visible = renderToString(
      <LiveRunsClient initialJobs={[]} hideFinished={false} />,
    );
    expect(visible).toContain("?finished=hide");

    const hidden = renderToString(
      <LiveRunsClient initialJobs={[]} hideFinished={true} />,
    );
    // The "show" link points back at the bare page URL.
    expect(hidden).toContain("/admin/reddit-sources/live");
  });
});
