// @vitest-environment happy-dom

// Pins the no-count-no-badge invariant: the badge mounts with count=null and
// renders nothing until the first poll lands; under renderToString the useEffect
// never fires, so the SSR markup is empty. A reviewer with an empty queue gets a
// clean sidebar entry, not a "0". Non-zero rendering is exercised by manual QA.

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("@/app/admin/actions", () => ({
  countSubmissionQueueAction: vi.fn(async () => 0),
}));

import SidebarSubmissionsBadge from "./SidebarSubmissionsBadge";

describe("SidebarSubmissionsBadge", () => {
  it("renders nothing on initial mount (count starts null)", () => {
    const html = renderToString(<SidebarSubmissionsBadge />);
    expect(html).toBe("");
  });
});
