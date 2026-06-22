"use client";

// The Wires surface: a full-screen vertical, snap-scrolling feed of 9:16 doodle
// shorts. One short per screen, the active one plays, the rest are paused — the
// TikTok / Instagram-Reels interaction the user asked for.
//
// Engine (see _plans/2026-06-17-reels-vertical-video-feed.md): native CSS
// scroll-snap for the touch surface (what mobile users expect), with an
// IntersectionObserver picking the active index off whichever section is
// >=60% visible. Sections are sized to the SHELL height (100%), not raw 100dvh,
// so the iOS Safari URL-bar collapse resizes every section together and snap
// alignment doesn't drift mid-scroll. `scroll-snap-stop: always` stops a fast
// flick from skipping past a short.
//
// Windowing: only the active card and its immediate neighbours hold a live
// <video> (radius 1 → at most three elements); everything else is a poster
// placeholder of the same height. That bounds memory and GCS egress so we
// don't download shorts the user never reaches.

import React, { useCallback, useEffect, useRef, useState } from "react";
import WireCard from "@/components/wires/WireCard";
import { useWiresData } from "@/components/wires/useWiresData";
import { useWireLikes } from "@/components/wires/useWireLikes";
import { useWirePrefs } from "@/components/wires/useWirePrefs";
import { useContinueReading, useSavedStories } from "@/lib/engagement-store";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

type OpenFn = (id: string, tab?: string) => void;

// How many shorts to pull per page, and how close to the end we get before
// fetching the next page so the swipe never hits a dead end.
const PAGE_SIZE = 8;
const PREFETCH_WITHIN = 3;
// Mount a live <video> for the active card +/- this many neighbours.
const MOUNT_RADIUS = 1;

export interface WiresFeedProps {
  /** Opens the existing Title sheet (Watch / Read / Read-along) for a story. */
  onOpenInfo: OpenFn;
  /** True when a modal is open over the feed — pause playback underneath it. */
  paused: boolean;
  /** Optional deep-link target: scroll to this story id once the feed loads. */
  initialStoryId?: string;
}

export default function WiresFeed({
  onOpenInfo,
  paused,
  initialStoryId,
}: WiresFeedProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);

  const { shorts, loading, loadingMore, loadMore } = useWiresData(PAGE_SIZE);
  const [activeIdx, setActiveIdx] = useState(0);
  const [soundHintShown, setSoundHintShown] = useState(true);
  const reducedMotion = usePrefersReducedMotion();
  const didInitialScroll = useRef(false);
  // Mute + autoplay are persisted viewer prefs, shared across cards and reloads.
  const { autoplay, muted, toggleAutoplay, toggleMuted } = useWirePrefs();

  // Saves stay in the local engagement store (the My List source of truth).
  // Likes are server-counted: seed from the rows we fetched, then toggle
  // optimistically against the action.
  const { isSaved, toggle: toggleSave } = useSavedStories();
  const { seed: seedLikes, toggle: toggleLike, get: getLike } = useWireLikes();
  useEffect(() => {
    seedLikes(shorts);
  }, [shorts, seedLikes]);
  // 2026-06-19 Phase 2: Continue Watching writes a progress entry per
  // story as playback advances. Thresholds keep the rail honest:
  //   - >= 5 s watched (filters out scrubbing past or accidental opens)
  //   - < 90% complete (the user effectively finished — don't park it
  //     in "Continue" forever)
  //   - on remove when >= 90%: an entry that crossed the threshold gets
  //     dropped so a re-watch from the top behaves cleanly.
  // Throttle to one write per story per 5 s so timeupdate's ~4 Hz tick
  // rate doesn't beat localStorage to death.
  const { set: setContinue, remove: removeContinue } = useContinueReading();
  const lastWriteAt = useRef<Map<string, number>>(new Map());
  const onShortTimeUpdate = useCallback(
    (storyId: string, currentTime: number, duration: number) => {
      if (!Number.isFinite(duration) || duration <= 0) return;
      const ratio = currentTime / duration;
      if (ratio >= 0.9) {
        // Finished (or near enough): drop the entry if we previously
        // wrote one. Cheap idempotent remove — no-op when absent.
        removeContinue(storyId);
        return;
      }
      if (currentTime < 5) return;
      const last = lastWriteAt.current.get(storyId) ?? 0;
      const now = Date.now();
      if (now - last < 5000) return;
      lastWriteAt.current.set(storyId, now);
      setContinue(storyId, { positionMs: Math.round(currentTime * 1000) });
    },
    [removeContinue, setContinue],
  );

  // Keep a ref to the latest loadMore so the IntersectionObserver can trigger
  // prefetch without re-binding every time the cursor changes (assigning a ref
  // is not setState, so it's effect-safe).
  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

  // Active index from whichever section is most visible (>=60%). Driven by the
  // settled snap position rather than every scroll tick, so a fast flick doesn't
  // thrash the active video. The same callback also prefetches as the active
  // card nears the tail. Re-bound when the section count changes.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || shorts.length === 0) return;
    const count = shorts.length;
    const io = new IntersectionObserver(
      (entries) => {
        let bestIdx = -1;
        let bestRatio = 0;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const idx = Number((e.target as HTMLElement).dataset.idx);
          if (e.intersectionRatio >= 0.6 && e.intersectionRatio > bestRatio) {
            bestRatio = e.intersectionRatio;
            bestIdx = idx;
          }
        }
        if (bestIdx >= 0) {
          setActiveIdx((prev) => (prev === bestIdx ? prev : bestIdx));
          if (bestIdx >= count - PREFETCH_WITHIN) loadMoreRef.current();
        }
      },
      { root, threshold: [0.5, 0.6, 0.75, 0.9] },
    );
    for (const el of sectionRefs.current) if (el) io.observe(el);
    return () => io.disconnect();
  }, [shorts.length]);

  // Deep-link: once the feed has rendered, jump to the requested story (no
  // smooth-scroll — we want it already there on first paint).
  useEffect(() => {
    if (didInitialScroll.current || loading || !initialStoryId) return;
    const idx = shorts.findIndex((s) => s.id === initialStoryId);
    if (idx <= 0) {
      didInitialScroll.current = true; // 0 or not found: top is already correct
      return;
    }
    const el = sectionRefs.current[idx];
    if (el) {
      // Jump there; the IntersectionObserver picks up the new active index once
      // the scroll settles (no setState in the effect body).
      el.scrollIntoView({ block: "start" });
      didInitialScroll.current = true;
    }
  }, [loading, initialStoryId, shorts]);

  const dismissSoundHint = useCallback(() => setSoundHintShown(false), []);

  // ── States ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="absolute inset-0 z-30 grid place-items-center bg-black">
        <div className="flex flex-col items-center gap-3 text-muted">
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-line border-t-accent" />
          <span className="font-mono text-[11px] uppercase tracking-[.2em]">Loading wires</span>
        </div>
      </div>
    );
  }

  if (shorts.length === 0) {
    return (
      <div className="absolute inset-0 z-30 grid place-items-center bg-black px-8 text-center">
        <div>
          <p className="font-display text-[22px] font-black uppercase tracking-tightest text-ink">
            No wires yet
          </p>
          <p className="mt-2 font-body text-[14px] text-muted">
            New shorts show up here as soon as they&rsquo;re published. Check back soon.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="noscroll absolute inset-0 z-30 snap-y snap-mandatory overflow-y-scroll bg-black"
      style={{ overscrollBehavior: "contain", WebkitOverflowScrolling: "touch" }}
    >
      {shorts.map((s, i) => (
        <section
          key={s.id}
          data-idx={i}
          ref={(el) => {
            sectionRefs.current[i] = el;
          }}
          className="relative h-full w-full snap-start snap-always"
        >
          <WireCard
            short={s}
            active={i === activeIdx}
            mounted={Math.abs(i - activeIdx) <= MOUNT_RADIUS}
            eager={i === activeIdx || i === activeIdx + 1}
            insetBottom={84}
            muted={muted}
            autoplay={autoplay}
            reducedMotion={reducedMotion}
            paused={paused}
            onToggleMute={toggleMuted}
            onToggleAutoplay={toggleAutoplay}
            onOpenInfo={onOpenInfo}
            showSoundHint={i === activeIdx && soundHintShown}
            onDismissSoundHint={dismissSoundHint}
            liked={getLike(s.id)?.liked ?? s.viewer_liked}
            likeCount={getLike(s.id)?.count ?? s.like_count}
            saved={isSaved(s.id)}
            onToggleLike={toggleLike}
            onToggleSave={toggleSave}
            onTimeUpdate={(t, d) => onShortTimeUpdate(s.id, t, d)}
          />
        </section>
      ))}
      {loadingMore && (
        <div className="flex h-16 items-center justify-center text-muted">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-line border-t-accent" />
        </div>
      )}
    </div>
  );
}
