// @vitest-environment happy-dom

// Regression test for the Phase 0 invariant of the video editor overhaul:
// the preview center area MUST always render labeled content for every
// possible empty / loading / error state. Never an unlabeled void.
//
// PreviewEmptyState is the single source of truth that PreviewHost, the
// PlayerNoSSR `loading` fallback, the Player `errorFallback`, and the
// Remotion composition's defensive guard all route through. Pinning its
// behavior here means any regression that strips the diagnostic copy
// fails CI before the user has to file a "preview is black again" bug.

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import {
  PreviewEmptyState,
  type PreviewEmptyReason,
} from "./PreviewEmptyState";

const ALL_REASONS: PreviewEmptyReason[] = [
  "no-frames",
  "no-frame-urls",
  "player-error",
  "runtime-loading",
];

describe("PreviewEmptyState", () => {
  it.each(ALL_REASONS)(
    "renders a labeled status surface for reason %s",
    (reason) => {
      const html = renderToString(<PreviewEmptyState reason={reason} />);
      // The labeled-content invariant: must always include the
      // accessible role and the reason marker, and must not be empty.
      expect(html).toContain(`role="status"`);
      expect(html).toContain(`data-preview-empty-state="${reason}"`);
      // A non-trivial body — guards against future refactors that strip
      // the copy and leave just the role attributes.
      expect(html.length).toBeGreaterThan(120);
    },
  );

  it("includes the reason label and hint copy for no-frames", () => {
    const html = renderToString(<PreviewEmptyState reason="no-frames" />);
    expect(html).toContain("No frames yet");
    expect(html).toContain("Run the media + video pipeline");
  });

  it("includes the diagnostic label and hint for no-frame-urls", () => {
    const html = renderToString(<PreviewEmptyState reason="no-frame-urls" />);
    expect(html).toContain("Frames not resolved");
    expect(html).toContain("pipeline ran successfully");
  });

  it("includes the diagnostic label and hint for player-error", () => {
    const html = renderToString(<PreviewEmptyState reason="player-error" />);
    expect(html).toContain("Preview runtime error");
    expect(html).toContain("[video editor preview]");
  });

  it("includes the loading label for runtime-loading", () => {
    const html = renderToString(
      <PreviewEmptyState reason="runtime-loading" />,
    );
    expect(html).toContain("Loading preview runtime");
  });

  it("surfaces a real detail string verbatim", () => {
    const html = renderToString(
      <PreviewEmptyState
        reason="player-error"
        detail="TypeError: Cannot read properties of undefined (reading 'fps')"
      />,
    );
    expect(html).toContain(
      "TypeError: Cannot read properties of undefined (reading &#x27;fps&#x27;)",
    );
  });

  it("surfaces the story id when supplied", () => {
    const html = renderToString(
      <PreviewEmptyState reason="no-frame-urls" storyId="abc-123" />,
    );
    expect(html).toContain("abc-123");
    expect(html).toContain("story");
  });

  it("does not render the story line when storyId is omitted", () => {
    const html = renderToString(<PreviewEmptyState reason="no-frames" />);
    // The "story · " label is only emitted when storyId is supplied.
    expect(html).not.toContain("story ·");
  });

  it("paints a cream background, not black, so a swap with the real preview never reads as a void", () => {
    const html = renderToString(<PreviewEmptyState reason="no-frames" />);
    // The Composition's AbsoluteFill paints #fbfaf4 — the empty state has
    // to match so the visual handoff between empty/loading/error/real is
    // seamless. Drifting this color is the regression we're guarding.
    expect(html).toContain("background:#fbfaf4");
  });
});
