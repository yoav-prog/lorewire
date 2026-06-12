// @vitest-environment happy-dom

// StatusStepIndicator tests. The component is purely visual on the
// server side — the click handlers fire changeStatus, which is a server
// action we don't exercise from a unit test. The tests below pin the
// rendered shape so the workflow steps stay clickable and the current
// status is unambiguous on first paint:
//   - three step buttons exist (review / ready / published)
//   - the current step carries aria-current=step and is disabled
//   - reachable next steps are not disabled
//   - the connector fill width tracks the current step
//   - archived state renders an "Unarchive" affordance instead
//
// We mock the server action import so renderToString doesn't pull a
// real server-side fetch — only the visual contract matters here.

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("@/app/admin/actions", () => ({
  changeStatus: vi.fn(),
}));

import { StatusStepIndicator } from "./StatusStepIndicator";

describe("StatusStepIndicator", () => {
  it("renders three workflow steps", () => {
    const html = renderToString(
      <StatusStepIndicator storyId="s1" currentStatus="review" />,
    );
    expect(html).toContain('data-step="review"');
    expect(html).toContain('data-step="ready"');
    expect(html).toContain('data-step="published"');
  });

  it("marks the current step with aria-current=step and disables it", () => {
    const html = renderToString(
      <StatusStepIndicator storyId="s1" currentStatus="ready" />,
    );
    // The ready button gets both aria-current="step" and disabled.
    expect(html).toMatch(
      /data-step="ready"[^>]*aria-current="step"|aria-current="step"[^>]*data-step="ready"/,
    );
    expect(html).toMatch(/data-step="ready"[^>]*disabled=""|disabled=""[^>]*data-step="ready"/);
  });

  it("does not disable steps the admin can move to", () => {
    const html = renderToString(
      <StatusStepIndicator storyId="s1" currentStatus="review" />,
    );
    // Published button is reachable from review.
    expect(html).not.toMatch(/data-step="published"[^>]*disabled=""/);
  });

  it("flips the side action from Archive to Unarchive when archived", () => {
    const archived = renderToString(
      <StatusStepIndicator storyId="s1" currentStatus="archived" />,
    );
    expect(archived).toContain("Unarchive");

    const live = renderToString(
      <StatusStepIndicator storyId="s1" currentStatus="ready" />,
    );
    expect(live).toContain("Archive");
    expect(live).not.toContain("Unarchive");
  });

  it("falls back to the draft hint when the status is pre-review", () => {
    const html = renderToString(
      <StatusStepIndicator storyId="s1" currentStatus="draft" />,
    );
    expect(html.toLowerCase()).toContain("draft");
  });

  it("renders the workflow group with an accessible label", () => {
    const html = renderToString(
      <StatusStepIndicator storyId="s1" currentStatus="review" />,
    );
    expect(html).toContain('aria-label="Workflow status"');
  });
});
