"use client";

// Desktop Wires: the same shorts and the same WireCard as mobile, but a
// DISCRETE pager instead of touch scroll-snap (the council's call — a mouse
// wheel is continuous and scroll-snap feels mushy/overshoots under it).
// Navigation is Arrow/Page/Space keys, a debounced wheel (one step per
// gesture), and on-screen up/down buttons. The active short sits in a centred
// 9:16 frame; the immediate neighbours are mounted and slid in/out for an
// instant next-step and to preload.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WireCard from "@/components/wires/WireCard";
import { WiresTopControls } from "@/components/wires/WiresTopControls";
import { useWiresData } from "@/components/wires/useWiresData";
import { useWireLikes } from "@/components/wires/useWireLikes";
import { useWirePrefs } from "@/components/wires/useWirePrefs";
import { useWireCategoryFilter } from "@/lib/wire-category-filter";
import { useSavedStories } from "@/lib/engagement-store";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

type OpenFn = (id: string, tab?: string) => void;

const PAGE_SIZE = 8;
const PREFETCH_WITHIN = 3;
const MOUNT_RADIUS = 1;
// Wheel: minimum deltaY to count as a step, and the cool-down before the next.
const WHEEL_THRESHOLD = 24;
const WHEEL_COOLDOWN_MS = 480;

const Chevron = ({ dir, size = 24 }: { dir: "up" | "down"; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ transform: dir === "up" ? "rotate(180deg)" : undefined }}
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export interface WiresDesktopProps {
  onOpenInfo: OpenFn;
  /** A modal (DetailModal) is open over the feed — pause + ignore navigation. */
  paused: boolean;
  /** Optional deep-link target: open at this story if it's in the loaded pages. */
  initialStoryId?: string;
}

export default function WiresDesktop({
  onOpenInfo,
  paused,
  initialStoryId,
}: WiresDesktopProps) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [soundHintShown, setSoundHintShown] = useState(true);
  // Immersive (video-only) mode: fullscreen the pager container. Wheel / arrow
  // paging keeps working in fullscreen since those handlers live on it.
  const [immersive, setImmersive] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  // Mute + autoplay are persisted viewer prefs, shared across cards and reloads.
  // `hideVoted` (default ON) drives the "unvoted only" feed via the top-center
  // filter pill; the server applies the filter through useWiresData.
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
  const {
    selected: categorySlugs,
    toggle: toggleCategory,
    clear: clearCategories,
  } = useWireCategoryFilter();
  const { shorts, loading, loadMore } = useWiresData(
    PAGE_SIZE,
    hideVoted,
    categorySlugs,
  );
  const { isSaved, toggle: toggleSave } = useSavedStories();
  const { seed: seedLikes, toggle: toggleLike, get: getLike } = useWireLikes();
  useEffect(() => {
    seedLikes(shorts);
  }, [shorts, seedLikes]);

  // Shuffle: a stored permutation of story ids (null = natural order). New
  // pages append in server order after the shuffled ids.
  const [order, setOrder] = useState<string[] | null>(null);
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

  // Refs so the stable key/wheel handlers read fresh values without re-binding.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeIdxRef = useRef(0);
  const shortsRef = useRef(shorts);
  const loadMoreRef = useRef(loadMore);
  const pausedRef = useRef(paused);
  const wheelLock = useRef(false);
  useEffect(() => {
    activeIdxRef.current = activeIdx;
  }, [activeIdx]);
  useEffect(() => {
    shortsRef.current = displayShorts;
  }, [displayShorts]);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Navigate +/-1, clamped; prefetch as we near the tail. Event-driven only
  // (called from key/wheel/button handlers), so no set-state-in-effect.
  const go = useCallback((delta: number) => {
    const list = shortsRef.current;
    const cur = activeIdxRef.current;
    const next = Math.max(0, Math.min(list.length - 1, cur + delta));
    if (next === cur) return;
    activeIdxRef.current = next;
    setActiveIdx(next);
    if (next >= list.length - PREFETCH_WITHIN) loadMoreRef.current();
  }, []);

  // Deep-link: apply the initial story once loaded. Render-phase set, guarded —
  // the React-19 way to derive state from a prop without a set-state effect.
  const [appliedInitial, setAppliedInitial] = useState(false);
  if (!appliedInitial && !loading && shorts.length > 0) {
    setAppliedInitial(true);
    if (initialStoryId) {
      const idx = displayShorts.findIndex((s) => s.id === initialStoryId);
      if (idx > 0) setActiveIdx(idx);
    }
  }

  // Keyboard navigation (ignored while typing in a field or with a modal open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (pausedRef.current) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowDown" || e.key === "PageDown") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowUp" || e.key === "PageUp") {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  // Wheel: one discrete step per gesture (debounced), not mushy continuous
  // scroll. Non-passive so we can preventDefault the page scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (pausedRef.current) return;
      e.preventDefault();
      if (wheelLock.current || Math.abs(e.deltaY) < WHEEL_THRESHOLD) return;
      wheelLock.current = true;
      go(e.deltaY > 0 ? 1 : -1);
      setTimeout(() => {
        wheelLock.current = false;
      }, WHEEL_COOLDOWN_MS);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [go]);

  const dismissSoundHint = useCallback(() => setSoundHintShown(false), []);

  // Shuffle the loaded wires into a random order and jump to the top.
  const onShuffle = useCallback(() => {
    const ids = shorts.map((s) => s.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    setOrder(ids);
    activeIdxRef.current = 0;
    setActiveIdx(0);
  }, [shorts]);

  // Switch the feed between "unvoted only" and "all". Flipping the pref
  // refetches from the top (useWiresData resets on the onlyUnvoted change); we
  // clear any shuffle order and reset to the first card so the new list starts
  // clean.
  const resetFeedPosition = useCallback(() => {
    setOrder(null);
    activeIdxRef.current = 0;
    setActiveIdx(0);
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

  // Immersive mode: fullscreen the pager container (video-only cards). Must ride
  // the click gesture, so requesting fullscreen is synchronous here.
  const enterImmersive = useCallback(() => {
    setImmersive(true);
    const el = containerRef.current as
      | (HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> | void })
      | null;
    if (!el) return;
    try {
      const p = el.requestFullscreen
        ? el.requestFullscreen()
        : el.webkitRequestFullscreen?.();
      if (p && typeof (p as Promise<void>).catch === "function") {
        (p as Promise<void>).catch((err: unknown) =>
          console.warn("[wires immersive enter err]", { err: String(err) }),
        );
      }
    } catch (err) {
      console.warn("[wires immersive enter err]", { err: String(err) });
    }
  }, []);

  const exitImmersive = useCallback(() => {
    setImmersive(false);
    const doc = document as Document & {
      webkitExitFullscreen?: () => Promise<void> | void;
      webkitFullscreenElement?: Element | null;
    };
    if (!document.fullscreenElement && !doc.webkitFullscreenElement) return;
    try {
      const p = doc.exitFullscreen
        ? doc.exitFullscreen()
        : doc.webkitExitFullscreen?.();
      if (p && typeof (p as Promise<void>).catch === "function") {
        (p as Promise<void>).catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Drop immersive if the user leaves fullscreen via Escape / the OS.
  useEffect(() => {
    const onChange = () => {
      const doc = document as Document & {
        webkitFullscreenElement?: Element | null;
      };
      if (!document.fullscreenElement && !doc.webkitFullscreenElement) {
        setImmersive(false);
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  // Auto-advance to the next wire when one ends; false at the tail so the card
  // replays in place (and we prefetch the next page).
  const onWireEnded = useCallback((): boolean => {
    const list = shortsRef.current;
    if (activeIdxRef.current < list.length - 1) {
      go(1);
      return true;
    }
    loadMoreRef.current();
    return false;
  }, [go]);

  // ── Body: loader / empty / feed. The filter pill is rendered by the outer
  //    wrapper below so it stays visible in every state (including empty). ──
  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="grid h-full place-items-center">
        <span className="h-7 w-7 animate-spin rounded-full border-2 border-line border-t-accent" />
      </div>
    );
  } else if (shorts.length === 0) {
    body =
      categorySlugs.length > 0 ? (
        // Category filter yielded nothing. Offer the one click that widens it.
        <div className="grid h-full place-items-center px-8 text-center">
          <div>
            <p className="font-display text-[26px] font-black uppercase tracking-tightest text-ink">
              No wires in these categories
            </p>
            <p className="mt-2 font-body text-[15px] text-muted">
              Nothing matches the categories you picked{hideVoted ? " that you haven't voted on yet" : ""}. Try clearing the category filter.
            </p>
            <button
              type="button"
              onClick={onClearCategories}
              className="mt-6 rounded-full bg-accent px-6 py-2.5 font-mono text-[12px] font-bold uppercase tracking-[.18em] text-bg transition hover:opacity-90 active:scale-95"
            >
              Clear categories
            </button>
          </div>
        </div>
      ) : hideVoted ? (
        // Caught-up: the viewer has voted on every published wire. Never a dead
        // end — one click brings the full feed back (rule 10).
        <div className="grid h-full place-items-center px-8 text-center">
          <div>
            <p className="font-display text-[26px] font-black uppercase tracking-tightest text-ink">
              You&rsquo;re all caught up
            </p>
            <p className="mt-2 font-body text-[15px] text-muted">
              You&rsquo;ve voted on every wire. Switch to All to watch them again, or check back for new ones.
            </p>
            <button
              type="button"
              onClick={() => applyFilter(false)}
              className="mt-6 rounded-full bg-accent px-6 py-2.5 font-mono text-[12px] font-bold uppercase tracking-[.18em] text-bg transition hover:opacity-90 active:scale-95"
            >
              Show all wires
            </button>
          </div>
        </div>
      ) : (
        <div className="grid h-full place-items-center px-8 text-center">
          <div>
            <p className="font-display text-[26px] font-black uppercase tracking-tightest text-ink">
              No wires yet
            </p>
            <p className="mt-2 font-body text-[15px] text-muted">
              New shorts show up here as soon as they&rsquo;re published.
            </p>
          </div>
        </div>
      );
  } else {
    const atTop = activeIdx <= 0;
    const atBottom = activeIdx >= displayShorts.length - 1;
    const lo = Math.max(0, activeIdx - MOUNT_RADIUS);
    const hi = Math.min(displayShorts.length - 1, activeIdx + MOUNT_RADIUS);
    const windowed: number[] = [];
    for (let i = lo; i <= hi; i++) windowed.push(i);
    body = (
      <div
        ref={containerRef}
        className="absolute inset-0 flex items-center justify-center"
        style={{ overscrollBehavior: "contain" }}
      >
        {/* Centred portrait stage; the windowed cards slide vertically between
            steps. Slightly taller than 9:16 so the video region stays ~9:16 once
            the control bar takes its share. */}
        <div className="relative aspect-[9/18] h-[calc(100vh-96px)] max-h-[940px] overflow-hidden rounded-2xl">
          {windowed.map((i) => (
            <div
              key={displayShorts[i].id}
              className="absolute inset-0"
              style={{
                transform: `translateY(${(i - activeIdx) * 100}%)`,
                transition: reducedMotion
                  ? undefined
                  : "transform .35s cubic-bezier(.16,1,.3,1)",
              }}
            >
              <WireCard
                short={displayShorts[i]}
                active={i === activeIdx}
                mounted
                eager={i === activeIdx || i === activeIdx + 1}
                insetBottom={18}
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
                liked={getLike(displayShorts[i].id)?.liked ?? displayShorts[i].viewer_liked}
                likeCount={getLike(displayShorts[i].id)?.count ?? displayShorts[i].like_count}
                saved={isSaved(displayShorts[i].id)}
                onToggleLike={toggleLike}
                onToggleSave={toggleSave}
                onWireEnded={onWireEnded}
                immersive={immersive}
                onEnterImmersive={enterImmersive}
                onExitImmersive={exitImmersive}
              />
            </div>
          ))}
        </div>

        {/* Up / down paging controls. */}
        <div className="absolute right-6 top-1/2 flex -translate-y-1/2 flex-col gap-3 xl:right-12">
          <button
            onClick={() => go(-1)}
            disabled={atTop}
            aria-label="Previous wire"
            className="grid h-12 w-12 place-items-center rounded-full text-ink transition hover:bg-white/20 disabled:opacity-30"
            style={{ background: "rgba(255,255,255,.12)" }}
          >
            <Chevron dir="up" />
          </button>
          <button
            onClick={() => go(1)}
            disabled={atBottom}
            aria-label="Next wire"
            className="grid h-12 w-12 place-items-center rounded-full text-ink transition hover:bg-white/20 disabled:opacity-30"
            style={{ background: "rgba(255,255,255,.12)" }}
          >
            <Chevron dir="down" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-x-0 bottom-0 top-[68px] z-30 bg-black">
      <WiresTopControls
        hideVoted={hideVoted}
        onSelectFilter={applyFilter}
        selectedCategories={categorySlugs}
        onToggleCategory={onToggleCategory}
        onClearCategories={onClearCategories}
        variant="desktop"
      />
      {body}
    </div>
  );
}
