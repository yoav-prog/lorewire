"use client";

// Floating "jump to vote" CTA for the article reader. Lives on top of the
// modal scroll surface and watches the poll widget via IntersectionObserver
// — the button shows ONLY when the poll is off-screen, so the reader gets
// the shortcut while reading but the button stops competing with the poll
// once they've scrolled to it.
//
// Renders nothing when there's no poll to scroll to. The poll element is
// looked up by id at click time (instead of a ref) so callers don't have
// to thread one through GenArticle + the modal layout.

import { useEffect, useState } from "react";

interface Props {
  /** DOM id of the element to scroll into view. Defaults to the poll
   *  section's `article-poll` anchor that both shells wrap around their
   *  <PollWidget>. Exposed as a prop so future article surfaces (e.g. the
   *  public /v/[slug] page) can point at a different target without
   *  changing this component. */
  targetId?: string;
  /** Button copy. Default is the article-reader phrasing; the read-along
   *  surface might want something different ("Vote on this take"), so the
   *  string is overridable. */
  label?: string;
}

const DEFAULT_TARGET_ID = "article-poll";

export function JumpToPoll({
  targetId = DEFAULT_TARGET_ID,
  label = "Vote",
}: Props) {
  // `mounted` gates the first render so the button doesn't briefly flash
  // in the wrong state during hydration — we want the IntersectionObserver
  // to set the real `visible` value before anything renders.
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = document.getElementById(targetId);
    if (!el) {
      // No poll on this article — render nothing. Bail without
      // observing so we don't trap a stale element reference.
      setMounted(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // Show the floating CTA whenever the poll is OUT of view; hide
          // it the moment any part of the poll crosses into the viewport.
          // Inverting the relationship here keeps the button purposeful —
          // it's a shortcut to a destination the reader can't currently
          // see, and stops being a shortcut once they can.
          setVisible(!entry.isIntersecting);
        }
      },
      // 0 threshold + tiny rootMargin so the button hides the moment the
      // poll's top edge crosses the viewport bottom (not when the whole
      // poll is in view). Better UX: button is gone by the time the
      // reader's eye reaches the question.
      { threshold: 0, rootMargin: "0px 0px -10% 0px" },
    );
    observer.observe(el);
    setMounted(true);
    return () => observer.disconnect();
  }, [targetId]);

  if (!mounted || !visible) return null;

  const onClick = () => {
    const el = document.getElementById(targetId);
    if (!el) return;
    // Smooth scroll on browsers that support it; the modal scroll
    // container is the document for both AppShell + DesktopShell modal
    // layouts (the modal itself scrolls the page).
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    // eslint-disable-next-line no-console -- rule 14
    console.info("[lorewire jump to poll]", { targetId });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Jump to ${label}`}
      className="jump-to-poll-cta"
      style={{
        // Anchored to the viewport so the button rides ABOVE the modal
        // content regardless of where the user has scrolled to inside the
        // modal. z-index sits above the modal's 60 but below any future
        // toast layer.
        position: "fixed",
        right: "max(16px, env(safe-area-inset-right, 16px))",
        bottom: "max(24px, env(safe-area-inset-bottom, 24px))",
        zIndex: 70,
        // Pill shape, accent color, slight scale animation on press.
        // Box shadow gives the button enough lift to read against the
        // dark modal background without being obnoxious.
        background: "#E8462B",
        color: "#0A0A0C",
        padding: "12px 20px",
        borderRadius: 999,
        border: "none",
        boxShadow:
          "0 8px 24px rgba(232, 70, 43, 0.35), 0 2px 6px rgba(0, 0, 0, 0.45)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        fontFamily: "var(--font-display), system-ui, sans-serif",
        fontWeight: 700,
        fontSize: 14,
        textTransform: "uppercase",
        letterSpacing: ".06em",
        transition:
          "transform 120ms ease-out, box-shadow 120ms ease-out, opacity 180ms ease-out",
        // CSS-only fade-in via inline animation keyframes (declared in
        // globals.css under `.jump-to-poll-cta`). The class is purely a
        // hook for the keyframes; layout stays inline so this component
        // is portable to surfaces that don't share the modal's stylesheet.
      }}
      onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.96)")}
      onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
      onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
    >
      <span>{label}</span>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 5v14" />
        <path d="m19 12-7 7-7-7" />
      </svg>
    </button>
  );
}

interface InlineProps {
  targetId?: string;
  question?: string;
}

/** Inline "Cast your verdict" CTA rendered AT the end of the article body
 *  (and optionally elsewhere). Less visually loud than the floating button
 *  because it lives inline with the reading flow — but still high-contrast
 *  enough to invite the click. Smooth-scrolls to the same target. Renders
 *  nothing when the target doesn't exist on the page so an article
 *  without a poll silently omits the section. */
export function InlineJumpToPoll({
  targetId = DEFAULT_TARGET_ID,
  question,
}: InlineProps) {
  const [hasTarget, setHasTarget] = useState(false);

  useEffect(() => {
    setHasTarget(Boolean(document.getElementById(targetId)));
  }, [targetId]);

  if (!hasTarget) return null;

  const onClick = () => {
    const el = document.getElementById(targetId);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    // eslint-disable-next-line no-console -- rule 14
    console.info("[lorewire inline jump to poll]", { targetId });
  };

  return (
    <div
      style={{
        marginTop: 32,
        padding: "20px 22px",
        borderRadius: 14,
        background:
          "linear-gradient(135deg, rgba(232,70,43,0.12) 0%, rgba(232,70,43,0.04) 100%)",
        border: "1px solid rgba(232,70,43,0.28)",
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: "1 1 240px", minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontFamily: "var(--font-mono), monospace",
            fontSize: 10,
            letterSpacing: ".24em",
            textTransform: "uppercase",
            color: "#E8462B",
          }}
        >
          Your verdict
        </p>
        <p
          style={{
            margin: "4px 0 0",
            fontFamily: "var(--font-display), system-ui, sans-serif",
            fontWeight: 800,
            fontSize: 17,
            lineHeight: 1.25,
            color: "#F5F3EF",
          }}
        >
          {question || "Where do you land on this one?"}
        </p>
      </div>
      <button
        type="button"
        onClick={onClick}
        aria-label="Cast your verdict"
        style={{
          background: "#F5F3EF",
          color: "#0A0A0C",
          padding: "11px 18px",
          borderRadius: 999,
          border: "none",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          fontFamily: "var(--font-display), system-ui, sans-serif",
          fontWeight: 700,
          fontSize: 13.5,
          textTransform: "uppercase",
          letterSpacing: ".06em",
          flexShrink: 0,
          transition: "transform 120ms ease-out",
        }}
        onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.96)")}
        onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
        onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
      >
        <span>Cast your verdict</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 5v14" />
          <path d="m19 12-7 7-7-7" />
        </svg>
      </button>
    </div>
  );
}
