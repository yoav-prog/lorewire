"use client";

// End-of-tab CTA that nudges the reader from Watch / Read / Read-along
// into the Comments tab. Mirrors the InlineJumpToPoll pattern (single
// inline banner, brand colors, end-of-content placement) so the modal's
// CTAs feel like one family — Poll above, Comments below.
//
// Two states:
//   - count > 0  →  "Join the discussion" with the live count
//   - count == 0 →  "Start the conversation — be the first to comment"
// Both states use the same shape so the layout doesn't jump as comments
// land. Visibility is prop-driven (enabled=false → render null) so the
// parent can hide the CTA on the Comments tab itself.
//
// onJump is a callback rather than a hash navigate because the Comments
// tab is a tab in the modal, not a DOM anchor — the parent owns tab
// state and switches it imperatively.

interface JumpToCommentsProps {
  count: number;
  onJump: () => void;
  /** Pass false to hide entirely (e.g. when the Comments tab itself is
   *  active, or when the comments kill switch is off and the count
   *  endpoint returned enabled=false). Default true. */
  enabled?: boolean;
}

const ACCENT = "#E8462B";
const INK = "#F5F3EF";
const INK_MUTED = "rgba(245,243,239,0.7)";
const SURFACE = "rgba(245,243,239,0.04)";
const SURFACE_HOVER = "rgba(232,70,43,0.10)";

export function JumpToComments({
  count,
  onJump,
  enabled = true,
}: JumpToCommentsProps) {
  if (!enabled) return null;
  const empty = count === 0;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onJump}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onJump();
        }
      }}
      aria-label={
        empty
          ? "Start the discussion in Comments"
          : `Read ${count} ${count === 1 ? "comment" : "comments"}`
      }
      style={{
        margin: "28px 0 4px",
        padding: "14px 16px",
        borderRadius: 14,
        border: `1px solid ${ACCENT}33`,
        background: SURFACE,
        display: "flex",
        alignItems: "center",
        gap: 14,
        cursor: "pointer",
        transition:
          "background 180ms ease-out, border-color 180ms ease-out, transform 120ms ease-out",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = SURFACE_HOVER;
        e.currentTarget.style.borderColor = `${ACCENT}80`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = SURFACE;
        e.currentTarget.style.borderColor = `${ACCENT}33`;
        e.currentTarget.style.transform = "scale(1)";
      }}
      onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.985)")}
      onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
    >
      {/* Chat bubble glyph in the accent color — same visual family as
          the dot pattern used in TopArticleCTA. Anchors the CTA so the
          eye lands on it before the copy. */}
      <span
        aria-hidden
        style={{
          width: 38,
          height: 38,
          borderRadius: 10,
          background: `${ACCENT}1F`,
          color: ACCENT,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
      </span>

      <div style={{ minWidth: 0, flex: 1 }}>
        <p
          style={{
            margin: 0,
            fontFamily: "var(--font-mono), ui-monospace, monospace",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: ".22em",
            textTransform: "uppercase",
            color: ACCENT,
            lineHeight: 1.2,
          }}
        >
          {empty ? "Start the conversation" : "Comments"}
        </p>
        <p
          style={{
            margin: "3px 0 0",
            fontFamily: "var(--font-body), system-ui, sans-serif",
            fontSize: 14,
            color: empty ? INK_MUTED : INK,
            lineHeight: 1.35,
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {empty
            ? "Be the first to share your take on this story."
            : `${count} ${count === 1 ? "reader has" : "readers have"} weighed in. Join them.`}
        </p>
      </div>

      <span
        aria-hidden
        style={{
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "7px 12px",
          borderRadius: 999,
          background: ACCENT,
          color: "#0A0A0C",
          fontFamily: "var(--font-display), system-ui, sans-serif",
          fontWeight: 700,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: ".08em",
        }}
      >
        <span>{empty ? "Write" : "Read"}</span>
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </svg>
      </span>
    </div>
  );
}
