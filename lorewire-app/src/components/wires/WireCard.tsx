"use client";

// One wire in the Wires feed. The card is a vertical stack: the FULL 9:16 video
// on top (object-contain, so nothing is cropped and the burned-in captions are
// always visible) and a solid control bar BELOW it holding the title, the Read
// CTA, and the like/save/share actions — deliberately off the video so no chrome
// ever covers the frame or the captions.
//
// Player interaction (the "real reels" behaviors):
//   - tap / click            → play-pause (deferred ~280ms so a double-tap is caught)
//   - double-tap / dbl-click → like, with a heart-burst over the frame
//   - press and hold         → pause while held, resume on release
//   - hover (desktop)        → reveals the scrubber + time, then it slims back down
//   - scrubber               → drag anywhere on the bar to seek
//   - autoplay toggle        → a pinned switch; when off, a wire waits for a tap
//   - buffering spinner       on stall; loop on end (the feed handles next-wire swipes)
//
// Off-window cards render a poster placeholder of the same height so the feed's
// scroll/paging geometry stays correct without a live <video> per item.
//
// Autoplay: muted + playsInline so the browser allows it without a gesture. The
// muted PROPERTY is set imperatively before play() (React's muted attribute
// doesn't reliably set the property, and muted-autoplay is blocked without it),
// and we retry on `canplay` for when play() fired before the video was ready.
// Under prefers-reduced-motion (or with the autoplay toggle off) we never
// autoplay — a centre play button opts in.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { CAT, type Cat } from "@/lib/stories";
import { storyShareUrl } from "@/lib/share";
import ShareSheet from "@/components/ShareSheet";
import type { WireStory } from "@/app/actions";

type OpenFn = (id: string, tab?: string) => void;

// Show the like number only once a wire crosses this many likes — below it,
// just the heart. Keeps a zero-traffic catalog from showing "0 likes" on every
// card; drop to 0 to show real counts always once engagement justifies it.
const LIKE_COUNT_THRESHOLD = 3;

// Max gap between two taps to count as a double-tap (like), and how long the
// pointer must stay down to count as a press-and-hold (pause).
const DOUBLE_TAP_MS = 280;
const HOLD_MS = 350;

// Live `category` is a free string from the DB; map it to the brand category
// colour when it matches one of the six, else a neutral surface tone.
function catColor(category: string | null): string {
  if (category && category in CAT) return CAT[category as Cat];
  return "var(--color-surface2)";
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

const SpeakerOn = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 9v6h4l5 4V5L8 9H4Z" />
    <path d="M16 8.5a4 4 0 0 1 0 7M18.5 6a7 7 0 0 1 0 12" />
  </svg>
);
const SpeakerOff = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 9v6h4l5 4V5L8 9H4Z" />
    <path d="m16 9 5 6M21 9l-5 6" />
  </svg>
);
// Looping-play glyph for the autoplay toggle; slashed when autoplay is off.
const AutoplayGlyph = ({ on, size = 20 }: { on: boolean; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 11a7.5 7.5 0 0 1 12.8-5.3L20 8" />
    <path d="M20 4v4h-4" />
    <path d="M19.5 13a7.5 7.5 0 0 1-12.8 5.3L4 16" />
    <path d="M4 20v-4h4" />
    <path d="M10.5 9.5v5l4-2.5z" fill="currentColor" stroke="none" />
    {!on && <path d="M4 4 20 20" strokeWidth={2.2} />}
  </svg>
);
const ShuffleIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22" />
    <path d="m18 2 4 4-4 4" />
    <path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2" />
    <path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8" />
    <path d="m18 14 4 4-4 4" />
  </svg>
);
// End-of-wire mode glyphs: down-arrow-to-bar = advance to next; repeat = loop.
const AdvanceGlyph = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 4v10" />
    <path d="m7 11 5 5 5-5" />
    <path d="M5 20h14" />
  </svg>
);
const LoopGlyph = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="m17 2 4 4-4 4" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <path d="m7 22-4-4 4-4" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </svg>
);
const PlayGlyph = ({ size = 30 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>
);
const HeartIcon = ({ filled, size = 23 }: { filled: boolean; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "var(--color-accent)" : "none"} stroke={filled ? "var(--color-accent)" : "currentColor"} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20.5S3.5 15 3.5 8.8A4.3 4.3 0 0 1 12 6.9a4.3 4.3 0 0 1 8.5 1.9C20.5 15 12 20.5 12 20.5Z" />
  </svg>
);
const BookmarkIcon = ({ filled, size = 22 }: { filled: boolean; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 4h12v16l-6-4-6 4z" />
  </svg>
);
const ShareUpIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
    <path d="M12 15V3M8 7l4-4 4 4" />
  </svg>
);

export interface WireCardProps {
  short: WireStory;
  /** This is the currently snapped card. */
  active: boolean;
  /** Within the feed's mount window — hold a live <video>. */
  mounted: boolean;
  /** Feed-level mute state (shared across cards). */
  muted: boolean;
  /** Feed-level autoplay master toggle. When false, a wire waits for a tap. */
  autoplay: boolean;
  /** End-of-wire behavior: true = advance to the next wire, false = loop it. */
  advance: boolean;
  /** prefers-reduced-motion — suppress autoplay, require an explicit tap. */
  reducedMotion: boolean;
  /** A modal (Title sheet) is open over the feed — keep playback paused. */
  paused: boolean;
  /** Preload the full video (the active card + the immediate next) so the next
   *  swipe starts instantly; other mounted cards only fetch metadata. */
  eager?: boolean;
  /** Extra bottom padding under the control bar so it clears a fixed nav (the
   *  mobile tab bar). Desktop passes a small value. */
  insetBottom?: number;
  onToggleMute: () => void;
  onToggleAutoplay: () => void;
  /** Toggle end-of-wire behavior between advance and loop. */
  onToggleAdvance: () => void;
  /** Shuffle the feed order (feed-level). When omitted, the control hides. */
  onShuffle?: () => void;
  onOpenInfo: OpenFn;
  /** Hint visibility is owned by the feed so it shows once, not per card. */
  showSoundHint: boolean;
  onDismissSoundHint: () => void;
  /** Engagement. `liked`/`likeCount` come from the server-backed like store. */
  liked: boolean;
  likeCount: number;
  saved: boolean;
  onToggleLike: (id: string) => void;
  onToggleSave: (id: string) => void;
  /** Playback progress callback. Fires as `<video>` time advances. The
   *  feed throttles + thresholds this for the Continue Watching store —
   *  WireCard just forwards the raw event so playback paths stay local. */
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  /** Fired when the video finishes (only in autoplay mode, where it doesn't
   *  loop). Returns true if the feed advanced to the next wire; false means
   *  there was no next one, so the card replays in place. */
  onWireEnded?: () => boolean;
}

export default function WireCard({
  short,
  active,
  mounted,
  muted,
  autoplay,
  advance,
  reducedMotion,
  paused,
  eager = false,
  insetBottom = 16,
  onToggleMute,
  onToggleAutoplay,
  onToggleAdvance,
  onShuffle,
  onOpenInfo,
  showSoundHint,
  onDismissSoundHint,
  liked,
  likeCount,
  saved,
  onToggleLike,
  onToggleSave,
  onTimeUpdate,
  onWireEnded,
}: WireCardProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [posterOk, setPosterOk] = useState(true);
  // Reduced-motion / autoplay-off opt-in; explicit tap-pause; whether the
  // browser blocked autoplay. These drive the centre play affordance.
  const [userStarted, setUserStarted] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [blocked, setBlocked] = useState(false);
  // Playback surface state for the scrubber + spinner.
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [heartBurst, setHeartBurst] = useState(false);
  // Our own ShareSheet overlay (not the OS share panel).
  const [shareOpen, setShareOpen] = useState(false);

  // Gesture bookkeeping (refs so handlers stay stable and read fresh values).
  const seekingRef = useRef(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const holdTimer = useRef<number | null>(null);
  const holdFired = useRef(false);
  const holdPaused = useRef(false);
  const lastTap = useRef(0);
  const singleTapTimer = useRef<number | null>(null);
  const burstTimer = useRef<number | null>(null);

  // Generation counter for tryPlay() calls. Bumped on every tryPlay AND on
  // every pause in the shouldPlay effect. The then/catch handlers ignore
  // results from a stale generation, so a pending play() that the user
  // swiped past can't strand `blocked = true` on a card that should now be
  // happily playing. Without this, fast swipes lose the play/pause race
  // and the centre Play overlay sticks until tap.
  const playGenRef = useRef(0);

  // Autoplay is suppressed by reduced-motion OR the feed-level toggle; in
  // either case the user must opt in with a tap (tracked by userStarted).
  const autoStart = autoplay && !reducedMotion;
  const shouldPlay =
    active && mounted && !paused && !userPaused && (autoStart || userStarted);

  // Reset transient flags around the active transition so re-entry autoplays
  // fresh. Done during render (the React 19 pattern the shell uses in
  // TitleSheet) rather than inside an effect.
  //
  // active → inactive: full reset (next time the user lands here it starts
  // from frame 0 with no carried-over user-paused or blocked state).
  // inactive → active: clear `blocked` and `userPaused` defensively, because
  // a stale rejection from a prior tryPlay (lost play/pause race during a
  // fast swipe) could otherwise leave `blocked = true` until the user taps.
  const [prevActive, setPrevActive] = useState(active);
  if (prevActive !== active) {
    setPrevActive(active);
    if (!active) {
      setUserStarted(false);
      setUserPaused(false);
      setBlocked(false);
      setBuffering(false);
      setSeeking(false);
      setCurrentTime(0);
    } else {
      setBlocked(false);
      setUserPaused(false);
    }
  }

  const videoUrl = short.video_url;
  const poster = short.hero_image && posterOk ? short.hero_image : null;
  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  // Start playback reliably: set the muted PROPERTY right before play() and
  // record whether the browser ACTUALLY blocked us (NotAllowedError = real
  // autoplay-policy block; AbortError = pause() interrupted a pending play,
  // a benign race when the user is swiping between cards).
  //
  // The generation guard prevents a stale rejection from a play() call the
  // user has already swiped past from clobbering state on the now-current
  // card. Without it, fast swipes leave `blocked = true` stranded and the
  // centre Play overlay sticks until the user taps it.
  const tryPlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const gen = ++playGenRef.current;
    v.muted = muted;
    const p = v.play();
    if (p && typeof p.then === "function") {
      p.then(() => {
        if (gen !== playGenRef.current) return;
        setBlocked(false);
      }).catch((e: unknown) => {
        if (gen !== playGenRef.current) return;
        const name =
          e && typeof e === "object" && "name" in e
            ? String((e as { name: unknown }).name)
            : "";
        if (name === "NotAllowedError") {
          setBlocked(true);
          console.warn("[wires play blocked]", { id: short.id, name, e: String(e) });
        } else {
          // AbortError (most common) or any other transient. Don't surface a
          // tap-to-play overlay — the next shouldPlay-driven tryPlay will
          // recover automatically when the card settles.
          console.info("[wires play interrupted]", { id: short.id, name, e: String(e) });
        }
      });
    }
  }, [muted, short.id]);

  // Drive play/pause off the derived shouldPlay flag. Bumping the generation
  // counter on pause invalidates any in-flight play() Promise so its
  // rejection becomes a no-op (see tryPlay above).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (shouldPlay) {
      tryPlay();
    } else {
      playGenRef.current++;
      v.pause();
      if (!active) {
        try {
          v.currentTime = 0;
        } catch {
          /* not seekable yet — harmless */
        }
      }
    }
  }, [shouldPlay, active, tryPlay]);

  // Keep the muted property in sync with the feed-level toggle.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  // Clear any pending gesture timers on unmount.
  useEffect(() => {
    return () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
      if (singleTapTimer.current) clearTimeout(singleTapTimer.current);
      if (burstTimer.current) clearTimeout(burstTimer.current);
    };
  }, []);

  // Play/pause from a single tap. In opt-in mode (reduced motion or autoplay
  // off) the first tap starts; afterwards it toggles.
  const togglePlayPause = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!autoStart && !userStarted) {
      setUserStarted(true);
      setUserPaused(false);
      return;
    }
    if (v.paused) {
      setUserPaused(false);
      tryPlay();
    } else {
      setUserPaused(true);
      v.pause();
    }
  }, [autoStart, userStarted, tryPlay]);

  // Keyboard control for the active wire (desktop): space toggles play/pause,
  // left/right seek 5s. Only the active card listens, and not while a field is
  // focused or a modal is open over the feed.
  useEffect(() => {
    if (!active || paused) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      const v = videoRef.current;
      if (e.key === " ") {
        e.preventDefault();
        togglePlayPause();
      } else if (e.key === "ArrowLeft" && v) {
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - 5);
        setCurrentTime(v.currentTime);
      } else if (e.key === "ArrowRight" && v && Number.isFinite(v.duration)) {
        e.preventDefault();
        v.currentTime = Math.min(v.duration, v.currentTime + 5);
        setCurrentTime(v.currentTime);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, paused, togglePlayPause]);

  const burstLike = useCallback(() => {
    if (!liked) onToggleLike(short.id);
    setHeartBurst(true);
    if (burstTimer.current) clearTimeout(burstTimer.current);
    burstTimer.current = window.setTimeout(() => setHeartBurst(false), 700);
  }, [liked, onToggleLike, short.id]);

  // Tap arbiter: a second tap within DOUBLE_TAP_MS likes (and cancels the
  // pending single-tap play toggle); a lone tap toggles play after the window.
  const handleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      if (singleTapTimer.current) {
        clearTimeout(singleTapTimer.current);
        singleTapTimer.current = null;
      }
      lastTap.current = 0;
      burstLike();
      return;
    }
    lastTap.current = now;
    singleTapTimer.current = window.setTimeout(() => {
      singleTapTimer.current = null;
      togglePlayPause();
    }, DOUBLE_TAP_MS);
  }, [burstLike, togglePlayPause]);

  // Press-and-hold: pause while held, resume on release. Returns true when the
  // pointer-up was consumed by a hold (so it isn't also treated as a tap).
  const endHold = useCallback(
    (resume: boolean): boolean => {
      if (holdTimer.current) {
        clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }
      if (holdFired.current) {
        if (resume && holdPaused.current && shouldPlay) tryPlay();
        holdPaused.current = false;
        holdFired.current = false;
        return true;
      }
      return false;
    },
    [shouldPlay, tryPlay],
  );

  const onStagePointerDown = useCallback(() => {
    holdFired.current = false;
    holdTimer.current = window.setTimeout(() => {
      holdFired.current = true;
      const v = videoRef.current;
      if (v && !v.paused) {
        v.pause();
        holdPaused.current = true;
      }
    }, HOLD_MS);
  }, []);

  const onStagePointerUp = useCallback(() => {
    if (!endHold(true)) handleTap();
  }, [endHold, handleTap]);

  const onStagePointerLeave = useCallback(() => {
    endHold(true);
  }, [endHold]);

  // Scrubber: drag anywhere on the bar to seek. Pointer capture keeps the drag
  // tracking even when the finger/cursor strays off the thin bar.
  const seekToClientX = useCallback((clientX: number) => {
    const track = trackRef.current;
    const v = videoRef.current;
    if (!track || !v || !Number.isFinite(v.duration) || v.duration <= 0) return;
    const rect = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const t = frac * v.duration;
    v.currentTime = t;
    setCurrentTime(t);
  }, []);

  const onSeekDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      seekingRef.current = true;
      setSeeking(true);
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported — drag still works while over the bar */
      }
      seekToClientX(e.clientX);
    },
    [seekToClientX],
  );

  const onSeekMove = useCallback(
    (e: React.PointerEvent) => {
      if (!seekingRef.current) return;
      seekToClientX(e.clientX);
    },
    [seekToClientX],
  );

  const onSeekUp = useCallback((e: React.PointerEvent) => {
    if (!seekingRef.current) return;
    e.stopPropagation();
    seekingRef.current = false;
    setSeeking(false);
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* nothing captured — fine */
    }
  }, []);

  // Share opens our OWN ShareSheet with the PUBLIC canonical reader URL
  // (/v/[slug]) — never an internal id or a signed GCS URL.
  const shareUrl = storyShareUrl(
    short.slug,
    typeof window !== "undefined" ? window.location.origin : "",
  );

  const showPlayButton =
    active &&
    !paused &&
    ((!autoStart && !userStarted) || userPaused || blocked);
  const controlsExpanded = hovered || seeking;
  const showCount = likeCount >= LIKE_COUNT_THRESHOLD;

  return (
    <div className="flex h-full w-full flex-col bg-black">
      {/* ── Video stage — full frame, never cropped or covered ── */}
      <div
        className="relative min-h-0 flex-1"
        onMouseEnter={() => setHovered(true)}
        onMouseMove={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {mounted && videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            poster={poster ?? undefined}
            muted={muted}
            loop={!advance}
            playsInline
            preload={eager ? "auto" : "metadata"}
            className="absolute inset-0 h-full w-full touch-pan-y object-contain"
            onPointerDown={onStagePointerDown}
            onPointerUp={onStagePointerUp}
            onPointerLeave={onStagePointerLeave}
            onPointerCancel={onStagePointerLeave}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (Number.isFinite(v.duration)) setDuration(v.duration);
            }}
            onWaiting={() => setBuffering(true)}
            onPlaying={() => setBuffering(false)}
            onCanPlay={() => {
              setBuffering(false);
              if (shouldPlay) tryPlay();
            }}
            onPlay={() => setBlocked(false)}
            onEnded={() => {
              // In autoplay mode the video doesn't loop, so this fires once a
              // wire finishes. Ask the feed to advance; if there's no next wire
              // (end of the loaded list), replay this one in place so the frame
              // never dead-stops.
              const advanced = onWireEnded ? onWireEnded() : false;
              if (!advanced) {
                const v = videoRef.current;
                if (v) {
                  try {
                    v.currentTime = 0;
                  } catch {
                    /* not seekable — harmless */
                  }
                  tryPlay();
                }
              }
            }}
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              if (Number.isFinite(v.duration) && v.duration > 0) {
                if (!seekingRef.current) setCurrentTime(v.currentTime);
                onTimeUpdate?.(v.currentTime, v.duration);
              }
            }}
            onError={() =>
              console.warn("[wires video err]", { id: short.id, src: videoUrl })
            }
          />
        ) : poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={poster}
            alt=""
            className="absolute inset-0 h-full w-full object-contain"
            onError={() => setPosterOk(false)}
          />
        ) : (
          <div className="absolute inset-0" style={{ background: catColor(short.category) }}>
            <div className="absolute inset-0 grain opacity-40 mix-blend-overlay" />
          </div>
        )}

        {/* Subtle top scrim so the category + controls read over a bright frame. */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-20"
          style={{ background: "linear-gradient(180deg, rgba(0,0,0,.45) 0%, rgba(0,0,0,0) 100%)" }}
        />

        {/* Top row: category + duration (left), autoplay + mute (right). */}
        <div
          className="absolute inset-x-0 top-0 flex items-start justify-between px-4"
          style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 14px)" }}
        >
          <div className="flex items-center gap-2">
            {short.category && (
              <span
                className="rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-[.16em] text-ink ink-shadow"
                style={{ background: catColor(short.category) }}
              >
                {short.category}
              </span>
            )}
            {short.duration && (
              <span className="rounded px-1.5 py-0.5 font-mono text-[10px] text-ink/85" style={{ background: "rgba(0,0,0,.4)" }}>
                {short.duration}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onShuffle && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onShuffle();
                }}
                aria-label="Shuffle wires"
                title="Shuffle"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink"
                style={{ background: "rgba(0,0,0,.4)" }}
              >
                <ShuffleIcon size={18} />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleAutoplay();
              }}
              aria-label={autoplay ? "Turn autoplay off" : "Turn autoplay on"}
              aria-pressed={autoplay}
              title={autoplay ? "Autoplay on" : "Autoplay off"}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink"
              style={{ background: "rgba(0,0,0,.4)", opacity: autoplay ? 1 : 0.7 }}
            >
              <AutoplayGlyph on={autoplay} size={19} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleAdvance();
              }}
              aria-label={
                advance ? "Auto-advance on; switch to loop" : "Loop on; switch to auto-advance"
              }
              aria-pressed={advance}
              title={advance ? "Auto-advance" : "Loop"}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink"
              style={{ background: "rgba(0,0,0,.4)" }}
            >
              {advance ? <AdvanceGlyph size={18} /> : <LoopGlyph size={18} />}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleMute();
                onDismissSoundHint();
              }}
              aria-label={muted ? "Unmute" : "Mute"}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink"
              style={{ background: "rgba(0,0,0,.4)" }}
            >
              {muted ? <SpeakerOff size={20} /> : <SpeakerOn size={20} />}
            </button>
          </div>
        </div>

        {/* "Tap for sound" hint — shows once while muted. */}
        {active && muted && showSoundHint && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleMute();
              onDismissSoundHint();
            }}
            className="absolute left-1/2 top-[60px] -translate-x-1/2 flex items-center gap-1.5 rounded-full px-3 py-1.5 font-body text-[12.5px] font-semibold text-ink active:scale-95 transition"
            style={{ background: "rgba(0,0,0,.55)", backdropFilter: "blur(4px)" }}
          >
            <SpeakerOff size={15} /> Tap for sound
          </button>
        )}

        {/* Buffering spinner — only while actively trying to play. */}
        {active && buffering && !showPlayButton && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <span className="block h-10 w-10 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          </div>
        )}

        {/* Centre play affordance — only when genuinely paused/blocked/opt-in. */}
        {showPlayButton && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              togglePlayPause();
            }}
            aria-label="Play"
            className="absolute left-1/2 top-1/2 grid h-[68px] w-[68px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-bg active:scale-95 transition"
            style={{ background: "rgba(245,243,239,.92)", boxShadow: "0 10px 30px rgba(0,0,0,.4)" }}
          >
            <PlayGlyph />
          </button>
        )}

        {/* Double-tap heart burst. */}
        {heartBurst && (
          <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
            <span className="wire-heart-burst">
              <HeartIcon filled size={132} />
            </span>
          </div>
        )}

        {/* Scrubber + time, pinned to the bottom of the video stage. The hit
            zone is taller than the visible bar so it's easy to grab. */}
        <div className="absolute inset-x-0 bottom-0 z-20 px-3 pb-1">
          {(controlsExpanded || currentTime > 0) && (
            <div className="mb-1 flex justify-end">
              <span
                className="rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-ink/90 transition-opacity"
                style={{ background: "rgba(0,0,0,.45)", opacity: controlsExpanded ? 1 : 0.65 }}
              >
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>
          )}
          <div
            ref={trackRef}
            onPointerDown={onSeekDown}
            onPointerMove={onSeekMove}
            onPointerUp={onSeekUp}
            onPointerCancel={onSeekUp}
            className="flex cursor-pointer touch-none items-center"
            style={{ height: 18 }}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration) || 0}
            aria-valuenow={Math.round(currentTime)}
          >
            <div
              className="relative w-full rounded-full transition-all"
              style={{
                height: controlsExpanded ? 5 : 3,
                background: "rgba(255,255,255,.28)",
              }}
            >
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-accent"
                style={{ width: `${progress * 100}%` }}
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full bg-accent transition-opacity"
                style={{
                  left: `${progress * 100}%`,
                  width: 12,
                  height: 12,
                  opacity: controlsExpanded ? 1 : 0,
                  boxShadow: "0 1px 4px rgba(0,0,0,.5)",
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Control bar BELOW the video — title, Read CTA, actions ── */}
      <div
        className="relative z-10 shrink-0 border-t border-line bg-black px-4 pt-3"
        style={{ paddingBottom: insetBottom }}
      >
        <div className="flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="line-clamp-2 font-display font-black uppercase tracking-tightest leading-[1.02] text-ink" style={{ fontSize: 17 }}>
              {short.title}
            </h2>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenInfo(short.id, "Read");
              }}
              className="mt-2 inline-flex items-center gap-2 rounded-[9px] bg-ink px-3.5 py-2 font-display text-[12px] font-bold uppercase tracking-tight text-bg active:scale-[.98] transition"
            >
              Read the story
            </button>
          </div>

          {/* Engagement — Like is server-counted (shown past a threshold), Save
              writes the real My List, Share to the public /v/[slug]. */}
          <div className="flex shrink-0 items-end gap-3.5 pb-0.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleLike(short.id);
              }}
              aria-label={liked ? "Unlike" : "Like"}
              aria-pressed={liked}
              className="flex flex-col items-center gap-0.5 text-ink active:scale-90 transition"
            >
              <HeartIcon filled={liked} />
              <span className="font-body text-[10px] font-semibold tabular-nums" style={{ color: liked ? "var(--color-accent)" : undefined }}>
                {showCount ? formatCount(likeCount) : "Like"}
              </span>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleSave(short.id);
              }}
              aria-label={saved ? "Remove from My List" : "Save to My List"}
              aria-pressed={saved}
              className="flex flex-col items-center gap-0.5 text-ink active:scale-90 transition"
            >
              <BookmarkIcon filled={saved} />
              <span className="font-body text-[10px] font-semibold" style={{ color: saved ? "var(--color-accent)" : undefined }}>
                {saved ? "Saved" : "Save"}
              </span>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShareOpen(true);
              }}
              aria-label="Share"
              className="flex flex-col items-center gap-0.5 text-ink active:scale-90 transition"
            >
              <ShareUpIcon />
              <span className="font-body text-[10px] font-semibold">Share</span>
            </button>
          </div>
        </div>
      </div>

      {shareOpen && (
        <ShareSheet
          url={shareUrl}
          title={short.title ?? "LoreWire"}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}
