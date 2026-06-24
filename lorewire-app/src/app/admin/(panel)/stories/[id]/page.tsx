import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/dal";
import {
  getStory,
  getSetting,
  getUserById,
  listSegments,
  type SegmentKind,
  type SegmentRow,
} from "@/lib/repo";
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
import {
  loadHeroStyleSettings,
  saveStoryHeroStyleAction,
  setStoryOverrideAction,
  setStoryNoindexAction,
} from "@/app/admin/actions";
import { HeroStylePicker } from "@/app/admin/(panel)/_components/HeroStylePicker";
import { resolveHeroStyleFromContext } from "@/lib/hero-styles-resolver";
import { heroStyleSourceLabel } from "@/lib/hero-styles";
import { statusClass } from "@/app/admin/ui";
import Breadcrumb from "@/app/admin/Breadcrumb";
import {
  MediaRegenPanel,
  type MediaAssetSpec,
} from "@/app/admin/(panel)/_components/MediaRegenPanel";
import {
  GranularRegenGrid,
  type GranularItem,
} from "@/app/admin/(panel)/_components/GranularRegenGrid";
import { WorldBiblePanel } from "@/app/admin/(panel)/_components/WorldBiblePanel";
import { StatusStepIndicator } from "./StatusStepIndicator";
import { PollEditor } from "./PollEditor";
import {
  getPollByStoryId,
  getPresetForCategory,
  type StoryCategory,
} from "@/lib/polls";
import {
  activeSegmentSettingKey,
  isVideoAspect,
  LEGACY_DEFAULT_ASPECT,
  type VideoAspect,
} from "@/lib/aspect";
import { resolveSceneCount, readSceneCountMode } from "@/lib/scene-count";
import { VoicePicker } from "@/components/voice-picker/VoicePicker";
import { listVoices } from "@/lib/voice-library";
import { one } from "@/lib/db";
import StoryCommentsToggle from "./StoryCommentsToggle";
import { OverviewTab } from "./OverviewTab";
import { StoryTabBar } from "./StoryTabBar";
import {
  asShortClientTab,
  StoryShortTabsClient,
} from "./StoryShortTabsClient";
import { isShortClientTab, resolveStoryTab } from "./tabs";

const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";

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

  // Lazy-load short editor state only when the active tab needs it. The
  // 7 non-overview tabs all render through StoryShortTabsClient and
  // share the same chrome (RenderAfterEditsBanner / RenderStatusPanel /
  // EditSessionBanner / preview player), so the load fires for any of
  // them. Overview pays zero short-related round trips.
  const shortLoad = isShortClientTab(activeTab)
    ? await loadShortClientTabState(id, session.userId)
    : null;

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
  // `voicePickerEnabled` gates the Phase 3 picker (per
  // `_plans/2026-06-14-voiceover-picker.md`). The setting defaults to off
  // ("0") so the picker is dark until the admin flips it on AND the
  // Phase 2.b bake script has populated preview MP3s — that's the
  // contract: don't ship UI that plays broken audio.
  const [intros, outros, defaultAspectRaw, voicePickerEnabledRaw, poll] =
    await Promise.all([
      listSegments("intro"),
      listSegments("outro"),
      getSetting("video.default_aspect"),
      getSetting("voice.picker_enabled"),
      // Phase 1 of _plans/2026-06-17-engagement-polls.md. Either the
      // existing poll row OR null; the editor seeds null rows with the
      // category preset so the form is never empty on first author.
      getPollByStoryId(id),
    ]);
  const pollPreset = getPresetForCategory(s.category);
  const voicePickerEnabled = String(voicePickerEnabledRaw ?? "0") !== "0";

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

  // Pull the voice library only when the picker flag is on. The library
  // does a 24h-memoized live ElevenLabs fetch under the hood; pulling it
  // when the picker is dark wastes a round trip on every story render.
  const voices = voicePickerEnabled ? await listVoices() : [];

  // In-flight regen state. Drives the "Synthesizing voiceover..."
  // pending UI and the disabled regen button — a second click during a
  // running synth would double-spend TTS credit on identical output.
  const [latestVoiceRender, voiceRegenInFlight] = voicePickerEnabled
    ? await Promise.all([
        (await import("@/lib/voice-render-queue")).latestVoiceRenderForStory(
          s.id,
        ),
        (await import("@/lib/voice-render-queue")).hasActiveVoiceRender(s.id),
      ])
    : [null, false];
  const lastVoiceRegenError =
    latestVoiceRender && latestVoiceRender.status === "error"
      ? latestVoiceRender.error
      : null;

  return (
    <div className="space-y-5">
      <Breadcrumb trail={[{ href: "/admin/content", label: "Inbox" }]} />
      <div className="flex items-center justify-end gap-3">
        <span
          className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${statusClass(
            s.status,
          )}`}
        >
          {s.status ?? "draft"}
        </span>
      </div>

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

        {/* Sidebar — constant across all tabs (the right rail keeps the
            per-story controls available no matter which tab is open). */}
        <aside className="space-y-4">
          <div className="rounded-xl border border-line bg-surface p-4">
            <div className={`${LABEL} mb-3`}>Status</div>
            <StatusStepIndicator storyId={s.id} currentStatus={s.status} />
          </div>

          <PollEditor
            storyId={s.id}
            storyCategory={s.category as StoryCategory | string | null}
            poll={poll}
            presetQuestion={pollPreset.question}
            presetOptionA={pollPreset.optionA}
            presetOptionB={pollPreset.optionB}
          />

          <div className="rounded-xl border border-line bg-surface p-4">
            <div className={LABEL}>Search visibility</div>
            <p className="mb-2 text-[12px] text-muted">
              {s.noindex
                ? "Hidden from search engines. /v/${slug} emits noindex,nofollow."
                : "Indexable. /v/${slug} can be crawled and ranked."}
            </p>
            <form action={setStoryNoindexAction}>
              <input type="hidden" name="id" value={s.id} />
              <input
                type="hidden"
                name="noindex"
                value={s.noindex ? "0" : "1"}
              />
              <button className="rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent">
                {s.noindex ? "Show in search engines" : "Hide from search engines"}
              </button>
            </form>
          </div>

          <MediaRegenPanel
            ownerKind="story"
            ownerId={s.id}
            assets={storyAssets}
          />

          {/* Hero & poster style picker (step 5 of
              _plans/2026-06-17-hero-style-registry.md). Reuses the same
              shared HeroStylePicker the settings page renders, but
              points its form at saveStoryHeroStyleAction so the value
              lands on `stories.hero_style_id` (NULL = "use the
              resolver chain"). The caption surfaces the resolved
              style + the layer that produced it — the explicit
              "show the resolution source" ask. The "Restyle hero from
              short character" button on MediaRegenPanel above uses
              the SAME resolution to pick which style to render. */}
          {(() => {
            const ctx = {
              pinnedId: s.hero_style_id,
              category: s.category ?? "Drama",
              storyId: s.id,
              globalStyleId: heroStyleSettings.globalStyleId,
              categoryDefaults: heroStyleSettings.categoryDefaults,
            };
            const resolved = resolveHeroStyleFromContext(ctx);
            const captionPrefix =
              s.hero_style_id
                ? `Pinned to "${resolved.style.label}"`
                : `Currently resolves to "${resolved.style.label}"`;
            const sourceLine = heroStyleSourceLabel(
              resolved.source,
              s.category ?? "Drama",
              resolved.whitelist,
            );
            return (
              <HeroStylePicker
                label="Hero & poster style"
                hint="Closed-enum override for which poster look gets rendered on this story. Empty = let the resolver chain pick (per-category default → global default → smart auto-pick from this category's short-list). Changing this only affects the NEXT hero render — click 'Restyle hero from short character' on the panel above to regenerate."
                selectedId={s.hero_style_id ?? ""}
                thumbnails={heroStyleSettings.thumbnails}
                includeAutoOption
                autoOptionLabel="Use the resolver chain"
                formAction={saveStoryHeroStyleAction}
                formHiddenFields={{ storyId: s.id }}
                captionOverride={`${captionPrefix}. ${sourceLine}.`}
                saveLabel="Save hero style"
              />
            );
          })()}

          {/* Per-story comments open/closed toggle. The control lives
              next to hero style because both are "how this story
              behaves on the public surface" knobs. Site-wide kill
              switch lives at /admin/comments and overrides this
              setting — see the helper text inside the toggle. */}
          <StoryCommentsToggle
            resolvedArticleId={commentsArticleId}
            closed={commentsClosed}
            siteWideEnabled={siteCommentsEnabled}
            revalidatePath={`/admin/stories/${id}`}
          />

          {/* Bible lives in `stories.pipeline_cache` (split off
              video_config 2026-06-14 — see
              `_plans/2026-06-14-pipeline-cache-column.md`). Fall back
              to video_config so stories persisted before the migration
              still render in the inspector. */}
          <WorldBiblePanel
            cacheJson={s.pipeline_cache ?? s.video_config ?? null}
          />

          {sceneGranular.length > 0 && (
            <GranularRegenGrid
              ownerKind="story"
              ownerId={s.id}
              title="Scenes (per-image)"
              description="Redo a single scene without touching the rest."
              items={sceneGranular}
            />
          )}

          {propGranular.length > 0 && (
            <GranularRegenGrid
              ownerKind="story"
              ownerId={s.id}
              title="Props (per-image)"
              description="Redo a single prop. Label + side stay; only the image changes."
              items={propGranular}
            />
          )}

          {voicePickerEnabled && voices.length > 0 && (
            <VoicePicker
              storyId={s.id}
              voices={voices}
              currentProvider={s.voice_provider}
              currentVoiceId={s.voice_id}
              regenInFlight={voiceRegenInFlight}
              lastRegenError={lastVoiceRegenError}
            />
          )}

          <div className="rounded-xl border border-line bg-surface p-4">
            <div className={LABEL}>Media</div>
            {s.hero_image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={s.hero_image}
                alt=""
                className="mb-3 w-full rounded-lg border border-line"
              />
            ) : (
              <p className="mb-2 text-[13px] text-muted">No hero image yet.</p>
            )}
            {gallery.length > 0 && (
              <p className="mb-2 text-[13px] text-muted">
                {gallery.length} illustration(s)
              </p>
            )}
            {s.audio_url && (
              <audio controls src={s.audio_url} className="mb-2 w-full" />
            )}
            {s.video_url ? (
              <video controls src={s.video_url} className="w-full rounded-lg" />
            ) : (
              <p className="text-[13px] text-muted">No video rendered yet.</p>
            )}
            <Link
              href={`/admin/videos/${s.id}`}
              className="mt-3 inline-flex w-full items-center justify-center rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent"
            >
              Open video editor →
            </Link>
          </div>

          <SegmentOverrideCard
            kind="intro"
            label="Intro"
            rows={intros}
            storyId={s.id}
            pinnedId={s.intro_segment_id}
            skip={Boolean(s.skip_intro)}
            globalActiveId={activeIntroId ?? null}
          />

          <SegmentOverrideCard
            kind="outro"
            label="Outro"
            rows={outros}
            storyId={s.id}
            pinnedId={s.outro_segment_id}
            skip={Boolean(s.skip_outro)}
            globalActiveId={activeOutroId ?? null}
          />

          <div className="rounded-xl border border-line bg-surface p-4 font-mono text-[11px] text-muted">
            <div className={LABEL}>Meta</div>
            <p>id: {s.id}</p>
            <p>tokens: {s.tokens ?? 0}</p>
            <p>cost: ${((s.cost_cents ?? 0) / 100).toFixed(2)}</p>
            {s.created_at && <p>created: {s.created_at.slice(0, 16)}</p>}
            {s.published_at && <p>published: {s.published_at.slice(0, 16)}</p>}
          </div>
        </aside>
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

function SegmentOverrideCard({
  kind,
  label,
  rows,
  storyId,
  pinnedId,
  skip,
  globalActiveId,
}: {
  kind: SegmentKind;
  label: string;
  rows: SegmentRow[];
  storyId: string;
  pinnedId: string | null;
  skip: boolean;
  globalActiveId: string | null;
}) {
  const enabledRows = rows.filter((r) => r.enabled !== 0);
  // The select's current value reflects the resolution chain so the UI shows
  // exactly what the render will use: a skip flag wins over a pinned id, and
  // a pinned id wins over the global active.
  const currentValue = skip ? "skip" : pinnedId || "inherit";
  const globalRow = rows.find((r) => r.id === globalActiveId);
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className={LABEL}>{label}</div>
      <form action={setStoryOverrideAction} className="space-y-2">
        <input type="hidden" name="story_id" value={storyId} />
        <input type="hidden" name="kind" value={kind} />
        <select
          name="pick"
          defaultValue={currentValue}
          className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
        >
          <option value="inherit">
            Use global active
            {globalRow ? ` (${globalRow.label ?? globalRow.id.slice(0, 8)})` : " (none set)"}
          </option>
          <option value="skip">Skip — no {kind} for this story</option>
          {enabledRows.length > 0 && (
            <optgroup label="Pin a specific one">
              {enabledRows.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label ?? r.id.slice(0, 8)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button className="w-full rounded-md border border-line px-3 py-1.5 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent">
          Save {label.toLowerCase()} choice
        </button>
      </form>
    </div>
  );
}
