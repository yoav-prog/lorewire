"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  CAT,
  STORIES,
  type Story,
} from "@/lib/stories";
import { RedditEmbed, resolveRedditEmbedTarget } from "@/components/RedditEmbed";
import ReelsDesktop from "@/components/reels/ReelsDesktop";
import { alignScriptToWords } from "@/lib/script-graft";
import {
  placeArticleImages,
  splitArticleParagraphs,
} from "@/lib/article-image-positions";
import {
  getLiveStoryMedia,
  type LiveStoryMediaResult,
} from "@/app/actions";
import {
  CATEGORY_RAILS,
  POLL_RAIL_KINDS,
  POLL_RAIL_TITLES,
  resolveRailIds,
  useHomepageCuration,
  useHomepagePolls,
  useStoryPoll,
  type HomepageInitial,
} from "@/lib/homepage-rails";
import { PollRailCard } from "@/components/PollRail";
import { PollWidget } from "@/components/PollWidget";
import {
  useContinueReading,
  useRecentlyViewed,
  useSavedStories,
} from "@/lib/engagement-store";

// Centralised default when no live media has loaded yet — the modal
// shows the baked story shape. Derived helpers below add the is_short
// flag + scene images once getLiveStoryMedia resolves.
const NO_LIVE_MEDIA: LiveStoryMediaResult = {
  ok: true,
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

const NAV = ["Home", "Reels", "Browse", "New & Hot", "My List"];

/* ----------------------------- ICONS ----------------------------- */
const Ico = ({ d, fill, size = 24, stroke = 1.7 }: IconProps & { d: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill || "none"} stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);
const SearchI: IconCmp = (p) => <Ico {...p} d={<><circle cx="11" cy="11" r="6.2" /><path d="m20 20-3.6-3.6" /></>} />;
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
function PosterArt({ story, rounded = 8, showTitle = true, kicker = true }: { story: Story; rounded?: number; showTitle?: boolean; kicker?: boolean }) {
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
      <div className="absolute inset-0 poster-vig"></div>
      {kicker && <div className="absolute left-3 top-3"><span className="font-mono text-[9px] uppercase tracking-[.18em] px-1.5 py-0.5 rounded" style={{ color: "#fff", background: "rgba(0,0,0,.34)" }}>{story.cat}</span></div>}
      <div className="absolute right-2.5 top-2.5 font-mono text-[10px] tracking-wide px-1.5 py-0.5 rounded" style={{ background: "rgba(0,0,0,.5)", color: "#F5F3EF" }}>{story.dur}</div>
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

function TopNav({ view, setView, solid, query, setQuery }: { view: string; setView: (v: string) => void; solid: boolean; query: string; setQuery: (q: string) => void }) {
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
          <span className="font-display font-black text-[26px] tracking-tightest text-ink">LORE</span>
          <span className="font-display font-black text-[26px] tracking-tightest text-accent">WIRE</span>
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
          <div className="w-9 h-9 rounded-md flex items-center justify-center font-display font-bold text-[14px] text-bg" style={{ background: "#E8462B" }}>L</div>
        </div>
      </div>
    </header>
  );
}

/* ----------------------------- HERO ----------------------------- */
function Hero({ story, onOpen, onShuffle }: { story: Story; onOpen: OpenFn; onShuffle: () => void }) {
  const c = CAT[story.cat];
  const [heroOk, setHeroOk] = useState(true);
  // Desktop Hero is widescreen — prefer the 16:9 landscape variant when it
  // exists, fall back to the 3:4 portrait with object-position adjustment
  // otherwise.
  const heroSrc = story.heroImageLandscape || story.heroImage;
  const isLandscape = !!story.heroImageLandscape;
  const showHero = !!heroSrc && heroOk;
  return (
    <section className="relative h-[82vh] min-h-[620px] w-full overflow-hidden">
      <div className="absolute inset-0 drift" style={{ background: c }}>
        {showHero && (
          <img
            src={heroSrc}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            // Landscape variant fits naturally; portrait fallback needs
            // object-position to keep characters' faces visible instead of
            // cropping into bodies.
            style={isLandscape ? undefined : { objectPosition: "50% 25%" }}
            onError={() => {
              setHeroOk(false);
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
        <div className="max-w-[620px]">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="w-[3px] h-4 bg-accent rounded-full"></span>
            <span className="font-mono text-[11px] uppercase tracking-[.36em] text-ink/90">LoreWire Original</span>
          </div>
          <h1 className="font-display font-black uppercase tracking-tightest leading-[.88] text-ink ink-shadow" style={{ fontSize: 84 }}>{story.title}</h1>
          <div className="flex items-center gap-2.5 mt-5 flex-wrap whitespace-nowrap">
            <span className="font-semibold text-[15px]" style={{ color: "#5fcf86" }}>{story.match}% Match</span>
            <span className="text-muted">·</span><span className="text-ink/80 text-[15px]">{story.year}</span>
            <span className="text-muted">·</span>
            <span className="font-mono text-[12px] px-2 py-0.5 rounded border border-line text-ink/80">{story.dur}</span>
            {story.tags.slice(0, 2).map((t) => <span key={t} className="font-body text-[14px] text-ink/80">· {t}</span>)}
          </div>
          <p className="font-body text-[17px] leading-relaxed text-ink/85 mt-5 max-w-[540px]">{story.syn}</p>
          <div className="flex items-center gap-3 mt-7">
            <button onClick={() => onOpen(story.id, "Watch")} className="flex items-center gap-2.5 bg-ink text-bg font-display font-bold uppercase tracking-tight text-[16px] rounded-[10px] px-8 py-3.5 hover:bg-white transition active:scale-[.98]"><PlayI size={24} /> Play</button>
            <button onClick={() => onOpen(story.id)} className="flex items-center gap-2.5 font-body font-semibold text-[15px] text-ink rounded-[10px] px-6 py-3.5 transition active:scale-[.98]" style={{ background: "rgba(255,255,255,.14)" }}><InfoI size={20} /> More Info</button>
            <button onClick={onShuffle} className="flex items-center gap-2.5 font-mono text-[12px] uppercase tracking-[.18em] text-ink/85 rounded-[10px] px-5 py-3.5 border border-line hover:border-ink/40 transition active:scale-[.98]"><ShuffleI size={17} /> Play Something</button>
          </div>
        </div>
      </div>
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
        <div ref={ref} className="flex gap-3.5 overflow-x-auto noscroll px-10 max-w-[1600px] mx-auto" style={{ scrollPaddingLeft: 40 }}>{children}</div>
        <button onClick={() => scroll(1)} className="absolute right-0 top-0 bottom-0 z-20 w-16 flex items-center justify-center text-ink transition-opacity" style={{ opacity: hover ? 1 : 0 }}><span className="rail-fade-r absolute inset-0"></span><span className="relative w-9 h-9 rounded-full bg-bg/70 border border-line flex items-center justify-center"><ChevR size={22} /></span></button>
      </div>
    </section>
  );
}

function PosterCard({ story, onOpen, w = 196, h = 284, progress, landscape }: { story: Story; onOpen: OpenFn; w?: number | string; h?: number; progress?: number; landscape?: boolean }) {
  return (
    <button onClick={() => onOpen(story.id)} className="relative shrink-0 transition-transform duration-200 hover:scale-[1.05] hover:z-10" style={{ width: w }}>
      <div className="relative" style={{ height: h, boxShadow: "0 8px 26px rgba(0,0,0,.4)", borderRadius: 8 }}>
        <PosterArt story={story} showTitle={!landscape} />
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
    </button>
  );
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
  return (
    <>
      {ids.slice(0, 10).map((id, i) => {
        const s = resolveStory(id);
        if (!s) return null;
        return (
          <button key={id} onClick={() => onOpen(id)} className="relative shrink-0 flex items-end transition-transform duration-200 hover:scale-[1.04] hover:z-10" style={{ minWidth: 264 }}>
            <span className="font-display font-black leading-[.7] select-none shrink-0 -mr-2" style={{ fontSize: 200, color: "transparent", WebkitTextStroke: "2.5px rgba(255,255,255,.34)" }}>{i + 1}</span>
            <div className="shrink-0 -ml-3" style={{ width: 164, height: 236, boxShadow: "0 8px 26px rgba(0,0,0,.4)", borderRadius: 8 }}><PosterArt story={s} /></div>
          </button>
        );
      })}
    </>
  );
}

/* ----------------------------- WATCH (real video or doodle) ----------------------------- */
function WatchDoodle({
  story,
  liveMedia,
}: {
  story: Story;
  liveMedia: LiveStoryMediaResult;
}) {
  // liveMedia is lifted to DetailModal so the WATCH / READ / GALLERY
  // surfaces all share the same single fetch. Falls back to the baked
  // story.videoUrl when the live read missed (legacy sample-only entries
  // or before the fetch settled).
  const videoUrl = liveMedia.video_url ?? story.videoUrl;
  if (videoUrl) {
    return (
      <div>
        <div className="relative rounded-[14px] overflow-hidden w-full bg-black" style={{ height: 540 }}>
          <video
            src={videoUrl}
            poster={story.heroImage}
            controls
            preload="metadata"
            playsInline
            className="absolute inset-0 w-full h-full object-contain"
            onError={() => console.warn("[lorewire video err]", { storyId: story.id, src: videoUrl })}
          />
        </div>
        <p className="font-mono text-[11px] uppercase tracking-[.2em] text-muted mt-4">LoreWire Original &middot; doodle short</p>
      </div>
    );
  }
  return (
    <div>
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
        <div className="mt-8 max-w-[660px]">
          <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted mb-3">From the original thread</p>
          <RedditEmbed url={redditTarget.url} title={story.title} />
        </div>
      ) : (
        <div className="mt-8 rounded-[10px] p-5" style={{ background: "#211F29", borderLeft: "3px solid #E8462B" }}>
          <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted mb-2.5">From the original thread</p>
          <div className="flex items-center gap-2 mt-3.5 font-mono text-[11.5px] text-muted flex-wrap">
            <span className="text-ink/80">r/AmItheAsshole</span>
            <span>&middot;</span>
            <span>retold by LoreWire</span>
            <span className="ml-auto text-accent/40 font-medium">View source &rarr;</span>
          </div>
        </div>
      )}
    </article>
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

function DetailModal({ story, initialTab, onClose, onOpen, inList, toggleList }: { story: Story; initialTab?: string; onClose: () => void; onOpen: OpenFn; inList: boolean; toggleList: (id: string) => void }) {
  const [tab, setTab] = useState(initialTab || "Watch");
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
  const c = CAT[story.cat];
  let more = STORIES.filter((s) => s.cat === story.cat && s.id !== story.id);
  if (more.length < 6) more = more.concat(STORIES.filter((s) => s.id !== story.id && !more.includes(s)));
  more = more.slice(0, 6);
  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto scrim-in" style={{ background: "rgba(0,0,0,.82)" }} onClick={onClose}>
      <div className="min-h-full flex items-start justify-center py-10 px-4">
        <div className="modal-in relative w-full max-w-[920px] rounded-[14px] overflow-hidden" style={{ background: "#15141A", boxShadow: "0 40px 120px rgba(0,0,0,.7)" }} onClick={(e) => e.stopPropagation()}>
          <div className="relative h-[400px]">
            <DetailModalHero story={story} />

            <div className="absolute inset-x-0 bottom-0 h-2/3" style={{ background: "linear-gradient(0deg,#15141A 4%, rgba(21,20,26,0) 100%)" }}></div>
            <button onClick={onClose} className="absolute top-5 right-5 w-10 h-10 rounded-full flex items-center justify-center text-ink z-10" style={{ background: "rgba(0,0,0,.5)" }}><XI size={22} /></button>
            <button onClick={() => setTab("Watch")} className="absolute left-10 top-[150px] w-[72px] h-[72px] rounded-full flex items-center justify-center text-bg hover:scale-105 transition" style={{ background: "#F5F3EF", boxShadow: "0 12px 32px rgba(0,0,0,.45)" }}><PlayI size={32} /></button>
            <div className="absolute left-10 right-10 bottom-7">
              <h1 className="font-display font-black uppercase tracking-tightest leading-[.9] text-ink ink-shadow" style={{ fontSize: 54 }}>{story.title}</h1>
            </div>
          </div>
          <div className="px-10 pb-12">
            <div className="flex items-start gap-8 pt-6">
              <div className="flex-1">
                <div className="flex items-center gap-2.5 flex-wrap font-body text-[14px] mb-4">
                  <span className="font-semibold" style={{ color: "#5fcf86" }}>{story.match}% Match</span>
                  <span className="text-muted">{story.year}</span>
                  <span className="px-2 py-0.5 rounded border border-line text-ink/80 font-mono text-[11px]">{story.dur}</span>
                  <span className="px-2 py-0.5 rounded font-mono text-[10px] uppercase tracking-wider" style={{ background: "rgba(232,70,43,.16)", color: "#E8462B" }}>True</span>
                  <span className="px-2.5 py-0.5 rounded-full text-[12px] font-semibold" style={{ background: c, color: "#fff" }}>{story.cat}</span>
                </div>
                <p className="font-body text-[15.5px] leading-relaxed text-ink/85 max-w-[520px]">{story.syn}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0 pt-1">
                <button onClick={() => setTab("Watch")} className="flex items-center gap-2 bg-ink text-bg font-display font-bold uppercase tracking-tight text-[14px] rounded-[9px] px-6 py-3 hover:bg-white transition"><PlayI size={20} /> Play</button>
                <button onClick={() => toggleList(story.id)} title="My List" className="w-11 h-11 rounded-full border border-line flex items-center justify-center transition hover:border-ink/50" style={{ color: inList ? "#E8462B" : "#F5F3EF" }}>{inList ? <CheckI size={20} /> : <PlusI size={20} />}</button>
                <button title="Rate" className="w-11 h-11 rounded-full border border-line flex items-center justify-center text-ink hover:border-ink/50 transition"><StarI size={19} /></button>
                <button title="Share" className="w-11 h-11 rounded-full border border-line flex items-center justify-center text-ink hover:border-ink/50 transition"><ShareI size={19} /></button>
              </div>
            </div>
            <div className="flex gap-8 mt-8 border-b border-line">
              {["Watch", "Read", "Read-along"].map((t) => (
                <button key={t} onClick={() => setTab(t)} className="relative pb-3 font-display font-bold uppercase tracking-tight text-[15px] transition" style={{ color: tab === t ? "#F5F3EF" : "#8E8A97" }}>
                  {t}{tab === t && <span className="absolute left-0 right-0 -bottom-px h-[3px] bg-accent rounded-full"></span>}
                </button>
              ))}
            </div>
            <div className="pt-7">
              {tab === "Watch" && <WatchDoodle story={story} liveMedia={liveMedia} />}
              {tab === "Read" && <Read story={story} liveMedia={liveMedia} />}
              {tab === "Read-along" && <ReadAlong story={story} liveMedia={liveMedia} />}
            </div>
            {pollView && (
              <section className="mt-10">
                <PollWidget
                  pollId={pollView.pollId}
                  question={pollView.question}
                  optionA={pollView.optionA}
                  optionB={pollView.optionB}
                  initialResult={pollView.result}
                  initialVotedSide={pollView.votedSide}
                />
              </section>
            )}
            <section className="mt-12">
              <h2 className="font-display font-bold uppercase tracking-tightest text-[17px] text-ink mb-4">More Like This</h2>
              <div className="grid grid-cols-3 gap-4">
                {more.map((s) => (
                  <button key={s.id} onClick={() => onOpen(s.id)} className="rounded-[10px] overflow-hidden text-left hover:scale-[1.03] transition" style={{ background: "#211F29" }}>
                    <div style={{ height: 150 }}><PosterArt story={s} showTitle={false} rounded={0} /></div>
                    <div className="p-3.5">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="font-mono text-[10px] text-muted">{s.dur}</span>
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
  curation,
  behavior,
  catalog,
  resolveStory,
  pollsInitial,
}: {
  onOpen: OpenFn;
  onShuffle: () => void;
  curation: ReturnType<typeof useHomepageCuration>["curation"];
  behavior: ReturnType<typeof useHomepageCuration>["behavior"];
  catalog: ReturnType<typeof useHomepageCuration>["catalog"];
  resolveStory: ReturnType<typeof useHomepageCuration>["resolveStory"];
  pollsInitial: HomepageInitial["pollRails"];
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

  // Hero behaviour: curation.hero_required forces "no hero curation -> no
  // hero", which HomePage honours by rendering null in the hero slot.
  // Default (false) lets the empty-rail resolver auto-derive a hero so
  // a fresh install doesn't show a blank top of the home page.
  const heroIds = behavior.heroRequired
    ? curation?.hero ?? []
    : resolveRailIds("hero", curation, behavior, catalog) ?? [];
  const heroStory = heroIds[0] ? resolveStory(heroIds[0]) : null;

  const continueIds = resolveRailIds("continue", curation, behavior, catalog, {
    continue: continueState.ids,
  });
  const top10Ids = resolveRailIds("top10", curation, behavior, catalog);
  const newRowIds = resolveRailIds("new_row", curation, behavior, catalog);

  return (
    <div className="pb-20">
      {heroStory && <Hero story={heroStory} onOpen={onOpen} onShuffle={onShuffle} />}
      <div className={heroStory ? "relative -mt-20 z-10" : "relative z-10 pt-[110px]"}>
        {continueIds && continueIds.length > 0 && (
          <Rail title="Continue Watching">
            {continueIds.map((id) => {
              const s = resolveStory(id);
              if (!s) return null;
              return <PosterCard key={id} story={s} onOpen={onOpen} w={300} h={170} landscape />;
            })}
          </Rail>
        )}
        {top10Ids && top10Ids.length > 0 && (
          <Rail title="Top 10 Today">
            <Top10Row onOpen={onOpen} ids={top10Ids} resolveStory={resolveStory} />
          </Rail>
        )}
        {CATEGORY_RAILS.map((rail) => {
          const ids = resolveRailIds(rail.surface, curation, behavior, catalog);
          if (!ids) return null;
          // Skip rails that resolve to no displayable stories at all (no
          // curation + no fallback hits) so the homepage doesn't render
          // an empty section header.
          const items = ids.map((id) => resolveStory(id)).filter((s): s is Story => s !== null);
          if (items.length === 0) return null;
          return (
            <Rail key={rail.surface} title={rail.title}>
              {items.map((s) => <PosterCard key={s.id} story={s} onOpen={onOpen} />)}
            </Rail>
          );
        })}
        {POLL_RAIL_KINDS.map((kind) => {
          const cards = pollRails[kind];
          if (cards.length === 0) return null;
          return (
            <Rail key={`poll-${kind}`} title={POLL_RAIL_TITLES[kind]}>
              {cards.map((row) => (
                <PollRailCard key={row.storyId} row={row} kind={kind} />
              ))}
            </Rail>
          );
        })}
        {newRowIds && newRowIds.length > 0 && (
          <Rail title="New on LoreWire">
            {newRowIds.map((id) => {
              const s = resolveStory(id);
              if (!s) return null;
              return <PosterCard key={id} story={s} onOpen={onOpen} />;
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
}: {
  title: string;
  sub?: string;
  ids: string[];
  onOpen: OpenFn;
  resolveStory: (id: string) => Story | null;
}) {
  // Resolve through the live+sample catalog, NOT byId — saved ids can be
  // real shorts the Reels feed saved that aren't in the baked sample
  // catalog, and byId throws on unknown ids. Unresolved ids are skipped
  // cleanly so a stale My List entry can't crash the page.
  const items = ids.map(resolveStory).filter((s): s is Story => s !== null);
  return (
    <div className="pt-[110px] pb-24 max-w-[1600px] mx-auto px-10">
      <h1 className="font-display font-black uppercase tracking-tightest text-ink text-[40px] leading-none">{title}</h1>
      {sub && <p className="font-mono text-[11px] uppercase tracking-[.2em] text-muted mt-3">{sub}</p>}
      <div className="grid grid-cols-5 gap-5 mt-9">
        {items.map((s) => <div key={s.id} style={{ height: 296 }}><PosterCard story={s} onOpen={onOpen} w={"100%"} h={296} /></div>)}
      </div>
      {items.length === 0 && <p className="font-body text-muted mt-12">Nothing here yet.</p>}
    </div>
  );
}

function SearchPage({ onOpen, query }: { onOpen: OpenFn; query: string }) {
  const res = STORIES.filter((s) => (s.title + s.cat).toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="pt-[110px] pb-24 max-w-[1600px] mx-auto px-10">
      <p className="font-mono text-[11px] uppercase tracking-[.2em] text-muted mb-2">{query ? `Results for "${query}"` : `Browse all · ${STORIES.length} stories`}</p>
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
  const [active, setActive] = useState<{ id: string; tab?: string } | null>(null);
  const [reelsStoryId, setReelsStoryId] = useState<string | null>(null);
  const [solid, setSolid] = useState(false);
  const [query, setQuery] = useState("");

  // My List is the persisted saved-stories store, shared with the Reels feed's
  // Save button and the detail modal so a Save anywhere shows up everywhere.
  const { saved: list, toggle: toggleList } = useSavedStories();
  // 2026-06-19 Phase 2: Recently viewed is recorded whenever the user
  // opens a story (detail sheet or Reels deep-link). LRU ordered, capped
  // at 50 by the engagement-store.
  const { recordView } = useRecentlyViewed();

  // Hoisted curation + live-catalog hook. HomePage reads it through props
  // instead of calling the hook itself so every grid (Browse / New & Hot /
  // My List) can share resolveStory and resolve real-short ids saved
  // through the Reels feed without throwing on byId. The seed comes from
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
  // Lock the page behind a modal AND while the Reels feed owns the viewport.
  useEffect(() => {
    const lock = active !== null || view === "Reels";
    document.body.style.overflow = lock ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [active, view]);

  const open: OpenFn = (id, t) => {
    setActive({ id, tab: t });
    recordView(id);
  };
  const close = () => setActive(null);
  // "Play Something" jumps into the Reels feed (optionally at a story).
  const openReels = (id?: string) => {
    if (id) recordView(id);
    setReelsStoryId(id ?? null);
    close();
    setView("Reels");
  };
  const shuffle = () => openReels();

  return (
    <div className="min-h-screen bg-bg">
      <TopNav view={view} setView={(v) => { if (v !== "Search") setQuery(""); setReelsStoryId(null); setView(v); }} solid={solid || view !== "Home"} query={query} setQuery={setQuery} />

      {view === "Home" && (
        <HomePage
          onOpen={open}
          onShuffle={shuffle}
          curation={curation}
          behavior={behavior}
          catalog={catalog}
          resolveStory={resolveStory}
          pollsInitial={initial.pollRails}
        />
      )}
      {view === "Reels" && <ReelsDesktop onOpenInfo={open} paused={!!active} initialStoryId={reelsStoryId ?? undefined} />}
      {view === "Browse" && <GridPage title="Browse" sub={`All true stories · ${STORIES.length} titles`} ids={STORIES.map((s) => s.id)} onOpen={open} resolveStory={resolveStory} />}
      {view === "New & Hot" && <GridPage title="New & Hot" sub="Fresh threads this week" ids={["stranger", "wifi", "wrongmom", "wrongnumber", "replyall", "groupghost", "rules", "birthday", "seat", "parking"]} onOpen={open} resolveStory={resolveStory} />}
      {view === "My List" && <GridPage title="My List" sub={`${list.length} saved`} ids={list} onOpen={open} resolveStory={resolveStory} />}
      {view === "Search" && <SearchPage onOpen={open} query={query} />}

      <footer className="border-t border-line mt-10">
        <div className="max-w-[1600px] mx-auto px-10 py-9 flex items-center gap-3">
          <span className="font-display font-black text-[20px] tracking-tightest text-ink">LORE<span className="text-accent">WIRE</span></span>
          <span className="font-mono text-[11px] uppercase tracking-[.2em] text-muted">True internet stories, hand-drawn.</span>
        </div>
      </footer>

      {active && (() => {
        // resolveStory checks the live catalog first so real-short ids saved
        // through the Reels feed (not in STORIES) still open the modal.
        // Stale id -> render nothing; close button still works because
        // `active` is set.
        const s = resolveStory(active.id);
        return s ? <DetailModal story={s} initialTab={active.tab} onClose={close} onOpen={open} inList={list.includes(active.id)} toggleList={toggleList} /> : null;
      })()}
    </div>
  );
}
