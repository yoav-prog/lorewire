// @vitest-environment happy-dom

// Pins the Phase 1 invariants of the storyboard rail (per
// _plans/2026-06-12-video-editor-overhaul.md):
//
//   - Every frame card shows its image (or a labeled fallback when the
//     URL didn't resolve — same lesson as Phase 0: never an unlabeled
//     surface).
//   - The frame index is rendered 1-based + zero-padded to width 2,
//     matching how the rest of the editor references frames.
//   - Caption and filename surface verbatim so the user can match a row
//     to the source story.
//   - The "selected" state is detectable from the DOM (aria-pressed +
//     accent-orange left border).
//
// Drift any of these and CI fails before the user notices the storyboard
// rail regressed.

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { FrameCard } from "./FrameCard";

const BASE = {
  index: 0,
  url: "/generated/abc-123/scene-1.png",
  caption: "by Friday the office gift fund went missing",
  filename: "scene-1.png",
  isSelected: false,
  onClick: () => undefined,
};

describe("FrameCard", () => {
  it("renders the resolved thumbnail when a URL is supplied", () => {
    const html = renderToString(<FrameCard {...BASE} />);
    expect(html).toContain(`src="${BASE.url}"`);
    expect(html).toContain(`loading="lazy"`);
    expect(html).toContain(`decoding="async"`);
  });

  it("renders a labeled fallback (not an unlabeled void) when the URL is empty", () => {
    const html = renderToString(<FrameCard {...BASE} url="" />);
    expect(html).not.toContain("<img");
    expect(html).toContain("no image");
  });

  it("renders the frame index 1-based and padded to width 2", () => {
    const html = renderToString(<FrameCard {...BASE} index={0} />);
    expect(html).toContain(">01<");

    const second = renderToString(<FrameCard {...BASE} index={9} />);
    expect(second).toContain(">10<");

    const long = renderToString(<FrameCard {...BASE} index={99} />);
    // Indices beyond 99 stop padding — the layout still works, the
    // assertion just pins that we don't crash or strip digits.
    expect(long).toContain(">100<");
  });

  it("surfaces the caption text verbatim", () => {
    const html = renderToString(<FrameCard {...BASE} />);
    expect(html).toContain(BASE.caption);
  });

  it("falls back to (no caption) when the caption is empty", () => {
    const html = renderToString(<FrameCard {...BASE} caption="" />);
    expect(html).toContain("(no caption)");
  });

  it("surfaces the filename verbatim", () => {
    const html = renderToString(<FrameCard {...BASE} filename="scene-7.png" />);
    expect(html).toContain("scene-7.png");
  });

  it("exposes the selected state via aria-pressed and an accent border", () => {
    const selected = renderToString(<FrameCard {...BASE} isSelected />);
    expect(selected).toContain(`aria-pressed="true"`);
    expect(selected).toContain("var(--color-accent)");

    const unselected = renderToString(<FrameCard {...BASE} isSelected={false} />);
    expect(unselected).toContain(`aria-pressed="false"`);
    expect(unselected).not.toContain("var(--color-accent)");
  });

  it("carries a data-frame-index attribute for E2E/selector use", () => {
    const html = renderToString(<FrameCard {...BASE} index={4} />);
    expect(html).toContain(`data-frame-index="4"`);
  });

  it("renders the row body as a real button so the click target is keyboard-accessible", () => {
    const html = renderToString(<FrameCard {...BASE} />);
    expect(html).toContain('<button type="button"');
  });

  it("renders an actions slot under the body when supplied", () => {
    const html = renderToString(
      <FrameCard
        {...BASE}
        isSelected
        actions={<span data-test-actions="yes">action slot</span>}
      />,
    );
    expect(html).toContain('data-test-actions="yes"');
    expect(html).toContain("action slot");
  });

  it("does not render the actions slot when not supplied", () => {
    const html = renderToString(<FrameCard {...BASE} isSelected />);
    expect(html).not.toContain("action slot");
  });

  it("renders the regen overlay when isRegenerating is true", () => {
    const html = renderToString(<FrameCard {...BASE} isRegenerating />);
    expect(html).toContain('data-testid="frame-regenerating-overlay"');
    expect(html).toContain("regen");
  });

  it("dims the thumbnail when isRegenerating is true", () => {
    const html = renderToString(<FrameCard {...BASE} isRegenerating />);
    // The img className gains opacity-40 while a regen is in flight so
    // the user sees the live state on collapsed cards too.
    expect(html).toMatch(/<img[^>]+class="[^"]*opacity-40/);
  });

  it("does NOT render the regen overlay by default", () => {
    const html = renderToString(<FrameCard {...BASE} />);
    expect(html).not.toContain('data-testid="frame-regenerating-overlay"');
    expect(html).not.toMatch(/<img[^>]+class="[^"]*opacity-40/);
  });
});
