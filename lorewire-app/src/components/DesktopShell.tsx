"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CAT,
  STORIES,
  isPublishedStory,
  type Story,
} from "@/lib/stories";
import { RedditEmbed, resolveRedditEmbedTarget } from "@/components/RedditEmbed";
import WiresDesktop from "@/components/wires/WiresDesktop";
// Stories rail + viewer intentionally NOT mounted on desktop — final
// product call after the layout iteration (PR #82) still didn't read
// right against the hero composition. Desktop discovery happens
// through the existing rails (Continue Watching, Top 10, category
// rails). Mobile keeps the rail; see AppShell.tsx for the mount.
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
import { CommentsTab } from "@/components/CommentsTab";
import { JumpToComments } from "@/components/JumpToComments";
import {
  CATEGORY_RAILS,
  POLL_RAIL_KINDS,
  POLL_RAIL_TITLES,
  filterIdsByNotVoted,
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
import { heroTitleFontSizeDesktop, heroTitleBucket } from "@/lib/hero-title-size";
import {
  SLOW_MODE_PLAYBACK_RATE,
  useWirePrefs,
} from "@/components/wires/useWirePrefs";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { useStoryPlayEvents } from "@/lib/use-story-play-events";
import {
  pickRandomPlayable,
  pushShuffleRecent,
  readShuffleRecents,
} from "@/lib/play-shuffle";
import { PollRailCard } from "@/components/PollRail";
import { renderHeroVerdictBadge } from "@/lib/polls-shared";
import { PollWidget } from "@/components/PollWidget";
import {
  BackToTop,
  InlineJumpToPoll,
  JumpToPoll,
  TopArticleCTA,
} from "@/components/JumpToPoll";
import {
  useContinueReading,
  useRecentlyViewed,
  useSavedStories,
  useStoryRatings,
} from "@/lib/engagement-store";
import RatingStars, { RatingBadge } from "@/components/RatingStars";
import SignInChip from "@/components/SignInChip";
import SiteFooter from "@/components/SiteFooter";
import type { PublicSession } from "@/lib/homepage-data";

// Centralised default when no live media has loaded yet — the modal
// shows the baked story shape. Derived helpers below add the is_short
// flag + scene images once getLiveStoryMedia resolves.
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

// 2026-06-26 slice H of _plans/2026-06-26-homepage-redesign-v1.md:
// nav vocabulary swap away from Netflix copy. "New & Hot" was
// Netflix's "New & Popular"; "My List" was Netflix's exact term.
// "Today's Verdicts" pairs with the new hero verdict signal and
// names the page's purpose for LoreWire; "Saved" is a generic but
// honest replacement (the page is still a saved-stories list, not
// a vote-history list — renaming it to "Your Verdicts" would imply
// the entries are voted-on stories, which the underlying data
// doesn't yet enforce).
const NAV = ["Home", "Wires", "Browse", "Today's Verdicts", "Saved"];

/* ----------------------------- ICONS ----------------------------- */
const Ico = ({ d, fill, size = 24, stroke = 1.7 }: IconProps & { d: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill || "none"} stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);
const SearchI: IconCmp = (p) => <Ico {...p} d={<><circle cx="11" cy="11" r="6.2" /><path d="m20 20-3.6-3.6" /></>} />;
// Gear icon for the Settings link in TopNav. Outline-only to match
// the rest of the icon family; same 24-viewBox geometry so it sits
// on the same baseline as SearchI/PlayI etc.
const SettingsGearI: IconCmp = (p) => (
  <Ico
    {...p}
    d={
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </>
    }
  />
);
const PlayI = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>
);
const PlusI: IconCmp = (p) => <Ico {...p} d={<path d="M12 5v14M5 12h14" />} />;
const CheckI: IconCmp = (p) => <Ico {...p} d={<path d="m5 12 5 5L20 7" />} />;
const StarI: IconCmp = (p) => <Ico {...p} d={<path d="M12 4.5l2.2 4.6 5 .6-3.7 3.4 1 4.9L12 16.1 7.5 18.5l1-4.9L4.8 10.2l5-.6z" />} />;
const ShareI: IconCmp = (p) => <Ico {...p} d={<><circle cx="6" cy="12" r="2.3" /><circle cx="17" cy="6" r="2.3" /><circle cx="17" cy="18" r="2.3" /><path d="M8 11l7-4M8 13l7 4" /></>} />;
const ChevR: IconCmp = (p) => <Ico {...p} d={<path d="m9 6 6 6-6 6" />} />;
const ChevL: IconCmp = (p) => <Ico {...p} d={<path d="m15 6-6 6 6 6" />} />;
const XI: IconCmp = (p) => <Ico {...p} d={<path d="M6 6l12 12M18 6 6 18" />} />;
const ShuffleI: IconCmp = (p) => <Ico {...p} d={<><path d="M4 7h3l9 10h4M4 17h3l3-3.3M16 7h4M14 13.5l2 3.5" /><path d="m18 5 2 2-2 2M18 15l2 2-2 2" /></>} />;
const InfoI: IconCmp = (p) => <Ico {...p} d={<><circle cx="12" cy="12" r="8.4" /><path d="M12 11v5M12 8h.01" /></>} />;

/* ----------------------------- POSTER ART ----------------------------- */
// 2026-06-26 slice H of _plans/2026-06-26-homepage-redesign-v1.md:
// default poster border-radius 8 -> 12. Softer card reads less
// rectangular-streamer-grid; callers that need a different radius
// pass `rounded` explicitly (Search result tiles still opt out
// with `rounded={0}`).
function PosterArt({ story, rounded = 12, showTitle = true, kicker = true, vig = false }: { story: Story; rounded?: number; showTitle?: boolean; kicker?: boolean; vig?: boolean }) {
  const c = CAT[story.cat];
  const [imageOk, setImageOk] = useState(true);
  const showImage = !!story.heroImage && imageOk;
  // Suppress CSS title when the artwork has it baked in (Wave 2 cinematic
  // thumbnails) so the same words don't stack on top of themselves.
  const renderCssTitle = showTitle && !story.heroHasBakedTitle;
  return (
    <div className="relative w-full h-full overflow-hidden" style={{ borderRadius: rounded, background: c }}>
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
      {!showImage && <div className="absolute -right-4 -top-5 font-display font-black leading-none select-none" style={{ fontSize: 200, color: "rgba(255,255,255,.10)" }}>{story.glyph}</div>}
      {/* vig is the heavy bottom-up dark gradient that used to stack on
          top of the line-165 gradient. Default is now off so baked titles
          in the artwork stay bright across every rail. The line-165
          gradient (.55 opacity at the bottom) still provides enough
          contrast for non-baked CSS titles. Callers can opt back in with
          vig={true} if a specific surface needs the deeper darkening. */}
      {vig && <div className="absolute inset-0 poster-vig"></div>}
      {kicker && <div className="absolute left-3 top-3"><span className="font-mono text-[9px] uppercase tracking-[.18em] px-1.5 py-0.5 rounded" style={{ color: "#fff", background: "rgba(0,0,0,.34)" }}>{story.cat}</span></div>}
      {story.dur && (
        <div className="absolute right-2.5 top-2.5 font-mono text-[10px] tracking-wide px-1.5 py-0.5 rounded" style={{ background: "rgba(0,0,0,.5)", color: "#F5F3EF" }}>{story.dur}</div>
      )}
      {renderCssTitle && (
        <div className="absolute left-3.5 right-3.5 bottom-5">
          <h3 className="font-display font-extrabold uppercase tracking-tightest leading-[.92] ink-shadow" style={{ fontSize: story.title.length > 16 ? 19 : 23, color: "#F5F3EF" }}>{story.title}</h3>
        </div>
      )}
    </div>
  );
}

/* ----------------------------- TOP NAV ----------------------------- */
// Single nav link with an animated underline. Underline grows from center on
// hover and stays planted at the active width — gives the bar a clear "you are
// here" anchor without an extra background pill that would clutter the layout.
function NavLink({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`group relative font-body text-[14px] py-1.5 transition-colors duration-200 ${active ? "text-ink font-bold" : "text-muted font-medium hover:text-ink"}`}
    >
      {label}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-0 h-[2px] rounded-full transition-all duration-300 ease-out ${active ? "w-[70%] opacity-100" : "w-0 opacity-0 group-hover:w-[58%] group-hover:opacity-90"}`}
        style={{ background: active ? "#E8462B" : "#F5F3EF" }}
      />
    </button>
  );
}

function TopNav({ view, setView, solid, query, setQuery, session }: { view: string; setView: (v: string) => void; solid: boolean; query: string; setQuery: (q: string) => void; session: PublicSession | null }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const open = searchOpen || query !== "";
  return (
    <header className="fixed top-0 left-0 right-0 z-50 transition-colors duration-300"
      style={{ background: solid ? "#0A0A0C" : "transparent", borderBottom: solid ? "1px solid rgba(255,255,255,.07)" : "1px solid transparent" }}>
      {/* Soft top-of-page scrim. Extends below the 68px header so the dark fade
          terminates inside the hero rather than at the header's bottom edge —
          that hard cut-off was reading as a thin horizontal line. */}
      {!solid && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0"
          style={{ height: 150, background: "linear-gradient(180deg, rgba(10,10,12,.82) 0%, rgba(10,10,12,.5) 35%, rgba(10,10,12,.18) 70%, rgba(10,10,12,0) 100%)" }}
        />
      )}
      <div className="relative mx-auto max-w-[1600px] flex items-center gap-9 px-10 h-[68px]">
        <button onClick={() => setView("Home")} className="flex items-center gap-1.5 shrink-0">
          {/* 2026-06-26 slice H follow-up: the LORE WIRE wordmark
              stays in Archivo Black regardless of the --font-display
              swap. Brand identity is locked to the wordmark's original
              voice; only chrome typography (headlines, rail headers)
              moves to Fraunces. */}
          <span className="font-black text-[26px] tracking-tightest text-ink" style={{ fontFamily: "var(--font-archivo), Arial, sans-serif" }}>LORE</span>
          <span className="font-black text-[26px] tracking-tightest text-accent" style={{ fontFamily: "var(--font-archivo), Arial, sans-serif" }}>WIRE</span>
        </button>
        <nav className="flex items-center gap-7">
          {NAV.map((n) => (
            <NavLink key={n} label={n} active={view === n} onClick={() => setView(n)} />
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-5">
          <div className="flex items-center rounded-full transition-all overflow-hidden" style={{ background: open ? "#15141A" : "transparent", border: open ? "1px solid rgba(255,255,255,.12)" : "1px solid transparent", width: open ? 248 : 38 }}>
            <button onClick={() => { setSearchOpen((o) => !o); setView("Search"); }} className="w-[38px] h-[38px] flex items-center justify-center text-ink shrink-0"><SearchI size={19} /></button>
            <input value={query} onChange={(e) => { setQuery(e.target.value); setView("Search"); }} placeholder="Stories, categories..." className="bg-transparent outline-none font-body text-[13.5px] text-ink placeholder:text-muted pr-3 w-full" style={{ display: open ? "block" : "none" }} />
          </div>
          <a
            href="/settings"
            aria-label="Settings"
            title="Settings"
            className="w-[38px] h-[38px] flex items-center justify-center text-ink hover:opacity-80 transition"
          >
            <SettingsGearI size={19} />
          </a>
          <SignInChip session={session} />
        </div>
      </div>
    </header>
  );
}

/* ----------------------------- HERO ----------------------------- */
// Rotation interval + crossfade timing for the hero carousel. The
// fade-in CSS class (globals.css) drives the per-slide fade; this
// constant only controls the auto-advance cadence.
const HERO_ROTATION_INTERVAL_MS = 7000;

// Length-aware <h1> for the hero title. Pre-floor the hero hardcoded
// fontSize: 84 for every title, which wrapped a 99-char title into 9
// lines. Now the size buckets down for over-length titles so the hero
// stays composed even when a bad title leaks past the pipeline gate
// (plan: _plans/2026-06-25-title-length-gate.md, Layer 2).
function HeroTitleH1({ title, storyId }: { title: string; storyId: string }) {
  const fontSize = heroTitleFontSizeDesktop(title);
  // Log when the floor fires so we can grep how often Layer 1 leaks.
  // A high rate here is the signal to retune the Python pipeline.
  if (fontSize < 84) {
    // eslint-disable-next-line no-console -- rule 14: namespaced observability
    console.info("[hero title size]", {
      surface: "desktop",
      storyId,
      chars: title.length,
      words: title.trim().split(/\s+/).length,
      bucket: heroTitleBucket(title),
      fontSize,
    });
  }
  return (
    <h1
      className="font-display font-black uppercase tracking-tightest leading-[.88] text-ink ink-shadow"
      style={{ fontSize }}
    >
      {title}
    </h1>
  );
}

function Hero({
  pool,
  onOpen,
  onShuffle,
  onActiveChange,
  pollQuestions,
  pollVerdicts,
}: {
  pool: Story[];
  onOpen: OpenFn;
  onShuffle: () => void;
  /** Fires whenever the visible slide changes. The outer shell reads it
   *  via a ref so "Play Something" can exclude the marquee the user is
   *  currently looking at. */
  onActiveChange?: (heroId: string) => void;
  /** 2026-06-26 slice D of _plans/2026-06-26-homepage-redesign-v1.md:
   *  poll question keyed by story id. Renders above the title as a
   *  handwritten audience-question hint when present; missing entries
   *  skip the overlay so the slide reads as a normal hero. */
  pollQuestions: HomepageInitial["heroPollQuestions"];
  /** 2026-06-26 slice H of _plans/2026-06-26-homepage-redesign-v1.md:
   *  audience-verdict badge keyed by story id. Replaces the legacy
   *  "{match}% Match" position in the meta row. Below-floor stories
   *  miss the entry and the row falls through to year + dur + tags. */
  pollVerdicts: HomepageInitial["heroVerdicts"];
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [tabHidden, setTabHidden] = useState(false);
  const [heroImageOk, setHeroImageOk] = useState(true);
  const reducedMotion = usePrefersReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);

  // Reset the image-ok flag whenever the slide changes so a previous
  // slide's image failure doesn't permanently strip the artwork.
  useEffect(() => {
    setHeroImageOk(true);
  }, [activeIndex]);

  // Tab visibility — pause the auto-advance when the tab is hidden so we
  // don't burn animation on a backgrounded page.
  useEffect(() => {
    const onVis = () => setTabHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Auto-advance. Paused on hover, when the tab is hidden, when the user
  // prefers reduced motion, or when there's only one slide (or none).
  useEffect(() => {
    if (pool.length < 2 || hovered || tabHidden || reducedMotion) return;
    const id = window.setInterval(() => {
      setActiveIndex((i) => (i + 1) % pool.length);
    }, HERO_ROTATION_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [pool.length, hovered, tabHidden, reducedMotion]);

  // Expose the active hero id to the parent so the shuffle exclusion
  // tracks the visible slide, not just pool[0].
  useEffect(() => {
    const active = pool[Math.min(activeIndex, pool.length - 1)];
    if (active) onActiveChange?.(active.id);
  }, [activeIndex, pool, onActiveChange]);

  // Preload the next slide's hero image so the crossfade paints a
  // complete picture, not a half-loaded one.
  useEffect(() => {
    if (pool.length < 2) return;
    const next = pool[(activeIndex + 1) % pool.length];
    const src = next.heroImageLandscape || next.heroImage;
    if (!src || typeof window === "undefined") return;
    const img = new window.Image();
    img.src = src;
  }, [activeIndex, pool]);

  // Keyboard arrow-key navigation when the hero region has focus.
  useEffect(() => {
    if (pool.length < 2) return;
    const el = sectionRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + pool.length) % pool.length);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % pool.length);
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [pool.length]);

  const story = pool[Math.min(activeIndex, pool.length - 1)];
  if (!story) return null;
  const c = CAT[story.cat];
  const heroSrc = story.heroImageLandscape || story.heroImage;
  const isLandscape = !!story.heroImageLandscape;
  const showHero = !!heroSrc && heroImageOk;
  const hasRotation = pool.length > 1;

  return (
    <section
      ref={sectionRef}
      className="relative h-[82vh] min-h-[620px] w-full overflow-hidden"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      tabIndex={hasRotation ? 0 : undefined}
      role={hasRotation ? "region" : undefined}
      aria-roledescription={hasRotation ? "carousel" : undefined}
      aria-label={hasRotation ? "Featured stories" : undefined}
    >
      {/* Keyed wrapper so each slide animates in via the existing fade-in
          CSS class. React unmounts the old slide and mounts the new one,
          which restarts the animation cleanly. */}
      <div key={story.id} className="absolute inset-0 fade-in">
        {/* 2026-06-26 slice H follow-up: `drift` removed. Editorial
            publications use STATIC hero images, not the slow zoom
            that's Netflix's exact "cinematic still" treatment. */}
        <div className="absolute inset-0" style={{ background: c }}>
          {showHero && (
            <img
              src={heroSrc}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              // Landscape variant fits naturally; portrait fallback needs
              // object-position to keep characters' faces visible.
              style={isLandscape ? undefined : { objectPosition: "50% 25%" }}
              onError={() => {
                setHeroImageOk(false);
                console.warn("[lorewire hero err]", { storyId: story.id, src: heroSrc });
              }}
            />
          )}
          <div className="absolute inset-0" style={{ background: showHero ? "linear-gradient(90deg, rgba(10,10,12,.85) 0%, rgba(10,10,12,.55) 25%, rgba(10,10,12,.15) 50%, rgba(10,10,12,.05) 100%), linear-gradient(180deg, rgba(0,0,0,0) 50%, rgba(10,10,12,.85) 100%)" : "radial-gradient(90% 110% at 78% 26%, rgba(255,255,255,.20), rgba(0,0,0,.42) 72%)" }}></div>
          {!showHero && <div className="absolute inset-0 grain opacity-35 mix-blend-overlay"></div>}
          {!showHero && <div className="absolute right-[2%] top-[2%] font-display font-black leading-none select-none" style={{ fontSize: 560, color: "rgba(255,255,255,.085)" }}>{story.glyph}</div>}
        </div>
        <div className="absolute inset-0" style={{ background: "linear-gradient(90deg,#0A0A0C 8%, rgba(10,10,12,.45) 42%, rgba(10,10,12,0) 72%)" }}></div>
        <div className="absolute inset-x-0 bottom-0 h-44" style={{ background: "linear-gradient(0deg,#0A0A0C 4%, rgba(10,10,12,0) 100%)" }}></div>
        <div className="relative h-full max-w-[1600px] mx-auto px-10 flex items-end pb-24">
          <div className="max-w-[620px]" aria-live="polite">
            {/* 2026-06-26 slice H follow-up: "LoreWire Original"
                eyebrow dropped (direct copy of Netflix's "NETFLIX
                ORIGINAL" pattern with the accent strip + small-caps
                mono). The hero now opens straight on the question. */}
            {/* 2026-06-26 slice H of _plans/2026-06-26-homepage-redesign-v1.md:
                the QUESTION is now the LEAD element of the hero (was a
                small kicker in slice D). Netflix leads with the title
                because the title IS the product; LoreWire leads with the
                question because the question IS the product. Handwriting
                (Caveat) keeps the "audience is asking" attribution from
                slice D. Story without an enabled poll skips this block
                — title-only hero is the graceful fallback. */}
            {pollQuestions[story.id] && (
              <p
                className="leading-tight text-ink mb-2 select-none"
                style={{
                  fontFamily: "var(--font-caveat)",
                  fontSize: 64,
                  textShadow: "0 1px 14px rgba(0,0,0,.55)",
                }}
              >
                {pollQuestions[story.id]}
              </p>
            )}
            {/* Title: secondary now (was the huge H1). Show name still
                grounds the slide but doesn't compete with the question.
                Bumped 36 -> 52 after the first preview review -- 36
                read as too small for the available space on desktop. */}
            <h2 className="font-display font-extrabold uppercase tracking-tightest leading-[.95] text-ink ink-shadow" style={{ fontSize: 52 }}>
              {story.title}
            </h2>
            {/* Verdict + meta row. The accent-coloured verdict badge
                replaces the legacy "{match}% Match" position (Netflix's
                exact match-score copy); absent when the poll is below
                the public floor. Year + dur + tags follow as supporting
                metadata. */}
            {/* 2026-06-27 hero polish: verdict badge becomes a soft
                accent pill (was plain accent-colored text). Reads as a
                deliberate callout element. Separators unified to small
                dots (mobile already used these); the typographic "·"
                was heavier than the meta around it. */}
            <div className="flex items-center gap-2.5 mt-5 flex-wrap whitespace-nowrap">
              {pollVerdicts[story.id] && (
                <>
                  <span
                    className="font-semibold text-[13px] text-accent px-2.5 py-0.5 rounded-full"
                    style={{ background: "rgba(232, 70, 43, 0.14)" }}
                  >
                    {renderHeroVerdictBadge(pollVerdicts[story.id])}
                  </span>
                  <span className="w-1 h-1 rounded-full bg-ink/30"></span>
                </>
              )}
              <span className="text-ink/80 text-[15px]">{story.year}</span>
              {story.dur && (
                <>
                  <span className="w-1 h-1 rounded-full bg-ink/30"></span>
                  <span className="font-mono text-[12px] px-2 py-0.5 rounded border border-line text-ink/80">{story.dur}</span>
                </>
              )}
              {story.tags.slice(0, 2).map((t) => (
                <React.Fragment key={t}>
                  <span className="w-1 h-1 rounded-full bg-ink/30"></span>
                  <span className="font-body text-[14px] text-ink/80">{t}</span>
                </React.Fragment>
              ))}
            </div>
            {/* Synopsis bumped text-ink/85 -> text-ink/90 for slight
                legibility win over dark gradient. */}
            <p className="font-body text-[17px] leading-relaxed text-ink/90 mt-5 max-w-[540px]">{story.syn}</p>
            {/* Button vocabulary swap (slice H): the trio used to be
                "Play / More Info / Play Something" — literally Netflix's
                hero button language. Now it names what those actions
                actually DO on LoreWire: watch + cast a verdict, read the
                long-form article, or shuffle for a random one. */}
            <div className="flex items-center gap-3 mt-7">
              {/* 2026-06-26 slice H follow-up: play icon dropped
                  from the primary CTA. The triangle is one of
                  Netflix's most iconic UI cues; removing it pushes
                  the button toward editorial CTA. */}
              {/* 2026-06-26 slice H follow-up: primary CTA font
                  locked to Archivo Black. Fraunces serif uppercase at
                  button sizes reads odd; bold sans CTAs against
                  serif headlines = classic magazine pairing. */}
              <button onClick={() => onOpen(story.id, "Watch")} className="flex items-center bg-ink text-bg font-bold uppercase tracking-tight text-[16px] rounded-[10px] px-8 py-3.5 hover:bg-white transition active:scale-[.98]" style={{ fontFamily: "var(--font-archivo), Arial, sans-serif" }}>Watch &amp; Vote</button>
              <button onClick={() => onOpen(story.id, "Read")} className="flex items-center gap-2.5 font-body font-semibold text-[15px] text-ink rounded-[10px] px-6 py-3.5 transition active:scale-[.98]" style={{ background: "rgba(255,255,255,.14)" }}><InfoI size={20} /> Read the article</button>
              <button onClick={onShuffle} className="flex items-center gap-2.5 font-mono text-[12px] uppercase tracking-[.18em] text-ink/85 rounded-[10px] px-5 py-3.5 border border-line hover:border-ink/40 transition active:scale-[.98]"><ShuffleI size={17} /> Surprise me</button>
            </div>
          </div>
        </div>
      </div>

      {/* 2026-06-27 hero polish: dots refined. Smaller (5px instead of
          8px) for a quieter footprint. Active dot uses accent (orange-
          red) instead of white -- LoreWire's brand color, not Netflix's
          neutral chrome. Generous tap target preserved via the wrapper
          button padding. Border dropped (was a half-pixel pseudo-shadow
          that read fuzzy at small sizes). */}
      {hasRotation && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-7 z-20 flex items-center gap-3">
          {pool.map((s, i) => (
            <button
              key={s.id}
              onClick={() => setActiveIndex(i)}
              aria-label={`Show slide ${i + 1} of ${pool.length}`}
              aria-current={i === activeIndex}
              className="relative grid place-items-center"
              style={{ width: 20, height: 20 }}
            >
              <span
                className="rounded-full transition-all"
                style={{
                  width: i === activeIndex ? 22 : 5,
                  height: 5,
                  background:
                    i === activeIndex ? "rgb(232, 70, 43)" : "rgba(255, 255, 255, .38)",
                }}
              />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/* ----------------------------- RAIL ----------------------------- */
function Rail({ title, children }: { title: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const scroll = (dir: number) => ref.current && ref.current.scrollBy({ left: dir * 720, behavior: "smooth" });
  return (
    <section className="mt-11" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <h2 className="font-display font-bold uppercase tracking-tightest text-[19px] text-ink px-10 max-w-[1600px] mx-auto mb-3.5">{title}</h2>
      <div className="relative">
        <button onClick={() => scroll(-1)} className="absolute left-0 top-0 bottom-0 z-20 w-16 flex items-center justify-center text-ink transition-opacity" style={{ opacity: hover ? 1 : 0 }}><span className="rail-fade-l absolute inset-0"></span><span className="relative w-9 h-9 rounded-full bg-bg/70 border border-line flex items-center justify-center"><ChevL size={22} /></span></button>
        {/* pb-3 reserves room for the cards' -bottom-2 hover underline
            stroke. Without it, overflow-x: auto forces overflow-y: auto
            (CSS spec), so the underline 8px below each card triggers a
            vertical scroll and the hover affordance is hidden until the
            user scrolls within the rail. */}
        <div ref={ref} className="flex gap-3.5 overflow-x-auto noscroll px-10 pb-3 max-w-[1600px] mx-auto" style={{ scrollPaddingLeft: 40 }}>{children}</div>
        <button onClick={() => scroll(1)} className="absolute right-0 top-0 bottom-0 z-20 w-16 flex items-center justify-center text-ink transition-opacity" style={{ opacity: hover ? 1 : 0 }}><span className="rail-fade-r absolute inset-0"></span><span className="relative w-9 h-9 rounded-full bg-bg/70 border border-line flex items-center justify-center"><ChevR size={22} /></span></button>
      </div>
    </section>
  );
}

function PosterCard({ story, onOpen, w = 196, h = 284, progress, landscape, voteCount }: { story: Story; onOpen: OpenFn; w?: number | string; h?: number; progress?: number; landscape?: boolean; voteCount?: number }) {
  const { getRating } = useStoryRatings();
  // 2026-06-26 slice H of _plans/2026-06-26-homepage-redesign-v1.md:
  // hover treatment swaps from Netflix's scale-pop (transform:
  // scale(1.05) on hover) to an editorial underline stroke that
  // draws left-to-right under the poster. Reads as a newspaper
  // "this is the article you're hovering" cue rather than a
  // streamer "this tile is interactive" cue. scaleX from origin-left
  // (instead of width 0 -> 100%) so the animation is GPU-cheap.
  // 180ms ease-out matches the spec; group-focus-visible mirrors the
  // hover so keyboard navigation gets the same affordance.
  return (
    <button onClick={() => onOpen(story.id)} className="group relative shrink-0" style={{ width: w }}>
      <div className="relative" style={{ height: h, boxShadow: "0 8px 26px rgba(0,0,0,.4)", borderRadius: 12 }}>
        <PosterArt story={story} showTitle={!landscape} />
        <RatingBadge value={getRating(story.id) ?? 0} className="absolute right-2 z-10" style={{ top: 30 }} />
        {/* 2026-06-26 slice H of _plans/2026-06-26-homepage-redesign-v1.md:
            vote-count chip in the bottom-left of the poster art. The
            parent rail passes voteCount from initial.posterVoteCounts;
            values are pre-floored on the server. Sits inside the poster
            div so it clips with the borderRadius. */}
        {voteCount != null && voteCount > 0 && (
          <div
            className="absolute left-2.5 z-10 font-mono uppercase tracking-wider rounded bg-black/65 text-white/95 backdrop-blur-sm"
            style={{ bottom: 10, fontSize: 10, padding: "2px 6px" }}
          >
            {formatVoteCount(voteCount)}
          </div>
        )}
        {landscape && (
          <div className="absolute left-3.5 right-3.5 bottom-5">
            <h3 className="font-display font-extrabold uppercase tracking-tightest leading-[.92] ink-shadow text-ink" style={{ fontSize: 18 }}>{story.title}</h3>
          </div>
        )}
      </div>
      {progress != null && (
        <div className="absolute left-2 right-2 bottom-2 h-[3px] rounded-full" style={{ background: "rgba(255,255,255,.26)" }}>
          <div className="h-full rounded-full bg-accent" style={{ width: `${progress}%` }}></div>
        </div>
      )}
      {/* The underline stroke. Hangs below the poster (negative
          bottom) so it doesn't overlap the artwork or the progress
          bar. 4px inset on each side reads as a deliberate stroke
          rather than a divider rule across the whole rail. */}
      <span
        className="absolute left-1 right-1 -bottom-2 h-[2px] bg-accent origin-left scale-x-0 transition-transform ease-out group-hover:scale-x-100 group-focus-visible:scale-x-100 pointer-events-none rounded-full"
        style={{ transitionDuration: "180ms" }}
      />
    </button>
  );
}

/** Render a vote count as a compact chip string. Mirrors the helper
 *  in AppShell so both shells produce identical chip copy. */
function formatVoteCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    const formatted = k % 1 === 0 ? k.toFixed(0) : k.toFixed(1);
    return `${formatted}k votes`;
  }
  return `${n} votes`;
}

function Top10Row({
  onOpen,
  ids,
  resolveStory,
}: {
  onOpen: OpenFn;
  ids: string[];
  resolveStory: (id: string) => Story | null;
}) {
  // resolveStory checks the live catalog + static STORIES so a freshly-
  // published id (in the DB but not yet baked into published.ts) still
  // renders. Returning null on a miss filters the entry out so a stale
  // curation row can't crash the rail.
  //
  // Layout: a single grid-cols-10 child of the standard Rail's flex
  // container, w-full so it fills the rail's 1520px usable width
  // (max-w-[1600px] minus px-10). Each ~144px cell is a poster
  // (aspectRatio 164/236, ~144x208). The giant outlined numeral sits
  // BEHIND the poster (z-0 vs poster z-10), anchored to peek out from
  // the bottom-left — its top ~30px is tucked behind the poster's
  // bottom edge, the remaining ~40px hangs visibly below. Thumbnail
  // artwork stays fully visible (numeral never overlays it). pb-14
  // on the grid reserves room below the cells for the peek. showTitle
  // is suppressed because the title is baked into the artwork at this
  // size. The hover underline lives INSIDE the poster (bottom edge)
  // here so it doesn't slice through the numeral the way the standard
  // -bottom-2 stroke would. Standard Rail's overflow-x-auto is
  // silently inert because the grid never overflows; chevrons stay
  // for visual parity with the other rails.
  return (
    <div className="grid grid-cols-10 gap-2 w-full pb-14">
      {ids.slice(0, 10).map((id, i) => {
        const s = resolveStory(id);
        if (!s) return null;
        return (
          <button key={id} onClick={() => onOpen(id)} className="group relative min-w-0">
            {/* Numeral peeks from behind the poster's bottom-left
                corner. z-0 + bottom: -40 keeps it under the poster
                visually while letting ~40px of the character hang
                below the cell as the editorial flourish. */}
            <span
              className="absolute font-display font-black leading-[.7] select-none pointer-events-none"
              style={{
                left: 6,
                bottom: -40,
                fontSize: 100,
                color: "transparent",
                WebkitTextStroke: "1.75px rgba(255,255,255,.55)",
                zIndex: 0,
              }}
            >
              {i + 1}
            </span>
            <div
              className="relative w-full"
              style={{ aspectRatio: "164 / 236", boxShadow: "0 8px 26px rgba(0,0,0,.4)", borderRadius: 12, zIndex: 10 }}
            >
              <PosterArt story={s} showTitle={false} />
              {/* Hover underline — moved inside the poster's bottom
                  edge so it doesn't cut through the numeral hanging
                  below the cell. */}
              <span
                className="absolute left-2 right-2 bottom-2 h-[2px] bg-accent origin-left scale-x-0 transition-transform ease-out group-hover:scale-x-100 group-focus-visible:scale-x-100 pointer-events-none rounded-full"
                style={{ transitionDuration: "180ms", zIndex: 20 }}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------- WATCH (real video or doodle) ----------------------------- */
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
  // liveMedia is lifted to DetailModal so the WATCH / READ / GALLERY
  // surfaces all share the same single fetch. Falls back to the baked
  // story.videoUrl when the live read missed (legacy sample-only entries
  // or before the fetch settled).
  const videoUrl = liveMedia.video_url ?? story.videoUrl;
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Phase 1 of _plans/2026-06-25-top10-ranking.md: emit play_started +
  // play_completed once each per story view. The hook handles dedupe
  // and the 90% completion threshold.
  const playEvents = useStoryPlayEvents(story.id);

  // Both PLAY affordances in DetailModal (the hero circle and the text Play
  // button under the meta row) raise this signal. Without it they only set
  // the tab to "Watch" — already the default — so a click does nothing
  // visible when the player is already below the fold inside the modal.
  useEffect(() => {
    if (!pendingPlay) return;
    const v = videoRef.current;
    if (v) {
      v.scrollIntoView({ behavior: "smooth", block: "center" });
      const p = v.play();
      if (p && typeof p.then === "function") {
        p.catch((e) => console.warn("[lorewire detail-modal play err]", { storyId: story.id, e: String(e) }));
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
      <div ref={sectionRef}>
        <div className="relative rounded-[14px] overflow-hidden w-full bg-black" style={{ height: 540 }}>
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
            className="absolute right-3 top-3 z-10 grid h-9 w-9 place-items-center rounded-full font-mono text-[10px] font-semibold tabular-nums text-ink"
            style={{ background: "rgba(0,0,0,.55)", opacity: slow ? 1 : 0.7 }}
          >
            {slow ? ".75×" : "1×"}
          </button>
        </div>
        <p className="font-mono text-[11px] uppercase tracking-[.2em] text-muted mt-4">LoreWire Original &middot; doodle short</p>
      </div>
    );
  }
  return (
    <div ref={sectionRef}>
      <div className="relative rounded-[14px] overflow-hidden w-full" style={{ background: "#FBFAF4", height: 440 }}>
        <div className="absolute inset-0" style={{ background: "repeating-linear-gradient(0deg, rgba(26,23,20,.035) 0 1px, transparent 1px 28px)" }}></div>
        <div className="absolute top-5 left-0 right-0 text-center font-hand font-bold text-doodle" style={{ fontSize: 32 }}>so about that office gift fund&hellip;</div>
        <div className="absolute left-1/2 top-[130px] -translate-x-1/2 floaty">
          <svg width="230" height="154" viewBox="0 0 230 154">
            <rect x="5" y="5" width="220" height="144" rx="7" fill="#fff" stroke="#1A1714" strokeWidth="5" />
            <polyline points="8,10 115,78 222,10" fill="none" stroke="#1A1714" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center pt-6"><span className="font-hand font-bold" style={{ fontSize: 66, color: "#E8462B", transform: "rotate(-4deg)" }}>$800</span></div>
        </div>
        <div className="absolute right-10 bottom-10" style={{ transform: "rotate(7deg)" }}>
          <div className="relative bg-white p-2.5 pb-7 shadow-[0_10px_26px_rgba(26,23,20,.25)]" style={{ width: 148 }}>
            <div className="w-full grain" style={{ height: 100, background: "#d9d4c6" }}></div>
            <div className="absolute left-0 right-0 bottom-1.5 text-center font-hand font-bold text-doodle" style={{ fontSize: 22 }}>the breakroom</div>
          </div>
        </div>
        <div className="absolute left-12 bottom-14" style={{ transform: "rotate(-3deg)" }}>
          <span className="font-hand font-bold px-1.5" style={{ fontSize: 30, color: "#1A1714", background: "#FFD84D", WebkitBoxDecorationBreak: "clone", boxDecorationBreak: "clone" }}>she never paid it back</span>
        </div>
        <svg className="absolute left-[120px] bottom-[185px]" width="72" height="56" viewBox="0 0 72 56">
          <path d="M5 8 C 30 3, 50 18, 58 44" fill="none" stroke="#1A1714" strokeWidth="3.5" strokeLinecap="round" />
          <path d="M48 40 l11 7 l-3 -13" fill="none" stroke="#1A1714" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="flex items-center gap-4 mt-5">
        <button className="w-12 h-12 rounded-full bg-accent text-bg flex items-center justify-center shrink-0"><PlayI size={22} /></button>
        <span className="font-mono text-[12px] text-muted">0:42</span>
        <div className="flex-1 h-[4px] rounded-full bg-surface2"><div className="h-full w-[31%] rounded-full bg-accent"></div></div>
        <span className="font-mono text-[12px] text-muted">2:14</span>
      </div>
      <p className="font-hand text-muted mt-3" style={{ fontSize: 22 }}>hand-drawn explainer &middot; low-motion</p>
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

// One scene at a time: a single image with its caption directly below and
// prev/next arrows on the frame edges. Replaces the old multi-card scroller so
// the caption is always visible (the tall 9:16 cards used to push it off the
// modal) and the reader steps through scenes in order. Same component shape on
// mobile (AppShell) so both breakpoints behave identically.
function GalleryCarousel({ items, useShort }: { items: { src: string; caption: string }[]; useShort: boolean }) {
  const [idx, setIdx] = useState(0);
  const n = items.length;
  // Clamp at the ends (vs wrap) so the n / total counter never lies about
  // where you are — clearer for a first-look reader than silent loop-around.
  const go = (d: number) => setIdx((p) => Math.max(0, Math.min(n - 1, p + d)));
  const g = items[idx];
  const cardAspect = useShort ? "9/16" : "3/4";
  const maxW = useShort ? 300 : 460;
  const arrowCls =
    "absolute top-1/2 -translate-y-1/2 z-20 w-11 h-11 rounded-full flex items-center justify-center transition disabled:opacity-0";
  const arrowStyle = { background: "rgba(0,0,0,.55)", border: "1px solid rgba(255,255,255,.14)", color: "#F5F3EF" } as const;
  return (
    <div className="fade-in mx-auto" style={{ maxWidth: maxW }}>
      <div className="relative rounded-[14px] overflow-hidden" style={{ aspectRatio: cardAspect, background: "#15141A" }}>
        <img src={g.src} alt={`Scene ${idx + 1}`} className="absolute inset-0 w-full h-full object-cover" />
        <span className="absolute top-4 left-5 font-mono text-[11px] uppercase tracking-[.2em] px-2 py-0.5 rounded text-ink" style={{ background: "rgba(0,0,0,.55)" }}>{`Scene ${idx + 1}`}</span>
        <button onClick={() => go(-1)} disabled={idx === 0} aria-label="Previous scene" className={`${arrowCls} left-3`} style={arrowStyle}><ChevL size={22} /></button>
        <button onClick={() => go(1)} disabled={idx === n - 1} aria-label="Next scene" className={`${arrowCls} right-3`} style={arrowStyle}><ChevR size={22} /></button>
      </div>
      {g.caption && <p className="font-body text-[15.5px] leading-relaxed text-ink/85 mt-4">{g.caption}</p>}
      <div className="flex items-center justify-between mt-4">
        <span className="font-mono text-[12px] tracking-wide text-muted">{idx + 1} / {n}</span>
        <button
          onClick={() => go(1)}
          disabled={idx === n - 1}
          className="px-5 py-1.5 rounded-full font-body font-semibold text-[13.5px] transition disabled:opacity-40 flex items-center gap-1"
          style={{ background: "#F5F3EF", color: "#0A0A0C" }}
        >
          Next <ChevR size={17} />
        </button>
      </div>
    </div>
  );
}

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
  // the long-form 16:9 illustrations are still the right fit.
  // `useShortScenes` drives the 9:16 aspect framing; `scenes` is what we
  // actually render. Splitting them lets a live-only long-form story
  // (story.images empty because LiveCatalogStory drops it) still pull
  // scenes from the live row instead of falling through to no images.
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

  // Aspect ratio + crop behaviour switches with the source. Long-form
  // illustrations are 16:9 and benefit from the upper-third crop to put
  // faces in frame. Doodle scenes are authored 9:16 and centre-crop the
  // best on phones; bound the width so the column doesn't blow out the
  // article measure on desktop.
  const sceneAspect = useShortScenes ? "9/16" : "16/9";
  const sceneObjectPos = useShortScenes ? "50% 50%" : "50% 30%";
  const sceneWrapStyle: React.CSSProperties = useShortScenes
    ? {
        background: "#15141A",
        aspectRatio: sceneAspect,
        maxWidth: 360,
        marginLeft: "auto",
        marginRight: "auto",
      }
    : { background: "#15141A", aspectRatio: sceneAspect };

  return (
    <article className="fade-in max-w-[660px]">
      <p className="font-mono text-[10px] uppercase tracking-[.24em] text-accent mb-2">{story.cat} &middot; 6 min read</p>
      <h1 className="font-display font-black uppercase tracking-tightest leading-[.95] text-ink" style={{ fontSize: 40 }}>{story.title}</h1>
      {paras.map((para, i) => (
        <React.Fragment key={i}>
          {i === 0 ? (
            <p className="font-body text-[16.5px] leading-[1.7] text-ink/90 mt-5"><span className="float-left font-display font-black text-accent mr-2.5 leading-[.78]" style={{ fontSize: 72 }}>{para.charAt(0)}</span>{para.slice(1)}</p>
          ) : (
            <p className="font-body text-[16.5px] leading-[1.7] text-ink/90 mt-5">{para}</p>
          )}
          {placement.inline.has(i) && (
            <figure className="my-7">
              <div className="rounded-[12px] overflow-hidden relative" style={sceneWrapStyle}>
                <img src={placement.inline.get(i)} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ objectPosition: sceneObjectPos }} />
              </div>
              <figcaption className="font-mono text-[11px] text-muted mt-2 text-center">Illustration &middot; LoreWire Studio</figcaption>
            </figure>
          )}
        </React.Fragment>
      ))}
      {placement.extras.length > 0 && (
        <div className="mt-7 grid gap-6">
          {placement.extras.map((src, idx) => (
            <figure key={`extra-${idx}`} className="m-0">
              <div className="rounded-[12px] overflow-hidden relative" style={sceneWrapStyle}>
                <img src={src} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ objectPosition: sceneObjectPos }} />
              </div>
              <figcaption className="font-mono text-[11px] text-muted mt-2 text-center">Illustration &middot; LoreWire Studio</figcaption>
            </figure>
          ))}
        </div>
      )}
      {redditTarget ? (
        <RedditSourceCard
          url={redditTarget.url}
          title={story.title}
          redditId={redditTarget.redditId}
        />
      ) : (
        <RedditSourceStub />
      )}
    </article>
  );
}

// Designed "From the original thread" card that wraps the Reddit embed
// widget. Shared visual language with the mobile (AppShell) variant —
// gradient surface, subreddit chip with the Reddit avatar mark, and a
// clear "Open in Reddit" affordance that always works even if the
// hydrated widget gets blocked by a content filter.
function RedditSourceCard({
  url,
  title,
  redditId,
}: {
  url: string;
  title?: string;
  redditId: string;
}) {
  return (
    <section
      className="mt-8 rounded-[16px] overflow-hidden p-6 max-w-[660px]"
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
          <p className="font-mono text-[12px] uppercase tracking-[.2em] text-muted leading-tight">
            From the original thread
          </p>
          <p className="font-display font-bold text-ink leading-tight mt-0.5 truncate" style={{ fontSize: 18 }}>
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

// Stub rendered when no real Reddit source URL resolves — invites the
// reader to discover more in the subreddit instead of looking like a
// half-broken embed placeholder.
function RedditSourceStub() {
  return (
    <section
      className="mt-8 rounded-[16px] p-6 max-w-[660px]"
      style={{
        background:
          "linear-gradient(135deg, #181620 0%, #15141A 60%, #1c1822 100%)",
        border: "1px solid rgba(245,243,239,0.08)",
      }}
    >
      <div className="flex items-center gap-3">
        <RedditMark muted />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[12px] uppercase tracking-[.2em] text-muted leading-tight">
            Retold by LoreWire
          </p>
          <p className="font-display font-bold text-ink/85 leading-tight mt-0.5" style={{ fontSize: 18 }}>
            From r/AmItheAsshole
          </p>
        </div>
      </div>
      <p className="text-ink/65 text-[14px] leading-relaxed mt-3">
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

// Reddit snoo avatar mark, inline SVG so we don't pull a third-party icon
// set into the bundle. The `muted` variant desaturates for the stub card.
function RedditMark({ muted = false }: { muted?: boolean }) {
  const fill = muted ? "#3a3540" : "#E8462B";
  return (
    <span
      aria-hidden
      className="shrink-0"
      style={{
        width: 44,
        height: 44,
        borderRadius: 999,
        background: fill,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: muted ? "none" : "0 4px 14px rgba(232,70,43,0.35)",
      }}
    >
      <svg
        width="26"
        height="26"
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
    <div>
      <div className="flex gap-2 mb-6">
        {["Article", "Gallery"].map((m) => (
          <button key={m} onClick={() => setMode(m)} className="px-4 py-1.5 rounded-full font-body font-semibold text-[13.5px] transition" style={mode === m ? { background: "#F5F3EF", color: "#0A0A0C" } : { background: "rgba(255,255,255,.07)", color: "#C9C6CE", border: "1px solid rgba(255,255,255,.085)" }}>{m}</button>
        ))}
      </div>
      {mode === "Article" ? (
        (liveMedia.body || story.body) ? <GenArticle story={story} liveMedia={liveMedia} /> : (
        <article className="fade-in max-w-[660px]">
          <p className="font-mono text-[10px] uppercase tracking-[.24em] text-accent mb-2">Entitled &middot; 6 min read</p>
          <h1 className="font-display font-black uppercase tracking-tightest leading-[.95] text-ink" style={{ fontSize: 40 }}>The $800 Envelope</h1>
          <p className="font-body text-[16.5px] leading-[1.7] text-ink/90 mt-5">
            <span className="float-left font-display font-black text-accent mr-2.5 leading-[.78]" style={{ fontSize: 72 }}>I</span>
            t started, as these things do, with the most enthusiastic person in the office. Dana volunteered to collect for the retirement gift before anyone else could even reach for their wallet, and within a day the cash was rolling in from every desk on the floor.
          </p>
          <p className="font-body text-[16.5px] leading-[1.7] text-ink/90 mt-5">The envelope was, by all accounts, fat. People remembered handing over twenties. One person swears they put in a hundred. And then, sometime over a long weekend, the envelope simply&hellip; relocated.</p>
          <figure className="my-7">
            <div className="rounded-[12px] overflow-hidden grain relative" style={{ background: "#FBFAF4", height: 200 }}>
              <div className="absolute inset-0 flex items-center justify-center"><span className="font-hand font-bold" style={{ fontSize: 54, color: "#E8462B", transform: "rotate(-3deg)" }}>poof.</span></div>
            </div>
            <figcaption className="font-mono text-[10px] text-muted mt-2">Illustration &middot; LoreWire Studio</figcaption>
          </figure>
          <p className="font-body text-[16.5px] leading-[1.7] text-ink/90">What follows is a slow-motion unraveling: a vague excuse, a suspiciously new handbag, and a group chat that had quietly been keeping receipts the entire time.</p>
          <blockquote className="my-8 border-l-[3px] border-accent pl-5">
            <p className="font-display font-bold uppercase tracking-tightest leading-[1.04] text-ink" style={{ fontSize: 28 }}>&ldquo;I moved it somewhere safe,&rdquo; she said. <span className="text-accent">It was not somewhere safe.</span></p>
          </blockquote>
          <p className="font-body text-[16.5px] leading-[1.7] text-ink/90">By Monday, forty-one people wanted answers and exactly one of them worked in HR. The math, helpfully, did itself.</p>
          <div className="mt-8 rounded-[10px] p-5" style={{ background: "#211F29", borderLeft: "3px solid #E8462B" }}>
            <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted mb-2.5">From the original thread</p>
            <p className="font-body italic text-[15.5px] text-ink/90 leading-relaxed">&ldquo;She told us it was &lsquo;handled.&rsquo; It was handled the way a magician handles a coin.&rdquo;</p>
            <div className="flex items-center gap-2 mt-3.5 font-mono text-[11.5px] text-muted flex-wrap">
              <span className="text-ink/80">u/throwaway_desk42</span><span>&middot;</span><span>r/AmItheAsshole</span><span>&middot;</span><span>Mar 2024</span>
              <span className="ml-auto text-accent font-medium">View source &rarr;</span>
            </div>
          </div>
        </article>
        )
      ) : (
        (() => {
          const items = _galleryFromStory(story, liveMedia);
          if (items && items.length > 0) {
            // 9:16 cards when the source is the short's doodle frames so the
            // gallery reads as a vertical scene; 3:4 for long-form 16:9 stills.
            const useShort = liveMedia.is_short && liveMedia.images.length > 0;
            return <GalleryCarousel items={items} useShort={useShort} />;
          }
          // Fallback for stories without pipeline assets.
          return (
            <div className="fade-in grid grid-cols-2 gap-5">
              {GALLERY.map((g, i) => (
                <div key={i} className="rounded-[14px] overflow-hidden flex" style={{ background: "#FBFAF4" }}>
                  <div className="w-[140px] shrink-0 relative grain flex items-center justify-center" style={{ background: "#FBFAF4" }}>
                    <span className="font-display font-black leading-none" style={{ fontSize: 120, color: "rgba(26,23,20,.13)" }}>{g.n}</span>
                    <span className="absolute top-3 left-4 font-hand font-bold text-accent" style={{ fontSize: 30 }}>{g.n}.</span>
                  </div>
                  <p className="font-body text-[15px] leading-snug text-doodle p-5 self-center">{g.t}</p>
                </div>
              ))}
            </div>
          );
        })()
      )}
    </div>
  );
}

/* ----------------------------- READ-ALONG ----------------------------- */
const SCRIPT = ("Dana volunteered to collect the money before anyone else could blink. The envelope filled up fast, fat with twenties and one brave hundred. Then, over a single long weekend, it simply vanished from the drawer. She said she moved it somewhere safe. It was not, in any sense, safe.").split(" ");

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
    <div className="max-w-[760px]">
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
      <div className="flex items-center gap-4">
        <button onClick={toggle} className="w-16 h-16 rounded-full bg-accent text-bg flex items-center justify-center shrink-0 hover:scale-105 active:scale-95 transition">
          {playing ? <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg> : <PlayI size={26} />}
        </button>
        <div className="flex-1 flex items-center gap-[3px] h-14">
          {Array.from({ length: 64 }).map((_, i) => { const seed = Math.sin(i * 1.7) * 0.5 + 0.5; const hgt = 18 + seed * 34 + (i % 3) * 7; const played = (i / 64) * 100 <= progress; return <span key={i} className="flex-1 rounded-full transition-colors" style={{ height: hgt, background: played ? "#E8462B" : "rgba(255,255,255,.14)" }}></span>; })}
        </div>
        <div className="flex flex-col items-end font-mono text-[12px] text-muted shrink-0 w-14">
          <span className="text-ink">{fmt(elapsed)}</span><span>{fmt(totalSecs)}</span>
        </div>
      </div>
      <div className="mt-8 leading-[1.75] font-body" style={{ fontSize: 27 }}>
        {words.map((w, i) => { const spoken = i < activeIdx, current = i === activeIdx; return <span key={i} style={{ color: current ? "#fff" : spoken ? "rgba(245,243,239,.95)" : "rgba(142,138,151,.5)", background: current ? "#E8462B" : "transparent", padding: current ? "2px 7px" : "2px 0", borderRadius: 6, fontWeight: current ? 700 : 500, transition: "color .12s, background .12s" }}>{w.word}{" "}</span>; })}
      </div>
      <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted mt-8">Word-by-word &middot; press play to follow along</p>
    </div>
  );
}

function FakeReadAlong() {
  const [playing, setPlaying] = useState(false);
  const [idx, setIdx] = useState(-1);
  const tRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (playing) {
      tRef.current = setInterval(() => setIdx((i) => {
        if (i >= SCRIPT.length - 1) { if (tRef.current) clearInterval(tRef.current); setPlaying(false); return i; }
        return i + 1;
      }), 300);
    }
    return () => { if (tRef.current) clearInterval(tRef.current); };
  }, [playing]);
  const toggle = () => { if (idx >= SCRIPT.length - 1) setIdx(-1); setPlaying((p) => !p); };
  const cur = Math.max(idx, 0), total = SCRIPT.length, secsTotal = Math.round(total * 0.3), secsNow = Math.round((cur + 1) * 0.3);
  const fmt = (s: number) => `0:${String(Math.min(s, secsTotal)).padStart(2, "0")}`;
  const progress = ((idx + 1) / total) * 100;
  return (
    <div className="max-w-[760px]">
      <div className="flex items-center gap-4">
        <button onClick={toggle} className="w-16 h-16 rounded-full bg-accent text-bg flex items-center justify-center shrink-0 hover:scale-105 active:scale-95 transition">
          {playing ? <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg> : <PlayI size={26} />}
        </button>
        <div className="flex-1 flex items-center gap-[3px] h-14">
          {Array.from({ length: 64 }).map((_, i) => { const seed = Math.sin(i * 1.7) * 0.5 + 0.5; const hgt = 18 + seed * 34 + (i % 3) * 7; const played = (i / 64) * 100 <= progress; return <span key={i} className="flex-1 rounded-full transition-colors" style={{ height: hgt, background: played ? "#E8462B" : "rgba(255,255,255,.14)" }}></span>; })}
        </div>
        <div className="flex flex-col items-end font-mono text-[12px] text-muted shrink-0 w-14">
          <span className="text-ink">{fmt(idx < 0 ? 0 : secsNow)}</span><span>{fmt(secsTotal)}</span>
        </div>
      </div>
      <div className="mt-8 leading-[1.75] font-body" style={{ fontSize: 27 }}>
        {SCRIPT.map((w, i) => { const spoken = i < idx, current = i === idx; return <span key={i} style={{ color: current ? "#fff" : spoken ? "rgba(245,243,239,.95)" : "rgba(142,138,151,.5)", background: current ? "#E8462B" : "transparent", padding: current ? "2px 7px" : "2px 0", borderRadius: 6, fontWeight: current ? 700 : 500, transition: "color .12s, background .12s" }}>{w}{" "}</span>; })}
      </div>
      <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted mt-8">Word-by-word &middot; press play to follow along</p>
    </div>
  );
}

/* ----------------------------- DETAIL MODAL ----------------------------- */
// Header block for the detail modal. Renders the hero image when the story has
// one, falling back to the gradient + glyph the design ships with otherwise.
function DetailModalHero({ story }: { story: Story }) {
  const c = CAT[story.cat];
  const [heroOk, setHeroOk] = useState(true);
  // Modal header is widescreen too; use landscape when available.
  const heroSrc = story.heroImageLandscape || story.heroImage;
  const isLandscape = !!story.heroImageLandscape;
  const showHero = !!heroSrc && heroOk;
  return (
    <div className="absolute inset-0" style={{ background: c }}>
      {showHero && (
        <img
          src={heroSrc}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          style={isLandscape ? undefined : { objectPosition: "50% 25%" }}
          onError={() => {
            setHeroOk(false);
            console.warn("[lorewire modal hero err]", { storyId: story.id, src: heroSrc });
          }}
        />
      )}
      <div className="absolute inset-0" style={{ background: showHero ? "linear-gradient(180deg, rgba(0,0,0,.05) 0%, rgba(0,0,0,.45) 65%, rgba(21,20,26,.9) 100%)" : "radial-gradient(90% 120% at 72% 22%, rgba(255,255,255,.20), rgba(0,0,0,.5) 74%)" }}></div>
      {!showHero && <div className="absolute inset-0 grain opacity-35 mix-blend-overlay"></div>}
      {!showHero && <div className="absolute -right-6 top-0 font-display font-black leading-none select-none" style={{ fontSize: 380, color: "rgba(255,255,255,.10)" }}>{story.glyph}</div>}
    </div>
  );
}

function DetailModal({ story, initialTab, initialCommentId, onClose, onOpen, inList, toggleList, session, seededModalComments, catalog }: { story: Story; initialTab?: string; initialCommentId?: string; onClose: () => void; onOpen: OpenFn; inList: boolean; toggleList: (id: string) => void; session: HomepageInitial["session"]; seededModalComments: HomepageInitial["seededModalComments"]; catalog: MergedCatalog }) {
  const [tab, setTab] = useState(initialTab || "Watch");
  // Both PLAY affordances (the hero circle and the text Play button in the
  // meta row) flip this to true. WatchDoodle's effect consumes it: scroll
  // the player into view and start playback. Mirrors the mobile TitleSheet
  // pattern — without this the buttons only set the tab to "Watch" (already
  // the default), so a click does nothing visible.
  const [pendingPlay, setPendingPlay] = useState(false);
  const onPlayClick = () => {
    setTab("Watch");
    setPendingPlay(true);
  };
  const onPlayConsumed = useCallback(() => setPendingPlay(false), []);
  // 2026-06-18 polls plan extension: fetch the per-story poll for the
  // modal. Re-fires whenever the modal swaps stories (the hook keys
  // on story.id). Renders below the tab content (Watch / Read /
  // Read-along) so the user always sees the question + vote. Passing
  // `story` lets the server lazy-autodraft a poll on first open for
  // stories published before the autodraft hooks landed.
  const { view: pollView } = useStoryPoll(story.id, story);
  // Reset the tab whenever the parent swaps in a different story or initialTab
  // — React 19's set-state-in-effect rule rejects the old useEffect pattern.
  // The sanctioned alternative is to track the previous prop values during
  // render and update state inline.
  const [prevStoryId, setPrevStoryId] = useState(story.id);
  const [prevInitialTab, setPrevInitialTab] = useState(initialTab);
  if (prevStoryId !== story.id || prevInitialTab !== initialTab) {
    setPrevStoryId(story.id);
    setPrevInitialTab(initialTab);
    setTab(initialTab || "Watch");
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Comment count for the tab badge. Light fetch (count + kill-switch only)
  // so the "COMMENTS (N)" tab label shows the count the moment the modal
  // opens, without paying the full thread fetch. The thread itself loads
  // lazily inside CommentsTab when the user clicks the tab. Reset on
  // story change so swapping stories doesn't briefly show the previous
  // count.
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
        /* swallow — tab falls back to "Comments" without a count */
      });
    return () => { cancelled = true; };
  }, [story.id]);

  // One live fetch per modal open. Shared by WATCH, READ → Article, READ →
  // Gallery so opening the modal hits the DB once instead of three times
  // and every subview sees a consistent "is this the short?" answer.
  // Falls back to NO_LIVE_MEDIA on miss/error so subviews behave as if
  // the baked story was canonical (legacy sample-only entries).
  const [liveMedia, setLiveMedia] = useState<LiveStoryMediaResult>(NO_LIVE_MEDIA);
  useEffect(() => {
    let cancelled = false;
    setLiveMedia(NO_LIVE_MEDIA);
    getLiveStoryMedia(story.id)
      .then((r) => {
        if (cancelled) return;
        if (!r.found) {
          // eslint-disable-next-line no-console -- rule 14
          console.info("[lorewire media live]", {
            storyId: story.id,
            found: false,
            baked: story.videoUrl ?? null,
          });
          return;
        }
        // eslint-disable-next-line no-console -- rule 14
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
        // eslint-disable-next-line no-console -- rule 14
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
  // "More Like This" mirrors Search / browse rails: only stories the pipeline
  // has actually produced content for. The old STORIES-based list let empty
  // sample placeholders into the rail, so cards opened to nothing. Pull from
  // the merged live catalog and filter through isPublishedStory.
  const published = catalog.array.filter(isPublishedStory);
  let more = published.filter((s) => s.cat === story.cat && s.id !== story.id);
  if (more.length < 6) more = more.concat(published.filter((s) => s.id !== story.id && !more.includes(s)));
  more = more.slice(0, 6);
  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto scrim-in" style={{ background: "rgba(0,0,0,.82)" }} onClick={onClose}>
      {shareOpen && <ShareSheet url={shareUrl} title={story.title} onClose={() => setShareOpen(false)} />}
      <div className="min-h-full flex items-start justify-center py-10 px-4">
        <div id="article-top" className="modal-in relative w-full max-w-[920px] rounded-[14px] overflow-hidden scroll-mt-0" style={{ background: "#15141A", boxShadow: "0 40px 120px rgba(0,0,0,.7)" }} onClick={(e) => e.stopPropagation()}>
          <div className="relative h-[400px]">
            <DetailModalHero story={story} />

            <div className="absolute inset-x-0 bottom-0 h-2/3" style={{ background: "linear-gradient(0deg,#15141A 4%, rgba(21,20,26,0) 100%)" }}></div>
            <button onClick={onClose} className="absolute top-5 right-5 w-10 h-10 rounded-full flex items-center justify-center text-ink z-10" style={{ background: "rgba(0,0,0,.5)" }}><XI size={22} /></button>
            <button onClick={onPlayClick} aria-label="Play" className="absolute left-10 top-[150px] w-[72px] h-[72px] rounded-full flex items-center justify-center text-bg hover:scale-105 transition" style={{ background: "#F5F3EF", boxShadow: "0 12px 32px rgba(0,0,0,.45)" }}><PlayI size={32} /></button>
            <div className="absolute left-10 right-10 bottom-7">
              <h1 className="font-display font-black uppercase tracking-tightest leading-[.9] text-ink ink-shadow" style={{ fontSize: 54 }}>{story.title}</h1>
            </div>
          </div>
          <div className="px-10 pb-12">
            <div className="flex items-start gap-8 pt-6">
              <div className="flex-1">
                {/* 2026-06-26 slice H follow-up: removed "{match}% Match"
                    from the modal meta row -- Netflix's exact match-score
                    copy. The hero already swapped this for the verdict
                    badge; the modal aligns. */}
                <div className="flex items-center gap-2.5 flex-wrap font-body text-[14px] mb-4">
                  <span className="text-muted">{story.year}</span>
                  {story.dur && (
                    <span className="px-2 py-0.5 rounded border border-line text-ink/80 font-mono text-[11px]">{story.dur}</span>
                  )}
                  <span className="px-2 py-0.5 rounded font-mono text-[10px] uppercase tracking-wider" style={{ background: "rgba(232,70,43,.16)", color: "#E8462B" }}>True</span>
                  <span className="px-2.5 py-0.5 rounded-full text-[12px] font-semibold" style={{ background: c, color: "#fff" }}>{story.cat}</span>
                </div>
                <p className="font-body text-[15.5px] leading-relaxed text-ink/85 max-w-[520px]">{story.syn}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0 pt-1">
                {/* Slice H follow-up: modal PLAY button font -> Archivo. */}
                <button onClick={onPlayClick} className="flex items-center gap-2 bg-ink text-bg font-bold uppercase tracking-tight text-[14px] rounded-[9px] px-6 py-3 hover:bg-white transition" style={{ fontFamily: "var(--font-archivo), Arial, sans-serif" }}><PlayI size={20} /> Play</button>
                <button onClick={() => toggleList(story.id)} title="Saved" className="w-11 h-11 rounded-full border border-line flex items-center justify-center transition hover:border-ink/50" style={{ color: inList ? "#E8462B" : "#F5F3EF" }}>{inList ? <CheckI size={20} /> : <PlusI size={20} />}</button>
                <button onClick={() => setRateOpen((v) => !v)} aria-label="Rate" aria-pressed={myRating > 0} title={myRating > 0 ? `Your rating: ${myRating}` : "Rate"} className="w-11 h-11 rounded-full border flex items-center justify-center hover:border-ink/50 transition" style={{ borderColor: rateOpen ? "#F4B740" : "var(--color-line)", color: myRating > 0 ? "#F4B740" : "#F5F3EF" }}><StarI size={19} /></button>
                <button onClick={() => { setShareOpen(true); import("@/app/actions").then((m) => m.recordStoryEventAction(story.id, "share_initiated")).catch(() => {}); }} aria-label="Share" title="Share" className="w-11 h-11 rounded-full border border-line flex items-center justify-center text-ink hover:border-ink/50 transition"><ShareI size={19} /></button>
              </div>
            </div>
            {rateOpen && (
              <div className="flex items-center gap-3 mt-4">
                <span className="font-body text-[13px] text-muted">{myRating > 0 ? "Your rating" : "Rate this story"}</span>
                <RatingStars value={myRating} onRate={(n) => setRating(story.id, n)} onClear={() => clearRating(story.id)} size={26} />
              </div>
            )}
            <div className="flex gap-8 mt-8 border-b border-line">
              {["Watch", "Read", "Read-along", "Comments"].map((t) => (
                <button key={t} onClick={() => setTab(t)} className="relative pb-3 font-bold uppercase tracking-tight text-[15px] transition whitespace-nowrap" style={{ color: tab === t ? "#F5F3EF" : "#8E8A97", fontFamily: "var(--font-archivo), Arial, sans-serif" }}>
                  {t === "Comments" && commentInfo ? `${t} (${commentInfo.count})` : t}{tab === t && <span className="absolute left-0 right-0 -bottom-px h-[3px] bg-accent rounded-full"></span>}
                </button>
              ))}
            </div>
            {/* Top-of-content vote teaser lives at the modal level (not
                inside a single tab) so Watch, Read, and Read-along all
                surface the shortcut. Visibility is prop-driven off
                pollView so the CTA appears the moment the async
                useStoryPoll hook resolves — the previous DOM-lookup
                gate hid the CTA permanently when the poll element
                wasn't in the tree at mount time. */}
            <div className="max-w-[660px] mt-5">
              <TopArticleCTA
                enabled={pollView !== null}
                question={pollView?.question ?? "Where do you land on this one?"}
              />
            </div>
            <div className="pt-7">
              {tab === "Watch" && <WatchDoodle story={story} liveMedia={liveMedia} pendingPlay={pendingPlay} onPlayConsumed={onPlayConsumed} />}
              {tab === "Read" && <Read story={story} liveMedia={liveMedia} />}
              {tab === "Read-along" && <ReadAlong story={story} liveMedia={liveMedia} />}
              {tab === "Comments" && <CommentsTab storyId={story.id} signedIn={session !== null} focusedCommentId={initialCommentId} seed={seededModalComments} />}
              <JumpToComments
                count={commentInfo?.count ?? 0}
                onJump={() => setTab("Comments")}
                enabled={tab !== "Comments" && commentInfo !== null && commentInfo.enabled}
              />
            </div>
            {/* End-of-content "Cast your verdict" pill. Same reasoning as
                the top CTA — modal-level so every tab gets it, and
                visibility tracks pollView so we don't hide on first paint. */}
            <div className="max-w-[660px]">
              <InlineJumpToPoll
                enabled={pollView !== null}
                question={pollView?.question ?? "What's your take on this one?"}
              />
            </div>
            {pollView && (
              <section id="article-poll" className="mt-10 scroll-mt-24">
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
            {pollView && <JumpToPoll label="Vote now" />}
            <section className="mt-12">
              <h2 className="font-display font-bold uppercase tracking-tightest text-[17px] text-ink mb-4">More Like This</h2>
              <div className="grid grid-cols-3 gap-4">
                {more.map((s) => (
                  <button key={s.id} onClick={() => onOpen(s.id)} className="rounded-[10px] overflow-hidden text-left hover:scale-[1.03] transition" style={{ background: "#211F29" }}>
                    <div style={{ height: 150 }}><PosterArt story={s} showTitle={false} rounded={0} /></div>
                    <div className="p-3.5">
                      <div className="flex items-center justify-between mb-1.5">
                        {s.dur ? (
                          <span className="font-mono text-[10px] text-muted">{s.dur}</span>
                        ) : (
                          <span />
                        )}
                        <span className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: CAT[s.cat], color: "#fff" }}>{s.cat}</span>
                      </div>
                      <h3 className="font-display font-bold uppercase tracking-tightest text-ink text-[15px] leading-[.98]">{s.title}</h3>
                      <p className="font-body text-[12.5px] text-muted leading-snug mt-1.5 line-clamp-2">{s.syn}</p>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- PAGES ----------------------------- */

function HomePage({
  onOpen,
  onShuffle,
  onHeroActiveChange,
  curation,
  behavior,
  catalog,
  resolveStory,
  pollsInitial,
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
  curation: ReturnType<typeof useHomepageCuration>["curation"];
  behavior: ReturnType<typeof useHomepageCuration>["behavior"];
  catalog: ReturnType<typeof useHomepageCuration>["catalog"];
  resolveStory: ReturnType<typeof useHomepageCuration>["resolveStory"];
  pollsInitial: HomepageInitial["pollRails"];
  /** 2026-06-26 slice C of _plans/2026-06-26-homepage-redesign-v1.md:
   *  story ids the viewer's cookie has voted on. Subtracted from the
   *  Continue Watching list so the rail surfaces only watched stories
   *  the viewer hasn't cast a verdict on yet — the "You Didn't Vote
   *  Yet" reframe. Empty array for anonymous viewers (filter no-ops). */
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
   *  rail must have before rendering. 0 disables the floor. Floor
   *  applies to: new_row, category rails, divisive/agreed poll
   *  rails. Skipped for: continue, top10, unpopular. */
  coldStartFloor: HomepageInitial["coldStartFloor"];
  /** 2026-06-26 slice H: audience-verdict badges (hero overlay) +
   *  poster vote counts (rail PosterCard chip). Both maps pre-floored
   *  (entries above DEFAULT_PUBLIC_FLOOR only). */
  heroVerdicts: HomepageInitial["heroVerdicts"];
  posterVoteCounts: HomepageInitial["posterVoteCounts"];
}) {
  // Curation + live catalog are hoisted to DesktopShell so My List / Browse /
  // New & Hot grids can share the same resolveStory (saved real shorts aren't
  // in the baked STORIES catalog). One hook call drives both the rails and
  // every grid that resolves ids to cards.
  // Phase 4.5 of _plans/2026-06-17-engagement-polls.md. The three
  // derived rails — computed live from poll_aggregates, not curated.
  // Empty arrays (no votes yet OR rail disabled in settings) just
  // render nothing; the homepage skips the section entirely so the
  // page doesn't carry placeholder "no content" tiles. Seeded from SSR
  // (see _plans/2026-06-18-homepage-no-flash-ssr.md) so the rails paint
  // on first byte instead of popping in after a client fetch.
  const { rails: pollRails } = useHomepagePolls(pollsInitial);
  // 2026-06-19 Phase 2: per-user Continue Watching now has a real
  // progress source. Engagement-store tracks story progress in
  // localStorage; this rail surfaces it. Resolution order in
  // resolveRailIds is: admin curation → user state → catalog fallback.
  const continueState = useContinueReading();

  // Hero rotation pool (capacity 8). The shell uses the pool count for
  // its [home render] log and onHeroActiveChange to keep the shuffle's
  // hero-exclusion tracking the visible slide (not just pool[0]).
  // heroDivisiveIds (slice D of _plans/2026-06-26-homepage-redesign-v1.md)
  // becomes the auto-fill source so the carousel leads with the
  // most-debated stories, not just the most recent.
  const heroPool = resolveHeroPool(
    curation,
    behavior,
    catalog,
    resolveStory,
    heroDivisiveIds,
  );
  const heroStory = pickHeroAtIndex(heroPool, 0);

  // 2026-06-26 slice C of _plans/2026-06-26-homepage-redesign-v1.md.
  // Build the voted-story-id Set once per render so the filter does
  // O(1) lookups instead of rebuilding the Set per call.
  const votedSet = useMemo(
    () => new Set(votedStoryIds),
    [votedStoryIds],
  );

  // Each rail flows through filterIdsByPublished AFTER resolveRailIds so
  // curated and fallback paths are both gated identically. Empty results
  // collapse the rail entirely (no header for an empty rail).
  // For the continue rail specifically, ALSO drop ids the viewer has
  // already voted on — that turns the raw watched list into the
  // "You Didn't Vote Yet" surface (slice C). Anonymous viewers and
  // viewers with no vote history get an empty Set, which makes the
  // filter a no-op (rail behaves exactly like the old Continue
  // Watching).
  const continueIds = filterIdsByPublished(
    filterIdsByNotVoted(
      resolveRailIds("continue", curation, behavior, catalog, {
        continue: continueState.ids,
      }),
      votedSet,
    ),
    resolveStory,
  );
  const top10Ids = filterIdsByPublished(
    resolveRailIds("top10", curation, behavior, catalog),
    resolveStory,
  );
  const newRowIds = filterIdsByPublished(
    resolveRailIds("new_row", curation, behavior, catalog),
    resolveStory,
  );

  // eslint-disable-next-line no-console -- rule 14
  console.info("[home render]", {
    shell: "desktop",
    total_catalog: catalog.array.length,
    hero_pool: heroPool.length,
    continue: continueIds.length,
    top10: top10Ids.length,
    new_row: newRowIds.length,
  });

  return (
    <div className="pb-20">
      {heroPool.length > 0 && (
        <Hero
          pool={heroPool}
          onOpen={onOpen}
          onShuffle={onShuffle}
          onActiveChange={onHeroActiveChange}
          pollQuestions={heroPollQuestions}
          pollVerdicts={heroVerdicts}
        />
      )}
      <div className={heroPool.length > 0 ? "relative -mt-20 z-10" : "relative z-10 pt-[110px]"}>
        {continueIds.length > 0 && (
          <Rail title="You Didn't Vote Yet">
            {continueIds.map((id) => {
              const s = resolveStory(id);
              if (!s) return null;
              return <PosterCard key={id} story={s} onOpen={onOpen} />;
            })}
          </Rail>
        )}
        {top10Ids.length > 0 && (
          <Rail title="Top 10 Today">
            <Top10Row onOpen={onOpen} ids={top10Ids} resolveStory={resolveStory} />
          </Rail>
        )}
        {/* 2026-06-26 slice E of _plans/2026-06-26-homepage-redesign-v1.md:
            when rotation is on (rotatingCategoryToday set), the homepage
            shows ONE category rail per day instead of all six. When the
            kill switch is off (rotatingCategoryToday === null), every
            category rail renders — the pre-redesign behaviour. */}
        {(rotatingCategoryToday
          ? CATEGORY_RAILS.filter((r) => r.surface === rotatingCategoryToday)
          : CATEGORY_RAILS
        ).map((rail) => {
          const ids = resolveRailIds(rail.surface, curation, behavior, catalog);
          if (!ids) return null;
          // Skip rails that resolve to no displayable stories at all (no
          // curation + no fallback hits, or only sample placeholders) so
          // the homepage doesn't render an empty section header.
          const items = ids
            .map((id) => resolveStory(id))
            .filter((s): s is Story => s !== null && isPublishedStory(s));
          // 2026-06-26 slice F of _plans/2026-06-26-homepage-redesign-v1.md:
          // hide category rails below the cold-start floor. Admin can set
          // the floor to 0 to disable; Math.max(1, ...) preserves the
          // legacy `> 0` gate when the floor is off.
          if (items.length < Math.max(1, coldStartFloor)) return null;
          return (
            <Rail key={rail.surface} title={rail.title}>
              {items.map((s) => <PosterCard key={s.id} story={s} onOpen={onOpen} voteCount={posterVoteCounts[s.id]} />)}
            </Rail>
          );
        })}
        {POLL_RAIL_KINDS.map((kind) => {
          const cards = pollRails[kind];
          // 2026-06-26 slice F: divisive + agreed are floor-eligible;
          // unpopular is the personalized minority rail (already gated
          // by the slice-A vote-count threshold) so it surfaces at any
          // size for the viewers who qualify.
          const railFloor =
            kind === "unpopular" ? 1 : Math.max(1, coldStartFloor);
          if (cards.length < railFloor) return null;
          return (
            <Rail key={`poll-${kind}`} title={POLL_RAIL_TITLES[kind]}>
              {cards.map((row) => (
                <PollRailCard key={row.storyId} row={row} kind={kind} />
              ))}
            </Rail>
          );
        })}
        {/* 2026-06-26 slice F of _plans/2026-06-26-homepage-redesign-v1.md:
            "New on LoreWire" is floor-eligible — a 1-poster New row would
            undercut the rail's promise of "fresh content." Math.max(1, ...)
            keeps the legacy `> 0` semantic when admin sets the floor to 0. */}
        {newRowIds.length >= Math.max(1, coldStartFloor) && (
          <Rail title="New on LoreWire">
            {newRowIds.map((id) => {
              const s = resolveStory(id);
              if (!s) return null;
              return <PosterCard key={id} story={s} onOpen={onOpen} voteCount={posterVoteCounts[id]} />;
            })}
          </Rail>
        )}
      </div>
    </div>
  );
}

function GridPage({
  title,
  sub,
  ids,
  onOpen,
  resolveStory,
  headerExtras,
}: {
  title: string;
  sub?: string;
  ids: string[];
  onOpen: OpenFn;
  resolveStory: (id: string) => Story | null;
  /** Optional slot rendered next to the title — used on the My List
   *  page to surface the sign-in chip as the persistent "save across
   *  devices" entry point. */
  headerExtras?: React.ReactNode;
}) {
  // Resolve through the live+sample catalog, NOT byId — saved ids can be
  // real shorts the Wires feed saved that aren't in the baked sample
  // catalog, and byId throws on unknown ids. Unresolved ids are skipped
  // cleanly so a stale My List entry can't crash the page.
  const items = ids.map(resolveStory).filter((s): s is Story => s !== null);
  return (
    <div className="pt-[110px] pb-24 max-w-[1600px] mx-auto px-10">
      <div className="flex items-end justify-between gap-6">
        <div>
          <h1 className="font-display font-black uppercase tracking-tightest text-ink text-[40px] leading-none">{title}</h1>
          {sub && <p className="font-mono text-[11px] uppercase tracking-[.2em] text-muted mt-3">{sub}</p>}
        </div>
        {headerExtras ? <div className="shrink-0">{headerExtras}</div> : null}
      </div>
      <div className="grid grid-cols-5 gap-5 mt-9">
        {items.map((s) => <div key={s.id} style={{ height: 296 }}><PosterCard story={s} onOpen={onOpen} w={"100%"} h={296} /></div>)}
      </div>
      {items.length === 0 && <p className="font-body text-muted mt-12">Nothing here yet.</p>}
    </div>
  );
}

// Browse / Search list only stories the pipeline has actually produced
// real content for (hero, short render, narration, or article body).
// The bare STORIES catalog includes 16 sample placeholders; without this
// gate the public listings would advertise stories that open into empty
// shells. The merged catalog (live DB rows + sample STORIES) is the
// input so freshly-published shorts that haven't been baked back into
// src/data/published.ts still surface.
function SearchPage({ onOpen, query, catalog }: { onOpen: OpenFn; query: string; catalog: MergedCatalog }) {
  const published = catalog.array.filter(isPublishedStory);
  const q = query.trim().toLowerCase();
  const res = q
    ? published.filter((s) => (s.title + s.cat).toLowerCase().includes(q))
    : published;
  return (
    <div className="pt-[110px] pb-24 max-w-[1600px] mx-auto px-10">
      <p className="font-mono text-[11px] uppercase tracking-[.2em] text-muted mb-2">{query ? `Results for "${query}"` : `Browse all · ${published.length} stories`}</p>
      <h1 className="font-display font-black uppercase tracking-tightest text-ink text-[40px] leading-none mb-9">{query || "Search"}</h1>
      <div className="grid grid-cols-5 gap-5">
        {res.map((s) => <div key={s.id} style={{ height: 296 }}><PosterCard story={s} onOpen={onOpen} w={"100%"} h={296} /></div>)}
      </div>
      {res.length === 0 && <p className="font-body text-muted mt-12">No stories match &ldquo;{query}&rdquo;.</p>}
    </div>
  );
}

/* ----------------------------- DESKTOP SHELL ----------------------------- */
export default function DesktopShell({ initial }: { initial: HomepageInitial }) {
  const [view, setView] = useState("Home");
  const [active, setActive] = useState<{ id: string; tab?: string; commentId?: string } | null>(null);

  // Deep-link landing: `/?story=X&tab=Y&c=Z` opens the DetailModal at
  // story X on tab Y (default Watch), and Z (when present) becomes the
  // focused comment Id so the Comments tab scrolls into the discussion
  // at that comment. Same shape as MobileShell's deep-link path.
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
    // eslint-disable-next-line no-console -- rule 14
    console.info("[deep-link modal open]", { story_id: id, tab, comment_id: commentId ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);
  const [solid, setSolid] = useState(false);
  const [query, setQuery] = useState("");

  // My List is the persisted saved-stories store, shared with the Wires feed's
  // Save button and the detail modal so a Save anywhere shows up everywhere.
  const { saved: list, toggle: toggleList } = useSavedStories();
  // 2026-06-19 Phase 2: Recently viewed is recorded whenever the user
  // opens a story (detail sheet or Wires deep-link). LRU ordered, capped
  // at 50 by the engagement-store.
  const { recordView } = useRecentlyViewed();

  // Tracks the currently visible hero slide. The Hero carousel rotates
  // through pool ids; the shuffle below reads this ref to exclude the
  // visible slide (not just pool[0]) so a click never replays what's
  // already on screen. Using a ref keeps the carousel's auto-advance
  // from re-rendering the outer shell every 7s.
  const heroActiveIdRef = useRef<string | null>(null);
  const onHeroActiveChange = useCallback((heroId: string) => {
    heroActiveIdRef.current = heroId;
  }, []);

  // Hoisted curation + live-catalog hook. HomePage reads it through props
  // instead of calling the hook itself so every grid (Browse / New & Hot /
  // My List) can share resolveStory and resolve real-short ids saved
  // through the Wires feed without throwing on byId. The seed comes from
  // src/app/page.tsx's SSR fetch so the first paint already shows the
  // correct curation — no client-fetch flash. See
  // _plans/2026-06-18-homepage-no-flash-ssr.md.
  const { curation, behavior, catalog, resolveStory } = useHomepageCuration({
    curation: initial.curation,
    behavior: initial.behavior,
    liveRows: initial.liveRows,
  });

  useEffect(() => {
    const onS = () => setSolid(window.scrollY > 120);
    window.addEventListener("scroll", onS, { passive: true });
    return () => window.removeEventListener("scroll", onS);
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [view]);
  // Lock the page behind a modal AND while the Wires feed owns the viewport.
  useEffect(() => {
    const lock = active !== null || view === "Wires";
    document.body.style.overflow = lock ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [active, view]);

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
    // Prefer the carousel's currently-visible slide (set by the Hero via
    // onHeroActiveChange). Fall back to pool[0] when the carousel hasn't
    // mounted yet (first paint, before useEffect runs).
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
      shell: "desktop",
      picked: pickedId,
      pool_size: playablePoolSize,
      excluded_hero: heroId,
      recents_count: recents.length,
    });
    if (!pickedId) return;
    pushShuffleRecent(pickedId);
    open(pickedId, "Watch");
  };

  return (
    <div className="min-h-screen bg-bg">
      <TopNav view={view} setView={(v) => { if (v !== "Search") setQuery(""); setView(v); }} solid={solid || view !== "Home"} query={query} setQuery={setQuery} session={initial.session} />

      {view === "Home" && (
        <HomePage
          onOpen={open}
          onShuffle={shuffle}
          onHeroActiveChange={onHeroActiveChange}
          curation={curation}
          behavior={behavior}
          catalog={catalog}
          resolveStory={resolveStory}
          pollsInitial={initial.pollRails}
          votedStoryIds={initial.votedStoryIds}
          heroDivisiveIds={initial.heroDivisiveIds}
          heroPollQuestions={initial.heroPollQuestions}
          rotatingCategoryToday={initial.rotatingCategoryToday}
          coldStartFloor={initial.coldStartFloor}
          heroVerdicts={initial.heroVerdicts}
          posterVoteCounts={initial.posterVoteCounts}
        />
      )}
      {view === "Wires" && <WiresDesktop onOpenInfo={open} paused={!!active} />}
      {view === "Browse" && (() => {
        // Browse advertises the public catalog of real stories. The bare
        // STORIES array carries 16 sample placeholders the design was
        // built against; only entries with actual produced content
        // (videoUrl / heroImage / audioUrl / body) belong in the grid.
        // Source is the merged catalog so freshly-published live rows
        // surface even before src/data/published.ts is rebaked.
        const browseStories = catalog.array.filter(isPublishedStory);
        const ids = browseStories.map((s) => s.id);
        // eslint-disable-next-line no-console -- rule 14
        console.info("[browse render]", { total_catalog: catalog.array.length, published_count: browseStories.length });
        return <GridPage title="Browse" sub={`All true stories · ${ids.length} titles`} ids={ids} onOpen={open} resolveStory={resolveStory} />;
      })()}
      {view === "Today's Verdicts" && (() => {
        // Same published-only gate as Browse. New & Hot promises "fresh
        // threads this week" — that promise breaks the moment a sample
        // placeholder lands on the grid. Sort by year DESC so the
        // freshest produced content leads (matches the homepage
        // new_row fallback ordering), then cap at 10 to keep the page
        // tight when the catalog scales.
        const newHot = catalog.array
          .filter(isPublishedStory)
          .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
          .slice(0, 10);
        const ids = newHot.map((s) => s.id);
        // eslint-disable-next-line no-console -- rule 14
        console.info("[new-and-hot render]", { total_catalog: catalog.array.length, shown: ids.length });
        return <GridPage title="Today's Verdicts" sub="Fresh threads this week" ids={ids} onOpen={open} resolveStory={resolveStory} />;
      })()}
      {view === "Saved" && (
        <GridPage
          title="Saved"
          sub={`${list.length} saved`}
          ids={list}
          onOpen={open}
          resolveStory={resolveStory}
          headerExtras={
            <SignInChip
              session={initial.session}
              tone={!initial.session && list.length > 0 ? "prominent" : "subtle"}
            />
          }
        />
      )}
      {view === "Search" && <SearchPage onOpen={open} query={query} catalog={catalog} />}

      <SiteFooter />

      {active && (() => {
        // resolveStory checks the live catalog first so real-short ids saved
        // through the Wires feed (not in STORIES) still open the modal.
        // Stale id -> render nothing; close button still works because
        // `active` is set.
        const s = resolveStory(active.id);
        return s ? <DetailModal story={s} initialTab={active.tab} initialCommentId={active.commentId} onClose={close} onOpen={open} inList={list.includes(active.id)} toggleList={toggleList} session={initial.session} seededModalComments={initial.seededModalComments} catalog={catalog} /> : null;
      })()}
    </div>
  );
}
