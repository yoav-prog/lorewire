"use client";

// Crawlable wrapper for story cards and hero CTAs. Renders a real
// <a href="/v/{slug}"> when the story has a public reader path, so
// search/AI crawlers can discover story pages from the homepage —
// before 2026-07-05 every card was a <button> and Google indexed
// exactly one URL (the homepage). The click still opens the in-page
// modal via preventDefault, so the user experience is unchanged;
// middle-click / ctrl-click / "open in new tab" get the real page.
// Stories without a slug (baked sample catalog) fall back to a
// <button> — an <a> without href is neither crawlable nor focusable.
//
// PollRailCard already links to /v/ directly; this brings the poster
// cards, Top 10 tiles, and hero CTAs onto the same crawlable pattern.

import Link from "next/link";
import React from "react";

import { storyReaderPath } from "@/lib/story-path";
import type { Story } from "@/lib/stories";

interface StoryLinkProps {
  story: Pick<Story, "slug">;
  /** The existing open-modal handler; runs for link and button alike. */
  onActivate: () => void;
  className?: string;
  style?: React.CSSProperties;
  "aria-label"?: string;
  children: React.ReactNode;
}

export function StoryLink({
  story,
  onActivate,
  className,
  style,
  "aria-label": ariaLabel,
  children,
}: StoryLinkProps) {
  const href = storyReaderPath(story);
  if (href) {
    return (
      // prefetch off: rails render dozens of cards and the href is the
      // crawl/new-tab path, not the primary click path (that's the modal).
      <Link
        href={href}
        prefetch={false}
        className={className}
        style={style}
        aria-label={ariaLabel}
        onClick={(e) => {
          // Plain left-click opens the modal (SPA behavior unchanged);
          // Link skips navigation when the handler prevents default.
          // Modified clicks (new tab / window) keep anchor semantics.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          onActivate();
        }}
      >
        {children}
      </Link>
    );
  }
  return (
    <button
      className={className}
      style={style}
      aria-label={ariaLabel}
      onClick={onActivate}
    >
      {children}
    </button>
  );
}
