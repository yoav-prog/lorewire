// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { AutoSaveStatus } from "./AutoSaveStatus";

describe("AutoSaveStatus", () => {
  it("renders nothing when idle and hideIdle defaults to true", () => {
    const html = renderToString(<AutoSaveStatus state="idle" />);
    expect(html).toBe("");
  });

  it("renders the idle label when hideIdle is false", () => {
    const html = renderToString(
      <AutoSaveStatus state="idle" hideIdle={false} />,
    );
    expect(html).toContain("Up to date");
  });

  it("renders the saving label in warn tone", () => {
    const html = renderToString(<AutoSaveStatus state="saving" />);
    expect(html).toContain("Saving");
    expect(html).toContain("text-warn");
  });

  it("renders the saved label", () => {
    const html = renderToString(<AutoSaveStatus state="saved" />);
    expect(html).toContain("Saved");
    expect(html).toContain("text-ink");
  });

  it("renders the failure label in danger tone", () => {
    const html = renderToString(<AutoSaveStatus state="error" />);
    expect(html).toContain("Save failed");
    expect(html).toContain("text-danger");
  });

  it("attaches the detail as a title attribute when supplied", () => {
    const html = renderToString(
      <AutoSaveStatus state="error" detail="session-stolen" />,
    );
    expect(html).toContain('title="session-stolen"');
  });

  it("carries a data-state attribute matching the state prop", () => {
    const html = renderToString(<AutoSaveStatus state="saving" />);
    expect(html).toContain('data-state="saving"');
  });
});
