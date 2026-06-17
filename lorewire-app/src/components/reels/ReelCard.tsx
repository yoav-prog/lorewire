"use client";

// One full-screen short in the Reels feed. Plays the rendered 9:16 MP4
// (captions are burned into the pixels, so there's no caption overlay to sync)
// when it's the active card AND it's been mounted by the feed's windowing.
// Off-window cards render as a poster placeholder of the same height so the
// scroll-snap geometry stays correct without holding a live <video> for every
// item (that's the egress + memory discipline from the plan).
//
// Autoplay rules (mobile-Safari safe): the video starts muted + playsInline so
// the browser allows autoplay without a gesture; the speaker toggle and the
// "Tap for sound" hint unmute inside a real tap. Under prefers-reduced-motion
// we never autoplay — the poster shows with a centre play button the user opts
// into.

import React, { useEffect, useRef, useState } from "react";
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
  // In reduced-motion mode the user must press play; track that opt-in.
  const [userStarted, setUserStarted] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  // Transient "Link copied" confirmation after the clipboard-fallback share.
  const [copied, setCopied] = useState(false);

  // Reset the reduced-motion opt-in the moment this card stops being active, so
  // re-entry requires a fresh tap. Done during render (the React 19 pattern the
  // shell uses in TitleSheet) rather than inside an effect.
  const [prevActive, setPrevActive] = useState(active);
  if (prevActive !== active) {
    setPrevActive(active);
    if (!active) setUserStarted(false);
  }

  const videoUrl = short.video_url;
  const poster = short.hero_image && posterOk ? short.hero_image : null;

  // Drive play/pause off the active flag. Only the active, mounted, non-paused
  // card plays; reduced-motion gates autoplay behind userStarted. Guard the
  // play() promise — a rapid swipe can flip active before it resolves.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const shouldPlay =
      active && mounted && !paused && (!reducedMotion || userStarted);
    if (shouldPlay) {
      const p = v.play();
      if (p && typeof p.catch === "function") {
        p.catch((e) =>
          console.warn("[reels play blocked]", { id: short.id, e: String(e) }),
        );
      }
    } else {
      v.pause();
      // Reset to the top when it scrolls out of the active slot so re-entry
      // starts the short fresh (matches the feed's loop feel).
      if (!active) {
        try {
          v.currentTime = 0;
        } catch {
          /* not seekable yet — harmless */
        }
      }
    }
  }, [active, mounted, paused, reducedMotion, userStarted, short.id]);

  // Keep the element's muted property in sync with the feed-level toggle.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  // Tap the video surface: toggle play/pause on the active card (TikTok feel).
  // In reduced-motion mode the first tap is the opt-in to start.
  const onSurfaceTap = () => {
    const v = videoRef.current;
    if (!v) return;
    if (reducedMotion && !userStarted) {
      setUserStarted(true);
      return;
    }
    if (v.paused) {
      v.play().catch(() => {});
    } else {
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
          preload={active ? "auto" : "metadata"}
          // object-cover for the full-bleed feed feel — the short is authored
          // 9:16 and its burned-in captions sit centre, so the minor side-crop
          // on a taller-than-9:16 phone never eats the text.
          className="absolute inset-0 h-full w-full object-cover"
          onClick={onSurfaceTap}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
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

      {/* Legibility scrim for the bottom overlay. */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2"
        style={{
          background:
            "linear-gradient(0deg, rgba(0,0,0,.82) 8%, rgba(0,0,0,.35) 45%, rgba(0,0,0,0) 100%)",
        }}
      />

      {/* Reduced-motion / not-yet-started: explicit play affordance. */}
      {((reducedMotion && !userStarted) || (active && !isPlaying && !paused)) && (
        <button
          onClick={onSurfaceTap}
          aria-label="Play"
          className="absolute left-1/2 top-1/2 grid h-[68px] w-[68px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-bg active:scale-95 transition"
          style={{ background: "rgba(245,243,239,.92)", boxShadow: "0 10px 30px rgba(0,0,0,.4)" }}
        >
          <PlayGlyph />
        </button>
      )}

      {/* Top row: brand mark + mute toggle. */}
      <div
        className="absolute inset-x-0 top-0 flex items-center justify-between px-4"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 14px)" }}
      >
        <span className="font-mono text-[10px] uppercase tracking-[.28em] text-ink/90 ink-shadow">
          Reels
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleMute();
            onDismissSoundHint();
          }}
          aria-label={muted ? "Unmute" : "Mute"}
          className="grid h-9 w-9 place-items-center rounded-full text-ink"
          style={{ background: "rgba(0,0,0,.4)" }}
        >
          {muted ? <SpeakerOff size={20} /> : <SpeakerOn size={20} />}
        </button>
      </div>

      {/* "Tap for sound" hint — shows once while muted so the user knows there
          IS audio (the Outsider's flinch complaint). Dismisses on first unmute. */}
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
      <div className="absolute bottom-[128px] right-2.5 flex flex-col items-center gap-5">
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

      {/* Bottom overlay: category, title, synopsis, Read CTA. The right padding
          leaves room for the engagement rail so the title never runs under it. */}
      <div className="absolute inset-x-0 bottom-0 pb-[120px] pl-4 pr-16">
        <div className="flex items-center gap-2 mb-2">
          {short.category && (
            <span
              className="rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-[.16em] text-ink"
              style={{ background: catColor(short.category) }}
            >
              {short.category}
            </span>
          )}
          {short.duration && (
            <span className="rounded px-1.5 py-0.5 font-mono text-[10px] text-ink/85" style={{ background: "rgba(0,0,0,.45)" }}>
              {short.duration}
            </span>
          )}
        </div>
        <h2 className="font-display font-black uppercase tracking-tightest leading-[.95] text-ink ink-shadow" style={{ fontSize: 26 }}>
          {short.title}
        </h2>
        {short.summary && (
          <p className="mt-2 line-clamp-2 font-body text-[13.5px] leading-snug text-ink/85">
            {short.summary}
          </p>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenInfo(short.id, "Read");
          }}
          className="mt-3 inline-flex items-center gap-2 rounded-[10px] bg-ink px-4 py-2.5 font-display text-[13px] font-bold uppercase tracking-tight text-bg active:scale-[.98] transition"
        >
          Read the story
        </button>
      </div>
    </div>
  );
}
