"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  CAT,
  STORIES,
  byId,
  PILLS,
  type Story,
} from "@/lib/stories";
import {
  ALL_PILL,
  CATEGORY_RAILS,
  POLL_RAIL_KINDS,
  POLL_RAIL_TITLES,
  filterIdsByPillCat,
  resolveRailIds,
  useHomepageCuration,
  useHomepagePolls,
  useStoryPoll,
  type HomepageInitial,
} from "@/lib/homepage-rails";
import { PollRailCard } from "@/components/PollRail";
import { PollWidget } from "@/components/PollWidget";
import {
  BackToTop,
  InlineJumpToPoll,
  JumpToPoll,
  TopArticleCTA,
} from "@/components/JumpToPoll";
import DesktopShell from "@/components/DesktopShell";
import ReelsFeed from "@/components/reels/ReelsFeed";
import CookieConsent from "@/components/CookieConsent";
import CrossDeviceNudge from "@/components/CrossDeviceNudge";
import SignInChip from "@/components/SignInChip";
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
import {
  useContinueReading,
  useRecentlyViewed,
  useSavedStories,
} from "@/lib/engagement-store";

// Mirror DesktopShell's NO_LIVE_MEDIA seed: until the live fetch resolves
// (or on miss/error) every subview falls back to the baked story shape.
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
const ReelsI: IconCmp = (p) => <Ico {...p} d={<><rect x="3.6" y="3.6" width="16.8" height="16.8" rx="4.5" /><path d="m10 8.4 5 3.6-5 3.6z" /></>} />;

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
      <div className="absolute right-2 top-2 font-mono text-[10px] tracking-wide px-1.5 py-0.5 rounded" style={{ background: "rgba(0,0,0,.5)", color: "#F5F3EF" }}>{story.dur}</div>
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
function Billboard({ story, onOpen, onShuffle }: { story: Story; onOpen: OpenFn; onShuffle: () => void }) {
  const c = CAT[story.cat];
  const [heroOk, setHeroOk] = useState(true);
  // Mobile Billboard is taller than it is wide (500h x ~390-480w), so the
  // portrait hero composes better here than the landscape variant.
  const heroSrc = story.heroImage;
  const showHero = !!heroSrc && heroOk;
  return (
    <div className="relative h-[500px] w-full overflow-hidden">
      <div className="absolute left-5 z-30 flex items-center gap-2" style={{ top: "calc(env(safe-area-inset-top, 0px) + 14px)" }}>
        <span className="relative grid place-items-center bg-ink text-bg font-display font-black rounded-[7px]" style={{ width: 26, height: 26, fontSize: 11, letterSpacing: "-.04em" }}>
          LW
          <span className="absolute rounded-full bg-accent" style={{ top: 3, right: 4, width: 4, height: 4 }}></span>
        </span>
        <span className="font-display font-black tracking-tight text-ink ink-shadow" style={{ fontSize: 18 }}>LoreWire</span>
      </div>
      <div className="absolute inset-0 drift" style={{ background: c }}>
        {showHero && (
          <img
            src={heroSrc}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
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

      <div className="absolute left-0 right-0 bottom-5 px-5">
        <div className="flex items-center gap-2 mb-2.5">
          <span className="w-[3px] h-3.5 bg-accent rounded-full"></span>
          <span className="font-mono text-[10px] uppercase tracking-[.34em] text-ink/90">LW Original</span>
        </div>
        <h1 className="font-display font-black uppercase tracking-tightest leading-[.9] text-ink ink-shadow" style={{ fontSize: 46 }}>{story.title}</h1>
        <div className="flex items-center gap-1.5 mt-3 flex-wrap">
          {story.tags.map((t, i) => (
            <React.Fragment key={t}>
              {i > 0 && <span className="w-1 h-1 rounded-full bg-muted/70"></span>}
              <span className="font-body text-[12.5px] text-ink/85">{t}</span>
            </React.Fragment>
          ))}
        </div>
        <div className="flex items-center gap-2.5 mt-4">
          <button onClick={() => onOpen(story.id, "Watch")} className="flex-1 flex items-center justify-center gap-2 bg-ink text-bg font-display font-bold uppercase tracking-tight text-[15px] rounded-[10px] py-3 active:scale-[.98] transition">
            <PlayI /> Play
          </button>
          <button onClick={() => onOpen(story.id)} className="flex items-center justify-center gap-2 px-4 py-3 rounded-[10px] font-body font-semibold text-[14px] text-ink" style={{ background: "rgba(255,255,255,.13)" }}>
            <InfoI size={18} /> More Info
          </button>
        </div>
        <button onClick={onShuffle} className="mt-3 w-full flex items-center justify-center gap-2 py-2.5 rounded-[10px] border border-line font-mono text-[11px] uppercase tracking-[.2em] text-ink/80 active:scale-[.98] transition">
          <ShuffleI size={15} /> Play Something
        </button>
      </div>
    </div>
  );
}

/* ----------------------------- POSTER CARD (rail) ----------------------------- */
function PosterCard({ story, onOpen, w = 132, h = 192, progress }: { story: Story; onOpen: OpenFn; w?: number | string; h?: number; progress?: number }) {
  return (
    <button onClick={() => onOpen(story.id)} className="relative shrink-0 active:scale-[.97] transition" style={{ width: w }}>
      <div style={{ height: h }}><PosterArt story={story} /></div>
      {progress != null && (
        <div className="absolute left-1.5 right-1.5 bottom-1.5 h-[3px] rounded-full" style={{ background: "rgba(255,255,255,.25)" }}>
          <div className="h-full rounded-full bg-accent" style={{ width: `${progress}%` }}></div>
        </div>
      )}
    </button>
  );
}

/* ----------------------------- HOME ----------------------------- */
function Home({
  onOpen,
  onShuffle,
  pill,
  setPill,
  curation,
  behavior,
  catalog,
  resolveStory,
  pollsInitial,
}: {
  onOpen: OpenFn;
  onShuffle: () => void;
  pill: string;
  setPill: (p: string) => void;
  curation: ReturnType<typeof useHomepageCuration>["curation"];
  behavior: ReturnType<typeof useHomepageCuration>["behavior"];
  catalog: ReturnType<typeof useHomepageCuration>["catalog"];
  resolveStory: ReturnType<typeof useHomepageCuration>["resolveStory"];
  pollsInitial: HomepageInitial["pollRails"];
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
  const heroIds = behavior.heroRequired
    ? curation?.hero ?? []
    : resolveRailIds("hero", curation, behavior, catalog) ?? [];
  const featured = heroIds[0] ? resolveStory(heroIds[0]) : null;

  const continueIdsAll = resolveRailIds("continue", curation, behavior, catalog, {
    continue: continueState.ids,
  });
  const top10IdsAll = resolveRailIds("top10", curation, behavior, catalog);
  const newRowIdsAll = resolveRailIds("new_row", curation, behavior, catalog);

  // 2026-06-21 pill filter (_plans/2026-06-21-category-classifier-and-pills.md).
  // When the user picks a category chip the rails narrow in place: each rail
  // keeps only stories whose `cat` matches the active pill. Empty rails hide
  // via the existing `length > 0` guards below. Hero/Billboard is curation-
  // driven and stays put — pulling the hero out from under the user on a tag
  // pick is jarring (Netflix doesn't do it either).
  const continueIds = filterIdsByPillCat(continueIdsAll, pill, resolveStory);
  const top10Ids = filterIdsByPillCat(top10IdsAll, pill, resolveStory);
  const newRowIds = filterIdsByPillCat(newRowIdsAll, pill, resolveStory);

  const railClass = "flex gap-3 px-4 overflow-x-auto noscroll pb-1";
  return (
    <div className="pb-28">
      {featured && (
        <Billboard story={featured} onOpen={onOpen} onShuffle={onShuffle} />
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
          <RailHead>Continue Watching</RailHead>
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

      {CATEGORY_RAILS.map((rail) => {
        // Pill filter: when a category is active, only show that one
        // category rail — the rest would just be empty or distracting.
        if (pill !== ALL_PILL && rail.cat !== pill) return null;
        const ids = resolveRailIds(rail.surface, curation, behavior, catalog);
        if (!ids) return null;
        const items = ids
          .map((id) => resolveStory(id))
          .filter((s): s is Story => s !== null);
        if (items.length === 0) return null;
        return (
          <section key={rail.surface} className="mt-7">
            <RailHead>{rail.title}</RailHead>
            <div className={railClass}>
              {items.map((s) => (
                <PosterCard key={s.id} story={s} onOpen={onOpen} />
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
        if (cards.length === 0) return null;
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

      {newRowIds && newRowIds.length > 0 && (
        <section className="mt-7">
          <RailHead>New on LoreWire</RailHead>
          <div className={railClass}>
            {newRowIds.map((id) => {
              const s = resolveStory(id);
              if (!s) return null;
              return <PosterCard key={id} story={s} onOpen={onOpen} />;
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
            .filter((s): s is Story => s !== null);
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
            onError={() => console.warn("[lorewire video err]", { storyId: story.id, src: videoUrl })}
          />
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
    <article id="article-top" className="fade-in scroll-mt-20">
      <p className="font-mono text-[10px] uppercase tracking-[.24em] text-accent mb-2">{story.cat} &middot; 6 min read</p>
      <h1 className="font-display font-black uppercase tracking-tightest leading-[.95] text-ink" style={{ fontSize: 30 }}>{story.title}</h1>
      <TopArticleCTA question="Where do you land on this one?" />
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
      <InlineJumpToPoll question={`What's your take on this one?`} />
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
function TitleSheet({ story, initialTab, onClose, onOpen, inList, toggleList }: { story: Story; initialTab?: string; onClose: () => void; onOpen: OpenFn; inList: boolean; toggleList: (id: string) => void }) {
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

  const c = CAT[story.cat];
  const more = STORIES.filter((s) => s.cat === story.cat && s.id !== story.id).slice(0, 6);
  if (more.length < 3) more.push(...STORIES.filter((s) => s.id !== story.id && !more.includes(s)).slice(0, 3));

  const [headerHeroOk, setHeaderHeroOk] = useState(true);
  // TitleSheet header is wider than it is tall (300h vs full-screen width on
  // a 480px-max-width mobile shell) so the landscape variant composes cleaner;
  // portrait is the fallback with the same upper-focus tweak.
  const headerHeroSrc = story.heroImageLandscape || story.heroImage;
  const isHeaderLandscape = !!story.heroImageLandscape;
  const showHeaderHero = !!headerHeroSrc && headerHeroOk;
  return (
    <div className="screen sheet-in z-40 noscroll" style={{ background: "#0A0A0C" }}>
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
          <span className="px-1.5 py-0.5 rounded border border-line text-ink/80 font-mono text-[10px]">{story.dur}</span>
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
          <button className="flex flex-col items-center gap-1 py-2 text-muted active:text-ink transition">
            <StarI size={22} /><span className="font-body text-[11px]">Rate</span>
          </button>
          <button className="flex flex-col items-center gap-1 py-2 text-muted active:text-ink transition">
            <ShareI size={22} /><span className="font-body text-[11px]">Share</span>
          </button>
        </div>

        <p className="font-body text-[14.5px] leading-relaxed text-ink/85 mt-4">{story.syn}</p>

        <div className="flex gap-6 mt-6 border-b border-line">
          {["Watch", "Read", "Read-along"].map((t) => (
            <button key={t} onClick={() => setTab(t)} className="relative pb-2.5 font-display font-bold uppercase tracking-tight text-[14px] transition" style={{ color: tab === t ? "#F5F3EF" : "#8E8A97" }}>
              {t}
              {tab === t && <span className="absolute left-0 right-0 -bottom-px h-[2.5px] bg-accent rounded-full"></span>}
            </button>
          ))}
        </div>

        <div className="-mx-4 mt-2">
          {tab === "Watch" && <WatchDoodle story={story} liveMedia={liveMedia} pendingPlay={pendingPlay} onPlayConsumed={onPlayConsumed} />}
          {tab === "Read" && <Read story={story} liveMedia={liveMedia} />}
          {tab === "Read-along" && <ReadAlong story={story} liveMedia={liveMedia} />}
        </div>

        {pollView && (
          <section id="article-poll" className="mt-8 scroll-mt-20">
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
function Search({ onOpen }: { onOpen: OpenFn }) {
  const [q, setQ] = useState("");
  const res = STORIES.filter((s) => (s.title + s.cat).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="pt-14 px-4 pb-28">
      <h1 className="font-display font-black uppercase tracking-tightest text-ink text-[26px] mb-3">Search</h1>
      <div className="flex items-center gap-2 rounded-[10px] px-3 py-2.5 mb-5" style={{ background: "#15141A", border: "1px solid rgba(255,255,255,.085)" }}>
        <span className="text-muted"><SearchI size={18} /></span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Stories, categories, vibes..." className="bg-transparent outline-none flex-1 font-body text-[14px] text-ink placeholder:text-muted" />
      </div>
      {q === "" && (
        <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted mb-3">Browse all &middot; {STORIES.length} stories</p>
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
function NewScreen({ onOpen }: { onOpen: OpenFn }) {
  const list = ["stranger", "wifi", "wrongmom", "wrongnumber", "rules", "birthday"];
  return (
    <div className="pt-14 px-4 pb-28">
      <h1 className="font-display font-black uppercase tracking-tightest text-ink text-[26px] mb-1">New &amp; Hot</h1>
      <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted mb-5">Fresh threads this week</p>
      <div className="flex flex-col gap-3">
        {list.map((id) => {
          const s = byId(id);
          return (
            <button key={id} onClick={() => onOpen(id)} className="flex gap-3 items-stretch text-left active:scale-[.99] transition">
              <div className="w-[110px] h-[68px] shrink-0"><PosterArt story={s} showTitle={false} /></div>
              <div className="flex-1 min-w-0 py-0.5">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-mono text-[9px] uppercase tracking-[.16em] px-1.5 py-0.5 rounded" style={{ background: CAT[s.cat], color: "#fff" }}>{s.cat}</span>
                  <span className="font-mono text-[10px] text-muted">{s.dur}</span>
                </div>
                <h3 className="font-display font-bold uppercase tracking-tightest text-ink text-[15px] leading-[.98] truncate">{s.title}</h3>
                <p className="font-body text-[12.5px] text-muted leading-snug mt-1 line-clamp-2">{s.syn}</p>
              </div>
            </button>
          );
        })}
      </div>
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
  // shorts the Reels feed saved that aren't in the baked sample catalog, and
  // byId throws on an unknown id. Unresolved ids are skipped cleanly.
  const items = list
    .map(resolveStory)
    .filter((s): s is Story => s !== null);
  return (
    <div className="pt-14 px-4 pb-28">
      {/* Header row: title + sign-in chip. For anonymous users with at
          least one save, the chip is the persistent "save across
          devices" entry point — the nudge fires at most once per
          snooze cycle, but this surface is always reachable. */}
      <div className="mb-5 flex items-center justify-between gap-3">
        <h1 className="font-display font-black uppercase tracking-tightest text-ink text-[26px]">
          My List
        </h1>
        <SignInChip
          session={session}
          tone={!session && items.length > 0 ? "prominent" : "subtle"}
        />
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
  const items: [string, IconCmp][] = [["Home", HomeI], ["Reels", ReelsI], ["Search", SearchI], ["New", NewI], ["My List", ListI]];
  return (
    <div className="absolute bottom-0 left-0 right-0 z-50" style={{ background: "linear-gradient(0deg,#0A0A0C 70%, rgba(10,10,12,0))" }}>
      <div className="flex justify-around items-center pt-2.5 pb-7 px-2">
        {items.map(([label, Icon]) => {
          const active = tab === label;
          return (
            <button key={label} onClick={() => setTab(label)} className="flex flex-col items-center gap-1 flex-1 transition" style={{ color: active ? "#E8462B" : "#8E8A97" }}>
              <Icon size={23} fill={active && label === "My List" ? "#E8462B" : "none"} />
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
  const [active, setActive] = useState<{ id: string; tab?: string } | null>(null);
  const [reelsStoryId, setReelsStoryId] = useState<string | null>(null);
  const screenRef = useRef<HTMLDivElement>(null);

  // My List is the persisted saved-stories store, shared with the Reels feed's
  // Save button and the Title sheet so a Save anywhere shows up everywhere.
  const { saved: list, toggle: toggleList } = useSavedStories();
  // 2026-06-19 Phase 2: Recently viewed is recorded whenever the user
  // opens a story (the detail sheet or a deep-link into Reels). LRU
  // ordering means the most-recent open bubbles to the front; the
  // engagement-store caps the list at 50.
  const { recordView } = useRecentlyViewed();

  // Hoisted curation + live-catalog hook. Home receives the values as
  // props instead of calling the hook itself so MyList and the modal
  // mount site below share one `resolveStory` (real shorts saved through
  // the Reels feed aren't in the baked STORIES catalog). One hook call
  // drives every component on the shell that maps an id to a card. The
  // seed comes from src/app/page.tsx's SSR fetch so the first paint
  // already shows the live curation — no client-fetch flash.
  const { curation, behavior, catalog, resolveStory } = useHomepageCuration({
    curation: initial.curation,
    behavior: initial.behavior,
    liveRows: initial.liveRows,
  });

  const open: OpenFn = (id, t) => {
    setActive({ id, tab: t });
    recordView(id);
  };
  const close = () => setActive(null);
  // "Play Something" jumps straight into the Reels feed (Phase 7 deep-link). An
  // id scrolls to that short if it's in the loaded pages; otherwise the feed
  // opens at the top.
  const openReels = (id?: string) => {
    if (id) recordView(id);
    setReelsStoryId(id ?? null);
    close();
    setTab("Reels");
  };
  const shuffle = () => openReels();

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
            pill={pill}
            setPill={setPill}
            curation={curation}
            behavior={behavior}
            catalog={catalog}
            resolveStory={resolveStory}
            pollsInitial={initial.pollRails}
          />
        )}
        {tab === "Search" && <Search onOpen={open} />}
        {tab === "New" && <NewScreen onOpen={open} />}
        {tab === "My List" && <MyList onOpen={open} list={list} resolveStory={resolveStory} session={initial.session} />}
      </div>

      {/* Reels rides above the (now-empty) screen as a full-cover layer, like
          the Title sheet does — it owns its own snap scroller and pauses
          whenever a sheet opens over it. */}
      {tab === "Reels" && (
        <ReelsFeed
          onOpenInfo={open}
          paused={!!active}
          initialStoryId={reelsStoryId ?? undefined}
        />
      )}

      {active && (() => {
        // resolveStory checks the live catalog first so real-short ids saved
        // through the Reels feed (not in STORIES) still open the sheet.
        // Stale id -> render nothing; close button still works because
        // `active` is set.
        const s = resolveStory(active.id);
        return s ? (
          <TitleSheet
            story={s}
            initialTab={active.tab}
            onClose={close}
            onOpen={open}
            inList={list.includes(active.id)}
            toggleList={toggleList}
          />
        ) : null;
      })()}

      {/* Switching tabs via the nav clears any Reels deep-link target so a plain
          tab tap always opens the feed at the top. */}
      <TabBar tab={tab} setTab={(t) => { close(); setReelsStoryId(null); setTab(t); }} />
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
