"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  CAT,
  STORIES,
  byId,
  CONTINUE,
  TOP10,
  ENTITLED_ROW,
  NEW_ROW,
  PILLS,
  type Story,
} from "@/lib/stories";
import DesktopShell from "@/components/DesktopShell";
import { RedditEmbed, isRealRedditUrl } from "@/components/RedditEmbed";

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
function Home({ onOpen, onShuffle, pill, setPill }: { onOpen: OpenFn; onShuffle: () => void; pill: string; setPill: (p: string) => void }) {
  const featured = byId("envelope");
  const railClass = "flex gap-3 px-4 overflow-x-auto noscroll pb-1";
  return (
    <div className="pb-28">
      <Billboard story={featured} onOpen={onOpen} onShuffle={onShuffle} />

      <div className="flex gap-2 px-4 py-4 overflow-x-auto noscroll">
        {PILLS.map((p) => (
          <button key={p} onClick={() => setPill(p)} className="shrink-0 px-3.5 py-1.5 rounded-full font-body font-semibold text-[13px] transition"
            style={pill === p ? { background: "#F5F3EF", color: "#0A0A0C" } : { background: "rgba(255,255,255,.07)", color: "#C9C6CE", border: "1px solid rgba(255,255,255,.085)" }}>
            {p}
          </button>
        ))}
      </div>

      <section className="mt-1">
        <RailHead>Continue Watching</RailHead>
        <div className={railClass}>
          {CONTINUE.map(({ id, p }) => <PosterCard key={id} story={byId(id)} onOpen={onOpen} w={150} h={96} progress={p} />)}
        </div>
      </section>

      <section className="mt-7">
        <RailHead>Top 10 Today</RailHead>
        <div className="flex gap-1 px-4 overflow-x-auto noscroll pb-1">
          {TOP10.map((id, i) => (
            <button key={id} onClick={() => onOpen(id)} className="relative shrink-0 flex items-end active:scale-[.97] transition" style={{ minWidth: 170 }}>
              <span className="font-display font-black leading-[.7] select-none shrink-0 -mr-1" style={{ fontSize: 120, color: "transparent", WebkitTextStroke: "2px rgba(255,255,255,.32)" }}>{i + 1}</span>
              <div className="shrink-0 w-[112px] h-[166px] -ml-2"><PosterArt story={byId(id)} /></div>
            </button>
          ))}
        </div>
      </section>

      <section className="mt-7">
        <RailHead>Audacity: Entitled People</RailHead>
        <div className={railClass}>
          {ENTITLED_ROW.map((id) => <PosterCard key={id} story={byId(id)} onOpen={onOpen} />)}
        </div>
      </section>

      <section className="mt-7">
        <RailHead>New on LoreWire</RailHead>
        <div className={railClass}>
          {NEW_ROW.map((id) => <PosterCard key={id} story={byId(id)} onOpen={onOpen} />)}
        </div>
      </section>
    </div>
  );
}

/* ----------------------------- WATCH (real video or doodle frame) ----------------------------- */
function WatchDoodle({ story }: { story: Story }) {
  // Real generated video gets a native player with the hero as poster; the
  // hand-drawn doodle stays as the fallback so older stories without media
  // keep their illustrated look.
  if (story.videoUrl) {
    return (
      <div className="px-4 pt-4 pb-2">
        <div className="relative rounded-[14px] overflow-hidden mx-auto bg-black" style={{ height: 430, width: "100%" }}>
          <video
            src={story.videoUrl}
            poster={story.heroImage}
            controls
            preload="metadata"
            playsInline
            className="absolute inset-0 w-full h-full object-contain"
            onError={() => console.warn("[lorewire video err]", { storyId: story.id, src: story.videoUrl })}
          />
        </div>
        <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted text-center mt-3">LoreWire Original &middot; doodle short</p>
      </div>
    );
  }
  return (
    <div className="px-4 pt-4 pb-2">
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
function _galleryFromStory(story: Story): { src: string; caption: string }[] | null {
  const imgs = story.images || [];
  if (imgs.length === 0) return null;
  const words = story.alignment || [];
  if (words.length === 0) return imgs.map((src) => ({ src, caption: "" }));
  const perScene = Math.max(1, Math.floor(words.length / imgs.length));
  return imgs.map((src, i) => {
    const start = i * perScene;
    const slice = words.slice(start, start + Math.min(10, perScene));
    return { src, caption: slice.map((w) => w.word).join(" ") };
  });
}
// Spread scene images evenly between paragraphs so the Article reads like a
// magazine piece. With N paragraphs and M images, image i goes after paragraph
// floor((i+1) * N / (M+1)) — the +1 keeps the first image off the top and the
// last image off the footer.
function _articleImagePositions(paraCount: number, imageCount: number): Set<number> {
  if (imageCount === 0 || paraCount < 3) return new Set();
  const positions = new Set<number>();
  for (let i = 0; i < imageCount; i++) {
    const idx = Math.floor(((i + 1) * paraCount) / (imageCount + 1));
    positions.add(Math.max(1, Math.min(paraCount - 1, idx)));
  }
  return positions;
}

function GenArticle({ story }: { story: Story }) {
  const paras = (story.body || "").split(/\n{2,}/);
  const scenes = story.images || [];
  const positions = _articleImagePositions(paras.length, scenes.length);
  // Map paragraph index -> which scene to render after it (left-to-right order).
  const posList = Array.from(positions).sort((a, b) => a - b);
  const imgAt = new Map<number, string>();
  posList.forEach((p, i) => {
    if (scenes[i]) imgAt.set(p, scenes[i]);
  });

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
          {imgAt.has(i) && (
            <figure className="my-5">
              <div className="rounded-[12px] overflow-hidden relative" style={{ background: "#15141A", aspectRatio: "16/9" }}>
                <img src={imgAt.get(i)} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ objectPosition: "50% 30%" }} />
              </div>
              <figcaption className="font-mono text-[10px] text-muted mt-1.5">Illustration &middot; LoreWire Studio</figcaption>
            </figure>
          )}
        </React.Fragment>
      ))}
      {isRealRedditUrl(story.source_url) ? (
        <div className="mt-6">
          <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted mb-3">From the original thread</p>
          <RedditEmbed url={story.source_url!} title={story.title} />
        </div>
      ) : (
        <div className="mt-6 rounded-[10px] p-4" style={{ background: "#15141A", borderLeft: "3px solid #E8462B" }}>
          <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted mb-2">From the original thread</p>
          <div className="flex items-center gap-2 font-mono text-[11px] text-muted flex-wrap">
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

function Read({ story }: { story: Story }) {
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
        story.body ? <GenArticle story={story} /> : (
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
          const items = _galleryFromStory(story);
          if (items && items.length > 0) {
            return (
              <div className="fade-in">
                <div className="flex gap-3 overflow-x-auto noscroll snap-x snap-mandatory -mx-1 px-1" id="gallery-scroll">
                  {items.map((g, i) => (
                    <div key={i} className="snap-center shrink-0 rounded-[14px] overflow-hidden" style={{ width: 300, background: "#15141A" }}>
                      <div className="relative" style={{ aspectRatio: "3/4" }}>
                        <img src={g.src} alt="" className="absolute inset-0 w-full h-full object-cover" />
                        <span className="absolute top-3 left-4 font-mono text-[10px] uppercase tracking-[.2em] px-1.5 py-0.5 rounded text-ink" style={{ background: "rgba(0,0,0,.55)" }}>{`Scene ${i + 1}`}</span>
                      </div>
                      {g.caption && <p className="font-body text-[14px] leading-snug text-ink/85 p-4">{g.caption}</p>}
                    </div>
                  ))}
                </div>
                <Dots count={items.length} />
              </div>
            );
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

function ReadAlong({ story }: { story: Story }) {
  const hasReal = !!story.audioUrl && !!story.alignment && story.alignment.length > 0;
  return hasReal ? <RealReadAlong story={story} /> : <FakeReadAlong />;
}

// Real read-along: drives the karaoke from an <audio> element's timeupdate,
// using the alignment word timings the pipeline writes (3.1 STT step).
function RealReadAlong({ story }: { story: Story }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const words = story.alignment || [];

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
        src={story.audioUrl}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
        onError={() => console.warn("[lorewire audio err]", { storyId: story.id, src: story.audioUrl })}
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
  useEffect(() => { setTab(initialTab || "Watch"); }, [story.id, initialTab]);
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
        <button onClick={() => setTab("Watch")} className="absolute left-1/2 top-[120px] -translate-x-1/2 w-16 h-16 rounded-full flex items-center justify-center text-bg active:scale-95 transition" style={{ background: "#F5F3EF", boxShadow: "0 10px 30px rgba(0,0,0,.4)" }}>
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

        <button onClick={() => setTab("Watch")} className="w-full flex items-center justify-center gap-2 bg-ink text-bg font-display font-bold uppercase tracking-tight text-[15px] rounded-[10px] py-3 mt-4 active:scale-[.98] transition">
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
          {tab === "Watch" && <WatchDoodle story={story} />}
          {tab === "Read" && <Read story={story} />}
          {tab === "Read-along" && <ReadAlong story={story} />}
        </div>

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
function MyList({ onOpen, list }: { onOpen: OpenFn; list: string[] }) {
  const items = list.map(byId);
  return (
    <div className="pt-14 px-4 pb-28">
      <h1 className="font-display font-black uppercase tracking-tightest text-ink text-[26px] mb-5">My List</h1>
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
  const items: [string, IconCmp][] = [["Home", HomeI], ["Search", SearchI], ["New", NewI], ["My List", ListI]];
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
function MobileShell() {
  const [tab, setTab] = useState("Home");
  const [pill, setPill] = useState("All");
  const [active, setActive] = useState<{ id: string; tab?: string } | null>(null);
  const [list, setList] = useState<string[]>([]);
  const screenRef = useRef<HTMLDivElement>(null);

  const open: OpenFn = (id, t) => setActive({ id, tab: t });
  const close = () => setActive(null);
  const shuffle = () => {
    const r = STORIES[Math.floor(Math.random() * STORIES.length)];
    open(r.id, "Watch");
  };
  const toggleList = (id: string) => setList((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));

  useEffect(() => {
    if (screenRef.current) screenRef.current.scrollTop = 0;
  }, [tab]);

  return (
    <div className="relative mx-auto w-full max-w-[480px] h-[100dvh] overflow-hidden bg-bg">
      <div ref={screenRef} className="screen noscroll">
        {tab === "Home" && <Home onOpen={open} onShuffle={shuffle} pill={pill} setPill={setPill} />}
        {tab === "Search" && <Search onOpen={open} />}
        {tab === "New" && <NewScreen onOpen={open} />}
        {tab === "My List" && <MyList onOpen={open} list={list} />}
      </div>

      {active && (
        <TitleSheet
          story={byId(active.id)}
          initialTab={active.tab}
          onClose={close}
          onOpen={open}
          inList={list.includes(active.id)}
          toggleList={toggleList}
        />
      )}

      <TabBar tab={tab} setTab={(t) => { close(); setTab(t); }} />
    </div>
  );
}

/* ----------------------------- RESPONSIVE APP ----------------------------- */
// Mobile layout below the lg breakpoint, the desktop layout at lg and up.
// Both mount; CSS shows exactly one, so neither layout regresses the other.
export default function AppShell() {
  return (
    <>
      <div className="lg:hidden">
        <MobileShell />
      </div>
      <div className="hidden lg:block">
        <DesktopShell />
      </div>
    </>
  );
}
