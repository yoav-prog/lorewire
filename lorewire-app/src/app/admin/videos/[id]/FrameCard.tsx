// Frame card for the video editor's left-rail storyboard. Pure
// presentational — props in, JSX out — so the test renders without the
// rest of EditorClient's heavy dynamic-import surface.
//
// Phase 1 of the video editor overhaul
// (_plans/2026-06-12-video-editor-overhaul.md): replace the text-only
// frame list with cards that actually show the image. Prompt slot is
// deferred to Phase 2 (when the schema gets `image_prompt`); the card
// layout is intentionally lockable for that addition without a redesign.
//
// Visual contract:
//   - 64px-wide 9:16 thumbnail with the frame index chip overlaid top-left
//   - 3-line caption snippet to the right of the thumbnail
//   - Filename underneath in mono / muted (kept for parity with the
//     pre-card text rail until prompts land)
//   - Selected state: accent-orange left border + raised surface bg
//
// Matches the editor's design tokens (bg-surface / bg-surface2 / border-line
// / text-ink / text-muted / var(--color-accent)). No gradients, no
// glassmorphism — those are the AI-generated tells rule 5 calls out.

export interface FrameCardProps {
  index: number; // 0-based; rendered as 1-based padded to width 2
  url: string; // resolved browser URL; empty string = no image yet
  caption: string;
  filename: string;
  isSelected: boolean;
  onClick: () => void;
  /** Rendered below the card body when the frame is selected. Used by
   *  EditorClient to inject FrameRegenActions (Phase 3) without forcing
   *  this layout-only component to know about server actions. */
  actions?: React.ReactNode;
}

export function FrameCard({
  index,
  url,
  caption,
  filename,
  isSelected,
  onClick,
  actions,
}: FrameCardProps) {
  const label = String(index + 1).padStart(2, "0");
  // Container + inner-button split: an `actions` slot can contain
  // interactive controls (textarea, buttons) which is invalid HTML nested
  // inside the outer button. The button now wraps only the row body; the
  // actions render below it inside the same selected-state border.
  return (
    <div
      data-frame-index={index}
      className={`border-b border-line transition-colors ${
        isSelected ? "bg-surface2" : ""
      }`}
      style={{
        borderLeft: isSelected
          ? "2px solid var(--color-accent)"
          : "2px solid transparent",
      }}
    >
      <button
        type="button"
        onClick={onClick}
        aria-pressed={isSelected}
        className={`block w-full p-3 text-left ${
          isSelected ? "" : "hover:bg-surface2/60"
        }`}
      >
        <div className="flex items-start gap-3">
          <div
            className="relative shrink-0 overflow-hidden rounded border border-line bg-surface"
            style={{ width: 64, aspectRatio: "9 / 16" }}
          >
            {url ? (
              // eslint-disable-next-line @next/next/no-img-element -- pipeline-generated thumbnails, not Next-optimised
              <img
                src={url}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center font-mono text-[8px] uppercase tracking-wider text-muted">
                no image
              </div>
            )}
            <span className="absolute left-1 top-1 rounded bg-bg/85 px-1 font-mono text-[9px] tabular-nums text-ink">
              {label}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-3 text-[12px] leading-snug text-ink">
              {caption ? (
                caption
              ) : (
                <span className="text-muted">(no caption)</span>
              )}
            </p>
            <p className="mt-1 truncate font-mono text-[10px] text-muted">
              {filename}
            </p>
          </div>
        </div>
      </button>
      {actions && <div className="px-3 pb-3">{actions}</div>}
    </div>
  );
}
