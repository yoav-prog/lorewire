// @vitest-environment happy-dom

// Pins LiveJobCard's collapsed-default-view contract:
//
//   - Subreddit + title render as a link to the per-row review page.
//   - Status chip text matches the raw status (queued / processing /
//     done / error / cancelled).
//   - The latest event line is shown in the collapsed view so the
//     admin can read the most recent phase without expanding.
//   - The "open detail page" tail link is always present.
//
// The expanded log + ticker behaviour requires runtime hooks; covered
// by manual QA per the plan.

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { ActiveJobView } from "@/lib/story-jobs-live-shared";
import LiveJobCard from "./LiveJobCard";

const NOW = "2026-06-28T12:00:00.000Z";

function makeJob(over: Partial<ActiveJobView> = {}): ActiveJobView {
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
    events: [],
    ...over,
  };
}

describe("LiveJobCard", () => {
  it("renders the subreddit and title with a link to the per-row page", () => {
    const html = renderToString(<LiveJobCard job={makeJob()} />);
    // React SSR inserts <!-- --> fences between adjacent text + JSX
    // expression nodes; assert each side of the fence independently.
    expect(html).toMatch(/r\/(<!---->|<!-- -->)?AITAH/);
    expect(html).toContain("Hero card title");
    expect(html).toContain("/admin/reddit-sources/abc123");
  });

  it("falls back to the reddit_id when the title is null", () => {
    const html = renderToString(
      <LiveJobCard job={makeJob({ title: null })} />,
    );
    expect(html).toContain("abc123");
  });

  it("falls back to em-dash when the subreddit is null", () => {
    const html = renderToString(
      <LiveJobCard job={makeJob({ subreddit: null })} />,
    );
    expect(html).toMatch(/r\/(<!---->|<!-- -->)?—/);
  });

  it("renders the raw status as a chip", () => {
    for (const status of ["queued", "processing", "done", "error", "cancelled"]) {
      const html = renderToString(<LiveJobCard job={makeJob({ status })} />);
      expect(html).toContain(`>${status}<`);
    }
  });

  it("renders the most recent event line in the collapsed view", () => {
    const html = renderToString(
      <LiveJobCard
        job={makeJob({
          status: "processing",
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
    // SSR comment fences split the [event] brackets from the event
    // name; match via regex tolerant of optional <!-- -->.
    expect(html).toMatch(/\[(<!---->|<!-- -->)?idea_done(<!---->|<!-- -->)?\]/);
    expect(html).toContain("Idea complete");
    // The earlier event is also in the DOM, but only via the expand
    // button's count label, not as the visible latest line.
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
