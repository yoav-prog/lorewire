// @vitest-environment happy-dom

// Pins the no-count-no-badge invariant. SidebarLiveBadge mounts with
// count=null and renders nothing until the first poll lands; under
// renderToString the useEffect never fires, so the SSR markup is
// always empty. That's exactly the contract we want to lock down: a
// staffer with no active runs gets a clean sidebar entry, not a
// "0" badge taking up space.
//
// Non-zero rendering is exercised by manual QA (queue a row, watch
// the sidebar tick to "1") because it depends on the live polling
// loop which isn't part of the SSR pass.

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("@/app/admin/actions", () => ({
  countActiveStoryJobsAction: vi.fn(async () => 0),
}));

import SidebarLiveBadge from "./SidebarLiveBadge";

describe("SidebarLiveBadge", () => {
  it("renders nothing on initial mount (count starts null)", () => {
    const html = renderToString(<SidebarLiveBadge />);
    expect(html).toBe("");
  });
});
