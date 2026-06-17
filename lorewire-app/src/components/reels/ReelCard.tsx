"use client";

// One full-screen short in the Reels feed. Plays the rendered 9:16 MP4 when it's
// the active card AND mounted by the feed's windowing; off-window cards render a
// poster placeholder of the same height so the layout geometry stays correct
// without holding a live <video> for every item (egress + memory discipline).
//
// The MP4's yellow karaoke captions are burned into the pixels and sit in the
// lower-centre band, so the chrome deliberately stays OUT of that band: category
// + duration ride the top, only a compact title + the Read CTA sit at the very
// bottom, and there's no synopsis competing with the caption text.
//
// Autoplay: muted + playsInline so the browser allows it without a gesture. The
// muted PROPERTY is set imperatively before play() (React's muted attribute
// doesn't reliably set the property, and muted-autoplay is blocked without it),
// and we retry on `canplay` for the case where play() fired before the video was
// ready. Under prefers-reduced-motion we never autoplay — a centre play button
// is the opt-in.

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
const HeartIcon = ({ filled, size = 26 }: { filled: boolean; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "var(--color-accent)" : "none"} stroke={filled ? "var(--color-accent)" : "currentColor"} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20.5S3.5 15 3.5 8.8A4.3 4.3 0 0 1 12 6.9a4.3 4.3 0 0 1 8.5 1.9C20.5 15 12 20.5 12 20.5Z" />
  </svg>
);
const BookmarkIcon = ({ filled, size = 25 }: { filled: boolean; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 4h12v16l-6-4-6 4z" />
  </svg>
);
const ShareUpIcon = ({ size = 24 }: { size?: number }) => (
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
      // Reset to the top when it scrolls out of the active slot so re-entry
      // starts the short fresh.
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

  // Tap the video surface: toggle play/pause on the active card. In
  // reduced-motion mode the first tap is the opt-in to start.
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
    <div className="relative h-full w-full overflow-hidden bg-black">
      {/* Media layer */}
      {mounted && videoUrl ? (
        <video
          ref={videoRef}
          src={videoUrl}
          poster={poster ?? undefined}
          muted={muted}
          loop
          playsInline
          preload={eager ? "auto" : "metadata"}
          // object-cover for the full-bleed feed feel — the short is authored
          // 9:16 and its burned-in captions sit centre, so the minor side-crop
          // on a taller-than-9:16 phone never eats the text.
          className="absolute inset-0 h-full w-full object-cover"
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
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setPosterOk(false)}
        />
      ) : (
        <div
          className="absolute inset-0"
          style={{ background: catColor(short.category) }}
        >
          <div className="absolute inset-0 grain opacity-40 mix-blend-overlay" />
        </div>
      )}

      {/* Top + bottom scrims only — the middle (caption band) stays clear. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-24"
        style={{ background: "linear-gradient(180deg, rgba(0,0,0,.5) 0%, rgba(0,0,0,0) 100%)" }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[36%]"
        style={{ background: "linear-gradient(0deg, rgba(0,0,0,.72) 0%, rgba(0,0,0,.25) 55%, rgba(0,0,0,0) 100%)" }}
      />

      {/* Centre play affordance — only when genuinely paused/blocked/opt-in,
          never during normal autoplay buffering (that flicker read as jank). */}
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

      {/* Top row: category + duration (left), mute (right). Kept up here so the
          lower-centre caption band stays clear. */}
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

      {/* "Tap for sound" hint — shows once while muted so the user knows there
          IS audio. Dismisses on first unmute. */}
      {active && muted && showSoundHint && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleMute();
            onDismissSoundHint();
          }}
          className="absolute left-1/2 top-[64px] -translate-x-1/2 flex items-center gap-1.5 rounded-full px-3 py-1.5 font-body text-[12.5px] font-semibold text-ink active:scale-95 transition"
          style={{ background: "rgba(0,0,0,.55)", backdropFilter: "blur(4px)" }}
        >
          <SpeakerOff size={15} /> Tap for sound
        </button>
      )}

      {/* Engagement rail — local + honest: a heart with NO fabricated count,
          Save that writes the real My List, and Share to the public /v/[slug]. */}
      <div className="absolute bottom-[132px] right-2.5 flex flex-col items-center gap-5">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleLike(short.id);
          }}
          aria-label={liked ? "Unlike" : "Like"}
          aria-pressed={liked}
          className="flex flex-col items-center gap-1 text-ink active:scale-90 transition"
        >
          <span className="grid h-11 w-11 place-items-center rounded-full" style={{ background: "rgba(0,0,0,.4)" }}>
            <HeartIcon filled={liked} />
          </span>
          <span className="font-body text-[11px] font-semibold ink-shadow">Like</span>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleSave(short.id);
          }}
          aria-label={saved ? "Remove from My List" : "Save to My List"}
          aria-pressed={saved}
          className="flex flex-col items-center gap-1 text-ink active:scale-90 transition"
        >
          <span className="grid h-11 w-11 place-items-center rounded-full" style={{ background: "rgba(0,0,0,.4)" }}>
            <BookmarkIcon filled={saved} />
          </span>
          <span className="font-body text-[11px] font-semibold ink-shadow" style={{ color: saved ? "var(--color-accent)" : undefined }}>
            {saved ? "Saved" : "Save"}
          </span>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onShare();
          }}
          aria-label="Share"
          className="flex flex-col items-center gap-1 text-ink active:scale-90 transition"
        >
          <span className="grid h-11 w-11 place-items-center rounded-full" style={{ background: "rgba(0,0,0,.4)" }}>
            <ShareUpIcon />
          </span>
          <span className="font-body text-[11px] font-semibold ink-shadow">{copied ? "Copied" : "Share"}</span>
        </button>
      </div>

      {/* Bottom overlay: compact title + Read CTA only. No synopsis — it used to
          sit straight on top of the burned-in caption. Right padding clears the
          engagement rail. */}
      <div className="absolute inset-x-0 bottom-0 pb-[116px] pl-4 pr-16">
        <h2 className="line-clamp-2 font-display font-black uppercase tracking-tightest leading-[1.02] text-ink ink-shadow" style={{ fontSize: 19 }}>
          {short.title}
        </h2>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenInfo(short.id, "Read");
          }}
          className="mt-2.5 inline-flex items-center gap-2 rounded-[9px] bg-ink px-3.5 py-2 font-display text-[12px] font-bold uppercase tracking-tight text-bg active:scale-[.98] transition"
        >
          Read the story
        </button>
      </div>
    </div>
  );
}
