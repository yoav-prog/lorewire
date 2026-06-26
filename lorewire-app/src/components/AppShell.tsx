"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CAT,
  STORIES,
  isPublishedStory,
  PILLS,
  type Story,
} from "@/lib/stories";
import {
  ALL_PILL,
  CATEGORY_RAILS,
  POLL_RAIL_KINDS,
  POLL_RAIL_TITLES,
  filterIdsByNotVoted,
  filterIdsByPillCat,
  filterIdsByPublished,
  pickHeroAtIndex,
  resolveHeroPool,
  resolveRailIds,
  useHomepageCuration,
  useHomepagePolls,
  useStoryPoll,
  type HomepageInitial,
  type MergedCatalog,
} from "@/lib/homepage-rails";
import {
  pickRandomPlayable,
  pushShuffleRecent,
  readShuffleRecents,
} from "@/lib/play-shuffle";
import { useStoryPlayEvents } from "@/lib/use-story-play-events";
import { heroTitleFontSizeMobile, heroTitleBucket } from "@/lib/hero-title-size";
import {
  SLOW_MODE_PLAYBACK_RATE,
  useWirePrefs,
} from "@/components/wires/useWirePrefs";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { PollRailCard } from "@/components/PollRail";
import { PollWidget } from "@/components/PollWidget";
import { renderHeroVerdictBadge } from "@/lib/polls-shared";
import {
  BackToTop,
  InlineJumpToPoll,
  JumpToPoll,
  TopArticleCTA,
} from "@/components/JumpToPoll";
import DesktopShell from "@/components/DesktopShell";
import WiresFeed from "@/components/wires/WiresFeed";
import { StoriesRail } from "@/components/stories/StoriesRail";
import { StoriesViewer } from "@/components/stories/StoriesViewer";
import {
  partitionStoriesPlaylistByViewed,
  resolveStoriesPlaylist,
} from "@/components/stories/stories-playlist";
import { useStoriesUrlState } from "@/components/stories/use-stories-url-state";
import { useViewedWires } from "@/components/stories/use-viewed-wires";
import CookieConsent from "@/components/CookieConsent";
import CrossDeviceNudge from "@/components/CrossDeviceNudge";
import SignInChip from "@/components/SignInChip";
import SiteFooter from "@/components/SiteFooter";
import { CommentsTab } from "@/components/CommentsTab";
import { JumpToComments } from "@/components/JumpToComments";
import { RedditEmbed, resolveRedditEmbedTarget } from "@/components/RedditEmbed";
import { alignScriptToWords } from "@/lib/script-graft";
import {
  placeArticleImages,
  splitArticleParagraphs,
} from "@/lib/article-image-positions";
import {
  getLiveStoryMedia,
  type LiveStoryMediaResult,
} from "@/app/actions";
import { storyShareUrl } from "@/lib/share";
import ShareSheet from "@/components/ShareSheet";
import {
  useContinueReading,
  useRecentlyViewed,
  useSavedStories,
  useStoryRatings,
} from "@/lib/engagement-store";
import RatingStars, { RatingBadge } from "@/components/RatingStars";

// Mirror DesktopShell's NO_LIVE_MEDIA seed: until the live fetch resolves
// (or on miss/error) every subview falls back to the baked story shape.
const NO_LIVE_MEDIA: LiveStoryMediaResult = {
  ok: true,
  slug: null,
  video_url: null,
  images: [],
  body: null,
  audio_url: null,
  alignment: [],
  is_short: false,
  found: false,
};

type OpenFn = (id: string, tab?: string) => void;
type IconProps = { size?: number; fill?: string; stroke?: number };
type IconCmp = (p: IconProps) => React.ReactElement;

/* ----------------------------- ICONS ----------------------------- */
const Ico = ({
  d,
  fill,
  size = 24,
  stroke = 1.7,
}: IconProps & { d: React.ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill || "none"}
    stroke="currentColor"
    strokeWidth={stroke}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {d}
  </svg>
);
const HomeI: IconCmp = (p) => <Ico {...p} d={<><path d="M3 11.5 12 4l9 7.5" /><path d="M5 10v9.5h14V10" /></>} />;
const SearchI: IconCmp = (p) => <Ico {...p} d={<><circle cx="11" cy="11" r="6.2" /><path d="m20 20-3.6-3.6" /></>} />;
const NewI: IconCmp = (p) => <Ico {...p} d={<><circle cx="12" cy="12" r="8.4" /><path d="M12 8v8M8 12h8" /></>} />;
const ListI: IconCmp = (p) => <Ico {...p} d={<path d="M6 4h12v16l-6-4-6 4Z" />} />;
const PlayI = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>
);
const PlusI: IconCmp = (p) => <Ico {...p} d={<path d="M12 5v14M5 12h14" />} />;
const StarI: IconCmp = (p) => <Ico {...p} d={<path d="M12 4.5l2.2 4.6 5 .6-3.7 3.4 1 4.9L12 16.1 7.5 18.5l1-4.9L4.8 10.2l5-.6z" />} />;
const ShareI: IconCmp = (p) => <Ico {...p} d={<><circle cx="6" cy="12" r="2.3" /><circle cx="17" cy="6" r="2.3" /><circle cx="17" cy="18" r="2.3" /><path d="M8 11l7-4M8 13l7 4" /></>} />;
const ChevDown: IconCmp = (p) => <Ico {...p} d={<path d="m6 9 6 6 6-6" />} />;
const ShuffleI: IconCmp = (p) => <Ico {...p} d={<><path d="M4 7h3l9 10h4M4 17h3l3-3.3M16 7h4M14 13.5l2 3.5" /><path d="m18 5 2 2-2 2M18 15l2 2-2 2" /></>} />;
const InfoI: IconCmp = (p) => <Ico {...p} d={<><circle cx="12" cy="12" r="8.4" /><path d="M12 11v5M12 8h.01" /></>} />;
const WiresI: IconCmp = (p) => <Ico {...p} d={<><rect x="3.6" y="3.6" width="16.8" height="16.8" rx="4.5" /><path d="m10 8.4 5 3.6-5 3.6z" /></>} />;

/* ----------------------------- POSTER ART ----------------------------- */
function PosterArt({ story, rounded = true, showTitle = true }: { story: Story; rounded?: boolean; showTitle?: boolean }) {
  // Suppress CSS title when the artwork has it baked in (Wave 2 cinematic
  // thumbnails) — otherwise the typography stacks on top of itself.
  const renderCssTitle = showTitle && !story.heroHasBakedTitle;
  const c = CAT[story.cat];
  // Heroes that 404 fall back to the gradient automatically.
  const [imageOk, setImageOk] = useState(true);
  const showImage = !!story.heroImage && imageOk;
  return (
    <div className="relative w-full h-full overflow-hidden" style={{ borderRadius: rounded ? 12 : 0, background: c }}>
      {showImage && (
        <img
          src={story.heroImage}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => {
            setImageOk(false);
            console.warn("[lorewire poster err]", { storyId: story.id, src: story.heroImage });
          }}
        />
      )}
      <div className="absolute inset-0" style={{ background: showImage ? "linear-gradient(180deg, rgba(0,0,0,0) 35%, rgba(0,0,0,.55) 100%)" : "radial-gradient(130% 100% at 78% 12%, rgba(255,255,255,.16), rgba(0,0,0,.35) 70%)" }}></div>
      {!showImage && <div className="absolute inset-0 grain opacity-40 mix-blend-overlay"></div>}
      {!showImage && (
        <div className="absolute -right-3 -top-4 font-display font-black leading-none select-none" style={{ fontSize: 172, color: "rgba(255,255,255,.10)" }}>{story.glyph}</div>
      )}
      <div className="absolute inset-0 poster-vig"></div>
      <div className="absolute left-2.5 top-2.5">
        <span className="font-mono text-[9px] uppercase tracking-[.18em] px-1.5 py-0.5 rounded" style={{ color: "#fff", background: "rgba(0,0,0,.32)" }}>{story.cat}</span>
      </div>
      {story.dur && (
        <div className="absolute right-2 top-2 font-mono text-[10px] tracking-wide px-1.5 py-0.5 rounded" style={{ background: "rgba(0,0,0,.5)", color: "#F5F3EF" }}>{story.dur}</div>
      )}
      {renderCssTitle && (
        <div className="absolute left-3 right-3 bottom-3">
          <h3 className="font-display font-extrabold uppercase tracking-tightest leading-[.92] ink-shadow" style={{ fontSize: story.title.length > 16 ? 19 : 22, color: "#F5F3EF" }}>{story.title}</h3>
        </div>
      )}
    </div>
  );
}

const RailHead = ({ children }: { children: React.ReactNode }) => (
  <h2 className="font-display font-bold uppercase tracking-tightest text-[15px] text-ink px-4 mb-2.5">{children}</h2>
);

/* ----------------------------- BILLBOARD ----------------------------- */
// 7-second auto-advance cadence; matches the desktop Hero. The
// progress-fill animation on the active dot is keyed off this same
// constant via inline animationDuration so the visual and the timer
// stay in lockstep.
const BILLBOARD_ROTATION_INTERVAL_MS = 7000;
// Below this gesture distance the touchend is treated as a tap, not a
// swipe. Tuned for finger-on-glass — small enough that a deliberate
// swipe always trips, big enough that an accidental drift on a Play
// tap doesn't.
const BILLBOARD_SWIPE_THRESHOLD_PX = 50;

// Length-aware <h1> for the mobile billboard title. Mirrors the
// desktop Hero's HeroTitleH1 (DesktopShell.tsx) so a too-long title
// shrinks instead of dominating the billboard
// (plan: _plans/2026-06-25-title-length-gate.md, Layer 2).
function MobileHeroTitleH1({ title, storyId }: { title: string; storyId: string }) {
  const fontSize = heroTitleFontSizeMobile(title);
  if (fontSize < 46) {
    // eslint-disable-next-line no-console -- rule 14: namespaced observability
    console.info("[hero title size]", {
      surface: "mobile",
      storyId,
      chars: title.length,
      words: title.trim().split(/\s+/).length,
      bucket: heroTitleBucket(title),
      fontSize,
    });
  }
  return (
    <h1
      className="font-display font-black uppercase tracking-tightest leading-[.9] text-ink ink-shadow"
      style={{ fontSize }}
    >
      {title}
    </h1>
  );
}

function Billboard({
  pool,
  onOpen,
  onShuffle,
  onActiveChange,
  session,
  pollQuestions,
  pollVerdicts,
}: {
  pool: Story[];
  onOpen: OpenFn;
  onShuffle: () => void;
  /** Fires when the visible slide changes. The outer shell tracks the
   *  value via a ref so the carousel's 7s tick doesn't re-render
   *  AppShell, and so "Play Something" excludes the slide actually on
   *  screen. */
  onActiveChange?: (heroId: string) => void;
  session: HomepageInitial["session"];
  /** 2026-06-26 slice D of _plans/2026-06-26-homepage-redesign-v1.md:
   *  poll question keyed by story id. Renders above the title as a
   *  handwritten "the audience is asking" hint when present. Missing
   *  entries (story without a poll, or with a disabled poll) skip the
   *  overlay entirely — the slide reads as a normal hero, no broken
   *  empty row. */
  pollQuestions: HomepageInitial["heroPollQuestions"];
  /** 2026-06-26 slice H of _plans/2026-06-26-homepage-redesign-v1.md:
   *  audience-verdict badge keyed by story id. Replaces the legacy
   *  "% Match" position in the meta row with a LoreWire signal
   *  ("73% chose the bride" or "Audience is divided"). Missing
   *  entries (poll below the public floor, or no poll) skip the
   *  badge — the meta row falls through to year + dur + tags only. */
  pollVerdicts: HomepageInitial["heroVerdicts"];
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [touching, setTouching] = useState(false);
  const [tabHidden, setTabHidden] = useState(false);
  const [heroOk, setHeroOk] = useState(true);
  const reducedMotion = usePrefersReducedMotion();
  // Touch state: keep the start point so we can classify the gesture on
  // touchend (horizontal swipe vs vertical scroll vs tap).
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  // Reset the per-slide image-ok flag so a previous failure doesn't
  // permanently strip artwork from later slides.
  useEffect(() => {
    setHeroOk(true);
  }, [activeIndex]);

  // Pause auto-advance when the tab is hidden so we don't burn the
  // rotation on a backgrounded page.
  useEffect(() => {
    const onVis = () => setTabHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Auto-advance. Paused on touch (so a user examining a slide isn't
  // yanked away mid-look), when the tab is hidden, when the OS reports
  // reduced-motion, or when there's only one slide.
  const isPaused = touching || tabHidden || reducedMotion || pool.length < 2;
  useEffect(() => {
    if (isPaused) return;
    const id = window.setInterval(() => {
      setActiveIndex((i) => (i + 1) % pool.length);
    }, BILLBOARD_ROTATION_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [isPaused, pool.length]);

  // Expose the active id to the parent so the shuffle exclusion tracks
  // the visible slide, not pool[0].
  useEffect(() => {
    const active = pool[Math.min(activeIndex, pool.length - 1)];
    if (active) onActiveChange?.(active.id);
  }, [activeIndex, pool, onActiveChange]);

  // Preload BOTH neighbors so swipes feel instant in either direction.
  useEffect(() => {
    if (pool.length < 2 || typeof window === "undefined") return;
    for (const offset of [-1, 1]) {
      const neighbor = pool[(activeIndex + offset + pool.length) % pool.length];
      const src = neighbor.heroImage;
      if (!src) continue;
      const img = new window.Image();
      img.src = src;
    }
  }, [activeIndex, pool]);

  const story = pool[Math.min(activeIndex, pool.length - 1)];
  if (!story) return null;
  const c = CAT[story.cat];
  const heroSrc = story.heroImage;
  const showHero = !!heroSrc && heroOk;
  const hasRotation = pool.length > 1;

  // Touch handlers. Only on the swipe-zone div (the upper hero artwork
  // area), NOT on the action buttons — wrapping the whole hero would
  // make a deliberate Play tap occasionally register as a swipe and
  // navigate the user away from their pick.
  const onTouchStart = (e: React.TouchEvent) => {
    if (!hasRotation) return;
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
    setTouching(true);
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!hasRotation) {
      setTouching(false);
      return;
    }
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) {
      setTouching(false);
      return;
    }
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    // Vertical-dominant gesture is a page-scroll attempt, not a swipe.
    if (Math.abs(dy) > Math.abs(dx)) {
      setTouching(false);
      return;
    }
    if (Math.abs(dx) >= BILLBOARD_SWIPE_THRESHOLD_PX) {
      const dir = dx < 0 ? 1 : -1;
      setActiveIndex((i) => (i + dir + pool.length) % pool.length);
    }
    // Brief resume delay so a user who swipes once doesn't get
    // auto-advanced again immediately — feels less aggressive.
    setTimeout(() => setTouching(false), 800);
  };

  return (
    <section
      className="relative h-[500px] w-full overflow-hidden"
      aria-roledescription={hasRotation ? "carousel" : undefined}
      aria-label={hasRotation ? "Featured stories" : undefined}
    >
      <div className="absolute left-5 z-30 flex items-center gap-2" style={{ top: "calc(env(safe-area-inset-top, 0px) + 14px)" }}>
        <span className="relative grid place-items-center bg-ink text-bg font-display font-black rounded-[7px]" style={{ width: 26, height: 26, fontSize: 11, letterSpacing: "-.04em" }}>
          LW
          <span className="absolute rounded-full bg-accent" style={{ top: 3, right: 4, width: 4, height: 4 }}></span>
        </span>
        <span className="font-display font-black tracking-tight text-ink ink-shadow" style={{ fontSize: 18 }}>LoreWire</span>
      </div>
      <div className="absolute right-4 z-30" style={{ top: "calc(env(safe-area-inset-top, 0px) + 10px)" }}>
        <SignInChip session={session} tone="overlay" />
      </div>

      {/* Slide content — keyed so each transition fades the new slide in
          via the existing fade-in keyframe. The touch handlers live on
          the OUTER wrapper (the artwork half) so a deliberate Play tap
          on the action row below can't accidentally trip a swipe. */}
      <div
        key={story.id}
        className="absolute inset-0 fade-in"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className="absolute inset-0 drift" style={{ background: c }}>
          {showHero && (
            <img
              src={heroSrc}
              alt=""
              className="absolute inset-0 w-full h-full object-cover select-none pointer-events-none"
              draggable={false}
              onError={() => {
                setHeroOk(false);
                console.warn("[lorewire billboard err]", { storyId: story.id, src: heroSrc });
              }}
            />
          )}
          <div className="absolute inset-0" style={{ background: showHero ? "linear-gradient(180deg, rgba(0,0,0,.15) 0%, rgba(0,0,0,.45) 70%, rgba(10,10,12,.85) 100%)" : "radial-gradient(120% 90% at 70% 20%, rgba(255,255,255,.18), rgba(0,0,0,.45) 72%)" }}></div>
          {!showHero && <div className="absolute inset-0 grain opacity-40 mix-blend-overlay"></div>}
          {!showHero && <div className="absolute -right-6 top-6 font-display font-black leading-none select-none" style={{ fontSize: 320, color: "rgba(255,255,255,.09)" }}>{story.glyph}</div>}
        </div>
        <div className="absolute inset-x-0 bottom-0 h-2/3" style={{ background: "linear-gradient(0deg,#0A0A0C 6%, rgba(10,10,12,.55) 45%, rgba(10,10,12,0) 100%)" }}></div>
      </div>

      {/* Action row sits ABOVE the touch layer (relative z-20 vs the
          fade-in's absolute inset). Buttons stay tappable, swipe stays
          contained to the artwork half — no gesture conflict. */}
      <div className="absolute left-0 right-0 bottom-5 px-5 z-20" aria-live="polite">
        <div className="flex items-center gap-2 mb-2.5">
          <span className="w-[3px] h-3.5 bg-accent rounded-full"></span>
          <span className="font-mono text-[10px] uppercase tracking-[.34em] text-ink/90">LW Original</span>
        </div>
        {/* 2026-06-26 slice H of _plans/2026-06-26-homepage-redesign-v1.md:
            the QUESTION is now the LEAD element of the hero (was a small
            kicker in slice D). Netflix leads with the title because the
            title IS the product; LoreWire leads with the question because
            the question IS the product. Handwriting font (Caveat) keeps
            the "audience is asking" attribution from slice D. Story
            without an enabled poll skips this whole block — title-only
            hero is the graceful fallback. */}
        {pollQuestions[story.id] && (
          <p
            className="leading-tight text-ink mb-1 select-none"
            style={{
              fontFamily: "var(--font-caveat)",
              fontSize: 42,
              textShadow: "0 1px 14px rgba(0,0,0,.55)",
            }}
          >
            {pollQuestions[story.id]}
          </p>
        )}
        {/* Title: secondary now (was the huge H1). The show name still
            grounds the slide but doesn't compete with the question.
            Bumped 24 -> 30 after the first preview review -- 24
            read as too small on mobile. */}
        <h2 className="font-display font-extrabold uppercase tracking-tightest leading-[1] text-ink ink-shadow" style={{ fontSize: 30 }}>
          {story.title}
        </h2>
        {/* Verdict + meta row. The verdict badge replaces the legacy
            "90% Match" position (Netflix's exact match-score copy);
            absent when the poll is below the public floor. Year + dur
            + tags follow as the supporting metadata. */}
        <div className="flex items-center gap-1.5 mt-2 flex-wrap text-[12.5px]">
          {pollVerdicts[story.id] && (
            <>
              <span className="font-semibold text-accent">
                {renderHeroVerdictBadge(pollVerdicts[story.id])}
              </span>
              <span className="w-1 h-1 rounded-full bg-muted/70"></span>
            </>
          )}
          <span className="font-body text-ink/85">{story.year}</span>
          {story.dur && (
            <>
              <span className="w-1 h-1 rounded-full bg-muted/70"></span>
              <span className="font-mono text-[12px] text-ink/85">{story.dur}</span>
            </>
          )}
          {story.tags.map((t) => (
            <React.Fragment key={t}>
              <span className="w-1 h-1 rounded-full bg-muted/70"></span>
              <span className="font-body text-ink/85">{t}</span>
            </React.Fragment>
          ))}
        </div>
        {/* Button vocabulary swap (slice H): the trio used to be "PLAY /
            More Info / Play Something" -- literally Netflix's hero
            button language. Now it names what those actions actually
            DO on LoreWire: watch + cast a verdict, read the long-form
            article, or shuffle for a random one. */}
        <div className="flex items-center gap-2.5 mt-4">
          <button onClick={() => onOpen(story.id, "Watch")} className="flex-1 flex items-center justify-center gap-2 bg-ink text-bg font-display font-bold uppercase tracking-tight text-[15px] rounded-[10px] py-3 active:scale-[.98] transition">
            <PlayI /> Watch &amp; Vote
          </button>
          <button onClick={() => onOpen(story.id, "Read")} className="flex items-center justify-center gap-2 px-4 py-3 rounded-[10px] font-body font-semibold text-[14px] text-ink" style={{ background: "rgba(255,255,255,.13)" }}>
            <InfoI size={18} /> Read the article
          </button>
        </div>
        <button onClick={onShuffle} className="mt-3 w-full flex items-center justify-center gap-2 py-2.5 rounded-[10px] border border-line font-mono text-[11px] uppercase tracking-[.2em] text-ink/80 active:scale-[.98] transition">
          <ShuffleI size={15} /> Surprise me
        </button>

        {/* Progress dots — Apple TV+ style. Inactive dots are 6px circles;
            the active one widens to a 24px pill with a left-to-right
            fill animation that runs the full rotation interval. The
            fill restarts via React key on slide change, and pauses
            (no animation at all) when the user is touching, the tab
            is hidden, or reduced-motion is on. */}
        {hasRotation && (
          <div className="mt-4 flex items-center justify-center gap-1.5" role="tablist" aria-label="Featured stories">
            {pool.map((s, i) => {
              const active = i === activeIndex;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveIndex(i)}
                  role="tab"
                  aria-selected={active}
                  aria-label={`Show featured story ${i + 1} of ${pool.length}`}
                  // Generous tap target (32px) with a 6px visual dot for
                  // inactives / 24px pill for active. The transparent
                  // padding doubles as the touch zone so a thumb tap
                  // doesn't have to land precisely on the pixels.
                  className="relative grid place-items-center"
                  style={{ width: active ? 32 : 16, height: 16 }}
                >
                  <span
                    className="relative block rounded-full overflow-hidden transition-[width] duration-200"
                    style={{
                      width: active ? 24 : 6,
                      height: 6,
                      background: active ? "rgba(255,255,255,.32)" : "rgba(255,255,255,.42)",
                    }}
                  >
                    {active && (
                      <span
                        // Key by activeIndex so React remounts the fill
                        // on every slide change — the CSS animation
                        // restarts from 0% cleanly.
                        key={`fill-${activeIndex}`}
                        className="absolute inset-y-0 left-0 bg-white"
                        style={{
                          width: isPaused ? "0%" : "100%",
                          animation: isPaused
                            ? "none"
                            : `heroProgress ${BILLBOARD_ROTATION_INTERVAL_MS}ms linear forwards`,
                        }}
                      />
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

/* ----------------------------- POSTER CARD (rail) ----------------------------- */
function PosterCard({ story, onOpen, w = 132, h = 192, progress, voteCount }: { story: Story; onOpen: OpenFn; w?: number | string; h?: number; progress?: number; voteCount?: number }) {
  const { getRating } = useStoryRatings();
  return (
    <button onClick={() => onOpen(story.id)} className="relative shrink-0 active:scale-[.97] transition" style={{ width: w }}>
      <div style={{ height: h }}><PosterArt story={story} /></div>
      <RatingBadge value={getRating(story.id) ?? 0} className="absolute right-2 z-10" style={{ top: 28 }} />
      {/* 2026-06-26 slice H of _plans/2026-06-26-homepage-redesign-v1.md:
          vote-count chip in the bottom-left corner of the poster. The
          parent rail passes voteCount from initial.posterVoteCounts;
          values are pre-floored on the server (>= DEFAULT_PUBLIC_FLOOR
          only). Renders nothing when absent — graceful degradation. */}
      {voteCount != null && voteCount > 0 && (
        <div
          className="absolute left-2 z-10 font-mono uppercase tracking-wider rounded bg-black/65 text-white/95 backdrop-blur-sm"
          style={{ bottom: 8, fontSize: 9, padding: "2px 6px" }}
        >
          {formatVoteCount(voteCount)}
        </div>
      )}
      {progress != null && (
        <div className="absolute left-1.5 right-1.5 bottom-1.5 h-[3px] rounded-full" style={{ background: "rgba(255,255,255,.25)" }}>
          <div className="h-full rounded-full bg-accent" style={{ width: `${progress}%` }}></div>
        </div>
      )}
    </button>
  );
}

/** Render a vote count as a compact chip string. < 1k stays raw
 *  ("234 votes"); >= 1k drops the trailing ".0" so 1000 reads as
 *  "1k votes" rather than "1.0k votes" but 1234 reads as "1.2k
 *  votes". Plural for any value — there's no story with < 20 votes
 *  reaching this code path (the server filters under the floor). */
function formatVoteCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    const formatted = k % 1 === 0 ? k.toFixed(0) : k.toFixed(1);
    return `${formatted}k votes`;
  }
  return `${n} votes`;
}

/* ----------------------------- HOME ----------------------------- */
function Home({
  onOpen,
  onShuffle,
  onHeroActiveChange,
  pill,
  setPill,
  curation,
  behavior,
  catalog,
  resolveStory,
  pollsInitial,
  session,
  storiesPlaylist,
  viewedWireIds,
  onOpenWire,
  votedStoryIds,
  heroDivisiveIds,
  heroPollQuestions,
  rotatingCategoryToday,
  coldStartFloor,
  heroVerdicts,
  posterVoteCounts,
}: {
  onOpen: OpenFn;
  onShuffle: () => void;
  onHeroActiveChange?: (heroId: string) => void;
  pill: string;
  setPill: (p: string) => void;
  curation: ReturnType<typeof useHomepageCuration>["curation"];
  behavior: ReturnType<typeof useHomepageCuration>["behavior"];
  catalog: ReturnType<typeof useHomepageCuration>["catalog"];
  resolveStory: ReturnType<typeof useHomepageCuration>["resolveStory"];
  pollsInitial: HomepageInitial["pollRails"];
  session: HomepageInitial["session"];
  /** IG-style rail playlist — already resolved + capped at the shell
   *  level so a tab switch back to Home doesn't recompute. */
  storiesPlaylist: Story[];
  /** Story ids the user has consumed in the Stories viewer; drives
   *  the rail's unseen-ring + hide-when-all-seen logic. */
  viewedWireIds: string[];
  /** Open the Stories viewer at a wire (pushes `?wire=<id>`). */
  onOpenWire: (wireId: string) => void;
  /** 2026-06-26 slice C of _plans/2026-06-26-homepage-redesign-v1.md:
   *  story ids the viewer's cookie has voted on. Subtracted from the
   *  Continue Watching list so the rail surfaces only watched stories
   *  the viewer hasn't cast a verdict on yet — the "You Didn't Vote
   *  Yet" reframe. Empty array for anonymous viewers (filter no-ops).
   *  Threaded through from `initial.votedStoryIds` via MobileShell. */
  votedStoryIds: HomepageInitial["votedStoryIds"];
  /** 2026-06-26 slice D: top story ids by current divisiveness.
   *  Threaded into resolveHeroPool as the auto-fill source so an
   *  uncurated hero leads with the most-debated stories. */
  heroDivisiveIds: HomepageInitial["heroDivisiveIds"];
  /** 2026-06-26 slice D: poll question keyed by story id. Used by
   *  the hero overlay to render the question hint above the title;
   *  only the question is surfaced, never the option labels. */
  heroPollQuestions: HomepageInitial["heroPollQuestions"];
  /** 2026-06-26 slice E: which category surface fills the rotating
   *  homepage slot today (or null when the kill switch is off and
   *  the legacy all-category-rails render path takes over). */
  rotatingCategoryToday: HomepageInitial["rotatingCategoryToday"];
  /** 2026-06-26 slice F: minimum published cards a floor-eligible
   *  rail must have before rendering. 0 disables the floor (legacy
   *  `> 0` gate). Floor applies to: new_row, category rails, and the
   *  divisive/agreed poll rails. Skipped for: continue (personalized),
   *  top10 (numbered visual handles thin counts), unpopular
   *  (personalized + already gated by minority threshold). */
  coldStartFloor: HomepageInitial["coldStartFloor"];
  /** 2026-06-26 slice H: audience-verdict badges keyed by story id
   *  (used by the hero overlay) + poster vote counts (rail PosterCard
   *  chip). Both maps are pre-floored — entries are present only when
   *  total_votes >= DEFAULT_PUBLIC_FLOOR. */
  heroVerdicts: HomepageInitial["heroVerdicts"];
  posterVoteCounts: HomepageInitial["posterVoteCounts"];
}) {
  // Curation + live catalog are hoisted to MobileShell so MyList / TitleSheet
  // can share resolveStory (saved real shorts aren't in the baked STORIES
  // catalog). One hook call drives both the rails and every component that
  // resolves an id to a card.
  // Phase 4.5 of _plans/2026-06-17-engagement-polls.md. Same hook
  // DesktopShell uses; the rail visual stays identical between shells
  // because PollRailCard owns its own layout. Seeded from SSR (see
  // _plans/2026-06-18-homepage-no-flash-ssr.md) so the rails paint on
  // first byte instead of popping in after the client fetch.
  const { rails: pollRails } = useHomepagePolls(pollsInitial);
  // 2026-06-19 Phase 2: per-user Continue Watching state from
  // engagement-store. When the browser has in-progress entries, they
  // beat the admin's "first-4-from-catalog" fallback (and lose to a
  // hand-curated continue list — admin override stays authoritative).
  const continueState = useContinueReading();
  // Hero rotation pool (capacity 8). Billboard handles the carousel
  // mechanics; the shell uses heroPool.length for its [home render]
  // log and onHeroActiveChange to keep the shuffle exclusion tracking
  // the visible slide. heroDivisiveIds (slice D of
  // _plans/2026-06-26-homepage-redesign-v1.md) becomes the auto-fill
  // source so the carousel leads with the most-debated stories, not
  // just the most recent.
  const heroPool = resolveHeroPool(
    curation,
    behavior,
    catalog,
    resolveStory,
    heroDivisiveIds,
  );
  const featured = pickHeroAtIndex(heroPool, 0);

  const continueIdsAll = resolveRailIds("continue", curation, behavior, catalog, {
    continue: continueState.ids,
  });
  const top10IdsAll = resolveRailIds("top10", curation, behavior, catalog);
  const newRowIdsAll = resolveRailIds("new_row", curation, behavior, catalog);

  // 2026-06-26 slice C of _plans/2026-06-26-homepage-redesign-v1.md.
  // Build the voted-story-id Set once per render so each filter pass
  // does O(1) lookups instead of rebuilding the Set per call.
  const votedSet = useMemo(
    () => new Set(votedStoryIds),
    [votedStoryIds],
  );

  // 2026-06-21 pill filter (_plans/2026-06-21-category-classifier-and-pills.md).
  // When the user picks a category chip the rails narrow in place: each rail
  // keeps only stories whose `cat` matches the active pill. Empty rails hide
  // via the existing `length > 0` guards below. Hero/Billboard is curation-
  // driven and stays put — pulling the hero out from under the user on a tag
  // pick is jarring (Netflix doesn't do it either).
  // After the pill filter, drop ids whose story has no produced content
  // so a curated rail can't surface a placeholder card.
  // For the continue rail specifically, ALSO drop ids the viewer has
  // already voted on — that turns the raw watched list into the
  // "You Didn't Vote Yet" surface (slice C). Anonymous viewers and
  // viewers with no vote history get an empty Set, which makes the
  // filter a no-op (rail behaves exactly like the old Continue
  // Watching).
  const continueIds = filterIdsByPublished(
    filterIdsByNotVoted(
      filterIdsByPillCat(continueIdsAll, pill, resolveStory),
      votedSet,
    ),
    resolveStory,
  );
  const top10Ids = filterIdsByPublished(
    filterIdsByPillCat(top10IdsAll, pill, resolveStory),
    resolveStory,
  );
  const newRowIds = filterIdsByPublished(
    filterIdsByPillCat(newRowIdsAll, pill, resolveStory),
    resolveStory,
  );

  // eslint-disable-next-line no-console -- rule 14
  console.info("[home render]", {
    shell: "mobile",
    total_catalog: catalog.array.length,
    pill,
    hero_pool: heroPool.length,
    continue: continueIds.length,
    top10: top10Ids.length,
    new_row: newRowIds.length,
  });

  const railClass = "flex gap-3 px-4 overflow-x-auto noscroll pb-1";
  return (
    <div className="pb-28">
      {/* IG-style Stories rail sits above the Billboard so freshness is
          the very first thing on the homepage. Hides entirely when
          every wire in the playlist is already viewed. */}
      <StoriesRail
        playlist={storiesPlaylist}
        viewedIds={viewedWireIds}
        onOpen={onOpenWire}
      />
      {heroPool.length > 0 && (
        <Billboard
          pool={heroPool}
          onOpen={onOpen}
          onShuffle={onShuffle}
          onActiveChange={onHeroActiveChange}
          session={session}
          pollQuestions={heroPollQuestions}
          pollVerdicts={heroVerdicts}
        />
      )}

      <div className="flex gap-2 px-4 py-4 overflow-x-auto noscroll">
        {PILLS.map((p) => (
          <button key={p} onClick={() => setPill(p)} className="shrink-0 px-3.5 py-1.5 rounded-full font-body font-semibold text-[13px] transition"
            style={pill === p ? { background: "#F5F3EF", color: "#0A0A0C" } : { background: "rgba(255,255,255,.07)", color: "#C9C6CE", border: "1px solid rgba(255,255,255,.085)" }}>
            {p}
          </button>
        ))}
      </div>

      {continueIds && continueIds.length > 0 && (
        <section className="mt-1">
          <RailHead>You Didn&apos;t Vote Yet</RailHead>
          <div className={railClass}>
            {continueIds.map((id) => {
              const s = resolveStory(id);
              if (!s) return null;
              return <PosterCard key={id} story={s} onOpen={onOpen} w={150} h={96} />;
            })}
          </div>
        </section>
      )}

      {top10Ids && top10Ids.length > 0 && (
        <section className="mt-7">
          <RailHead>Top 10 Today</RailHead>
          <div className="flex gap-1 px-4 overflow-x-auto noscroll pb-1">
            {top10Ids.slice(0, 10).map((id, i) => {
              const s = resolveStory(id);
              if (!s) return null;
              return (
                <button key={id} onClick={() => onOpen(id)} className="relative shrink-0 flex items-end active:scale-[.97] transition" style={{ minWidth: 170 }}>
                  <span className="font-display font-black leading-[.7] select-none shrink-0 -mr-1" style={{ fontSize: 120, color: "transparent", WebkitTextStroke: "2px rgba(255,255,255,.32)" }}>{i + 1}</span>
                  <div className="shrink-0 w-[112px] h-[166px] -ml-2"><PosterArt story={s} /></div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* 2026-06-26 slice E of _plans/2026-06-26-homepage-redesign-v1.md:
          when rotation is on (rotatingCategoryToday set), the homepage
          shows ONE category rail per day instead of all six. When the
          kill switch is off (rotatingCategoryToday === null), every
          category rail renders — the pre-redesign behaviour. The pill
          filter still narrows when a specific category chip is active. */}
      {(rotatingCategoryToday
        ? CATEGORY_RAILS.filter((r) => r.surface === rotatingCategoryToday)
        : CATEGORY_RAILS
      ).map((rail) => {
        // Pill filter: when a category is active, only show that one
        // category rail — the rest would just be empty or distracting.
        if (pill !== ALL_PILL && rail.cat !== pill) return null;
        const ids = resolveRailIds(rail.surface, curation, behavior, catalog);
        if (!ids) return null;
        // Skip rails that resolve to no displayable stories at all (no
        // curation + no fallback hits, or only sample placeholders).
        const items = ids
          .map((id) => resolveStory(id))
          .filter((s): s is Story => s !== null && isPublishedStory(s));
        // 2026-06-26 slice F of _plans/2026-06-26-homepage-redesign-v1.md:
        // hide category rails below the cold-start floor so a
        // half-built rail (1-3 posters) doesn't read as broken. Admin
        // can set the floor to 0 to disable (legacy `> 0` gate).
        if (items.length < Math.max(1, coldStartFloor)) return null;
        return (
          <section key={rail.surface} className="mt-7">
            <RailHead>{rail.title}</RailHead>
            <div className={railClass}>
              {items.map((s) => (
                <PosterCard key={s.id} story={s} onOpen={onOpen} voteCount={posterVoteCounts[s.id]} />
              ))}
            </div>
          </section>
        );
      })}

      {POLL_RAIL_KINDS.map((kind) => {
        // Pill filter for poll rails: keep only cards whose story category
        // matches. A null category means we don't know the link, so the
        // card hides under any non-All pill (consistent with "filter in
        // place — show only what we can prove is in this category").
        const cards =
          pill === ALL_PILL
            ? pollRails[kind]
            : pollRails[kind].filter((row) => row.category === pill);
        // 2026-06-26 slice F of _plans/2026-06-26-homepage-redesign-v1.md:
        // divisive + agreed are floor-eligible; unpopular is the
        // personalized "You Voted With the Minority" rail, already
        // gated by the slice-A vote-count threshold, so it surfaces
        // at any size for the viewers who qualify.
        const railFloor = kind === "unpopular" ? 1 : Math.max(1, coldStartFloor);
        if (cards.length < railFloor) return null;
        return (
          <section key={`poll-${kind}`} className="mt-7">
            <RailHead>{POLL_RAIL_TITLES[kind]}</RailHead>
            <div className={railClass}>
              {cards.map((row) => (
                <PollRailCard key={row.storyId} row={row} kind={kind} />
              ))}
            </div>
          </section>
        );
      })}

      {/* 2026-06-26 slice F of _plans/2026-06-26-homepage-redesign-v1.md:
          "New on LoreWire" is floor-eligible — a 1-poster New row would
          undercut the rail's promise of "fresh content." `Math.max(1, ...)`
          keeps the legacy `> 0` semantic when admin disables the floor. */}
      {newRowIds && newRowIds.length >= Math.max(1, coldStartFloor) && (
        <section className="mt-7">
          <RailHead>New on LoreWire</RailHead>
          <div className={railClass}>
            {newRowIds.map((id) => {
              const s = resolveStory(id);
              if (!s) return null;
              return <PosterCard key={id} story={s} onOpen={onOpen} voteCount={posterVoteCounts[id]} />;
            })}
          </div>
        </section>
      )}

      {pill !== ALL_PILL &&
        continueIds.length === 0 &&
        top10Ids.length === 0 &&
        newRowIds.length === 0 &&
        (() => {
          // The matching category rail might still have content even when
          // Continue/Top10/New are all empty after filtering, so only show
          // the empty state when even the category rail is empty.
          const matching = CATEGORY_RAILS.find((r) => r.cat === pill);
          if (!matching) return null;
          const ids =
            resolveRailIds(matching.surface, curation, behavior, catalog) ?? [];
          const items = ids
            .map((id) => resolveStory(id))
            .filter((s): s is Story => s !== null && isPublishedStory(s));
          if (items.length > 0) return null;
          return (
            <p className="font-body text-muted mt-10 mb-6 px-4 text-center text-[13px]">
              Nothing tagged{" "}
              <span className="text-ink font-semibold">{pill}</span> yet. Tap{" "}
              <span className="text-ink font-semibold">All</span> to see
              everything.
            </p>
          );
        })()}

      <SiteFooter />
    </div>
  );
}

/* ----------------------------- WATCH (real video or doodle frame) ----------------------------- */
function WatchDoodle({
  story,
  liveMedia,
  pendingPlay,
  onPlayConsumed,
}: {
  story: Story;
  liveMedia: LiveStoryMediaResult;
  pendingPlay: boolean;
  onPlayConsumed: () => void;
}) {
  // Real generated video gets a native player with the hero as poster; the
  // hand-drawn doodle stays as the fallback so older stories without media
  // keep their illustrated look. Prefer the live URL so a freshly re-rendered
  // short shows up here instead of the stale baked `story.videoUrl`.
  const videoUrl = liveMedia.video_url ?? story.videoUrl;
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Phase 1 of _plans/2026-06-25-top10-ranking.md: emit play_started +
  // play_completed once each per story view (hook dedupes and applies
  // the 90% completion threshold).
  const playEvents = useStoryPlayEvents(story.id);

  // PLAY buttons in the title sheet ship a pending-play signal down here;
  // without this they'd just call setTab("Watch") (already the default) and
  // the user would see nothing happen, because the player sits below the
  // synopsis + tab strip and is off-screen on first open.
  useEffect(() => {
    if (!pendingPlay) return;
    const v = videoRef.current;
    if (v) {
      v.scrollIntoView({ behavior: "smooth", block: "center" });
      const p = v.play();
      if (p && typeof p.then === "function") {
        p.catch((e) => console.warn("[lorewire title-sheet play err]", { storyId: story.id, e: String(e) }));
      }
    } else {
      sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    onPlayConsumed();
  }, [pendingPlay, onPlayConsumed, story.id]);

  // Mirror the global Slow mode pref onto the WATCH-tab <video>. Same effect
  // shape as WireCard / StoriesViewer so all three video surfaces honor one
  // toggle. preservesPitch keeps voices intelligible at 0.75x.
  // Plan: _plans/2026-06-25-slow-mode-playback.md (Layer 2 follow-up — this
  // surface was missed in the original PR #105 scope).
  const { slow, toggleSlow } = useWirePrefs();
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const rate = slow ? SLOW_MODE_PLAYBACK_RATE : 1;
    const vWithPitch = v as HTMLVideoElement & {
      preservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    vWithPitch.preservesPitch = true;
    vWithPitch.webkitPreservesPitch = true;
    v.playbackRate = rate;
    console.info("[detail watch playback rate]", { storyId: story.id, rate, slow });
  }, [slow, story.id, videoUrl]);

  if (videoUrl) {
    return (
      <div ref={sectionRef} className="px-4 pt-4 pb-2">
        <div className="relative rounded-[14px] overflow-hidden mx-auto bg-black" style={{ height: 430, width: "100%" }}>
          <video
            ref={videoRef}
            src={videoUrl}
            poster={story.heroImage}
            controls
            preload="metadata"
            playsInline
            className="absolute inset-0 w-full h-full object-contain"
            onPlay={playEvents.onPlay}
            onTimeUpdate={playEvents.onTimeUpdate}
            onError={() => console.warn("[lorewire video err]", { storyId: story.id, src: videoUrl })}
          />
          {/* Slow-mode pill — top-right of the video frame, matching the
              WireCard chrome cluster. Native HTML5 controls live at the
              bottom of the video so this pill never collides with them. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleSlow();
            }}
            aria-label={slow ? "Slow mode on; switch to normal speed" : "Turn slow mode on"}
            aria-pressed={slow}
            title={slow ? "Slow mode (0.75×)" : "Slow mode off"}
            className="absolute right-2 top-2 z-10 grid h-9 w-9 place-items-center rounded-full font-mono text-[10px] font-semibold tabular-nums text-ink"
            style={{ background: "rgba(0,0,0,.55)", opacity: slow ? 1 : 0.7 }}
          >
            {slow ? ".75×" : "1×"}
          </button>
        </div>
        <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted text-center mt-3">LoreWire Original &middot; doodle short</p>
      </div>
    );
  }
  return (
    <div ref={sectionRef} className="px-4 pt-4 pb-2">
      <div className="relative rounded-[14px] overflow-hidden mx-auto" style={{ background: "#FBFAF4", height: 430, width: "100%" }}>
        <div className="absolute inset-0" style={{ background: "repeating-linear-gradient(0deg, rgba(26,23,20,.035) 0 1px, transparent 1px 26px)" }}></div>

        <div className="absolute top-3 left-0 right-0 text-center font-hand font-bold text-doodle" style={{ fontSize: 26 }}>
          so about that office gift fund&hellip;
        </div>

        <div className="absolute left-1/2 top-[120px] -translate-x-1/2 floaty">
          <svg width="190" height="128" viewBox="0 0 190 128">
            <rect x="4" y="4" width="182" height="120" rx="6" fill="#fff" stroke="#1A1714" strokeWidth="4" />
            <polyline points="6,8 95,64 184,8" fill="none" stroke="#1A1714" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center pt-5">
            <span className="font-hand font-bold" style={{ fontSize: 54, color: "#E8462B", transform: "rotate(-4deg)" }}>$800</span>
          </div>
        </div>

        <div className="absolute right-5 bottom-7" style={{ transform: "rotate(7deg)" }}>
          <div className="relative bg-white p-2 pb-6 shadow-[0_8px_22px_rgba(26,23,20,.25)]" style={{ width: 118 }}>
            <div className="w-full h-[78px] grain" style={{ backgroundColor: "#d9d4c6" }}></div>
            <div className="absolute left-0 right-0 bottom-1 text-center font-hand font-bold text-doodle" style={{ fontSize: 18 }}>the breakroom</div>
          </div>
        </div>

        <div className="absolute left-5 bottom-10" style={{ transform: "rotate(-3deg)" }}>
          <span className="font-hand font-bold px-1.5" style={{ fontSize: 24, color: "#1A1714", background: "#FFD84D", boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" }}>
            she never paid it back
          </span>
        </div>

        <svg className="absolute left-[60px] bottom-[150px]" width="60" height="46" viewBox="0 0 60 46">
          <path d="M4 6 C 24 2, 40 14, 48 36" fill="none" stroke="#1A1714" strokeWidth="3" strokeLinecap="round" />
          <path d="M40 32 l9 6 l-2 -11" fill="none" stroke="#1A1714" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <div className="flex items-center gap-3 mt-4 px-1">
        <button className="w-11 h-11 rounded-full bg-accent text-bg flex items-center justify-center shrink-0"><PlayI size={20} /></button>
        <span className="font-mono text-[11px] text-muted">0:42</span>
        <div className="flex-1 h-[3px] rounded-full bg-surface2">
          <div className="h-full w-[31%] rounded-full bg-accent"></div>
        </div>
        <span className="font-mono text-[11px] text-muted">2:14</span>
      </div>
      <p className="font-hand text-muted text-center mt-3" style={{ fontSize: 19 }}>hand-drawn explainer &middot; low-motion</p>
    </div>
  );
}

/* ----------------------------- READ ----------------------------- */
const GALLERY = [
  { n: "1", t: "The envelope went around the whole floor. Twenties, a few fifties, one optimistic hundred." },
  { n: "2", t: "By Friday it was gone from the drawer. Dana said she'd 'moved it somewhere safe.'" },
  { n: "3", t: "Somewhere safe turned out to be a weekend trip and a very new handbag." },
  { n: "4", t: "HR found the group chat. The receipts, as they say, were already screenshotted." },
];

// Build gallery items from real pipeline assets. Each scene gets a short
// caption pulled from the alignment words at that scene's slot — proportional
// slicing keeps the prose moving in sync with the visual.
function _galleryFromStory(
  story: Story,
  liveMedia: LiveStoryMediaResult,
): { src: string; caption: string }[] | null {
  // Prefer live images whenever the live read returned any — for shorts
  // these are the 9:16 doodle scene frames; for long-form they are the
  // 16:9 stills off the stories row. The baked `story.images` is the
  // fallback for static catalog entries that have no live row at all
  // (LiveCatalogStory deliberately drops images to keep the rail payload
  // small, so a live-only long-form story has empty story.images).
  const imgs = liveMedia.images.length > 0
    ? liveMedia.images
    : story.images || [];
  if (imgs.length === 0) return null;
  // Prefer the live long-form alignment so captions show on pure-live
  // stories whose `story.alignment` is empty (the LiveCatalogStory
  // projection drops it to keep the rails payload small).
  const words = liveMedia.alignment.length > 0
    ? liveMedia.alignment
    : story.alignment || [];
  if (words.length === 0) return imgs.map((src) => ({ src, caption: "" }));
  const perScene = Math.max(1, Math.floor(words.length / imgs.length));
  return imgs.map((src, i) => {
    const start = i * perScene;
    const slice = words.slice(start, start + Math.min(10, perScene));
    return { src, caption: slice.map((w) => w.word).join(" ") };
  });
}
function GenArticle({
  story,
  liveMedia,
}: {
  story: Story;
  liveMedia: LiveStoryMediaResult;
}) {
  // Prefer live body so a story that's published in the DB but not yet
  // re-exported into published.ts still renders its real article text
  // instead of the hardcoded envelope sample fallback.
  const articleBody = liveMedia.body ?? story.body ?? "";
  // splitArticleParagraphs falls back to single-newline + sentence
  // chunking so a single-blob body still gets paragraph slots for the
  // image distributor to land in.
  const paras = splitArticleParagraphs(articleBody);
  // When the applied video is a short, the article reads alongside the
  // short's 9:16 doodle scenes — same visual story, same vibe. Otherwise
  // the long-form 16:9 illustrations are still the right fit. Either way,
  // prefer the live row's images so live-only stories (whose `story.images`
  // is empty because LiveCatalogStory drops it from the rail payload) still
  // get scene illustrations between paragraphs.
  const useShortScenes = liveMedia.is_short && liveMedia.images.length > 0;
  const scenes = liveMedia.images.length > 0 ? liveMedia.images : (story.images || []);
  // placeArticleImages guarantees every scene renders — either inline
  // between paragraphs or in the trailing extras strip below the body.
  const placement = placeArticleImages(paras.length, scenes);
  // eslint-disable-next-line no-console -- rule 14
  console.info("[lorewire article images]", {
    storyId: story.id,
    para_count: paras.length,
    scene_count: scenes.length,
    inline_count: placement.inline.size,
    extras_count: placement.extras.length,
    use_short_scenes: useShortScenes,
    body_source: liveMedia.body ? "live" : "static",
  });

  // Cross-check the article's source URL against the authoritative Reddit
  // id (story.id, which equals stories.reddit_id for pipeline rows). When
  // they disagree, the URL points at a different thread than the article
  // was written from — refuse to embed rather than mislead the reader.
  // The stub card still renders so the section never goes blank.
  const redditTarget = resolveRedditEmbedTarget(story.source_url, story.id);
  // eslint-disable-next-line no-console -- rule 14
  console.info("[lorewire reddit embed]", {
    storyId: story.id,
    source_url: story.source_url ?? null,
    rendered: redditTarget !== null,
    embed_url: redditTarget?.url ?? null,
    embed_reddit_id: redditTarget?.redditId ?? null,
  });

  // Aspect ratio + crop behaviour tracks the source. Long-form
  // illustrations are 16:9 and benefit from the upper-third crop to put
  // faces in frame. Doodle scenes are authored 9:16 and centre-crop the
  // best; bound the width so the column doesn't blow out the article
  // measure on phones.
  const sceneAspect = useShortScenes ? "9/16" : "16/9";
  const sceneObjectPos = useShortScenes ? "50% 50%" : "50% 30%";
  const sceneWrapStyle: React.CSSProperties = useShortScenes
    ? {
        background: "#15141A",
        aspectRatio: sceneAspect,
        maxWidth: 280,
        marginLeft: "auto",
        marginRight: "auto",
      }
    : { background: "#15141A", aspectRatio: sceneAspect };

  return (
    <article className="fade-in">
      <p className="font-mono text-[10px] uppercase tracking-[.24em] text-accent mb-2">{story.cat} &middot; 6 min read</p>
      <h1 className="font-display font-black uppercase tracking-tightest leading-[.95] text-ink" style={{ fontSize: 30 }}>{story.title}</h1>
      {paras.map((para, i) => (
        <React.Fragment key={i}>
          {i === 0 ? (
            <p className="font-body text-[15px] leading-relaxed text-ink/90 mt-4"><span className="float-left font-display font-black text-accent mr-2 leading-[.8]" style={{ fontSize: 58 }}>{para.charAt(0)}</span>{para.slice(1)}</p>
          ) : (
            <p className="font-body text-[15px] leading-relaxed text-ink/90 mt-4">{para}</p>
          )}
          {placement.inline.has(i) && (
            <figure className="my-5">
              <div className="rounded-[12px] overflow-hidden relative" style={sceneWrapStyle}>
                <img src={placement.inline.get(i)} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ objectPosition: sceneObjectPos }} />
              </div>
              <figcaption className="font-mono text-[10px] text-muted mt-1.5 text-center">Illustration &middot; LoreWire Studio</figcaption>
            </figure>
          )}
        </React.Fragment>
      ))}
      {placement.extras.length > 0 && (
        <div className="mt-5 grid gap-4">
          {placement.extras.map((src, idx) => (
            <figure key={`extra-${idx}`} className="m-0">
              <div className="rounded-[12px] overflow-hidden relative" style={sceneWrapStyle}>
                <img src={src} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ objectPosition: sceneObjectPos }} />
              </div>
              <figcaption className="font-mono text-[10px] text-muted mt-1.5 text-center">Illustration &middot; LoreWire Studio</figcaption>
            </figure>
          ))}
        </div>
      )}
      {redditTarget ? (
        <RedditSourceCard
          url={redditTarget.url}
          title={story.title}
          redditId={redditTarget.redditId}
          variant="mobile"
        />
      ) : (
        <RedditSourceStub variant="mobile" />
      )}
    </article>
  );
}

// Wraps the real Reddit embed in a designed container — gives the
// "from the original thread" section the visual weight it deserves on a
// page that's been heavily designed everywhere else. Header row carries
// the Reddit avatar mark + subreddit chip; the embed widget hydrates
// inside the card so we keep one consistent surface whether the embed
// loaded or fell through to a link.
function RedditSourceCard({
  url,
  title,
  redditId,
  variant,
}: {
  url: string;
  title?: string;
  redditId: string;
  variant: "mobile" | "desktop";
}) {
  const pad = variant === "desktop" ? "p-6" : "p-5";
  const headerSize = variant === "desktop" ? "text-[12px]" : "text-[11px]";
  return (
    <section
      className={`mt-8 rounded-[16px] overflow-hidden ${pad}`}
      style={{
        background:
          "linear-gradient(135deg, #1c1820 0%, #181620 65%, #221820 100%)",
        border: "1px solid rgba(232,70,43,0.22)",
        boxShadow: "0 14px 40px rgba(0,0,0,0.35)",
      }}
    >
      <div className="flex items-center gap-3 mb-4">
        <RedditMark />
        <div className="min-w-0 flex-1">
          <p className={`font-mono ${headerSize} uppercase tracking-[.2em] text-muted leading-tight`}>
            From the original thread
          </p>
          <p className="font-display font-bold text-ink leading-tight mt-0.5 truncate" style={{ fontSize: variant === "desktop" ? 18 : 15 }}>
            r/AmItheAsshole
          </p>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 font-mono text-[10px] uppercase tracking-[.18em] px-3 py-1.5 rounded-full transition hover:scale-[1.02]"
          style={{
            background: "rgba(232,70,43,0.14)",
            color: "#E8462B",
            border: "1px solid rgba(232,70,43,0.32)",
          }}
        >
          Open in Reddit &rarr;
        </a>
      </div>
      <div
        className="rounded-[12px] overflow-hidden"
        style={{ background: "rgba(245,243,239,0.04)" }}
      >
        <RedditEmbed url={url} title={title} />
      </div>
      <p className="font-mono text-[10px] text-muted/70 mt-3" data-reddit-id={redditId}>
        Embed loads from Reddit. Falls back to a direct link if the widget is blocked.
      </p>
    </section>
  );
}

// Stub for stories that have no verified Reddit source URL. Rendered when
// resolveRedditEmbedTarget returns null (mismatch, placeholder, or a
// sample catalog row). Looks like a designed "discuss this" card instead
// of a half-broken embed placeholder.
function RedditSourceStub({ variant }: { variant: "mobile" | "desktop" }) {
  const pad = variant === "desktop" ? "p-6" : "p-5";
  return (
    <section
      className={`mt-8 rounded-[16px] ${pad}`}
      style={{
        background:
          "linear-gradient(135deg, #181620 0%, #15141A 60%, #1c1822 100%)",
        border: "1px solid rgba(245,243,239,0.08)",
      }}
    >
      <div className="flex items-center gap-3">
        <RedditMark muted />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted leading-tight">
            Retold by LoreWire
          </p>
          <p className="font-display font-bold text-ink/85 leading-tight mt-0.5" style={{ fontSize: variant === "desktop" ? 18 : 15 }}>
            From r/AmItheAsshole
          </p>
        </div>
      </div>
      <p className="text-ink/65 text-[13.5px] leading-relaxed mt-3">
        This piece is one of many we've adapted from the subreddit. Want more? Browse what's resonating right now.
      </p>
      <a
        href="https://www.reddit.com/r/AmItheAsshole/hot/"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 mt-4 font-mono text-[11px] uppercase tracking-[.18em] px-3.5 py-2 rounded-full transition hover:scale-[1.02]"
        style={{
          background: "rgba(232,70,43,0.14)",
          color: "#E8462B",
          border: "1px solid rgba(232,70,43,0.32)",
        }}
      >
        Browse r/AmItheAsshole <span aria-hidden>&rarr;</span>
      </a>
    </section>
  );
}

// Reddit's snoo avatar mark, inline SVG. Keeps the source card visually
// anchored without pulling in a third-party icon set. The `muted` variant
// desaturates for the stub card where there's no real Reddit thread.
function RedditMark({ muted = false }: { muted?: boolean }) {
  const fill = muted ? "#3a3540" : "#E8462B";
  return (
    <span
      aria-hidden
      className="shrink-0"
      style={{
        width: 40,
        height: 40,
        borderRadius: 999,
        background: fill,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: muted ? "none" : "0 4px 14px rgba(232,70,43,0.35)",
      }}
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="#0A0A0C"
        aria-hidden
      >
        <circle cx="12" cy="12" r="10" fill="none" />
        <path d="M21 12.3c0-1.1-.9-2-2-2-.5 0-1 .2-1.4.5-1.4-.9-3.3-1.5-5.4-1.6l1-3.5 3 .7c0 .8.6 1.4 1.4 1.4s1.4-.6 1.4-1.4-.6-1.4-1.4-1.4c-.5 0-1 .3-1.2.7l-3.4-.8c-.2 0-.3.1-.4.2L11 9.2c-2.2 0-4.1.7-5.5 1.6-.4-.3-.9-.5-1.4-.5-1.1 0-2 .9-2 2 0 .8.5 1.5 1.2 1.8 0 .2-.1.5-.1.7 0 2.6 3.1 4.8 6.8 4.8s6.8-2.1 6.8-4.8c0-.2 0-.4-.1-.6.8-.3 1.3-1 1.3-1.9zM7 13.4c0-.8.6-1.4 1.4-1.4s1.4.6 1.4 1.4-.6 1.4-1.4 1.4-1.4-.6-1.4-1.4zm7.5 3.3c-.7.7-1.9 1-2.5 1s-1.8-.3-2.5-1c-.1-.1-.1-.3 0-.4.1-.1.3-.1.4 0 .5.5 1.4.7 2.1.7s1.7-.2 2.1-.7c.1-.1.3-.1.4 0 .2.1.2.3 0 .4zm-.4-1.9c-.8 0-1.4-.6-1.4-1.4s.6-1.4 1.4-1.4 1.4.6 1.4 1.4-.6 1.4-1.4 1.4z" />
      </svg>
    </span>
  );
}

function Read({
  story,
  liveMedia,
}: {
  story: Story;
  liveMedia: LiveStoryMediaResult;
}) {
  const [mode, setMode] = useState("Article");
  return (
    <div className="px-4 pt-3 pb-2">
      <div className="flex gap-2 mb-4">
        {["Article", "Gallery"].map((m) => (
          <button key={m} onClick={() => setMode(m)} className="px-3.5 py-1.5 rounded-full font-body font-semibold text-[13px] transition"
            style={mode === m ? { background: "#F5F3EF", color: "#0A0A0C" } : { background: "rgba(255,255,255,.07)", color: "#C9C6CE", border: "1px solid rgba(255,255,255,.085)" }}>
            {m}
          </button>
        ))}
      </div>

      {mode === "Article" ? (
        (liveMedia.body || story.body) ? <GenArticle story={story} liveMedia={liveMedia} /> : (
        <article className="fade-in">
          <p className="font-mono text-[10px] uppercase tracking-[.24em] text-accent mb-2">Entitled &middot; 6 min read</p>
          <h1 className="font-display font-black uppercase tracking-tightest leading-[.95] text-ink" style={{ fontSize: 30 }}>The $800 Envelope</h1>
          <p className="font-body text-[15px] leading-relaxed text-ink/90 mt-4">
            <span className="float-left font-display font-black text-accent mr-2 leading-[.8]" style={{ fontSize: 58 }}>I</span>
            t started, as these things do, with the most enthusiastic person in the office. Dana volunteered to collect for the retirement gift before anyone else could even reach for their wallet, and within a day the cash was rolling in from every desk on the floor.
          </p>
          <p className="font-body text-[15px] leading-relaxed text-ink/90 mt-4">
            The envelope was, by all accounts, fat. People remembered handing over twenties. One person swears they put in a hundred. And then, sometime over a long weekend, the envelope simply&hellip; relocated.
          </p>

          <figure className="my-5">
            <div className="rounded-[12px] overflow-hidden" style={{ background: "#FBFAF4", height: 150 }}>
              <div className="w-full h-full relative grain">
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="font-hand font-bold" style={{ fontSize: 40, color: "#E8462B", transform: "rotate(-3deg)" }}>poof.</span>
                </div>
              </div>
            </div>
            <figcaption className="font-mono text-[10px] text-muted mt-1.5">Illustration &middot; LoreWire Studio</figcaption>
          </figure>

          <p className="font-body text-[15px] leading-relaxed text-ink/90">
            What follows is a slow-motion unraveling: a vague excuse, a suspiciously new handbag, and a group chat that had quietly been keeping receipts the entire time.
          </p>

          <blockquote className="my-6 text-center">
            <p className="font-display font-bold uppercase tracking-tightest leading-[1.02] text-ink" style={{ fontSize: 24 }}>
              &ldquo;I moved it somewhere safe,&rdquo; she said. <span className="text-accent">It was not somewhere safe.</span>
            </p>
          </blockquote>

          <p className="font-body text-[15px] leading-relaxed text-ink/90">
            By Monday, forty-one people wanted answers and exactly one of them worked in HR. The math, helpfully, did itself.
          </p>

          <div className="mt-6 rounded-[10px] p-4" style={{ background: "#15141A", borderLeft: "3px solid #E8462B" }}>
            <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted mb-2">From the original thread</p>
            <p className="font-body italic text-[14.5px] text-ink/90 leading-relaxed">
              &ldquo;She told us it was &lsquo;handled.&rsquo; It was handled the way a magician handles a coin.&rdquo;
            </p>
            <div className="flex items-center gap-2 mt-3 font-mono text-[11px] text-muted flex-wrap">
              <span className="text-ink/80">u/throwaway_desk42</span><span>&middot;</span>
              <span>r/AmItheAsshole</span><span>&middot;</span><span>Mar 2024</span>
              <span className="ml-auto text-accent font-medium">View source &rarr;</span>
            </div>
          </div>
        </article>
        )
      ) : (
        (() => {
          const items = _galleryFromStory(story, liveMedia);
          if (items && items.length > 0) {
            // 9:16 frames for the short's doodle scenes; 3:4 for long-form stills.
            const useShort = liveMedia.is_short && liveMedia.images.length > 0;
            return <GalleryCarousel items={items} useShort={useShort} />;
          }
          // Fallback to the hardcoded sample gallery for stories without pipeline assets.
          return (
            <div className="fade-in">
              <div className="flex gap-3 overflow-x-auto noscroll snap-x snap-mandatory -mx-1 px-1" id="gallery-scroll">
                {GALLERY.map((g, i) => (
                  <div key={i} className="snap-center shrink-0 rounded-[14px] overflow-hidden" style={{ width: 300, background: "#FBFAF4" }}>
                    <div className="h-[230px] relative grain flex items-center justify-center">
                      <span className="font-display font-black leading-none" style={{ fontSize: 150, color: "rgba(26,23,20,.13)" }}>{g.n}</span>
                      <span className="absolute top-3 left-4 font-hand font-bold text-accent" style={{ fontSize: 30 }}>{g.n}.</span>
                    </div>
                    <p className="font-body text-[14.5px] leading-snug text-doodle p-4">{g.t}</p>
                  </div>
                ))}
              </div>
              <Dots count={GALLERY.length} />
            </div>
          );
        })()
      )}
    </div>
  );
}
function GalleryChevron({ dir, size = 20 }: { dir: "left" | "right"; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <path d={dir === "left" ? "m15 6-6 6 6 6" : "m9 6 6 6-6 6"} />
    </svg>
  );
}

// One scene at a time: a single image with its caption directly below and
// prev/next arrows on the frame. Mirror of the DesktopShell carousel so both
// breakpoints behave identically — the user reads scenes in order and the
// caption is always visible under the image.
function GalleryCarousel({ items, useShort }: { items: { src: string; caption: string }[]; useShort: boolean }) {
  const [idx, setIdx] = useState(0);
  const n = items.length;
  // Clamp at the ends so the n / total counter stays honest about position.
  const go = (d: number) => setIdx((p) => Math.max(0, Math.min(n - 1, p + d)));
  const g = items[idx];
  const cardAspect = useShort ? "9/16" : "3/4";
  const maxW = useShort ? 280 : 340;
  const arrowCls =
    "absolute top-1/2 -translate-y-1/2 z-20 w-10 h-10 rounded-full flex items-center justify-center transition disabled:opacity-0";
  const arrowStyle = { background: "rgba(0,0,0,.55)", border: "1px solid rgba(255,255,255,.14)", color: "#F5F3EF" } as const;
  return (
    <div className="fade-in mx-auto" style={{ maxWidth: maxW }}>
      <div className="relative rounded-[14px] overflow-hidden" style={{ aspectRatio: cardAspect, background: "#15141A" }}>
        <img src={g.src} alt={`Scene ${idx + 1}`} className="absolute inset-0 w-full h-full object-cover" />
        <span className="absolute top-3 left-4 font-mono text-[10px] uppercase tracking-[.2em] px-1.5 py-0.5 rounded text-ink" style={{ background: "rgba(0,0,0,.55)" }}>{`Scene ${idx + 1}`}</span>
        <button onClick={() => go(-1)} disabled={idx === 0} aria-label="Previous scene" className={`${arrowCls} left-2`} style={arrowStyle}><GalleryChevron dir="left" /></button>
        <button onClick={() => go(1)} disabled={idx === n - 1} aria-label="Next scene" className={`${arrowCls} right-2`} style={arrowStyle}><GalleryChevron dir="right" /></button>
      </div>
      {g.caption && <p className="font-body text-[14.5px] leading-relaxed text-ink/85 mt-3.5">{g.caption}</p>}
      <div className="flex items-center justify-between mt-3.5">
        <span className="font-mono text-[11.5px] tracking-wide text-muted">{idx + 1} / {n}</span>
        <button
          onClick={() => go(1)}
          disabled={idx === n - 1}
          className="px-4 py-1.5 rounded-full font-body font-semibold text-[13px] transition disabled:opacity-40 flex items-center gap-1"
          style={{ background: "#F5F3EF", color: "#0A0A0C" }}
        >
          Next <GalleryChevron dir="right" size={15} />
        </button>
      </div>
    </div>
  );
}

function Dots({ count }: { count: number }) {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const el = document.getElementById("gallery-scroll");
    if (!el) return;
    const onS = () => setActive(Math.round(el.scrollLeft / 312));
    el.addEventListener("scroll", onS, { passive: true });
    return () => el.removeEventListener("scroll", onS);
  }, []);
  return (
    <div className="flex justify-center gap-1.5 mt-4">
      {Array.from({ length: count }).map((_, i) => (
        <span key={i} className="h-1.5 rounded-full transition-all" style={{ width: i === active ? 18 : 6, background: i === active ? "#E8462B" : "rgba(255,255,255,.22)" }}></span>
      ))}
    </div>
  );
}

/* ----------------------------- READ-ALONG ----------------------------- */
const SCRIPT = (
  "Dana volunteered to collect the money before anyone else could blink. " +
  "The envelope filled up fast, fat with twenties and one brave hundred. " +
  "Then, over a single long weekend, it simply vanished from the drawer. " +
  "She said she moved it somewhere safe. It was not, in any sense, safe."
).split(" ");

function ReadAlong({
  story,
  liveMedia,
}: {
  story: Story;
  liveMedia: LiveStoryMediaResult;
}) {
  // Prefer the live LONG-FORM audio + alignment from the stories row so
  // a fresh "Regenerate voiceover" in the admin VoicePicker reaches this
  // surface without a re-export of published.ts. liveMedia.audio_url is
  // explicitly NOT the short's voiceover_url — see actions.ts: it sources
  // stories.audio_url, which the voice_renders_worker writes whenever
  // the admin regenerates the long-form narration.
  const audioUrl = liveMedia.audio_url ?? story.audioUrl;
  const rawAlignment =
    liveMedia.alignment.length > 0 ? liveMedia.alignment : story.alignment;
  // Script-graft: stories rendered before the pipeline's Phase-1 captions
  // fix (commit 02c7cc3) carry STT homophones in the alignment text
  // ("state" for "steak", "they're telling" for "in their telling"). Run
  // the same edit-distance graft used in the pipeline so the read-along
  // surface shows the real script. The graft is idempotent on already-
  // correct alignment (ElevenLabs / post-fix Google), so wrapping
  // unconditionally is safe and protects future drift too.
  const scriptBody = liveMedia.body ?? story.body ?? "";
  const alignment =
    rawAlignment && scriptBody
      ? alignScriptToWords(scriptBody, rawAlignment)
      : rawAlignment;
  const hasReal = !!audioUrl && !!alignment && alignment.length > 0;
  return hasReal ? (
    <RealReadAlong story={story} audioUrl={audioUrl} alignment={alignment} />
  ) : (
    <FakeReadAlong />
  );
}

// Real read-along: drives the karaoke from an <audio> element's timeupdate,
// using the alignment word timings the pipeline writes (3.1 STT step).
function RealReadAlong({
  story,
  audioUrl,
  alignment,
}: {
  story: Story;
  audioUrl: string;
  alignment: Array<{ word: string; start: number; end: number }>;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const words = alignment;

  // Find the active word index by linear scan — same rule the Remotion
  // composition uses (the chunk has at most ~4 words; binary search would
  // be more code for no win).
  const activeIdx = (() => {
    for (let i = 0; i < words.length; i++) {
      if (elapsed >= words[i].start && elapsed < words[i].end) return i;
    }
    return elapsed >= (words[words.length - 1]?.end ?? 0) ? words.length - 1 : -1;
  })();

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      a.play().catch((e) => console.warn("[lorewire audio play err]", { storyId: story.id, e }));
    } else {
      a.pause();
    }
  };

  const totalSecs = duration || words[words.length - 1]?.end || 0;
  const progress = totalSecs > 0 ? (elapsed / totalSecs) * 100 : 0;
  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const ss = String(Math.floor(s % 60)).padStart(2, "0");
    return `${m}:${ss}`;
  };

  return (
    <div className="px-4 pt-4 pb-2">
      <audio
        ref={audioRef}
        src={audioUrl}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
        onError={() => console.warn("[lorewire audio err]", { storyId: story.id, src: audioUrl })}
      />
      <div className="flex items-center gap-3.5">
        <button onClick={toggle} className="w-14 h-14 rounded-full bg-accent text-bg flex items-center justify-center shrink-0 active:scale-95 transition">
          {playing
            ? <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            : <PlayI size={24} />}
        </button>
        <div className="flex-1 flex items-center gap-[2px] h-12">
          {Array.from({ length: 46 }).map((_, i) => {
            const seed = Math.sin(i * 1.7) * 0.5 + 0.5;
            const hgt = 16 + seed * 30 + (i % 3) * 6;
            const played = (i / 46) * 100 <= progress;
            return <span key={i} className="flex-1 rounded-full transition-colors" style={{ height: hgt, background: played ? "#E8462B" : "rgba(255,255,255,.14)" }}></span>;
          })}
        </div>
      </div>
      <div className="flex justify-between font-mono text-[11px] text-muted mt-2">
        <span>{fmt(elapsed)}</span><span>{fmt(totalSecs)}</span>
      </div>

      <div className="mt-6 leading-[1.7] font-body" style={{ fontSize: 21 }}>
        {words.map((w, i) => {
          const spoken = i < activeIdx;
          const current = i === activeIdx;
          return (
            <span key={i} style={{
              color: current ? "#fff" : spoken ? "rgba(245,243,239,.95)" : "rgba(142,138,151,.55)",
              background: current ? "#E8462B" : "transparent",
              padding: current ? "1px 5px" : "1px 0",
              borderRadius: 5,
              fontWeight: current ? 700 : 500,
              transition: "color .12s, background .12s",
            }}>{w.word}{" "}</span>
          );
        })}
      </div>
      <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted mt-6">Word-by-word &middot; tap play to follow along</p>
    </div>
  );
}

// Fallback read-along for stories without alignment/audio. Drives a fake
// 300ms-per-word ticker so the design stays alive in the validation catalog.
function FakeReadAlong() {
  const [playing, setPlaying] = useState(false);
  const [idx, setIdx] = useState(-1);
  const tRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (playing) {
      tRef.current = setInterval(() => {
        setIdx((i) => {
          if (i >= SCRIPT.length - 1) {
            if (tRef.current) clearInterval(tRef.current);
            setPlaying(false);
            return i;
          }
          return i + 1;
        });
      }, 300);
    }
    return () => {
      if (tRef.current) clearInterval(tRef.current);
    };
  }, [playing]);
  const toggle = () => {
    if (idx >= SCRIPT.length - 1) setIdx(-1);
    setPlaying((p) => !p);
  };
  const cur = Math.max(idx, 0);
  const total = SCRIPT.length;
  const secsTotal = Math.round(total * 0.3);
  const secsNow = Math.round((cur + 1) * 0.3);
  const fmt = (s: number) => `0:${String(Math.min(s, secsTotal)).padStart(2, "0")}`;
  const progress = ((idx + 1) / total) * 100;

  return (
    <div className="px-4 pt-4 pb-2">
      <div className="flex items-center gap-3.5">
        <button onClick={toggle} className="w-14 h-14 rounded-full bg-accent text-bg flex items-center justify-center shrink-0 active:scale-95 transition">
          {playing
            ? <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            : <PlayI size={24} />}
        </button>
        <div className="flex-1 flex items-center gap-[2px] h-12">
          {Array.from({ length: 46 }).map((_, i) => {
            const seed = Math.sin(i * 1.7) * 0.5 + 0.5;
            const hgt = 16 + seed * 30 + (i % 3) * 6;
            const played = (i / 46) * 100 <= progress;
            return <span key={i} className="flex-1 rounded-full transition-colors" style={{ height: hgt, background: played ? "#E8462B" : "rgba(255,255,255,.14)" }}></span>;
          })}
        </div>
      </div>
      <div className="flex justify-between font-mono text-[11px] text-muted mt-2">
        <span>{fmt(idx < 0 ? 0 : secsNow)}</span><span>{fmt(secsTotal)}</span>
      </div>

      <div className="mt-6 leading-[1.7] font-body" style={{ fontSize: 21 }}>
        {SCRIPT.map((w, i) => {
          const spoken = i < idx;
          const current = i === idx;
          return (
            <span key={i} style={{
              color: current ? "#fff" : spoken ? "rgba(245,243,239,.95)" : "rgba(142,138,151,.55)",
              background: current ? "#E8462B" : "transparent",
              padding: current ? "1px 5px" : "1px 0",
              borderRadius: 5,
              fontWeight: current ? 700 : 500,
              transition: "color .12s, background .12s",
            }}>{w}{" "}</span>
          );
        })}
      </div>
      <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted mt-6">Word-by-word &middot; tap play to follow along</p>
    </div>
  );
}

/* ----------------------------- TITLE SHEET ----------------------------- */
function TitleSheet({ story, initialTab, initialCommentId, onClose, onOpen, inList, toggleList, session, seededModalComments, catalog }: { story: Story; initialTab?: string; initialCommentId?: string; onClose: () => void; onOpen: OpenFn; inList: boolean; toggleList: (id: string) => void; session: HomepageInitial["session"]; seededModalComments: HomepageInitial["seededModalComments"]; catalog: MergedCatalog }) {
  const [tab, setTab] = useState(initialTab || "Watch");
  // Both PLAY affordances (the hero circle and the big white button under the
  // meta row) flip this to true. WatchDoodle's effect consumes it: scroll the
  // player into view and start playback. Without this the buttons only set
  // the tab to "Watch" — which is already the default — and the user sees
  // nothing happen because the player sits below the fold on first open.
  const [pendingPlay, setPendingPlay] = useState(false);
  const onPlayClick = () => {
    setTab("Watch");
    setPendingPlay(true);
  };
  const onPlayConsumed = useCallback(() => setPendingPlay(false), []);
  // 2026-06-18 polls plan extension: per-story poll for the mobile
  // title sheet. Mirrors the DesktopShell DetailModal pattern; passing
  // `story` lets the server lazy-autodraft on first open when no poll
  // exists yet (every-story-has-a-poll invariant).
  const { view: pollView } = useStoryPoll(story.id, story);
  // Reset the tab whenever the parent swaps in a different story or hands us
  // a new initialTab. React 19's set-state-in-effect rule rejects the old
  // useEffect pattern; the sanctioned alternative is to track the previous
  // prop values during render and update state inline.
  const [prevStoryId, setPrevStoryId] = useState(story.id);
  const [prevInitialTab, setPrevInitialTab] = useState(initialTab);
  if (prevStoryId !== story.id || prevInitialTab !== initialTab) {
    setPrevStoryId(story.id);
    setPrevInitialTab(initialTab);
    setTab(initialTab || "Watch");
  }

  // Comment count for the tab badge. Fetched lightly (count + kill-switch
  // only, never the full thread) so the badge appears the moment the sheet
  // opens. The full thread loads lazily when the user clicks the Comments
  // tab — that's CommentsTab's job. Reset on story change so swapping
  // sheets doesn't show the previous story's count for a frame.
  const [commentInfo, setCommentInfo] = useState<{ count: number; enabled: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setCommentInfo(null);
    fetch(`/api/comments/count?storyId=${encodeURIComponent(story.id)}`)
      .then(async (r) => (r.ok ? ((await r.json()) as { count: number; enabled: boolean }) : null))
      .then((info) => {
        if (cancelled || !info) return;
        setCommentInfo(info);
      })
      .catch(() => {
        /* swallow — tab label falls back to "Comments" without a count */
      });
    return () => { cancelled = true; };
  }, [story.id]);

  // One live media fetch per sheet open, mirroring DesktopShell.DetailModal so
  // mobile WATCH stays in sync with desktop. Without this, mobile keeps showing
  // the baked `story.videoUrl` and misses freshly rendered shorts.
  const [liveMedia, setLiveMedia] = useState<LiveStoryMediaResult>(NO_LIVE_MEDIA);
  useEffect(() => {
    let cancelled = false;
    setLiveMedia(NO_LIVE_MEDIA);
    getLiveStoryMedia(story.id)
      .then((r) => {
        if (cancelled) return;
        if (!r.found) {
          console.info("[lorewire media live]", {
            storyId: story.id,
            found: false,
            baked: story.videoUrl ?? null,
          });
          return;
        }
        console.info("[lorewire media live]", {
          storyId: story.id,
          is_short: r.is_short,
          live_video_url: r.video_url,
          live_image_count: r.images.length,
          baked_video_url: story.videoUrl ?? null,
          baked_image_count: story.images?.length ?? 0,
        });
        setLiveMedia(r);
      })
      .catch((err) => {
        console.warn("[lorewire media live error]", {
          storyId: story.id,
          err: String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [story.id, story.videoUrl, story.images]);

  // Share opens our OWN ShareSheet (not the OS share panel). It carries the
  // PUBLIC canonical reader URL (/v/[slug]) for THIS story — never the internal
  // id or a signed media URL. liveMedia.slug is non-null exactly when the story
  // is published and reachable at /v/[slug]; otherwise we fall back to origin.
  const [shareOpen, setShareOpen] = useState(false);
  const shareUrl = storyShareUrl(
    liveMedia.slug,
    typeof window !== "undefined" ? window.location.origin : "",
  );

  // Personal star rating — local + honest (see useStoryRatings). The star opens
  // an inline picker; a set rating shows as a gold star here and a badge on the
  // story's thumbnails.
  const { getRating, setRating, clearRating } = useStoryRatings();
  const myRating = getRating(story.id) ?? 0;
  const [rateOpen, setRateOpen] = useState(false);

  const c = CAT[story.cat];
  // "More Like This" must only surface stories the pipeline has actually
  // produced content for — same bar as Search / New / homepage rails. The
  // old STORIES-based list pulled in empty sample placeholders and showed
  // poster cards that opened to nothing. Pull from the merged live catalog
  // and filter through isPublishedStory so the rail mirrors what the user
  // can actually browse elsewhere in the app.
  const published = catalog.array.filter(isPublishedStory);
  const more = published.filter((s) => s.cat === story.cat && s.id !== story.id).slice(0, 6);
  if (more.length < 3) more.push(...published.filter((s) => s.id !== story.id && !more.includes(s)).slice(0, 3));

  const [headerHeroOk, setHeaderHeroOk] = useState(true);
  // TitleSheet header is wider than it is tall (300h vs full-screen width on
  // a 480px-max-width mobile shell) so the landscape variant composes cleaner;
  // portrait is the fallback with the same upper-focus tweak.
  const headerHeroSrc = story.heroImageLandscape || story.heroImage;
  const isHeaderLandscape = !!story.heroImageLandscape;
  const showHeaderHero = !!headerHeroSrc && headerHeroOk;
  return (
    <div id="article-top" className="screen sheet-in z-40 noscroll scroll-mt-0" style={{ background: "#0A0A0C" }}>
      {shareOpen && <ShareSheet url={shareUrl} title={story.title} onClose={() => setShareOpen(false)} />}
      <div className="relative h-[300px]">
        <div className="absolute inset-0" style={{ background: c }}>
          {showHeaderHero && (
            <img
              src={headerHeroSrc}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              style={isHeaderLandscape ? undefined : { objectPosition: "50% 25%" }}
              onError={() => {
                setHeaderHeroOk(false);
                console.warn("[lorewire sheet hero err]", { storyId: story.id, src: headerHeroSrc });
              }}
            />
          )}
          <div className="absolute inset-0" style={{ background: showHeaderHero ? "linear-gradient(180deg, rgba(0,0,0,.05) 0%, rgba(0,0,0,.4) 70%, rgba(10,10,12,.85) 100%)" : "radial-gradient(120% 95% at 72% 18%, rgba(255,255,255,.18), rgba(0,0,0,.5) 74%)" }}></div>
          {!showHeaderHero && <div className="absolute inset-0 grain opacity-40 mix-blend-overlay"></div>}
          {!showHeaderHero && <div className="absolute -right-4 top-0 font-display font-black leading-none select-none" style={{ fontSize: 240, color: "rgba(255,255,255,.10)" }}>{story.glyph}</div>}
        </div>
        <div className="absolute inset-x-0 bottom-0 h-1/2" style={{ background: "linear-gradient(0deg,#0A0A0C 5%, rgba(10,10,12,0) 100%)" }}></div>
        <button onClick={onClose} className="absolute top-4 left-4 w-9 h-9 rounded-full flex items-center justify-center text-ink z-10" style={{ background: "rgba(0,0,0,.4)" }}>
          <ChevDown size={22} />
        </button>
        <button onClick={onPlayClick} aria-label="Play" className="absolute left-1/2 top-[120px] -translate-x-1/2 w-16 h-16 rounded-full flex items-center justify-center text-bg active:scale-95 transition" style={{ background: "#F5F3EF", boxShadow: "0 10px 30px rgba(0,0,0,.4)" }}>
          <PlayI size={28} />
        </button>
      </div>

      <div className="px-4 -mt-6 relative pb-28">
        <h1 className="font-display font-black uppercase tracking-tightest leading-[.92] text-ink ink-shadow" style={{ fontSize: 34 }}>{story.title}</h1>

        <div className="flex items-center gap-2 mt-3 flex-wrap font-body text-[12.5px]">
          <span className="font-semibold" style={{ color: "#5fcf86" }}>{story.match}% Match</span>
          <span className="text-muted">{story.year}</span>
          {story.dur && (
            <span className="px-1.5 py-0.5 rounded border border-line text-ink/80 font-mono text-[10px]">{story.dur}</span>
          )}
          <span className="px-1.5 py-0.5 rounded font-mono text-[10px] uppercase tracking-wider" style={{ background: "rgba(232,70,43,.16)", color: "#E8462B" }}>True</span>
          <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold" style={{ background: c, color: "#fff" }}>{story.cat}</span>
        </div>

        <button onClick={onPlayClick} className="w-full flex items-center justify-center gap-2 bg-ink text-bg font-display font-bold uppercase tracking-tight text-[15px] rounded-[10px] py-3 mt-4 active:scale-[.98] transition">
          <PlayI /> Play
        </button>

        <div className="grid grid-cols-3 gap-2 mt-3 text-center">
          <button onClick={() => toggleList(story.id)} className="flex flex-col items-center gap-1 py-2 text-muted active:text-ink transition">
            {inList ? <span className="text-accent"><Ico d={<path d="m5 12 5 5L20 7" />} size={22} /></span> : <PlusI size={22} />}
            <span className="font-body text-[11px]" style={{ color: inList ? "#E8462B" : undefined }}>My List</span>
          </button>
          <button onClick={() => setRateOpen((v) => !v)} aria-label="Rate" aria-pressed={myRating > 0} className="flex flex-col items-center gap-1 py-2 text-muted active:text-ink transition" style={{ color: myRating > 0 ? "#F4B740" : undefined }}>
            <StarI size={22} /><span className="font-body text-[11px]">{myRating > 0 ? `Rated ${myRating}` : "Rate"}</span>
          </button>
          <button onClick={() => { setShareOpen(true); import("@/app/actions").then((m) => m.recordStoryEventAction(story.id, "share_initiated")).catch(() => {}); }} aria-label="Share" className="flex flex-col items-center gap-1 py-2 text-muted active:text-ink transition">
            <ShareI size={22} /><span className="font-body text-[11px]">Share</span>
          </button>
        </div>

        {rateOpen && (
          <div className="mt-3 flex flex-col items-center gap-1.5">
            <span className="font-body text-[12px] text-muted">{myRating > 0 ? "Your rating" : "Tap to rate"}</span>
            <RatingStars value={myRating} onRate={(n) => setRating(story.id, n)} onClear={() => clearRating(story.id)} size={32} />
          </div>
        )}

        <p className="font-body text-[14.5px] leading-relaxed text-ink/85 mt-4">{story.syn}</p>

        <div className="flex gap-6 mt-6 border-b border-line overflow-x-auto noscroll">
          {["Watch", "Read", "Read-along", "Comments"].map((t) => (
            <button key={t} onClick={() => setTab(t)} className="relative pb-2.5 font-display font-bold uppercase tracking-tight text-[14px] transition whitespace-nowrap" style={{ color: tab === t ? "#F5F3EF" : "#8E8A97" }}>
              {t === "Comments" && commentInfo ? `${t} (${commentInfo.count})` : t}
              {tab === t && <span className="absolute left-0 right-0 -bottom-px h-[2.5px] bg-accent rounded-full"></span>}
            </button>
          ))}
        </div>

        {/* Top-of-content vote teaser. Lives at the modal level (not inside
            a tab) so Watch, Read, and Read-along all carry the same
            shortcut. Visibility is prop-driven off pollView so the CTA
            shows up the moment the async useStoryPoll hook resolves —
            previously a DOM lookup at mount time stranded the CTA hidden
            because the poll element hadn't rendered yet. */}
        <TopArticleCTA
          enabled={pollView !== null}
          question={pollView?.question ?? "Where do you land on this one?"}
        />

        <div className="-mx-4 mt-2">
          {tab === "Watch" && <WatchDoodle story={story} liveMedia={liveMedia} pendingPlay={pendingPlay} onPlayConsumed={onPlayConsumed} />}
          {tab === "Read" && <Read story={story} liveMedia={liveMedia} />}
          {tab === "Read-along" && <ReadAlong story={story} liveMedia={liveMedia} />}
          {tab === "Comments" && (
            <div className="px-4">
              <CommentsTab
                storyId={story.id}
                signedIn={session !== null}
                focusedCommentId={initialCommentId}
                seed={seededModalComments}
              />
            </div>
          )}
        </div>

        {/* End-of-tab nudge into the Comments tab. Hidden on Comments
            itself (you're already there) and while commentInfo is loading
            so we don't paint then re-paint a count. Visibility honors the
            kill switch — enabled=false means commentsEnabled is off for
            this article, no point inviting the click. */}
        <div className="px-4">
          <JumpToComments
            count={commentInfo?.count ?? 0}
            onJump={() => setTab("Comments")}
            enabled={tab !== "Comments" && commentInfo !== null && commentInfo.enabled}
          />
        </div>

        {/* End-of-content "Cast your verdict" pill. Same reasoning as the
            top CTA — sits at the modal level so every tab gets it, and
            visibility tracks pollView so we don't hide on first paint. */}
        <InlineJumpToPoll
          enabled={pollView !== null}
          question={pollView?.question ?? "What's your take on this one?"}
        />

        {pollView && (
          <section id="article-poll" className="mt-8 scroll-mt-20">
            <PollWidget
              pollId={pollView.pollId}
              question={pollView.question}
              optionA={pollView.optionA}
              optionB={pollView.optionB}
              initialResult={pollView.result}
              initialVotedSide={pollView.votedSide}
              storyId={story.id}
            />
          </section>
        )}
        <BackToTop />
        {pollView && <JumpToPoll label="Vote" />}

        <section className="mt-8 -mx-4">
          <RailHead>More Like This</RailHead>
          <div className="flex gap-3 px-4 overflow-x-auto noscroll pb-1">
            {more.map((s) => <PosterCard key={s.id} story={s} onOpen={onOpen} w={120} h={174} />)}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ----------------------------- SEARCH ----------------------------- */
// Mirrors DesktopShell's SearchPage: only stories the pipeline has
// actually produced content for (hero, short render, narration, or
// article body) belong in the public listing. Reads off the merged
// live + sample catalog so freshly-published live rows surface without
// waiting for src/data/published.ts to be rebaked.
function Search({ onOpen, catalog }: { onOpen: OpenFn; catalog: MergedCatalog }) {
  const [q, setQ] = useState("");
  const published = catalog.array.filter(isPublishedStory);
  const query = q.trim().toLowerCase();
  const res = query
    ? published.filter((s) => (s.title + s.cat).toLowerCase().includes(query))
    : published;
  return (
    <div className="pt-14 px-4 pb-28">
      <h1 className="font-display font-black uppercase tracking-tightest text-ink text-[26px] mb-3">Search</h1>
      <div className="flex items-center gap-2 rounded-[10px] px-3 py-2.5 mb-5" style={{ background: "#15141A", border: "1px solid rgba(255,255,255,.085)" }}>
        <span className="text-muted"><SearchI size={18} /></span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Stories, categories, vibes..." className="bg-transparent outline-none flex-1 font-body text-[14px] text-ink placeholder:text-muted" />
      </div>
      {q === "" && (
        <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted mb-3">Browse all &middot; {published.length} stories</p>
      )}
      <div className="grid grid-cols-2 gap-3">
        {res.map((s) => (
          <div key={s.id} style={{ height: 160 }}><PosterCard story={s} onOpen={onOpen} w={"100%"} h={160} /></div>
        ))}
      </div>
      {res.length === 0 && <p className="font-body text-muted text-center mt-10">No stories match &ldquo;{q}&rdquo;.</p>}
    </div>
  );
}

/* ----------------------------- NEW ----------------------------- */
// Same published-only gate as Search: only stories the pipeline has
// actually produced content for (videoUrl / heroImage / audioUrl /
// body) belong in this list. Reads off the merged live + sample
// catalog and sorts by year DESC so the freshest produced content
// leads (matches the homepage new_row fallback ordering and the
// desktop New & Hot view).
function NewScreen({ onOpen, catalog }: { onOpen: OpenFn; catalog: MergedCatalog }) {
  const list = catalog.array
    .filter(isPublishedStory)
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    .slice(0, 10);
  return (
    <div className="pt-14 px-4 pb-28">
      <h1 className="font-display font-black uppercase tracking-tightest text-ink text-[26px] mb-1">New &amp; Hot</h1>
      <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted mb-5">Fresh threads this week</p>
      {list.length === 0 ? (
        <p className="font-body text-muted text-center mt-10">Nothing fresh yet — check back soon.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((s) => (
            <button key={s.id} onClick={() => onOpen(s.id)} className="flex gap-3 items-stretch text-left active:scale-[.99] transition">
              <div className="w-[110px] h-[68px] shrink-0"><PosterArt story={s} showTitle={false} /></div>
              <div className="flex-1 min-w-0 py-0.5">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-mono text-[9px] uppercase tracking-[.16em] px-1.5 py-0.5 rounded" style={{ background: CAT[s.cat], color: "#fff" }}>{s.cat}</span>
                  {s.dur && (
                    <span className="font-mono text-[10px] text-muted">{s.dur}</span>
                  )}
                </div>
                <h3 className="font-display font-bold uppercase tracking-tightest text-ink text-[15px] leading-[.98] truncate">{s.title}</h3>
                <p className="font-body text-[12.5px] text-muted leading-snug mt-1 line-clamp-2">{s.syn}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------- MY LIST ----------------------------- */
function MyList({
  onOpen,
  list,
  resolveStory,
  session,
}: {
  onOpen: OpenFn;
  list: string[];
  resolveStory: (id: string) => Story | null;
  session: HomepageInitial["session"];
}) {
  // Resolve through the live+sample catalog, NOT byId — saved ids can be real
  // shorts the Wires feed saved that aren't in the baked sample catalog, and
  // byId throws on an unknown id. Unresolved ids are skipped cleanly.
  const items = list
    .map(resolveStory)
    .filter((s): s is Story => s !== null);
  return (
    <div className="pt-14 px-4 pb-28">
      {/* Header row: title + settings gear + sign-in chip. For anonymous
          users with at least one save, the chip is the persistent "save
          across devices" entry point. The gear is the mobile entry to
          /settings (no tab-bar slot available; gear here keeps it
          reachable from a screen the user already visits regularly). */}
      <div className="mb-5 flex items-center justify-between gap-3">
        <h1 className="font-display font-black uppercase tracking-tightest text-ink text-[26px]">
          My List
        </h1>
        <div className="flex items-center gap-2">
          <a
            href="/settings"
            aria-label="Settings"
            title="Settings"
            className="flex items-center justify-center w-9 h-9 rounded-full text-ink hover:opacity-80 transition"
            style={{ background: "rgba(255,255,255,.07)" }}
          >
            <svg
              width={18}
              height={18}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </a>
          <SignInChip
            session={session}
            tone={!session && items.length > 0 ? "prominent" : "subtle"}
          />
        </div>
      </div>
      {items.length === 0 ? (
        <p className="font-body text-muted mt-10 text-center">Nothing saved yet. Tap <span className="text-ink">+ My List</span> on any story.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {items.map((s) => <div key={s.id} style={{ height: 180 }}><PosterCard story={s} onOpen={onOpen} w={"100%"} h={180} /></div>)}
        </div>
      )}
    </div>
  );
}

/* ----------------------------- TAB BAR ----------------------------- */
function TabBar({ tab, setTab }: { tab: string; setTab: (t: string) => void }) {
  // 2026-06-26 slice H of _plans/2026-06-26-homepage-redesign-v1.md:
  // mobile tab labels swap toward LoreWire vocabulary. "My List" was
  // Netflix's exact term -> "Saved" (generic but honest; the page is
  // a saved-stories list, not a vote-history list). "New" was the
  // mobile abbreviation of "New & Hot" -> "Today's" (matches the
  // desktop "Today's Verdicts" within the bottom-bar width budget).
  const items: [string, IconCmp][] = [["Home", HomeI], ["Wires", WiresI], ["Search", SearchI], ["Today's", NewI], ["Saved", ListI]];
  return (
    <div className="absolute bottom-0 left-0 right-0 z-50" style={{ background: "linear-gradient(0deg,#0A0A0C 70%, rgba(10,10,12,0))" }}>
      <div className="flex justify-around items-center pt-2.5 pb-7 px-2">
        {items.map(([label, Icon]) => {
          const active = tab === label;
          return (
            <button key={label} onClick={() => setTab(label)} className="flex flex-col items-center gap-1 flex-1 transition" style={{ color: active ? "#E8462B" : "#8E8A97" }}>
              <Icon size={23} fill={active && label === "Saved" ? "#E8462B" : "none"} />
              <span className="font-body text-[10px] font-semibold tracking-tight">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------- MOBILE SHELL ----------------------------- */
function MobileShell({ initial }: { initial: HomepageInitial }) {
  const [tab, setTab] = useState("Home");
  const [pill, setPill] = useState("All");
  const [active, setActive] = useState<{ id: string; tab?: string; commentId?: string } | null>(null);

  // Deep-link landing: `/?story=X&tab=Y&c=Z` opens the modal at story X
  // on tab Y (default Watch), and Z (when present) becomes the focused
  // comment Id so the modal scrolls into the discussion at that comment.
  // Powers permalink shares from the Comments tab's "Link" button.
  // Runs ONCE on mount via the empty dep — subsequent navigation uses
  // the in-app onOpen / close path.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const id = sp.get("story")?.trim();
    if (!id) return;
    const tabParam = sp.get("tab")?.trim();
    const knownTabs = new Set(["Watch", "Read", "Read-along", "Comments"]);
    const tab = tabParam && knownTabs.has(tabParam) ? tabParam : "Watch";
    const commentId = sp.get("c")?.trim() || undefined;
    setActive({ id, tab, commentId });
    recordView(id);
    // eslint-disable-next-line no-console -- rule 14
    console.info("[deep-link modal open]", { story_id: id, tab, comment_id: commentId ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);
  const screenRef = useRef<HTMLDivElement>(null);

  // My List is the persisted saved-stories store, shared with the Wires feed's
  // Save button and the Title sheet so a Save anywhere shows up everywhere.
  const { saved: list, toggle: toggleList } = useSavedStories();
  // 2026-06-19 Phase 2: Recently viewed is recorded whenever the user
  // opens a story (the detail sheet or a deep-link into Wires). LRU
  // ordering means the most-recent open bubbles to the front; the
  // engagement-store caps the list at 50.
  const { recordView } = useRecentlyViewed();

  // Tracks the Billboard's currently-visible slide. The carousel rotates
  // through pool ids; shuffle reads this ref to exclude the on-screen
  // slide (not just pool[0]). Ref instead of state so the 7s tick stays
  // contained to the Billboard and doesn't re-render the outer shell.
  const heroActiveIdRef = useRef<string | null>(null);
  const onHeroActiveChange = useCallback((heroId: string) => {
    heroActiveIdRef.current = heroId;
  }, []);

  // Hoisted curation + live-catalog hook. Home receives the values as
  // props instead of calling the hook itself so MyList and the modal
  // mount site below share one `resolveStory` (real shorts saved through
  // the Wires feed aren't in the baked STORIES catalog). One hook call
  // drives every component on the shell that maps an id to a card. The
  // seed comes from src/app/page.tsx's SSR fetch so the first paint
  // already shows the live curation — no client-fetch flash.
  const { curation, behavior, catalog, resolveStory } = useHomepageCuration({
    curation: initial.curation,
    behavior: initial.behavior,
    liveRows: initial.liveRows,
  });

  // 2026-06-25 stories plans: IG-style rail + viewer. The playlist
  // is resolved once per catalog/curation change, then re-partitioned
  // by useViewedWires so unseen wires lead and already-viewed wires
  // fall to the end of the queue (matches IG — viewed thumbs at the
  // back, not at the front with a dimmed ring). Both the rail and
  // the viewer consume the SAME reordered playlist so tap-next inside
  // the viewer follows the visual rail order. The viewer snapshots
  // its prop at mount so an in-session mark-viewed doesn't shuffle
  // the queue mid-story; close + reopen takes a fresh snapshot. The
  // viewer opens via `?wire=<id>` (distinct from `?story=`, which is
  // the Comments deep-link). Plans:
  //   - _plans/2026-06-25-stories-rail-and-viewer.md
  //   - _plans/2026-06-25-user-settings-page.md (partition + prefs)
  const storiesPlaylist = useMemo(
    () => resolveStoriesPlaylist(curation, catalog, resolveStory),
    [curation, catalog, resolveStory],
  );
  const { viewed: viewedWireIds } = useViewedWires();
  const storiesPlaylistOrdered = useMemo(
    () => partitionStoriesPlaylistByViewed(storiesPlaylist, viewedWireIds),
    [storiesPlaylist, viewedWireIds],
  );
  const { openWireId, openWire, closeWire } = useStoriesUrlState();

  const open: OpenFn = (id, t) => {
    setActive({ id, tab: t });
    recordView(id);
  };
  const close = () => setActive(null);
  // "Play Something" picks a random playable story and opens it on the
  // Watch tab — same affordance as the hero's Play button, so the modal's
  // existing autoplay path kicks in. Excludes the current hero so the
  // click never replays what the user is already looking at; sessionStorage
  // recents soften repeats when inventory is thin.
  const shuffle = () => {
    // Prefer the Billboard's currently-visible slide (set via
    // onHeroActiveChange). Fall back to pool[0] before the carousel
    // mounts on first paint.
    const heroId =
      heroActiveIdRef.current ??
      pickHeroAtIndex(
        resolveHeroPool(
          curation,
          behavior,
          catalog,
          resolveStory,
          initial.heroDivisiveIds,
        ),
        0,
      )?.id ??
      null;
    const recents = readShuffleRecents();
    const pickedId = pickRandomPlayable({
      catalog: catalog.array,
      currentHeroId: heroId,
      recentIds: recents,
    });
    const playablePoolSize = catalog.array.filter((s) => !!s.videoUrl).length;
    // eslint-disable-next-line no-console -- rule 14
    console.info("[lorewire shuffle pick]", {
      shell: "mobile",
      picked: pickedId,
      pool_size: playablePoolSize,
      excluded_hero: heroId,
      recents_count: recents.length,
    });
    if (!pickedId) return;
    pushShuffleRecent(pickedId);
    open(pickedId, "Watch");
  };

  useEffect(() => {
    if (screenRef.current) screenRef.current.scrollTop = 0;
  }, [tab]);

  return (
    <div className="relative mx-auto w-full max-w-[480px] h-[100dvh] overflow-hidden bg-bg">
      <div ref={screenRef} className="screen noscroll">
        {tab === "Home" && (
          <Home
            onOpen={open}
            onShuffle={shuffle}
            onHeroActiveChange={onHeroActiveChange}
            pill={pill}
            setPill={setPill}
            curation={curation}
            behavior={behavior}
            catalog={catalog}
            resolveStory={resolveStory}
            pollsInitial={initial.pollRails}
            session={initial.session}
            storiesPlaylist={storiesPlaylistOrdered}
            viewedWireIds={viewedWireIds}
            onOpenWire={openWire}
            votedStoryIds={initial.votedStoryIds}
            heroDivisiveIds={initial.heroDivisiveIds}
            heroPollQuestions={initial.heroPollQuestions}
            rotatingCategoryToday={initial.rotatingCategoryToday}
            coldStartFloor={initial.coldStartFloor}
            heroVerdicts={initial.heroVerdicts}
            posterVoteCounts={initial.posterVoteCounts}
          />
        )}
        {tab === "Search" && <Search onOpen={open} catalog={catalog} />}
        {tab === "Today's" && <NewScreen onOpen={open} catalog={catalog} />}
        {tab === "Saved" && <MyList onOpen={open} list={list} resolveStory={resolveStory} session={initial.session} />}
      </div>

      {/* Wires rides above the (now-empty) screen as a full-cover layer, like
          the Title sheet does — it owns its own snap scroller and pauses
          whenever a sheet opens over it. */}
      {tab === "Wires" && <WiresFeed onOpenInfo={open} paused={!!active} />}

      {active && (() => {
        // resolveStory checks the live catalog first so real-short ids saved
        // through the Wires feed (not in STORIES) still open the sheet.
        // Stale id -> render nothing; close button still works because
        // `active` is set.
        const s = resolveStory(active.id);
        return s ? (
          <TitleSheet
            story={s}
            initialTab={active.tab}
            initialCommentId={active.commentId}
            onClose={close}
            onOpen={open}
            inList={list.includes(active.id)}
            toggleList={toggleList}
            session={initial.session}
            seededModalComments={initial.seededModalComments}
            catalog={catalog}
          />
        ) : null;
      })()}

      <TabBar tab={tab} setTab={(t) => { close(); setTab(t); }} />

      {/* IG-style Stories viewer. Opens when `?wire=<id>` is set
          (either via the rail tap or a shared deep link). Sits above
          every other layer so it overlays the Wires feed and the
          TitleSheet alike. Mounting it at the shell level (not inside
          Home) means a deep link works regardless of which tab is
          currently active. Plan: _plans/2026-06-25-stories-rail-and-viewer.md. */}
      {openWireId && storiesPlaylistOrdered.length > 0 && (
        <StoriesViewer
          playlist={storiesPlaylistOrdered}
          startId={openWireId}
          onClose={closeWire}
        />
      )}
    </div>
  );
}

/* ----------------------------- RESPONSIVE APP ----------------------------- */
// Mobile layout below the lg breakpoint, the desktop layout at lg and up.
// Both mount; CSS shows exactly one, so neither layout regresses the other.
//
// `initial` is the SSR-prefetched homepage payload from src/app/page.tsx.
// Each shell forwards it into its own useHomepageCuration / useHomepagePolls
// call so the first paint already shows the correct hero + rails. See
// _plans/2026-06-18-homepage-no-flash-ssr.md.
export default function AppShell({ initial }: { initial: HomepageInitial }) {
  // CookieConsent + CrossDeviceNudge both mount at the shell level so
  // they're shared across the mobile and desktop adapters — one banner,
  // one nudge, one decision, one source of truth. Both are fixed-position
  // so they float over whichever subview is rendered. The banner's own
  // visibility logic handles SSR (renders nothing) and the grandfather
  // branch (silent accept for existing users with prior persisted state).
  // The nudge's own visibility logic handles the first-save trigger,
  // 7-day snooze, and signed-in skip. Plan:
  // _plans/2026-06-19-anonymous-first-auth.md.
  return (
    <>
      <div className="lg:hidden">
        <MobileShell initial={initial} />
      </div>
      <div className="hidden lg:block">
        <DesktopShell initial={initial} />
      </div>
      <CookieConsent />
      <CrossDeviceNudge session={initial.session} />
    </>
  );
}
