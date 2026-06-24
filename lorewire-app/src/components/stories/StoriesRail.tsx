"use client";

// IG-style horizontal rail of circular Story thumbnails. Used in two
// places with two different presentations:
//
//   - Mobile (AppShell): bare rail above the Billboard, no title row,
//     compact 4px / 16px paddings. Matches the IG mobile feel.
//   - Desktop (DesktopShell): wrapped inside the page's design-system
//     section shell (title + max-width + horizontal padding matching
//     the other Rails on the page). Selected via `title` prop.
//
// Visual contract:
//
//   - circle: 64px on mobile (sm-), 72px on desktop (sm+)
//   - unseen → 2px accent ring (--color-accent)
//   - thumb caption: 1 line under the circle, ellipsized, 11px
//
// Behavior contract:
//
//   - if every wire in the playlist is already viewed → render nothing
//     (per plan: "hide when empty rather than show a row of grey rings")
//   - tapping a thumbnail calls onOpen(wireId), which the parent wires
//     to the URL state hook + the viewer mount
//   - rail is horizontally scrollable with hidden scrollbars (.noscroll)
//     so the long-tail playlist doesn't add visual chrome

import { memo } from "react";

import type { Story } from "@/lib/stories";

export interface StoriesRailProps {
  /** Full Stories playlist (already capped + augmented by
   *  resolveStoriesPlaylist). The rail filters by viewedIds itself
   *  rather than receiving an already-filtered list so the unseen
   *  count is the rail's own responsibility — keeps the viewer free
   *  to receive the unfiltered playlist for deep-link entry. */
  playlist: Story[];
  /** Story ids the viewer has already consumed. Drives the unseen
   *  ring + the "all-seen → hide rail" decision. */
  viewedIds: string[];
  /** Called when the user taps a thumbnail. The parent opens the
   *  StoriesViewer via the URL state hook. */
  onOpen: (wireId: string) => void;
  /** Optional className appended to the outer container so the parent
   *  shell can control vertical spacing without the rail caring. */
  className?: string;
  /** When set, the rail renders inside the page's design-system
   *  section shell: an h2 title row + max-w-[1600px] + px-10 inner
   *  padding so the circles line up horizontally with the poster
   *  rails below. Used by DesktopShell where the rail lives in the
   *  content area (so the Hero stays full-bleed). Mobile leaves
   *  this unset for the IG-style bare rail. */
  title?: string;
}

function RailInner({
  playlist,
  viewedIds,
  onOpen,
  className,
  title,
}: StoriesRailProps) {
  const viewedSet = new Set(viewedIds);
  const unseen = playlist.filter((s) => !viewedSet.has(s.id));
  // The rail's promise is "what's new." With zero unseen stories the
  // rail disappears entirely — a row of grey rings would invite a tap
  // that opens content the user has already consumed.
  if (unseen.length === 0) {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[stories rail hide]", {
      total: playlist.length,
      viewed: viewedSet.size,
      reason: "all-seen",
    });
    return null;
  }

  // eslint-disable-next-line no-console -- rule 14
  console.info("[stories rail mount]", {
    total: playlist.length,
    unseen_count: unseen.length,
    presentation: title ? "desktop" : "mobile",
  });

  if (title) {
    // Desktop presentation: section + h2 + content-width wrapper so the
    // circles line up with the other Rails on the page. The horizontal
    // padding (px-10) and max-width (1600) match the Rail() wrapper in
    // DesktopShell exactly. No prev/next chevrons — circles are small
    // enough that drag-to-scroll on the touchpad is enough; adding
    // chevrons would overstate the visual weight of the row.
    return (
      <section
        className={["mt-11", className ?? ""].join(" ").trim()}
        aria-label="Stories"
      >
        <h2 className="font-display font-bold uppercase tracking-tightest text-[19px] text-ink px-10 max-w-[1600px] mx-auto mb-3.5">
          {title}
        </h2>
        <div className="px-10 max-w-[1600px] mx-auto">
          <div
            className="flex gap-4 overflow-x-auto noscroll"
            role="list"
            aria-label="New stories"
          >
            {unseen.map((story, i) => (
              <RailThumb
                key={story.id}
                story={story}
                position={i}
                onOpen={onOpen}
              />
            ))}
          </div>
        </div>
      </section>
    );
  }

  // Mobile presentation: bare row of circles, no title, IG-style.
  return (
    <div className={["w-full", className ?? ""].join(" ").trim()}>
      <div
        className="flex gap-3 px-4 py-3 overflow-x-auto noscroll"
        role="list"
        aria-label="New stories"
      >
        {unseen.map((story, i) => (
          <RailThumb
            key={story.id}
            story={story}
            position={i}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}

interface RailThumbProps {
  story: Story;
  position: number;
  onOpen: (id: string) => void;
}

function RailThumb({ story, position, onOpen }: RailThumbProps) {
  const handleClick = () => {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[stories rail tap]", {
      id: story.id,
      position,
      was_unseen: true,
    });
    onOpen(story.id);
  };
  return (
    <button
      type="button"
      role="listitem"
      onClick={handleClick}
      className="shrink-0 flex flex-col items-center gap-1.5 active:scale-[.96] transition"
      aria-label={story.title || story.id}
    >
      <span
        className="block rounded-full p-[2px]"
        style={{ background: "var(--color-accent)" }}
      >
        <span
          className="block w-[64px] h-[64px] sm:w-[72px] sm:h-[72px] rounded-full overflow-hidden"
          style={{ background: "var(--color-surface2)" }}
        >
          {story.heroImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={story.heroImage}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover"
            />
          ) : (
            <span
              className="flex w-full h-full items-center justify-center font-display font-black text-2xl"
              style={{ color: "var(--color-muted)" }}
            >
              {story.glyph || "•"}
            </span>
          )}
        </span>
      </span>
      <span
        className="font-body text-[11px] font-semibold tracking-tight max-w-[80px] truncate"
        style={{ color: "var(--color-ink)" }}
        title={story.title}
      >
        {story.title}
      </span>
    </button>
  );
}

export const StoriesRail = memo(RailInner);
