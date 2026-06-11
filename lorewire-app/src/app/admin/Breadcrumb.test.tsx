// @vitest-environment happy-dom

// Rendering test for the Breadcrumb server component. We render via
// renderToString so happy-dom acts as a DOM target without needing
// @testing-library — keeps the dependency surface unchanged.

import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import Breadcrumb from "./Breadcrumb";

describe("Breadcrumb", () => {
  it("renders nothing when the trail is empty", () => {
    const html = renderToString(<Breadcrumb trail={[]} />);
    expect(html).toBe("");
  });

  it("renders a single-entry trail with a back arrow", () => {
    const html = renderToString(
      <Breadcrumb trail={[{ href: "/admin/content", label: "Inbox" }]} />,
    );
    expect(html).toContain("Inbox");
    expect(html).toContain("/admin/content");
    // React renders the &larr; HTML entity as the unicode left-arrow.
    expect(html).toContain("←");
  });

  it("renders a multi-entry trail with separators", () => {
    const html = renderToString(
      <Breadcrumb
        trail={[
          { href: "/admin/content", label: "Inbox" },
          { href: "/admin/content?kind=video", label: "Videos" },
        ]}
      />,
    );
    expect(html).toContain("Inbox");
    expect(html).toContain("Videos");
    expect(html).toContain("/admin/content?kind=video");
    // One inter-entry separator for two entries.
    const separatorMatches = html.match(/<span aria-hidden="true"[^>]*>\s*\/\s*<\/span>/g);
    expect(separatorMatches?.length ?? 0).toBe(1);
  });

  it("renders an accessible nav landmark", () => {
    const html = renderToString(
      <Breadcrumb trail={[{ href: "/admin/content", label: "Inbox" }]} />,
    );
    expect(html).toMatch(/<nav[^>]+aria-label="Breadcrumb"/);
  });
});
