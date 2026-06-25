"use client";

// IG-style full-screen Stories viewer. Opens over the homepage when a
// rail thumbnail is tapped or when the page lands with `?wire=<id>`.
//
// Owns:
//   - active wire index (jumps to startId on mount, advances on
//     tap-right / right-arrow / auto-advance, recedes on tap-left)
//   - paused state (hold-to-pause via the gesture machine; also pauses
//     when tab is hidden)
//   - mute state (reused from useWirePrefs so a user's Wires-feed mute
//     pref applies here too — one product, one mute)
//   - dwell timer (per-active-wire wall-clock; used to gate the
//     "mark viewed" write so a 200ms accidental tap doesn't mark a
//     wire seen)
//   - the auto-advance timer for image / text-only wires (videos
//     advance on `ended`)
//
// Renders:
//   - segmented progress bar across the top
//   - the active wire's poster + video stack
//   - close button, mute button, share button, "Read full →" CTA
//   - gesture target covering the frame
//
// Plans:
//   - _plans/2026-06-25-stories-rail-and-viewer.md (v1)
//   - _plans/2026-06-25-stories-reader-navigation.md (added the
//     "Read full →" CTA, swipe-up-open-reader, keyboard Enter/ArrowUp
//     → /v/[slug], and slug-canonical Share URL after slug landed
//     on the Story type)

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { copyToClipboard, storyShareUrl } from "@/lib/share";
import { type Story } from "@/lib/stories";
import { useWirePrefs } from "@/components/wires/useWirePrefs";

import { StoriesProgressBar } from "./StoriesProgressBar";
import { useStoriesGestures } from "./use-stories-gestures";
import {
  useStoriesAutoAdvance,
  useStoriesImageDwellMs,
} from "./use-stories-prefs";
import { useViewedWires } from "./use-viewed-wires";

const MIN_DWELL_FOR_VIEW_MARK_MS = 2000;

export interface StoriesViewerProps {
  /** Complete playlist to navigate through. The viewer never filters
   *  this — the rail handles unseen-only; here we want a deep-linked
   *  wire to open even if it's already viewed. */
  playlist: Story[];
  /** Wire id to start at. If absent / unknown the viewer opens at index 0. */
  startId: string | null;
  /** Close the viewer and clear `?wire=` from the URL. */
  onClose: () => void;
}

export function StoriesViewer({ playlist, startId, onClose }: StoriesViewerProps) {
  const { autoAdvance } = useStoriesAutoAdvance();
  const { imageDwellMs } = useStoriesImageDwellMs();

  // Snapshot the playlist at viewer-open time so an in-session re-
  // partition (the parent re-orders the rail when viewedIds changes,
  // which the viewer triggers via markViewed) doesn't shuffle the
  // queue under the user's feet. The viewer re-mounts on close +
  // reopen, taking a fresh snapshot that reflects the new viewed
  // state. Lazy-init via useState so it captures the first-render
  // playlist exactly once per viewer mount.
  const [stablePlaylist] = useState<Story[]>(() => playlist);

  // Resolve startId → starting index against the SNAPSHOT (not the
  // live playlist prop). Unknown id falls back to 0 rather than
  // throwing — defensive against stale share links.
  const startIndex = useMemo(() => {
    if (!startId) return 0;
    const idx = stablePlaylist.findIndex((s) => s.id === startId);
    return idx >= 0 ? idx : 0;
  }, [stablePlaylist, startId]);

  const [activeIndex, setActiveIndex] = useState(startIndex);
  const [paused, setPaused] = useState(false);
  const [restartToken, setRestartToken] = useState(0);
  const [activeDurationMs, setActiveDurationMs] = useState(imageDwellMs);
  const dwellStartRef = useRef<number>(performance.now());
  const reducedMotionRef = useRef(false);

  const { markViewed, isViewed } = useViewedWires();
  const { muted, toggleMuted } = useWirePrefs();

  const active = stablePlaylist[activeIndex] ?? null;
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Reset dwell + restartToken when the active wire changes.
  useEffect(() => {
    dwellStartRef.current = performance.now();
    setActiveDurationMs(imageDwellMs);
    setRestartToken((t) => t + 1);
    // eslint-disable-next-line no-console -- rule 14
    console.info("[stories viewer active]", {
      index: activeIndex,
      id: active?.id ?? null,
      total: stablePlaylist.length,
    });
  }, [activeIndex, active?.id, stablePlaylist.length, imageDwellMs]);

  // Track prefers-reduced-motion on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    reducedMotionRef.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
  }, []);

  // Pause when the tab goes hidden — matches IG behavior and keeps the
  // auto-advance timer from blowing through an out-of-focus tab.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") setPaused(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Mark viewed when the user has dwelled long enough. Called from
  // both auto-advance (timer fired) and manual advance / dismiss.
  const maybeMarkViewed = useCallback(
    (reason: "complete" | "dwell-advance") => {
      if (!active) return;
      const dwellMs = performance.now() - dwellStartRef.current;
      if (
        reason === "complete" ||
        dwellMs >= MIN_DWELL_FOR_VIEW_MARK_MS
      ) {
        if (!isViewed(active.id)) {
          markViewed(active.id);
          // eslint-disable-next-line no-console -- rule 14
          console.info("[stories viewed mark]", {
            id: active.id,
            trigger: reason,
            dwell_ms: Math.round(dwellMs),
          });
        }
      }
    },
    [active, isViewed, markViewed],
  );

  const advanceNext = useCallback(
    (reason: "complete" | "dwell-advance") => {
      maybeMarkViewed(reason);
      if (activeIndex + 1 >= stablePlaylist.length) {
        // End of playlist → dismiss.
        // eslint-disable-next-line no-console -- rule 14
        console.info("[stories viewer end-of-playlist]", {
          last_id: active?.id ?? null,
        });
        onClose();
        return;
      }
      setActiveIndex((i) => i + 1);
    },
    [activeIndex, stablePlaylist.length, active?.id, maybeMarkViewed, onClose],
  );

  const advancePrev = useCallback(() => {
    if (activeIndex === 0) {
      // Restart the current wire instead of bouncing the user out.
      setRestartToken((t) => t + 1);
      dwellStartRef.current = performance.now();
      return;
    }
    setActiveIndex((i) => i - 1);
  }, [activeIndex]);

  // Auto-advance timer for image / text-only wires. Videos use their
  // own `ended` event so the timer is skipped. Three short-circuits:
  //   - paused (hold-to-pause, tab hidden) — skip while paused
  //   - prefers-reduced-motion — accessibility, skip entirely
  //   - !autoAdvance (user pref from Settings) — manual-only mode
  // Note that the video `ended` handler still fires under
  // !autoAdvance for video wires — that's intentional. The pref
  // means "don't ADVANCE on a timer"; a finished video that just
  // sits on its last frame would be jarring. If users want video
  // wires to stop at the end too, that's a separate toggle.
  useEffect(() => {
    if (paused) return;
    if (active?.videoUrl) return;
    if (reducedMotionRef.current) return;
    if (!autoAdvance) return;
    const handle = setTimeout(
      () => advanceNext("dwell-advance"),
      activeDurationMs,
    );
    return () => clearTimeout(handle);
  }, [
    paused,
    active?.videoUrl,
    activeIndex,
    activeDurationMs,
    advanceNext,
    autoAdvance,
  ]);

  // Imperative mute write — React's `muted` attribute is unreliable
  // for the same reasons WireCard documents (autoplay-muted requires
  // the property, not just the attribute).
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.muted = muted;
  }, [muted, activeIndex]);

  // Open the active wire in the full long-form reader at /v/[slug].
  // Source-of-truth for the three open-reader entry points (CTA button,
  // swipe-up gesture, keyboard Enter / ArrowUp) so the dwell-mark + log
  // shape stays identical. No-ops when the active wire has no slug
  // (sample placeholders without a public reader path); the rest of the
  // app gates `/v/[slug]` navigation the same way.
  const openReader = useCallback(
    (trigger: "cta" | "swipe-up" | "keyboard") => {
      if (!active?.slug) return;
      maybeMarkViewed("dwell-advance");
      // eslint-disable-next-line no-console -- rule 14
      console.info("[stories viewer open-reader]", {
        id: active.id,
        slug: active.slug,
        trigger,
      });
      window.location.href = `/v/${active.slug}`;
    },
    [active?.id, active?.slug, maybeMarkViewed],
  );

  // Keyboard nav. Only when the viewer is mounted, so we don't fight
  // the rest of the page for keystrokes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowRight") {
        advanceNext("dwell-advance");
      } else if (e.key === "ArrowLeft") {
        advancePrev();
      } else if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        setPaused((p) => !p);
      } else if (e.key === "Enter" || e.key === "ArrowUp") {
        openReader("keyboard");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advanceNext, advancePrev, onClose, openReader]);

  const { ref: gestureRef } = useStoriesGestures({
    onAction: (action) => {
      switch (action.kind) {
        case "tap-prev":
          advancePrev();
          return;
        case "tap-next":
          advanceNext("dwell-advance");
          return;
        case "pause":
          setPaused(true);
          return;
        case "resume":
          setPaused(false);
          return;
        case "dismiss":
          maybeMarkViewed("dwell-advance");
          // eslint-disable-next-line no-console -- rule 14
          console.info("[stories viewer dismiss]", {
            id: active?.id ?? null,
            reason: "swipe-down",
          });
          onClose();
          return;
        case "open-reader":
          openReader("swipe-up");
          return;
        case "snap-back":
          return;
      }
    },
  });

  if (stablePlaylist.length === 0 || !active) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Stories"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/95"
      style={{
        padding: "max(env(safe-area-inset-top, 0px), 0px) 0 max(env(safe-area-inset-bottom, 0px), 0px) 0",
      }}
    >
      <div
        ref={gestureRef}
        className="relative w-full h-full max-w-[540px] max-h-[960px] sm:rounded-lg overflow-hidden"
        style={{ aspectRatio: "9 / 16" }}
      >
        <StoriesProgressBar
          total={stablePlaylist.length}
          activeIndex={activeIndex}
          durationMs={activeDurationMs}
          paused={paused}
          restartToken={restartToken}
          reducedMotion={reducedMotionRef.current}
        />

        {/* Media: video if present, poster fallback, neutral surface last */}
        {active.videoUrl ? (
          <video
            ref={videoRef}
            key={`video-${active.id}-${restartToken}`}
            src={active.videoUrl}
            poster={active.heroImage ?? undefined}
            muted={muted}
            playsInline
            autoPlay
            preload="auto"
            className="absolute inset-0 w-full h-full object-cover"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (Number.isFinite(v.duration) && v.duration > 0) {
                setActiveDurationMs(Math.round(v.duration * 1000));
              }
            }}
            onPause={() => {
              if (!paused) setPaused(true);
            }}
            onPlay={() => {
              if (paused) setPaused(false);
            }}
            onEnded={() => advanceNext("complete")}
            onError={() => {
              // eslint-disable-next-line no-console -- rule 14
              console.warn("[stories viewer error]", {
                id: active.id,
                kind: "video-load-failed",
                src: active.videoUrl ?? null,
              });
              advanceNext("dwell-advance");
            }}
          />
        ) : active.heroImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={active.heroImage}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            onError={() => {
              // eslint-disable-next-line no-console -- rule 14
              console.warn("[stories viewer error]", {
                id: active.id,
                kind: "image-load-failed",
                src: active.heroImage ?? null,
              });
              advanceNext("dwell-advance");
            }}
          />
        ) : (
          <div
            className="absolute inset-0"
            style={{ background: "var(--color-surface2)" }}
          />
        )}

        {/* Scrim so the chrome reads over a bright frame */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-24 pointer-events-none"
          style={{
            background:
              "linear-gradient(180deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,0) 100%)",
          }}
        />
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-32 pointer-events-none"
          style={{
            background:
              "linear-gradient(0deg, rgba(0,0,0,.7) 0%, rgba(0,0,0,0) 100%)",
          }}
        />

        {/* Top-right controls: mute, close. */}
        <div className="absolute top-3 right-3 z-40 flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleMuted();
            }}
            aria-label={muted ? "Unmute" : "Mute"}
            className="w-9 h-9 rounded-full flex items-center justify-center bg-black/40 text-white hover:bg-black/60 transition"
          >
            <MuteGlyph muted={muted} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              maybeMarkViewed("dwell-advance");
              // eslint-disable-next-line no-console -- rule 14
              console.info("[stories viewer dismiss]", {
                id: active.id,
                reason: "close-button",
              });
              onClose();
            }}
            aria-label="Close stories"
            className="w-9 h-9 rounded-full flex items-center justify-center bg-black/40 text-white hover:bg-black/60 transition"
          >
            <CloseGlyph />
          </button>
        </div>

        {/* Bottom chrome: title + read-full CTA + share. */}
        <div className="absolute inset-x-0 bottom-0 z-40 px-4 pb-5 text-white">
          <div className="font-display font-black text-[18px] leading-tight tracking-tight line-clamp-2">
            {active.title}
          </div>
          {active.syn ? (
            <div className="mt-1 font-body text-[13px] opacity-85 line-clamp-2">
              {active.syn}
            </div>
          ) : null}
          {/* "Read full →" only renders when the active wire has a
              public slug (live DB rows do; sample placeholders don't).
              Share always renders — storyShareUrl falls back to the
              site origin when slug is absent, mirroring how every
              other share path in the app handles it. */}
          <div className="mt-3 flex items-center gap-2">
            {active.slug ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openReader("cta");
                }}
                className="font-body font-semibold text-[13px] px-3.5 py-1.5 rounded-full bg-white text-black active:scale-[.97] transition"
              >
                Read full →
              </button>
            ) : null}
            <button
              type="button"
              onClick={async (e) => {
                e.stopPropagation();
                const origin =
                  typeof window !== "undefined" ? window.location.origin : "";
                const url = storyShareUrl(active.slug ?? null, origin);
                const ok = await copyToClipboard(url);
                // eslint-disable-next-line no-console -- rule 14
                console.info("[stories viewer share]", {
                  id: active.id,
                  slug: active.slug ?? null,
                  ok,
                });
              }}
              className="font-body font-semibold text-[13px] px-3.5 py-1.5 rounded-full text-white border border-white/30 active:scale-[.97] transition"
            >
              Share
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MuteGlyph({ muted }: { muted: boolean }) {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 9v6h4l5 4V5L8 9H4Z" />
      {muted ? (
        <>
          <path d="m16 9 5 6" />
          <path d="M21 9l-5 6" />
        </>
      ) : (
        <>
          <path d="M16 8.5a4 4 0 0 1 0 7" />
          <path d="M18.5 6a7 7 0 0 1 0 12" />
        </>
      )}
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </svg>
  );
}
