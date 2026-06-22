"use client";

// Desktop Wires: the same shorts and the same WireCard as mobile, but a
// DISCRETE pager instead of touch scroll-snap (the council's call — a mouse
// wheel is continuous and scroll-snap feels mushy/overshoots under it).
// Navigation is Arrow/Page/Space keys, a debounced wheel (one step per
// gesture), and on-screen up/down buttons. The active short sits in a centred
// 9:16 frame; the immediate neighbours are mounted and slid in/out for an
// instant next-step and to preload.

import React, { useCallback, useEffect, useRef, useState } from "react";
import WireCard from "@/components/wires/WireCard";
import { useWiresData } from "@/components/wires/useWiresData";
import { useWireLikes } from "@/components/wires/useWireLikes";
import { useWirePrefs } from "@/components/wires/useWirePrefs";
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
  const { shorts, loading, loadMore } = useWiresData(PAGE_SIZE);
  const [activeIdx, setActiveIdx] = useState(0);
  const [soundHintShown, setSoundHintShown] = useState(true);
  const reducedMotion = usePrefersReducedMotion();
  // Mute + autoplay are persisted viewer prefs, shared across cards and reloads.
  const { autoplay, muted, toggleAutoplay, toggleMuted } = useWirePrefs();
  const { isSaved, toggle: toggleSave } = useSavedStories();
  const { seed: seedLikes, toggle: toggleLike, get: getLike } = useWireLikes();
  useEffect(() => {
    seedLikes(shorts);
  }, [shorts, seedLikes]);

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
    shortsRef.current = shorts;
  }, [shorts]);
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
      const idx = shorts.findIndex((s) => s.id === initialStoryId);
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

  // ── States ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="fixed inset-x-0 bottom-0 top-[68px] z-30 grid place-items-center bg-black">
        <span className="h-7 w-7 animate-spin rounded-full border-2 border-line border-t-accent" />
      </div>
    );
  }
  if (shorts.length === 0) {
    return (
      <div className="fixed inset-x-0 bottom-0 top-[68px] z-30 grid place-items-center bg-black px-8 text-center">
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
  }

  const atTop = activeIdx <= 0;
  const atBottom = activeIdx >= shorts.length - 1;
  const lo = Math.max(0, activeIdx - MOUNT_RADIUS);
  const hi = Math.min(shorts.length - 1, activeIdx + MOUNT_RADIUS);
  const windowed: number[] = [];
  for (let i = lo; i <= hi; i++) windowed.push(i);

  return (
    <div
      ref={containerRef}
      className="fixed inset-x-0 bottom-0 top-[68px] z-30 flex items-center justify-center bg-black"
      style={{ overscrollBehavior: "contain" }}
    >
      {/* Centred portrait stage; the windowed cards slide vertically between
          steps. Slightly taller than 9:16 so the video region stays ~9:16 once
          the control bar takes its share. */}
      <div className="relative aspect-[9/18] h-[calc(100vh-96px)] max-h-[940px] overflow-hidden rounded-2xl">
        {windowed.map((i) => (
          <div
            key={shorts[i].id}
            className="absolute inset-0"
            style={{
              transform: `translateY(${(i - activeIdx) * 100}%)`,
              transition: reducedMotion
                ? undefined
                : "transform .35s cubic-bezier(.16,1,.3,1)",
            }}
          >
            <WireCard
              short={shorts[i]}
              active={i === activeIdx}
              mounted
              eager={i === activeIdx || i === activeIdx + 1}
              insetBottom={18}
              muted={muted}
              autoplay={autoplay}
              reducedMotion={reducedMotion}
              paused={paused}
              onToggleMute={toggleMuted}
              onToggleAutoplay={toggleAutoplay}
              onOpenInfo={onOpenInfo}
              showSoundHint={i === activeIdx && soundHintShown}
              onDismissSoundHint={dismissSoundHint}
              liked={getLike(shorts[i].id)?.liked ?? shorts[i].viewer_liked}
              likeCount={getLike(shorts[i].id)?.count ?? shorts[i].like_count}
              saved={isSaved(shorts[i].id)}
              onToggleLike={toggleLike}
              onToggleSave={toggleSave}
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
