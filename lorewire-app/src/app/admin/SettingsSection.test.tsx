// @vitest-environment happy-dom

// Rendering tests for the shared collapsible SettingsSection used across
// every /admin/* sub-nav page. Verifies: the section title and children
// render, the section is closed by default (no `open` attribute), passing
// `defaultOpen` flips it to open, and the optional status pill renders
// with the right tone class only when status is provided.

import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import SettingsSection from "./SettingsSection";

describe("SettingsSection", () => {
  it("renders the title and children", () => {
    const html = renderToString(
      <SettingsSection title="My section">
        <p>Body content</p>
      </SettingsSection>,
    );
    expect(html).toContain("My section");
    expect(html).toContain("Body content");
  });

  it("is closed by default (no open attribute on <details>)", () => {
    const html = renderToString(
      <SettingsSection title="Closed by default">
        <p>Body</p>
      </SettingsSection>,
    );
    // React serializes a falsy `open` by omitting the attribute. We rely
    // on the absence of `open="..."` / `open>` to confirm closed state.
    expect(html).toMatch(/<details(?![^>]*\bopen\b)/);
  });

  it("renders open when defaultOpen is true", () => {
    const html = renderToString(
      <SettingsSection title="Open" defaultOpen>
        <p>Body</p>
      </SettingsSection>,
    );
    expect(html).toMatch(/<details[^>]*\bopen\b/);
  });

  it("renders the description inside the body, not the summary", () => {
    const html = renderToString(
      <SettingsSection
        title="Has description"
        description="The body description text"
      >
        <p data-testid="kid">child</p>
      </SettingsSection>,
    );
    expect(html).toContain("The body description text");
    // Description must come AFTER </summary> so it's hidden when collapsed.
    const summaryEnd = html.indexOf("</summary>");
    const descIndex = html.indexOf("The body description text");
    expect(summaryEnd).toBeGreaterThan(-1);
    expect(descIndex).toBeGreaterThan(summaryEnd);
  });

  it("renders the status pill with ok tone when status.ok is true", () => {
    const html = renderToString(
      <SettingsSection
        title="Configured"
        status={{ ok: true, label: "Configured" }}
      >
        <p>Body</p>
      </SettingsSection>,
    );
    // Two "Configured" tokens are fine — title + pill label.
    expect(html).toContain("Configured");
    expect(html).toContain("✓");
    expect(html).toContain("text-accent");
    expect(html).not.toContain("text-warn");
  });

  it("renders the status pill with warn tone when status.ok is false", () => {
    const html = renderToString(
      <SettingsSection
        title="Missing"
        status={{ ok: false, label: "Env missing" }}
      >
        <p>Body</p>
      </SettingsSection>,
    );
    expect(html).toContain("Env missing");
    expect(html).toContain("✗");
    expect(html).toContain("text-warn");
    expect(html).not.toContain("text-accent");
  });

  it("omits the status pill when status is not provided", () => {
    const html = renderToString(
      <SettingsSection title="No status">
        <p>Body</p>
      </SettingsSection>,
    );
    expect(html).not.toContain("✓");
    expect(html).not.toContain("✗");
  });
});
