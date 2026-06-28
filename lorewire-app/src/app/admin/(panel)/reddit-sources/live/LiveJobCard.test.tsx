// @vitest-environment happy-dom

// Pins LiveJobCard's collapsed-default-view contract:
//
//   - Subreddit + title render as a link to the per-row review page.
//   - The headline chip renders the OVERALL pipeline state, not the
//     raw story_jobs.status. ("Running" not "done", etc.)
//   - A pill row renders one pill per non-skipped pipeline stage with
//     accessible labels.
//   - SKIPPED stages are dropped from the rendered row.
//   - The latest event line is shown in the collapsed view.
//   - The "open detail page" tail link is always present.
//
// The expanded log + ticker behaviour requires runtime hooks; covered
// by manual QA per the plan.

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type {
  ActiveJobView,
  PipelineOverallState,
  PipelineStage,
  PipelineStageState,
} from "@/lib/story-jobs-live-shared";
import LiveJobCard from "./LiveJobCard";

const NOW = "2026-06-28T12:00:00.000Z";

function stage(
  id: PipelineStage["id"],
  state: PipelineStageState,
  label: string,
): PipelineStage {
  return { id, state, label };
}

const ALL_PENDING_STAGES: PipelineStage[] = [
  stage("story", "pending", "Story"),
  stage("short", "pending", "Short"),
  stage("hero", "pending", "Hero & thumb"),
  stage("publish", "skipped", "Publish"),
];

function makeJob(over: Partial<ActiveJobView> = {}): ActiveJobView {
  const stages = over.stages ?? ALL_PENDING_STAGES;
  return {
    job_id: "job-1",
    reddit_id: "abc123",
    status: "queued",
    progress: 0,
    error: null,
    story_id: null,
    requested_at: NOW,
    started_at: null,
    finished_at: null,
    title: "Hero card title",
    subreddit: "AITAH",
    with_media: 1,
    full_pipeline: 0,
    finisher_status: null,
    auto_publish_status: null,
    short: null,
    stages,
    overall: "queued",
    last_settled_at: null,
    events: [],
    ...over,
  };
}

describe("LiveJobCard — header", () => {
  it("renders the subreddit and title with a link to the per-row page", () => {
    const html = renderToString(<LiveJobCard job={makeJob()} />);
    // React SSR inserts <!-- --> fences between adjacent text + JSX
    // expression nodes; assert each side independently.
    expect(html).toMatch(/r\/(<!---->|<!-- -->)?AITAH/);
    expect(html).toContain("Hero card title");
    expect(html).toContain("/admin/reddit-sources/abc123");
  });

  it("falls back to the reddit_id when the title is null", () => {
    const html = renderToString(<LiveJobCard job={makeJob({ title: null })} />);
    expect(html).toContain("abc123");
  });

  it("falls back to em-dash when the subreddit is null", () => {
    const html = renderToString(
      <LiveJobCard job={makeJob({ subreddit: null })} />,
    );
    expect(html).toMatch(/r\/(<!---->|<!-- -->)?—/);
  });
});

describe("LiveJobCard — overall chip", () => {
  const labels: Record<PipelineOverallState, string> = {
    queued: "Queued",
    running: "Running",
    done: "All done",
    failed: "Failed",
    cancelled: "Stopped",
  };

  it("renders the overall state label, not the raw story_jobs.status", () => {
    for (const overall of Object.keys(labels) as PipelineOverallState[]) {
      const html = renderToString(
        <LiveJobCard
          job={makeJob({
            overall,
            // A 'done' story_jobs.status with overall='running' is exactly
            // the PR #138 lie we're fixing: render the overall.
            status: "done",
          })}
        />,
      );
      expect(html).toContain(`>${labels[overall]}<`);
    }
  });
});

describe("LiveJobCard — stage pill row", () => {
  it("renders one pill per non-skipped stage", () => {
    const stages: PipelineStage[] = [
      stage("story", "done", "Story"),
      stage("short", "running", "Short"),
      stage("hero", "pending", "Hero & thumb"),
      stage("publish", "skipped", "Publish"),
    ];
    const html = renderToString(
      <LiveJobCard job={makeJob({ stages, overall: "running" })} />,
    );
    // Three visible labels, one hidden.
    // React escapes '&' to '&amp;' in attribute values.
    expect(html).toMatch(/aria-label="Story: done"/);
    expect(html).toMatch(/aria-label="Short: running"/);
    expect(html).toMatch(/aria-label="Hero &amp; thumb: pending"/);
    expect(html).not.toMatch(/aria-label="Publish: /);
  });

  it("renders the full 4-stage row when publish is not skipped", () => {
    const stages: PipelineStage[] = [
      stage("story", "done", "Story"),
      stage("short", "done", "Short"),
      stage("hero", "done", "Hero & thumb"),
      stage("publish", "running", "Publish"),
    ];
    const html = renderToString(
      <LiveJobCard job={makeJob({ stages, overall: "running", full_pipeline: 1 })} />,
    );
    expect(html).toMatch(/aria-label="Story: done"/);
    expect(html).toMatch(/aria-label="Publish: running"/);
  });

  it("renders nothing in the pill row when every stage is skipped", () => {
    const stages: PipelineStage[] = [
      stage("story", "skipped", "Story"),
      stage("short", "skipped", "Short"),
      stage("hero", "skipped", "Hero & thumb"),
      stage("publish", "skipped", "Publish"),
    ];
    const html = renderToString(
      <LiveJobCard job={makeJob({ stages, overall: "done" })} />,
    );
    expect(html).not.toMatch(/aria-label="Pipeline progress"/);
  });

  it("uses the visible label inside the pill body", () => {
    const stages: PipelineStage[] = [
      stage("story", "done", "Story"),
      stage("short", "running", "Short"),
      stage("hero", "pending", "Hero & thumb"),
      stage("publish", "skipped", "Publish"),
    ];
    const html = renderToString(
      <LiveJobCard job={makeJob({ stages, overall: "running" })} />,
    );
    // Render-side textual content for each visible pill. React escapes
    // '&' to '&amp;' in element text content as well.
    expect(html).toContain(">Story<");
    expect(html).toContain(">Short<");
    expect(html).toContain(">Hero &amp; thumb<");
  });
});

describe("LiveJobCard — events + tail", () => {
  it("renders the most recent event line in the collapsed view", () => {
    const html = renderToString(
      <LiveJobCard
        job={makeJob({
          status: "processing",
          overall: "running",
          events: [
            {
              id: "e1",
              ts: NOW,
              level: "info",
              event: "claimed",
              message: "Worker claimed",
              payload: null,
            },
            {
              id: "e2",
              ts: NOW,
              level: "info",
              event: "idea_done",
              message: "Idea complete",
              payload: null,
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/\[(<!---->|<!-- -->)?idea_done(<!---->|<!-- -->)?\]/);
    expect(html).toContain("Idea complete");
  });

  it("shows the expand button with the event count when there are events", () => {
    const html = renderToString(
      <LiveJobCard
        job={makeJob({
          events: [
            {
              id: "e1",
              ts: NOW,
              level: "info",
              event: "queued",
              message: null,
              payload: null,
            },
            {
              id: "e2",
              ts: NOW,
              level: "info",
              event: "claimed",
              message: null,
              payload: null,
            },
          ],
        })}
      />,
    );
    expect(html).toContain("Show log (2)");
  });

  it("always renders the open-detail-page tail link", () => {
    const html = renderToString(<LiveJobCard job={makeJob()} />);
    expect(html).toContain("Open detail page");
  });
});
