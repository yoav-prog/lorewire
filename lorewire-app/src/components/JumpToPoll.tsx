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

/** Slim "skip to the vote" banner rendered at the TOP of an article — sits
 *  between the title block and the body so a reader who already knows they
 *  want to vote can jump straight to the poll. Less visual weight than the
 *  end-of-body InlineJumpToPoll (single line, smaller pill) because it's
 *  the warm-up, not the close. */
interface TopArticleCTAProps {
  targetId?: string;
  question?: string;
  /** Set to false to hide the CTA. Prop-driven (not DOM-driven) so the
   *  caller controls visibility based on its own state — important when
   *  the poll element loads asynchronously (useStoryPoll). The previous
   *  DOM-lookup approach hid the CTA permanently when the poll wasn't in
   *  the tree at mount time, even after the async fetch landed and added
   *  the #article-poll element. Default true so existing call sites that
   *  haven't opted in still get the CTA. */
  enabled?: boolean;
}

export function TopArticleCTA({
  targetId = DEFAULT_TARGET_ID,
  question,
  enabled = true,
}: TopArticleCTAProps) {
  if (!enabled) return null;

  const onClick = () => {
    // Lookup is deferred to click time so we don't depend on mount-order
    // races between the CTA and the async-loaded poll element. By the
    // time the user clicks the visible CTA, the poll has rendered.
    const el = document.getElementById(targetId);
    if (!el) {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[lorewire top article cta miss]", { targetId });
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    // eslint-disable-next-line no-console -- rule 14
    console.info("[lorewire top article cta jump]", { targetId });
  };

  return (
    <div
      style={{
        marginTop: 16,
        marginBottom: 4,
        padding: "10px 14px",
        borderRadius: 12,
        background:
          "linear-gradient(90deg, rgba(232,70,43,0.08) 0%, rgba(232,70,43,0) 100%)",
        border: "1px solid rgba(232,70,43,0.22)",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <span
        aria-hidden
        className="lorewire-pulse-dot"
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: "#E8462B",
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontFamily: "var(--font-mono), monospace",
            fontSize: 10,
            letterSpacing: ".22em",
            textTransform: "uppercase",
            color: "#E8462B",
            lineHeight: 1.2,
          }}
        >
          Today's debate
        </p>
        <p
          style={{
            margin: "2px 0 0",
            fontFamily: "var(--font-body), system-ui, sans-serif",
            fontSize: 13.5,
            color: "rgba(245,243,239,0.85)",
            lineHeight: 1.35,
            // Truncate so a long question never wraps to a third line and
            // bloats the banner above the title's visual weight.
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {question || "Where do you land? Vote at the end."}
        </p>
      </div>
      <button
        type="button"
        onClick={onClick}
        aria-label="Skip to vote"
        style={{
          background: "transparent",
          color: "#E8462B",
          padding: "6px 10px",
          borderRadius: 999,
          border: "1px solid rgba(232,70,43,0.4)",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontFamily: "var(--font-display), system-ui, sans-serif",
          fontWeight: 700,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: ".08em",
          flexShrink: 0,
          transition: "background 120ms ease-out, transform 120ms ease-out",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = "rgba(232,70,43,0.14)")
        }
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.transform = "scale(1)";
        }}
        onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.96)")}
        onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
      >
        <span>Vote</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 5v14" />
          <path d="m19 12-7 7-7-7" />
        </svg>
      </button>
    </div>
  );
}

/** Inline "back to top" pill rendered AFTER the poll. Gives a clean way
 *  to return to the article's start once the reader has voted — pairs
 *  with TopArticleCTA / InlineJumpToPoll so the reading flow loops back
 *  on itself without forcing the user to hand-scroll. Renders nothing
 *  when the top anchor isn't on the page. */
interface BackToTopProps {
  /** DOM id of the article-top anchor. Default matches the
   *  `id="article-top"` placed on the modal hero / article wrapper. */
  targetId?: string;
  label?: string;
}

export function BackToTop({
  targetId = "article-top",
  label = "Back to top",
}: BackToTopProps) {
  // Always renders. The #article-top anchor is on the outer modal
  // container in both shells, so it's in the DOM on first paint — no
  // race condition like TopArticleCTA had with the async-loaded poll.
  // Defer the lookup to click time anyway so a stray remount doesn't
  // strand the button with a stale element reference.
  const onClick = () => {
    const el = document.getElementById(targetId);
    if (!el) {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[lorewire back to top miss]", { targetId });
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    // eslint-disable-next-line no-console -- rule 14
    console.info("[lorewire back to top]", { targetId });
  };

  return (
    <div
      style={{
        marginTop: 24,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className="lorewire-back-to-top"
        style={{
          background: "rgba(245,243,239,0.04)",
          color: "rgba(245,243,239,0.85)",
          padding: "12px 22px",
          borderRadius: 999,
          border: "1px solid rgba(245,243,239,0.18)",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          fontFamily: "var(--font-display), system-ui, sans-serif",
          fontWeight: 700,
          fontSize: 13,
          textTransform: "uppercase",
          letterSpacing: ".09em",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          transition:
            "background 160ms ease-out, color 160ms ease-out, transform 140ms ease-out, border-color 160ms ease-out, box-shadow 160ms ease-out",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(232,70,43,0.10)";
          e.currentTarget.style.color = "#F5F3EF";
          e.currentTarget.style.borderColor = "rgba(232,70,43,0.45)";
          e.currentTarget.style.boxShadow =
            "0 6px 22px rgba(232,70,43,0.18)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "rgba(245,243,239,0.04)";
          e.currentTarget.style.color = "rgba(245,243,239,0.85)";
          e.currentTarget.style.borderColor = "rgba(245,243,239,0.18)";
          e.currentTarget.style.boxShadow = "none";
          e.currentTarget.style.transform = "scale(1)";
        }}
        onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.96)")}
        onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
      >
        <svg
          className="lorewire-back-to-top__arrow"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 19V5" />
          <path d="m5 12 7-7 7 7" />
        </svg>
        <span>{label}</span>
      </button>
    </div>
  );
}

interface InlineProps {
  targetId?: string;
  question?: string;
  /** Set to false to hide the CTA. Prop-driven (not DOM-driven) so the
   *  caller controls visibility based on its own state — same reasoning
   *  as TopArticleCTA.enabled above. Default true so existing call sites
   *  that haven't opted in still get the CTA. */
  enabled?: boolean;
}

/** Inline "Cast your verdict" CTA rendered AT the end of the article body
 *  (and optionally elsewhere). Less visually loud than the floating
 *  button because it lives inline with the reading flow — but still
 *  high-contrast enough to invite the click. Smooth-scrolls to the same
 *  target. Hides when `enabled` is false so an article without a poll
 *  silently omits the section. */
export function InlineJumpToPoll({
  targetId = DEFAULT_TARGET_ID,
  question,
  enabled = true,
}: InlineProps) {
  if (!enabled) return null;

  const onClick = () => {
    const el = document.getElementById(targetId);
    if (!el) {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[lorewire inline jump to poll miss]", { targetId });
      return;
    }
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
