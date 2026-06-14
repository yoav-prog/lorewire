import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/dal";
import {
  getStory,
  getSetting,
  listSegments,
  type SegmentKind,
  type SegmentRow,
} from "@/lib/repo";
import {
  saveStory,
  setStoryOverrideAction,
  setStoryNoindexAction,
} from "@/app/admin/actions";
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
import { CategoryChipGroup } from "./CategoryChipGroup";
import { StatusStepIndicator } from "./StatusStepIndicator";
import { StoryAspectControl } from "./StoryAspectControl";
import { isVideoAspect, LEGACY_DEFAULT_ASPECT, type VideoAspect } from "@/lib/aspect";
import { resolveSceneCount, readSceneCountMode } from "@/lib/scene-count";
import { VoicePicker } from "@/components/voice-picker/VoicePicker";
import { listVoices } from "@/lib/voice-library";

const FIELD =
  "w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";
const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";

export default async function EditStory({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const s = await getStory(id);
  if (!s) notFound();

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
  const [intros, outros, activeIntroId, activeOutroId, defaultAspectRaw, voicePickerEnabledRaw] =
    await Promise.all([
      listSegments("intro"),
      listSegments("outro"),
      getSetting("video.active_intro_id"),
      getSetting("video.active_outro_id"),
      getSetting("video.default_aspect"),
      getSetting("voice.picker_enabled"),
    ]);
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

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        {/* Editor */}
        <form action={saveStory} className="space-y-4">
          <input type="hidden" name="id" value={s.id} />

          <div>
            <label className={LABEL}>Title</label>
            <input name="title" defaultValue={s.title ?? ""} className={FIELD} />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px]">
            <div>
              <label className={LABEL}>Category</label>
              <CategoryChipGroup
                name="category"
                initial={s.category ?? "Entitled"}
              />
            </div>
            <div>
              <label className={LABEL}>Duration</label>
              <input
                name="duration"
                defaultValue={s.duration ?? ""}
                placeholder="2:14"
                className={FIELD}
              />
            </div>
          </div>

          <div>
            <label className={LABEL}>Aspect ratio</label>
            <StoryAspectControl
              storyId={s.id}
              initialAspect={initialAspect}
              globalDefault={!aspectIsOverride}
            />
          </div>

          <div>
            <label className={LABEL}>Source URL</label>
            <input
              name="source_url"
              defaultValue={s.source_url ?? ""}
              className={FIELD}
            />
          </div>

          <div>
            <label className={LABEL}>Synopsis</label>
            <textarea
              name="summary"
              defaultValue={s.summary ?? ""}
              rows={2}
              className={FIELD}
            />
          </div>

          <div>
            <label className={LABEL}>Article body</label>
            <textarea
              name="body"
              defaultValue={s.body ?? ""}
              rows={16}
              className={`${FIELD} font-body leading-relaxed`}
            />
          </div>

          <div>
            <label className={LABEL}>Read-along script</label>
            <textarea
              name="teleprompter"
              defaultValue={s.teleprompter ?? ""}
              rows={6}
              className={FIELD}
            />
          </div>

          <button
            type="submit"
            className="rounded-lg bg-accent px-5 py-2.5 font-semibold text-bg transition-opacity hover:opacity-90"
          >
            Save changes
          </button>
        </form>

        {/* Sidebar */}
        <aside className="space-y-4">
          <div className="rounded-xl border border-line bg-surface p-4">
            <div className={`${LABEL} mb-3`}>Status</div>
            <StatusStepIndicator storyId={s.id} currentStatus={s.status} />
          </div>

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
