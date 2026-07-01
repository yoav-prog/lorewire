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

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WireCard from "@/components/wires/WireCard";
import { WiresTopControls } from "@/components/wires/WiresTopControls";
import { useWiresData } from "@/components/wires/useWiresData";
import { useWireLikes } from "@/components/wires/useWireLikes";
import { useWirePrefs } from "@/components/wires/useWirePrefs";
import { useWireCategoryFilter } from "@/lib/wire-category-filter";
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

  const [activeIdx, setActiveIdx] = useState(0);
  const [soundHintShown, setSoundHintShown] = useState(true);
  const reducedMotion = usePrefersReducedMotion();
  const didInitialScroll = useRef(false);
  // Mute + autoplay are persisted viewer prefs, shared across cards and reloads.
  // `hideVoted` (default ON) drives the "unvoted only" feed: the server filters
  // out wires this viewer already voted on, so the feed opens on what's left to
  // decide. The top-center pill toggles it.
  const {
    autoplay,
    muted,
    advance,
    slow,
    hideVoted,
    setHideVoted,
    toggleAutoplay,
    toggleMuted,
    toggleAdvance,
    toggleSlow,
  } = useWirePrefs();

  // Category filter (session-scoped, shared store). Selected slugs restrict the
  // feed server-side to wires tagged with those granular categories.
  const {
    selected: categorySlugs,
    toggle: toggleCategory,
    clear: clearCategories,
  } = useWireCategoryFilter();

  const { shorts, loading, loadingMore, loadMore } = useWiresData(
    PAGE_SIZE,
    hideVoted,
    categorySlugs,
  );

  // Shuffle: a stored permutation of story ids (null = natural order). New
  // pages (loadMore) append in server order after the shuffled ids.
  const [order, setOrder] = useState<string[] | null>(null);
  const [reorderNonce, setReorderNonce] = useState(0);
  const displayShorts = useMemo(() => {
    if (!order) return shorts;
    const byId = new Map(shorts.map((s) => [s.id, s]));
    const seen = new Set(order);
    const ordered = order.flatMap((id) => {
      const s = byId.get(id);
      return s ? [s] : [];
    });
    const extras = shorts.filter((s) => !seen.has(s.id));
    return [...ordered, ...extras];
  }, [order, shorts]);

  // activeIdx mirrored to a ref so auto-advance reads it without re-binding.
  const activeIdxRef = useRef(0);
  useEffect(() => {
    activeIdxRef.current = activeIdx;
  }, [activeIdx]);

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
    if (!root || displayShorts.length === 0) return;
    const count = displayShorts.length;
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
  }, [displayShorts.length, reorderNonce]);

  // Deep-link: once the feed has rendered, jump to the requested story (no
  // smooth-scroll — we want it already there on first paint).
  useEffect(() => {
    if (didInitialScroll.current || loading || !initialStoryId) return;
    const idx = displayShorts.findIndex((s) => s.id === initialStoryId);
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
  }, [loading, initialStoryId, displayShorts]);

  const dismissSoundHint = useCallback(() => setSoundHintShown(false), []);

  // Shuffle the loaded wires into a random order and jump back to the top.
  const onShuffle = useCallback(() => {
    const ids = shorts.map((s) => s.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    setOrder(ids);
    setActiveIdx(0);
    setReorderNonce((n) => n + 1);
    requestAnimationFrame(() => {
      sectionRefs.current[0]?.scrollIntoView({ block: "start" });
      if (containerRef.current) containerRef.current.scrollTop = 0;
    });
  }, [shorts]);

  // Any filter change (Unvoted/All or category) refetches the feed from the
  // top via useWiresData; reset the local view state so the new list starts
  // clean — clear any shuffle order, drop to the first card, scroll to top.
  const resetFeedPosition = useCallback(() => {
    setOrder(null);
    setActiveIdx(0);
    if (containerRef.current) containerRef.current.scrollTop = 0;
  }, []);

  const applyFilter = useCallback(
    (nextHideVoted: boolean) => {
      if (nextHideVoted === hideVoted) return;
      setHideVoted(nextHideVoted);
      resetFeedPosition();
    },
    [hideVoted, setHideVoted, resetFeedPosition],
  );

  const onToggleCategory = useCallback(
    (slug: string) => {
      toggleCategory(slug);
      resetFeedPosition();
    },
    [toggleCategory, resetFeedPosition],
  );

  const onClearCategories = useCallback(() => {
    clearCategories();
    resetFeedPosition();
  }, [clearCategories, resetFeedPosition]);

  // Auto-advance: scroll the next wire into view when the current one ends.
  // Returns false at the tail (so the card replays) and prefetches more.
  const onWireEnded = useCallback((): boolean => {
    const next = activeIdxRef.current + 1;
    const el = sectionRefs.current[next];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return true;
    }
    loadMoreRef.current();
    return false;
  }, []);

  // ── Body: loader / empty / feed. The filter pill is rendered by the outer
  //    wrapper below so it stays visible in every state (including empty). ──
  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="grid h-full place-items-center">
        <div className="flex flex-col items-center gap-3 text-muted">
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-line border-t-accent" />
          <span className="font-mono text-[11px] uppercase tracking-[.2em]">Loading wires</span>
        </div>
      </div>
    );
  } else if (shorts.length === 0) {
    body =
      categorySlugs.length > 0 ? (
        // Category filter yielded nothing. Offer the one tap that widens it.
        <div className="grid h-full place-items-center px-8 text-center">
          <div>
            <p className="font-display text-[22px] font-black uppercase tracking-tightest text-ink">
              No wires in these categories
            </p>
            <p className="mt-2 font-body text-[14px] text-muted">
              Nothing matches the categories you picked{hideVoted ? " that you haven't voted on yet" : ""}. Try clearing the category filter.
            </p>
            <button
              type="button"
              onClick={onClearCategories}
              className="mt-5 rounded-full bg-accent px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-[.18em] text-bg transition active:scale-95"
            >
              Clear categories
            </button>
          </div>
        </div>
      ) : hideVoted ? (
        // Caught-up: the viewer has voted on every published wire. Never a dead
        // end — one tap brings the full feed back (rule 10).
        <div className="grid h-full place-items-center px-8 text-center">
          <div>
            <p className="font-display text-[22px] font-black uppercase tracking-tightest text-ink">
              You&rsquo;re all caught up
            </p>
            <p className="mt-2 font-body text-[14px] text-muted">
              You&rsquo;ve voted on every wire. Switch to All to watch them again, or check back for new ones.
            </p>
            <button
              type="button"
              onClick={() => applyFilter(false)}
              className="mt-5 rounded-full bg-accent px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-[.18em] text-bg transition active:scale-95"
            >
              Show all wires
            </button>
          </div>
        </div>
      ) : (
        <div className="grid h-full place-items-center px-8 text-center">
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
  } else {
    body = (
      <div
        ref={containerRef}
        className="noscroll absolute inset-0 snap-y snap-mandatory overflow-y-scroll"
        style={{ overscrollBehavior: "contain", WebkitOverflowScrolling: "touch" }}
      >
        {displayShorts.map((s, i) => (
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
              advance={advance}
              slow={slow}
              reducedMotion={reducedMotion}
              paused={paused}
              onToggleMute={toggleMuted}
              onToggleAutoplay={toggleAutoplay}
              onToggleAdvance={toggleAdvance}
              onToggleSlow={toggleSlow}
              onShuffle={onShuffle}
              onOpenInfo={onOpenInfo}
              showSoundHint={i === activeIdx && soundHintShown}
              onDismissSoundHint={dismissSoundHint}
              liked={getLike(s.id)?.liked ?? s.viewer_liked}
              likeCount={getLike(s.id)?.count ?? s.like_count}
              saved={isSaved(s.id)}
              onToggleLike={toggleLike}
              onToggleSave={toggleSave}
              onTimeUpdate={(t, d) => onShortTimeUpdate(s.id, t, d)}
              onWireEnded={onWireEnded}
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

  return (
    <div className="absolute inset-0 z-30 bg-black">
      <WiresTopControls
        hideVoted={hideVoted}
        onSelectFilter={applyFilter}
        selectedCategories={categorySlugs}
        onToggleCategory={onToggleCategory}
        onClearCategories={onClearCategories}
        variant="mobile"
      />
      {body}
    </div>
  );
}
