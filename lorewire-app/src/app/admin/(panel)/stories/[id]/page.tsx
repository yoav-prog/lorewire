import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/dal";
import { getStory, getSetting, getUserById, listSegments } from "@/lib/repo";
import { readForeignSession } from "@/lib/short-edit-session";
import {
  getLatestFacebookPostForStoryAction,
  getLatestInstagramPostForStoryAction,
  getLatestTikTokPostForStoryAction,
  getLatestYouTubePostForStoryAction,
  getSeoMetadataForStoryAction,
  loadShortEditorState,
  listArticlesLinkedToStoryAction,
  type LinkedArticleSummary,
  type SeoMetadataState,
} from "@/app/admin/(panel)/shorts/[id]/actions";
import { loadHeroStyleSettings } from "@/app/admin/actions";
import Breadcrumb from "@/app/admin/Breadcrumb";
import { type MediaAssetSpec } from "@/app/admin/(panel)/_components/MediaRegenPanel";
import { type GranularItem } from "@/app/admin/(panel)/_components/GranularRegenGrid";
import { getPollByStoryId, getPresetForCategory } from "@/lib/polls";
import {
  activeSegmentSettingKey,
  isVideoAspect,
  LEGACY_DEFAULT_ASPECT,
  type VideoAspect,
} from "@/lib/aspect";
import { resolveSceneCount, readSceneCountMode } from "@/lib/scene-count";
import { listVoices } from "@/lib/voice-library";
import { one } from "@/lib/db";
import { latestShortRenderForStory } from "@/lib/short-render-queue";
import { OverviewTab } from "./OverviewTab";
import { StoryActionBar } from "./StoryActionBar";
import { StoryRail } from "./StoryRail";
import { StoryTabBar } from "./StoryTabBar";
import { StoryShortTabsClient } from "./StoryShortTabsClient";
import {
  asShortClientTab,
  isShortClientTab,
  resolveStoryTab,
} from "./tabs";

export default async function EditStory({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const session = await requireCapability("content.manage");
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const activeTab = resolveStoryTab(sp.tab);
  const s = await getStory(id);
  if (!s) notFound();

  // eslint-disable-next-line no-console -- rule 14 (observability)
  console.info("[unified editor mount]", { storyId: s.id, activeTab });

  // Latest short render — loaded on every tab so the StoryActionBar can
  // surface "is a render in progress?" + last-rendered-at regardless of
  // which tab is active. Cheap: one indexed query. When isShortClientTab
  // is true, loadShortClientTabState reuses this value rather than
  // re-fetching it.
  const latestRender = await latestShortRenderForStory(id).catch((err) => {
    // eslint-disable-next-line no-console -- rule 14
    console.warn("[unified editor page] latestShortRenderForStory failed", {
      err: String(err),
    });
    return null;
  });

  // Lazy-load short editor state only when the active tab needs it. The
  // 7 non-overview tabs all render through StoryShortTabsClient and
  // share the same chrome (RenderAfterEditsBanner / RenderStatusPanel /
  // EditSessionBanner / preview player), so the load fires for any of
  // them. Overview pays zero short-related round trips.
  //
  // Defensive try/catch around the loader: if anything inside the
  // composite load (loadShortEditorState + voices + linked articles +
  // platform posts + SEO + foreign-session resolution) throws, the
  // whole page server-renders a 500 and the user can't get past the
  // tab click. After 2026-06-25 production hot fix, an uncaught throw
  // degrades to a NoShortYetCard with the actual error message so the
  // editor stays reachable AND the failure is visible inline.
  type ShortLoadResult = Awaited<
    ReturnType<typeof loadShortClientTabState>
  >;
  let shortLoad: ShortLoadResult | null = null;
  if (isShortClientTab(activeTab)) {
    try {
      shortLoad = await loadShortClientTabState(id, session.userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      // eslint-disable-next-line no-console -- rule 14 (must surface root cause)
      console.error("[unified editor page] loadShortClientTabState threw", {
        storyId: id,
        activeTab,
        message,
        stack,
      });
      shortLoad = { ok: false, error: `editor-load-threw: ${message}` };
    }
  }

  // Hero style snapshot (global default + every per-category default +
  // every pre-generated thumbnail URL) — one round trip drives the
  // picker render + the resolver caption below.
  const heroStyleSettings = await loadHeroStyleSettings();

  // Comments state for the per-story toggle. The comments key for this
  // story is article.id when there's a linked published article,
  // else story.id — same resolution the public /api/comments/count and
  // the SSR seed do, so the admin's toggle controls the EXACT thread
  // the reader sees. siteWideEnabled is read so the toggle can
  // surface the "kill switch is off" caveat when it's relevant.
  const linkedArticleRow = await one<{ id: string }>(
    "SELECT id FROM articles WHERE story_id = ? AND status = 'published' LIMIT 1",
    [s.id],
  );
  const commentsArticleId = linkedArticleRow?.id ?? s.id;
  const commentsClosed =
    (await getSetting(`comments.article_off.${commentsArticleId}`)) === "1";
  const siteCommentsEnabled =
    (await getSetting("comments.enabled")) !== "0";

  let gallery: string[] = [];
  try {
    gallery = s.images ? (JSON.parse(s.images) as string[]) : [];
  } catch {
    gallery = [];
  }

  // Intro/outro override controls. The dropdown options are the enabled
  // segments for that kind plus an "inherit global" and "skip" sentinel; the
  // server action turns the choice into either a pinned id or a skip flag.
  // Also: pull the global default aspect + parse the per-story override so
  // the editor shows the right starting value (Phase 4 of
  // _plans/2026-06-12-video-aspect-ratio.md).
  //
  // The legacy story-level VoicePicker was removed from the rail in
  // cut 6 — the Voice tab is the canonical per-short voice surface.
  // voice.picker_enabled setting + listVoices load are gone with it.
  const [intros, outros, defaultAspectRaw, poll] = await Promise.all([
    listSegments("intro"),
    listSegments("outro"),
    getSetting("video.default_aspect"),
    // Phase 1 of _plans/2026-06-17-engagement-polls.md. Either the
    // existing poll row OR null; the editor seeds null rows with the
    // category preset so the form is never empty on first author.
    getPollByStoryId(id),
  ]);
  const pollPreset = getPresetForCategory(s.category);

  // Resolve the aspect for THIS story's display. The chain is:
  //   per-story video_config.aspect -> global default -> legacy 9:16.
  // `overriddenAspect` distinguishes the per-story value from the
  // inherited one so the UI can label the field accordingly.
  //
  // Same parse also lifts `scene_prompts` so the granular grid's
  // lightbox can display the exact prompt that produced each thumbnail
  // — without this, the modal renders "no prompt captured" for every
  // scene even though the prompts are sitting right here on the row.
  let storyConfigAspect: VideoAspect | null = null;
  let scenePromptsFromConfig: string[] = [];
  if (s.video_config) {
    try {
      const parsed = JSON.parse(s.video_config);
      if (parsed && typeof parsed === "object") {
        if (isVideoAspect((parsed as { aspect?: unknown }).aspect)) {
          storyConfigAspect = (parsed as { aspect: VideoAspect }).aspect;
        }
        const rawPrompts = (parsed as { scene_prompts?: unknown }).scene_prompts;
        if (Array.isArray(rawPrompts)) {
          scenePromptsFromConfig = rawPrompts.map((p) =>
            typeof p === "string" ? p : "",
          );
        }
      }
    } catch {
      // Malformed config — fall through to the global default.
    }
  }
  const globalDefaultAspect: VideoAspect = isVideoAspect(defaultAspectRaw)
    ? defaultAspectRaw
    : LEGACY_DEFAULT_ASPECT;
  const initialAspect: VideoAspect = storyConfigAspect ?? globalDefaultAspect;
  const aspectIsOverride = storyConfigAspect !== null;

  // The intro/outro that would splice for THIS story's aspect — "active" is
  // per-aspect (2026-06-15), so the override card's "(active)" hint reflects the
  // slot the resolver would actually read for this shape, not a single global
  // pointer.
  const [activeIntroId, activeOutroId] = await Promise.all([
    getSetting(activeSegmentSettingKey("intro", initialAspect)),
    getSetting(activeSegmentSettingKey("outro", initialAspect)),
  ]);

  // Resolve the scene count the pipeline WILL ask for so the rebuild
  // estimate + the asset label both reflect reality — not just the
  // default 30. Mirrors pipeline media.py's auto/manual chain (see
  // `lib/scene-count.ts`).
  const sceneCount = await resolveSceneCount({
    body: s.body,
    duration: s.duration,
  });
  const sceneMode = await readSceneCountMode();
  const sceneCountLabel = sceneMode === "auto"
    ? `All scene images (${sceneCount}, auto)`
    : `All scene images (${sceneCount})`;
  const sceneCountHint = sceneMode === "auto"
    ? `${sceneCount} scenes — derived from the ${s.duration ?? "estimated"} voiceover at the Settings → General "Seconds per scene" rate. Auto adapts to the script length; switch to Manual in Settings to pin an exact number.`
    : `${sceneCount} scenes — pinned in Settings → General → Scenes per story.`;

  // What this story owns that can be regenerated. Order is the order the
  // panel lists them in — hero first (most impactful), then bulk-asset
  // groups (scenes, props), then mouth-swap (specialty).
  const storyAssets: MediaAssetSpec[] = [
    {
      asset: "hero",
      label: "Hero image",
      hint: "The poster frame on the public reader and the OG card.",
    },
    {
      asset: "hero_from_short",
      label: "Restyle hero from short character",
      hint: "Redraws the hero + landscape using the short's character as an i2i reference. Same poster style, same protagonist as the Watch tab.",
    },
    {
      // 2026-06-19 finisher: i2i hero + thumbnail (3:4, 16:9, 1:1) using
      // the short's character AND a picker-chosen scene as references.
      // Story-jobs worker now runs this automatically after every short
      // completes; this button backfills legacy stories that already have
      // a short but no thumbnail. Five paid kie calls per click. Plan:
      // _plans/2026-06-19-reddit-source-auto-deliver-article-short-hero-thumbnail.md.
      asset: "hero_thumbnail_from_short",
      label: "Generate hero + thumbnail from short",
      hint: "Builds hero (3:4 + 16:9) AND thumbnail (3:4 + 16:9 + 1:1) using the short's character plus a picker-chosen dramatic scene. Five i2i calls. Used to backfill stories that pre-date the auto-finisher.",
    },
    {
      asset: "scenes",
      label: sceneCountLabel,
      hint: sceneCountHint,
      imageCountOverride: sceneCount,
    },
  ];
  // Optional bulk regens that only appear when the relevant feature is on.
  const propSlideOn = String((await getSetting("video.prop_slide")) ?? "0") !== "0";
  if (propSlideOn) {
    storyAssets.push({
      asset: "props",
      label: "All prop cutouts",
      hint: "Object cutouts that slide in across the video. Count comes from Settings → General → Props per story.",
    });
  }
  // Build the granular per-image grid items from the already-parsed
  // `gallery` (scene URLs) and the props JSON. Each item carries the
  // queue-contract slug ("scene:N", "prop:N") so the Regenerate button
  // targets exactly that index.
  const sceneGranular: GranularItem[] = gallery.map((url, i) => ({
    asset: `scene:${i}`,
    src: url,
    label: `Scene ${i + 1}`,
    prompt: scenePromptsFromConfig[i] ?? "",
  }));
  let propsParsed: { url: string; label?: string; side?: string }[] = [];
  try {
    if (s.props) {
      const raw = JSON.parse(s.props);
      if (Array.isArray(raw)) {
        propsParsed = raw.filter(
          (p): p is { url: string } => p && typeof p === "object" && typeof p.url === "string",
        );
      }
    }
  } catch {
    propsParsed = [];
  }
  const propGranular: GranularItem[] = propsParsed.map((p, i) => ({
    asset: `prop:${i}`,
    src: p.url,
    label: p.label ?? `Prop ${i + 1}`,
    meta: p.side ? `slides in from ${p.side}` : undefined,
  }));

  const mouthSwapOn = String((await getSetting("video.mouth_swap")) ?? "0") !== "0";
  if (mouthSwapOn) {
    storyAssets.push({
      asset: "mouth_swap",
      label: "Talking head bust",
      hint: "Protagonist portrait + mouth-removed pair for the lip-flap overlay. Two images per regen.",
    });
  }

  return (
    <div className="space-y-4">
      <Breadcrumb trail={[{ href: "/admin/content", label: "Inbox" }]} />

      <StoryActionBar
        storyId={s.id}
        initialStatus={s.status}
        initialRender={latestRender}
        initialNoindex={Boolean(s.noindex)}
      />

      <StoryTabBar storyId={s.id} activeTab={activeTab} />

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        {/* Active tab content */}
        <div className="min-w-0">
          {activeTab === "overview" && (
            <OverviewTab
              story={s}
              initialAspect={initialAspect}
              aspectIsOverride={aspectIsOverride}
            />
          )}
          {isShortClientTab(activeTab) &&
            (shortLoad?.ok ? (
              <StoryShortTabsClient
                storyId={s.id}
                // Safe narrow: we entered this branch because activeTab
                // passed isShortClientTab(); asShortClientTab() can't
                // return null here. The non-null assertion makes the
                // exhaustive switch happy without an `as`.
                activeTab={asShortClientTab(activeTab)!}
                initialConfig={shortLoad.config}
                initialRender={shortLoad.latestRender}
                voices={shortLoad.voices}
                foreignOwnerEmail={shortLoad.foreignOwnerEmail}
                linkedArticles={shortLoad.linkedArticles}
                initialFacebookPost={shortLoad.initialFacebookPost}
                initialInstagramPost={shortLoad.initialInstagramPost}
                initialYouTubePost={shortLoad.initialYouTubePost}
                initialTikTokPost={shortLoad.initialTikTokPost}
                initialSeoMetadata={shortLoad.initialSeoMetadata}
              />
            ) : (
              <NoShortYetCard
                error={shortLoad?.error ?? "unknown"}
                storyId={s.id}
              />
            ))}
        </div>

        {/* Per-tab rail via StoryRail (cut 6). Cards land in either the
            primary section or the Advanced drawer based on which tab is
            active — Overview gets Poll/HeroStyle/MediaPreview/Meta;
            short-config tabs get a focused preview + per-scene regen;
            Render gets the full media-regen + intro/outro + bible
            firehose. Status + Search Visibility live in the
            StoryActionBar above (single source of truth). */}
        <StoryRail
          activeTab={activeTab}
          storyId={s.id}
          storyCategory={s.category ?? null}
          heroStyleId={s.hero_style_id ?? null}
          heroImage={s.hero_image ?? null}
          audioUrl={s.audio_url ?? null}
          videoUrl={s.video_url ?? null}
          pipelineCache={s.pipeline_cache ?? null}
          videoConfig={s.video_config ?? null}
          introSegmentId={s.intro_segment_id ?? null}
          outroSegmentId={s.outro_segment_id ?? null}
          skipIntro={Boolean(s.skip_intro)}
          skipOutro={Boolean(s.skip_outro)}
          tokens={s.tokens ?? null}
          costCents={s.cost_cents ?? null}
          createdAt={s.created_at ?? null}
          publishedAt={s.published_at ?? null}
          gallery={gallery}
          poll={poll}
          pollPreset={pollPreset}
          heroStyleSettings={heroStyleSettings}
          storyAssets={storyAssets}
          sceneGranular={sceneGranular}
          propGranular={propGranular}
          intros={intros}
          outros={outros}
          activeIntroId={activeIntroId ?? null}
          activeOutroId={activeOutroId ?? null}
          commentsArticleId={commentsArticleId}
          commentsClosed={commentsClosed}
          siteCommentsEnabled={siteCommentsEnabled}
        />
      </div>
    </div>
  );
}

// Server-side loader for the 7 short-client tabs. Mirrors the parallel
// loaders in the standalone /admin/shorts/[id]/page.tsx so the unified
// page reaches the same starting state (config blob, latest render,
// voice catalog, linked articles, per-platform publish rows, SEO
// metadata, foreign-session resolution). Best-effort: each side-load
// catches its own error so a transient failure on one of them does not
// blank the entire editor.
async function loadShortClientTabState(
  storyId: string,
  currentUserId: string,
): Promise<
  | {
      ok: true;
      config: import("@/lib/short-config").ShortConfig;
      latestRender: import("@/lib/short-render-queue").ShortRenderRow | null;
      voices: Awaited<ReturnType<typeof listVoices>>;
      linkedArticles: LinkedArticleSummary[];
      foreignOwnerEmail: string | null;
      initialFacebookPost: Awaited<
        ReturnType<typeof getLatestFacebookPostForStoryAction>
      >;
      initialInstagramPost: Awaited<
        ReturnType<typeof getLatestInstagramPostForStoryAction>
      >;
      initialYouTubePost: Awaited<
        ReturnType<typeof getLatestYouTubePostForStoryAction>
      >;
      initialTikTokPost: Awaited<
        ReturnType<typeof getLatestTikTokPostForStoryAction>
      >;
      initialSeoMetadata: SeoMetadataState;
    }
  | { ok: false; error: string }
> {
  const [
    state,
    voices,
    articlesResult,
    initialFacebookPost,
    initialInstagramPost,
    initialYouTubePost,
    initialTikTokPost,
    initialSeoMetadata,
  ] = await Promise.all([
    loadShortEditorState(storyId),
    listVoices().catch((err) => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[unified editor page] listVoices failed", {
        err: String(err),
      });
      return [] as Awaited<ReturnType<typeof listVoices>>;
    }),
    listArticlesLinkedToStoryAction(storyId).catch((err) => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[unified editor page] linked articles failed", {
        err: String(err),
      });
      return { ok: false, articles: [] } as const;
    }),
    getLatestFacebookPostForStoryAction(storyId).catch((err) => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[unified editor page] latest facebook post lookup failed", {
        err: String(err),
      });
      return null;
    }),
    getLatestInstagramPostForStoryAction(storyId).catch((err) => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[unified editor page] latest instagram post lookup failed", {
        err: String(err),
      });
      return null;
    }),
    getLatestYouTubePostForStoryAction(storyId).catch((err) => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[unified editor page] latest youtube post lookup failed", {
        err: String(err),
      });
      return null;
    }),
    getLatestTikTokPostForStoryAction(storyId).catch((err) => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[unified editor page] latest tiktok post lookup failed", {
        err: String(err),
      });
      return null;
    }),
    getSeoMetadataForStoryAction(storyId).catch((err) => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[unified editor page] seo metadata lookup failed", {
        err: String(err),
      });
      return { metadata: null, generatedAt: null } as SeoMetadataState;
    }),
  ]);

  if (!state.ok || !state.config) {
    return { ok: false, error: state.error ?? "no-short-yet" };
  }

  const foreignOwnerEmail = await resolveForeignOwnerEmail(
    state.config,
    currentUserId,
  );

  return {
    ok: true,
    config: state.config,
    latestRender: state.latestRender ?? null,
    voices,
    linkedArticles: articlesResult.ok ? (articlesResult.articles ?? []) : [],
    foreignOwnerEmail,
    initialFacebookPost,
    initialInstagramPost,
    initialYouTubePost,
    initialTikTokPost,
    initialSeoMetadata,
  };
}

// Mirrors the standalone short editor's foreign-session resolver. Returns
// null when the current user owns the session, the session is stale, or
// no session was ever claimed — all of which mean "no banner."
async function resolveForeignOwnerEmail(
  config: import("@/lib/short-config").ShortConfig,
  currentUserId: string,
): Promise<string | null> {
  const read = readForeignSession(config, currentUserId);
  if (!read.isForeign || !read.foreignUserId) return null;
  const otherUser = await getUserById(read.foreignUserId);
  return otherUser?.email ?? read.foreignUserId;
}

function NoShortYetCard({
  error,
  storyId,
}: {
  error: string;
  storyId: string;
}) {
  // Same UX as the standalone short editor's NoShortYet: the most common
  // reason the editor lands cold is "you haven't generated a short for
  // this story yet." The Generate Short button lives on the long-form
  // editor; cut 3 will move it into the unified page so the escape
  // hatch is no longer the only path.
  if (error === "no-short-yet" || error === "short_renders-props-empty") {
    return (
      <div className="rounded-lg border border-line bg-surface p-4">
        <p className="text-[13px] text-ink">
          No short exists for this story yet.
        </p>
        <p className="mt-1 text-[12px] text-muted">
          Generate one from the long-form editor, then come back here to
          fine-tune individual scenes.
        </p>
        <Link
          href={`/admin/videos/${storyId}`}
          className="mt-3 inline-block rounded-md border border-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-accent hover:bg-accent/10"
        >
          Open 16:9 long-form editor
        </Link>
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="rounded-lg border border-warn bg-warn/10 p-4 text-[12px] text-warn"
    >
      Could not load the short editor: {error}
    </div>
  );
}

