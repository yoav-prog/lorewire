// Per-tab rail dispatcher for the unified story editor. Replaces the
// previous one-rail-fits-all aside that stacked 12 cards regardless of
// the active tab and made the page a 4000px scroll.
//
// Layout decision per the AskUserQuestion answer 2026-06-25: each tab
// gets a focused primary section (3-5 cards) plus an Advanced drawer
// that holds the rare-use cards. The drawer is collapsed by default.
//
// Cards live in either the primary section OR the drawer, never both
// — duplicate UI for the same action would violate rule 16. The
// allocation per tab:
//
//   Overview:                Poll, Hero Style, Media preview, Meta
//                            (drawer: Comments, Media re-render,
//                             Granular regen, Intro/Outro, World Bible)
//   Scenes/Captions/etc:     Media preview, Hero Style, Granular scenes
//                            (drawer: same as Overview)
//   Publish & SEO:           Meta
//                            (drawer: Comments only — most rail cards
//                             are not relevant during publishing)
//   Render:                  Media re-render, Granular scenes,
//                            Granular props, Intro/Outro, World Bible,
//                            Meta
//                            (drawer: Comments, Hero Style)
//
// Plan: _plans/2026-06-25-story-action-bar-and-rail-restructure.md.

import type { ReactNode } from "react";
import type { SegmentRow } from "@/lib/repo";
import type { PollRow, StoryCategory } from "@/lib/polls";
import { saveStoryHeroStyleAction } from "@/app/admin/actions";
import { HeroStylePicker } from "@/app/admin/(panel)/_components/HeroStylePicker";
import { resolveHeroStyleFromContext } from "@/lib/hero-styles-resolver";
import { heroStyleSourceLabel } from "@/lib/hero-styles";
import {
  MediaRegenPanel,
  type MediaAssetSpec,
} from "@/app/admin/(panel)/_components/MediaRegenPanel";
import {
  GranularRegenGrid,
  type GranularItem,
} from "@/app/admin/(panel)/_components/GranularRegenGrid";
import { WorldBiblePanel } from "@/app/admin/(panel)/_components/WorldBiblePanel";
import { PollEditor } from "./PollEditor";
import { SegmentOverrideCard } from "./SegmentOverrideCard";
import StoryCommentsToggle from "./StoryCommentsToggle";
import { StoryAdvancedDrawer } from "./StoryAdvancedDrawer";
import type { StoryTabId } from "./tabs";
import type { HeroStyleSettingsSnapshot } from "@/app/admin/actions";

const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";

export interface StoryRailProps {
  activeTab: StoryTabId;
  // Story columns the cards read directly.
  storyId: string;
  storyCategory: string | null;
  heroStyleId: string | null;
  heroImage: string | null;
  audioUrl: string | null;
  videoUrl: string | null;
  pipelineCache: string | null;
  videoConfig: string | null;
  introSegmentId: string | null;
  outroSegmentId: string | null;
  skipIntro: boolean;
  skipOutro: boolean;
  tokens: number | null;
  costCents: number | null;
  createdAt: string | null;
  publishedAt: string | null;
  // Server-loaded data each card needs.
  gallery: string[];
  poll: PollRow | null;
  pollPreset: { question: string; optionA: string; optionB: string };
  heroStyleSettings: HeroStyleSettingsSnapshot;
  storyAssets: MediaAssetSpec[];
  sceneGranular: GranularItem[];
  propGranular: GranularItem[];
  intros: SegmentRow[];
  outros: SegmentRow[];
  activeIntroId: string | null;
  activeOutroId: string | null;
  commentsArticleId: string;
  commentsClosed: boolean;
  siteCommentsEnabled: boolean;
}

export function StoryRail(props: StoryRailProps) {
  const { activeTab } = props;
  const slots = railSlotsFor(activeTab, props);
  return (
    <aside className="space-y-4">
      {slots.primary}
      {slots.advanced.length > 0 && (
        <StoryAdvancedDrawer
          label="Advanced settings"
          hint={`${slots.advanced.length} more setting${
            slots.advanced.length === 1 ? "" : "s"
          } for this tab`}
        >
          {slots.advanced}
        </StoryAdvancedDrawer>
      )}
    </aside>
  );
}

// Returns the primary + advanced card arrays for the active tab. Each
// card is built lazily (as a closure) so the dispatch logic doesn't
// have to declare every JSX block — it just decides where to put each
// card. The order inside each array matters: top-to-bottom rendering.
function railSlotsFor(activeTab: StoryTabId, p: StoryRailProps) {
  const c = renderableCards(p);

  // Comments and Hero Style live in the drawer on most tabs because
  // they're rarely-touched. The exceptions are called out below.
  switch (activeTab) {
    case "overview":
      return {
        primary: [c.poll(), c.heroStyle(), c.mediaPreview(), c.meta()],
        advanced: [
          c.comments(),
          c.mediaRerender(),
          c.granularScenes(),
          c.granularProps(),
          c.intro(),
          c.outro(),
          c.worldBible(),
        ],
      };

    case "scenes":
    case "captions":
    case "style":
    case "script":
    case "voice":
      return {
        primary: [c.mediaPreview(), c.heroStyle(), c.granularScenes()],
        advanced: [
          c.comments(),
          c.poll(),
          c.mediaRerender(),
          c.granularProps(),
          c.intro(),
          c.outro(),
          c.worldBible(),
          c.meta(),
        ],
      };

    case "publish":
      return {
        primary: [c.meta()],
        advanced: [
          c.comments(),
          c.poll(),
          c.heroStyle(),
          c.mediaPreview(),
          c.mediaRerender(),
          c.granularScenes(),
          c.granularProps(),
          c.intro(),
          c.outro(),
          c.worldBible(),
        ],
      };

    case "render":
      return {
        primary: [
          c.mediaRerender(),
          c.granularScenes(),
          c.granularProps(),
          c.intro(),
          c.outro(),
          c.worldBible(),
          c.meta(),
        ],
        advanced: [c.comments(), c.heroStyle(), c.poll(), c.mediaPreview()],
      };

    default: {
      // Exhaustiveness check: if a new tab id is added, TS forces us to
      // think about its rail allocation here.
      const _exhaustive: never = activeTab;
      void _exhaustive;
      return { primary: [], advanced: [] };
    }
  }
}

// All cards, factored as keyed closures. Each closure returns the JSX
// or null when the card has nothing to show (e.g. no scene gallery).
// Centralizing the props plumbing here keeps railSlotsFor focused on
// allocation.
function renderableCards(p: StoryRailProps) {
  return {
    poll: () => (
      <PollEditor
        key="poll"
        storyId={p.storyId}
        storyCategory={p.storyCategory as StoryCategory | string | null}
        poll={p.poll}
        presetQuestion={p.pollPreset.question}
        presetOptionA={p.pollPreset.optionA}
        presetOptionB={p.pollPreset.optionB}
      />
    ),

    heroStyle: (): ReactNode => {
      const ctx = {
        pinnedId: p.heroStyleId,
        category: p.storyCategory ?? "Drama",
        storyId: p.storyId,
        globalStyleId: p.heroStyleSettings.globalStyleId,
        categoryDefaults: p.heroStyleSettings.categoryDefaults,
      };
      const resolved = resolveHeroStyleFromContext(ctx);
      const captionPrefix = p.heroStyleId
        ? `Pinned to "${resolved.style.label}"`
        : `Currently resolves to "${resolved.style.label}"`;
      const sourceLine = heroStyleSourceLabel(
        resolved.source,
        p.storyCategory ?? "Drama",
        resolved.whitelist,
      );
      return (
        <HeroStylePicker
          key="hero-style"
          label="Hero & poster style"
          hint="Closed-enum override for which poster look gets rendered on this story. Empty = let the resolver chain pick (per-category default → global default → smart auto-pick from this category's short-list). Changing this only affects the NEXT hero render."
          selectedId={p.heroStyleId ?? ""}
          thumbnails={p.heroStyleSettings.thumbnails}
          includeAutoOption
          autoOptionLabel="Use the resolver chain"
          formAction={saveStoryHeroStyleAction}
          formHiddenFields={{ storyId: p.storyId }}
          captionOverride={`${captionPrefix}. ${sourceLine}.`}
          saveLabel="Save hero style"
        />
      );
    },

    mediaPreview: () => (
      <div
        key="media-preview"
        className="rounded-xl border border-line bg-surface p-4"
      >
        <div className={LABEL}>Media</div>
        {p.heroImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={p.heroImage}
            alt=""
            className="mb-3 w-full rounded-lg border border-line"
          />
        ) : (
          <p className="mb-2 text-[13px] text-muted">No hero image yet.</p>
        )}
        {p.gallery.length > 0 && (
          <p className="mb-2 text-[13px] text-muted">
            {p.gallery.length} illustration{p.gallery.length === 1 ? "" : "s"}
          </p>
        )}
        {p.audioUrl && (
          <audio controls src={p.audioUrl} className="mb-2 w-full" />
        )}
        {p.videoUrl ? (
          <video controls src={p.videoUrl} className="w-full rounded-lg" />
        ) : (
          <p className="text-[13px] text-muted">No video rendered yet.</p>
        )}
      </div>
    ),

    mediaRerender: () => (
      <MediaRegenPanel
        key="media-rerender"
        ownerKind="story"
        ownerId={p.storyId}
        assets={p.storyAssets}
      />
    ),

    granularScenes: () =>
      p.sceneGranular.length > 0 ? (
        <GranularRegenGrid
          key="granular-scenes"
          ownerKind="story"
          ownerId={p.storyId}
          title="Scenes (per-image)"
          description="Redo a single scene without touching the rest."
          items={p.sceneGranular}
        />
      ) : null,

    granularProps: () =>
      p.propGranular.length > 0 ? (
        <GranularRegenGrid
          key="granular-props"
          ownerKind="story"
          ownerId={p.storyId}
          title="Props (per-image)"
          description="Redo a single prop. Label + side stay; only the image changes."
          items={p.propGranular}
        />
      ) : null,

    intro: () => (
      <SegmentOverrideCard
        key="segment-intro"
        kind="intro"
        label="Intro"
        rows={p.intros}
        storyId={p.storyId}
        pinnedId={p.introSegmentId}
        skip={p.skipIntro}
        globalActiveId={p.activeIntroId}
      />
    ),

    outro: () => (
      <SegmentOverrideCard
        key="segment-outro"
        kind="outro"
        label="Outro"
        rows={p.outros}
        storyId={p.storyId}
        pinnedId={p.outroSegmentId}
        skip={p.skipOutro}
        globalActiveId={p.activeOutroId}
      />
    ),

    worldBible: () => (
      <WorldBiblePanel
        key="world-bible"
        cacheJson={p.pipelineCache ?? p.videoConfig ?? null}
      />
    ),

    comments: () => (
      <StoryCommentsToggle
        key="comments"
        resolvedArticleId={p.commentsArticleId}
        closed={p.commentsClosed}
        siteWideEnabled={p.siteCommentsEnabled}
        revalidatePath={`/admin/stories/${p.storyId}`}
      />
    ),

    meta: () => (
      <div
        key="meta"
        className="rounded-xl border border-line bg-surface p-4 font-mono text-[11px] text-muted"
      >
        <div className={LABEL}>Meta</div>
        <p>id: {p.storyId}</p>
        <p>tokens: {p.tokens ?? 0}</p>
        <p>cost: ${((p.costCents ?? 0) / 100).toFixed(2)}</p>
        {p.createdAt && <p>created: {p.createdAt.slice(0, 16)}</p>}
        {p.publishedAt && <p>published: {p.publishedAt.slice(0, 16)}</p>}
      </div>
    ),
  };
}
