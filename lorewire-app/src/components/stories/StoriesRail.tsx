"use client";

// IG-style horizontal rail of circular Story thumbnails. Mobile-only —
// PR 2026-06-25 final-decision removed it from desktop after the
// layout-fix iteration (PR #82) still didn't read right against the
// hero composition. Desktop discovery happens through the rails
// (Continue Watching, Top 10, category rails). On mobile the rail
// sits above the Billboard, matching the IG-on-phone shape users
// expect.
//
// Visual contract:
//
//   - circle: 64px on mobile (sm-) → 72px at sm+ (just for tablet
//     portrait, in case the breakpoint catches it)
//   - unseen → 2px accent ring (--color-accent)
//   - viewed → 1.5px muted ring (--color-line) + slightly reduced
//     thumb opacity, with a CSS transition so the moment of "marked
//     viewed" fades the highlight rather than snapping it
//
// Behavior contract (post-IG-fade plan):
//
//   - viewed stories STAY in the rail with a dimmed ring (matches IG;
//     v1 used to hide them entirely, which was the wrong call —
//     hiding lost the affordance of "re-watch this one")
//   - rail hides entirely only when the PLAYLIST is empty (truly no
//     published stories at all), not when every story is viewed
//   - tapping a thumbnail calls onOpen(wireId), which the parent wires
//     to the URL state hook + the viewer mount
//   - rail is horizontally scrollable with hidden scrollbars (.noscroll)

import { memo } from "react";

import type { Story } from "@/lib/stories";

export interface StoriesRailProps {
  /** Full Stories playlist (already capped + augmented by
   *  resolveStoriesPlaylist). The rail decides per-thumb whether to
   *  render with an unseen or viewed ring based on viewedIds. */
  playlist: Story[];
  /** Story ids the viewer has already consumed. Drives the per-thumb
   *  ring style + the [stories rail mount] log counts. */
  viewedIds: string[];
  /** Called when the user taps a thumbnail. The parent opens the
   *  StoriesViewer via the URL state hook. */
  onOpen: (wireId: string) => void;
  /** Optional className appended to the outer container so the parent
   *  shell can control vertical spacing without the rail caring. */
  className?: string;
}

function RailInner({
  playlist,
  viewedIds,
  onOpen,
  className,
}: StoriesRailProps) {
  const viewedSet = new Set(viewedIds);
  // Hide entirely only when there's nothing to show. Viewed stories
  // are still worth rendering — the user might want to re-watch one
  // (IG behavior). Hiding the rail when all-seen would lose that
  // affordance and visually punish users who actually consumed the
  // content.
  if (playlist.length === 0) {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[stories rail hide]", {
      total: 0,
      viewed: viewedSet.size,
      reason: "empty-playlist",
    });
    return null;
  }

  const unseenCount = playlist.filter((s) => !viewedSet.has(s.id)).length;
  // eslint-disable-next-line no-console -- rule 14
  console.info("[stories rail mount]", {
    total: playlist.length,
    unseen_count: unseenCount,
    viewed_count: playlist.length - unseenCount,
  });

  return (
    <div className={["w-full", className ?? ""].join(" ").trim()}>
      <div
        className="flex gap-3 px-4 py-3 overflow-x-auto noscroll"
        role="list"
        aria-label="Stories"
      >
        {playlist.map((story, i) => (
          <RailThumb
            key={story.id}
            story={story}
            position={i}
            viewed={viewedSet.has(story.id)}
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
  /** When true, the thumb wears the dimmed/viewed ring instead of the
   *  accent unseen ring. Drives the IG-style "I've already seen this"
   *  visual cue. */
  viewed: boolean;
  onOpen: (id: string) => void;
}

function RailThumb({ story, position, viewed, onOpen }: RailThumbProps) {
  const handleClick = () => {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[stories rail tap]", {
      id: story.id,
      position,
      was_unseen: !viewed,
    });
    onOpen(story.id);
  };
  // Ring: 2px accent when unseen, 1.5px muted line when viewed. Both
  // use the same outer span; the background swap is animated via a
  // CSS transition so the moment of mark-viewed fades the highlight
  // rather than snapping it (matches IG's "you've seen this" cue).
  const ringStyle: React.CSSProperties = {
    background: viewed ? "var(--color-line)" : "var(--color-accent)",
    padding: viewed ? "1.5px" : "2px",
    transition: "background 320ms ease, padding 320ms ease",
  };
  return (
    <button
      type="button"
      role="listitem"
      onClick={handleClick}
      className="shrink-0 flex flex-col items-center gap-1.5 active:scale-[.96] transition"
      aria-label={`${story.title || story.id}${viewed ? " (viewed)" : ""}`}
    >
      <span className="block rounded-full" style={ringStyle}>
        <span
          className="block w-[64px] h-[64px] sm:w-[72px] sm:h-[72px] rounded-full overflow-hidden"
          style={{
            background: "var(--color-surface2)",
            // Subtle opacity dim on viewed thumbs reinforces the ring
            // change. Stays high enough that the artwork remains
            // clearly recognizable.
            opacity: viewed ? 0.7 : 1,
            transition: "opacity 320ms ease",
          }}
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
        style={{
          color: viewed ? "var(--color-muted)" : "var(--color-ink)",
          transition: "color 320ms ease",
        }}
        title={story.title}
      >
        {story.title}
      </span>
    </button>
  );
}

export const StoriesRail = memo(RailInner);
