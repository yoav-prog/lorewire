"use client";

// One short in the Reels feed. The card is a vertical stack: the FULL 9:16 video
// on top (object-contain, so nothing is cropped and the burned-in captions are
// always visible) and a solid control bar BELOW it holding the title, the Read
// CTA, and the like/save/share actions — deliberately off the video so no chrome
// ever covers the frame or the captions.
//
// Off-window cards render a poster placeholder of the same height so the feed's
// scroll/paging geometry stays correct without a live <video> per item.
//
// Autoplay: muted + playsInline so the browser allows it without a gesture. The
// muted PROPERTY is set imperatively before play() (React's muted attribute
// doesn't reliably set the property, and muted-autoplay is blocked without it),
// and we retry on `canplay` for when play() fired before the video was ready.
// Under prefers-reduced-motion we never autoplay — a centre play button opts in.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { CAT, type Cat } from "@/lib/stories";
import type { LiveCatalogStory } from "@/app/actions";

type OpenFn = (id: string, tab?: string) => void;

// Live `category` is a free string from the DB; map it to the brand category
// colour when it matches one of the six, else a neutral surface tone.
function catColor(category: string | null): string {
  if (category && category in CAT) return CAT[category as Cat];
  return "var(--color-surface2)";
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

export interface ReelCardProps {
  short: LiveCatalogStory;
  /** This is the currently snapped card. */
  active: boolean;
  /** Within the feed's mount window — hold a live <video>. */
  mounted: boolean;
  /** Feed-level mute state (shared across cards). */
  muted: boolean;
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
  onOpenInfo: OpenFn;
  /** Hint visibility is owned by the feed so it shows once, not per card. */
  showSoundHint: boolean;
  onDismissSoundHint: () => void;
  /** Engagement (local, honest — no fabricated counts). */
  liked: boolean;
  saved: boolean;
  onToggleLike: (id: string) => void;
  onToggleSave: (id: string) => void;
}

export default function ReelCard({
  short,
  active,
  mounted,
  muted,
  reducedMotion,
  paused,
  eager = false,
  insetBottom = 16,
  onToggleMute,
  onOpenInfo,
  showSoundHint,
  onDismissSoundHint,
  liked,
  saved,
  onToggleLike,
  onToggleSave,
}: ReelCardProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [posterOk, setPosterOk] = useState(true);
  // Reduced-motion opt-in; explicit tap-pause; whether the browser blocked
  // autoplay. These drive the centre play affordance.
  const [userStarted, setUserStarted] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [blocked, setBlocked] = useState(false);
  // Transient "Link copied" confirmation after the clipboard-fallback share.
  const [copied, setCopied] = useState(false);

  // Reset the transient playback flags the moment this card stops being active,
  // so re-entry autoplays fresh. Done during render (the React 19 pattern the
  // shell uses in TitleSheet) rather than inside an effect.
  const [prevActive, setPrevActive] = useState(active);
  if (prevActive !== active) {
    setPrevActive(active);
    if (!active) {
      setUserStarted(false);
      setUserPaused(false);
      setBlocked(false);
    }
  }

  const videoUrl = short.video_url;
  const poster = short.hero_image && posterOk ? short.hero_image : null;
  const shouldPlay =
    active && mounted && !paused && !userPaused && (!reducedMotion || userStarted);

  // Start playback reliably: set the muted PROPERTY right before play() and
  // record whether the browser blocked us (so we can surface a tap-to-play).
  const tryPlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = muted;
    const p = v.play();
    if (p && typeof p.then === "function") {
      p.then(() => setBlocked(false)).catch((e) => {
        setBlocked(true);
        console.warn("[reels play blocked]", { id: short.id, e: String(e) });
      });
    }
  }, [muted, short.id]);

  // Drive play/pause off the derived shouldPlay flag.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (shouldPlay) {
      tryPlay();
    } else {
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

  // Tap the video: toggle play/pause. In reduced-motion mode the first tap opts
  // in to start.
  const onSurfaceTap = () => {
    const v = videoRef.current;
    if (!v) return;
    if (reducedMotion && !userStarted) {
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
  };

  // Share the PUBLIC canonical reader URL (/v/[slug]) — never an internal id or
  // a signed GCS URL. Native share sheet first, clipboard as the fallback.
  const onShare = async () => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const url = short.slug ? `${origin}/v/${short.slug}` : origin;
    const title = short.title ?? "LoreWire";
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title, url });
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
    } catch {
      /* user dismissed the share sheet or denied clipboard — nothing to do */
    }
  };

  const showPlayButton =
    active && !paused && ((reducedMotion && !userStarted) || userPaused || blocked);

  return (
    <div className="flex h-full w-full flex-col bg-black">
      {/* ── Video stage — full frame, never cropped or covered ── */}
      <div className="relative min-h-0 flex-1">
        {mounted && videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            poster={poster ?? undefined}
            muted={muted}
            loop
            playsInline
            preload={eager ? "auto" : "metadata"}
            className="absolute inset-0 h-full w-full object-contain"
            onClick={onSurfaceTap}
            onCanPlay={() => {
              if (shouldPlay) tryPlay();
            }}
            onPlay={() => setBlocked(false)}
            onError={() =>
              console.warn("[reels video err]", { id: short.id, src: videoUrl })
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

        {/* Subtle top scrim so the category + mute read over a bright frame. */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-20"
          style={{ background: "linear-gradient(180deg, rgba(0,0,0,.45) 0%, rgba(0,0,0,0) 100%)" }}
        />

        {/* Top row: category + duration (left), mute (right). */}
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

        {/* Centre play affordance — only when genuinely paused/blocked/opt-in. */}
        {showPlayButton && (
          <button
            onClick={onSurfaceTap}
            aria-label="Play"
            className="absolute left-1/2 top-1/2 grid h-[68px] w-[68px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-bg active:scale-95 transition"
            style={{ background: "rgba(245,243,239,.92)", boxShadow: "0 10px 30px rgba(0,0,0,.4)" }}
          >
            <PlayGlyph />
          </button>
        )}
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

          {/* Engagement — local + honest: a heart with NO fabricated count, Save
              that writes the real My List, Share to the public /v/[slug]. */}
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
              <span className="font-body text-[10px] font-semibold">Like</span>
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
                onShare();
              }}
              aria-label="Share"
              className="flex flex-col items-center gap-0.5 text-ink active:scale-90 transition"
            >
              <ShareUpIcon />
              <span className="font-body text-[10px] font-semibold">{copied ? "Copied" : "Share"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
