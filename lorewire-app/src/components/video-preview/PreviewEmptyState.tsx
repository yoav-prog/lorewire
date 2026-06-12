// Shared diagnostic surface for the video editor's preview area.
//
// Phase 0 of the video editor overhaul (_plans/2026-06-12-video-editor-overhaul.md):
// the center area must NEVER render an unlabeled void. Every empty / loading /
// error state goes through this component so the user always sees what's wrong
// instead of a black rectangle.
//
// Three call sites, three reasons:
//   1. PreviewHost (outside Remotion Player) when previewFrameUrls is empty
//      or fails the pre-flight check — caller wraps in the 9:16 aspect box.
//   2. PreviewComposition (inside the Player iframe) when frameUrls is empty
//      at runtime — caller wraps in <AbsoluteFill> so it covers the iframe.
//   3. Player.errorFallback when the composition throws — caller wraps in
//      <AbsoluteFill> (Remotion's fallback contract).
//
// Kept dependency-free (no Remotion imports) so it can render both inside
// the Player iframe AND in plain DOM. The shared `reason` enum keeps the
// copy consistent across call sites.

import type { CSSProperties } from "react";

export type PreviewEmptyReason =
  | "no-frames" // story has zero doodle_frames in video_config
  | "no-frame-urls" // frames exist but previewFrameUrls didn't resolve
  | "player-error" // Remotion Player.errorFallback fired
  | "runtime-loading"; // dynamic import of @remotion/player still pending

export interface PreviewEmptyStateProps {
  reason: PreviewEmptyReason;
  detail?: string;
  storyId?: string;
}

const COPY: Record<PreviewEmptyReason, { label: string; hint: string }> = {
  "no-frames": {
    label: "No frames yet",
    hint: "Run the media + video pipeline so the preview has something to show.",
  },
  "no-frame-urls": {
    label: "Frames not resolved",
    hint:
      "The story has frames in its config but their image URLs did not resolve. " +
      "Check that the pipeline ran successfully and that the generated files exist.",
  },
  "player-error": {
    label: "Preview runtime error",
    hint:
      "The Remotion Player crashed while rendering this composition. " +
      "Open devtools and reload — the namespaced [video editor preview] logs will name the cause.",
  },
  "runtime-loading": {
    label: "Loading preview runtime",
    hint: "The Remotion Player is initializing.",
  },
};

const ROOT_STYLE: CSSProperties = {
  // Cream canvas matches PreviewComposition's AbsoluteFill so a swap between
  // the empty state and the real preview never reads as a flash of black.
  background: "#fbfaf4",
  color: "#0f172a",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  padding: "0 32px",
  textAlign: "center",
  width: "100%",
  height: "100%",
};

const LABEL_STYLE: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "#64748b",
};

const HINT_STYLE: CSSProperties = {
  maxWidth: "32ch",
  fontSize: 13,
  lineHeight: 1.5,
  color: "#475569",
};

const DETAIL_STYLE: CSSProperties = {
  marginTop: 4,
  maxWidth: "44ch",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  color: "#94a3b8",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const STORY_STYLE: CSSProperties = {
  marginTop: 8,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 10,
  color: "#94a3b8",
};

export function PreviewEmptyState({
  reason,
  detail,
  storyId,
}: PreviewEmptyStateProps) {
  const copy = COPY[reason];
  return (
    <div
      role="status"
      aria-live="polite"
      data-preview-empty-state={reason}
      style={ROOT_STYLE}
    >
      <p style={LABEL_STYLE}>{copy.label}</p>
      <p style={HINT_STYLE}>{copy.hint}</p>
      {detail && <p style={DETAIL_STYLE}>{detail}</p>}
      {storyId && <p style={STORY_STYLE}>story · {storyId}</p>}
    </div>
  );
}
