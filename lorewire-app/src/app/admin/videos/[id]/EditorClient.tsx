"use client";

// /admin/videos/[id] editor client. 3-col layout:
//   left   = frame timeline (read-only)
//   center = @remotion/player driving PreviewComposition (live preview)
//   right  = tabs (Trim live; rest stubbed and shipping per the plan)
//
// Trim is now a controlled component: EditorClient owns `draftConfig` and
// passes the live values down to both the Player (so the preview reflects
// edits before save) AND the TrimPanel (so the sliders show what the
// Player is rendering). Save writes the draft to the persisted config via
// saveVideoConfigPatch.
//
// Match the lorewire admin design language (rule 5 + rule 16): dark surface
// tokens (bg-bg / bg-surface / bg-surface2), mono uppercase labels with
// tracking-wider, accent-orange for the one primary CTA. NO purple
// gradients, NO glassmorphism — those are the AI-generated tells the rule
// calls out.

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { statusClass } from "@/app/admin/ui";
import type {
  Overlay,
  ShortCaptionChunk,
  ShortVideoConfig,
} from "@/lib/video-config";
import type { RenderRow, RenderStatus } from "@/lib/video-render-queue";
import type {
  CaptionStyleForPreview,
  ResolvedCaptionStyle,
} from "@/lib/caption-style";
import CaptionStylePanel from "./CaptionStylePanel";
import { FrameCard } from "./FrameCard";
import { FrameRegenActions } from "./FrameRegenActions";
import { BulkConfirmProvider } from "./BulkConfirmContext";
import { RegenerateAllImagesButton } from "./RegenerateAllImagesButton";
import type { ImageRenderRow } from "@/lib/image-render-queue";
import type { CaptionPreset } from "@/lib/caption-presets";
import {
  AutoSaveStatus,
  PositionPicker,
  RangeSlider,
  Slider,
  Toggle,
  useDebouncedSave,
} from "@/components/ui";
import { aspectDims, type VideoAspect } from "@/lib/aspect";
import {
  PreviewComposition,
  type PreviewProps,
} from "@/components/video-preview/PreviewComposition";
import { PreviewEmptyState } from "@/components/video-preview/PreviewEmptyState";
import type { ErrorFallback } from "@remotion/player";
import {
  claimEditSession,
  heartbeatEditSession,
  queueRender,
  saveVideoConfigPatch,
} from "./actions";
import { enqueueImageRegenAction } from "@/app/admin/actions";

// Player is client-only (Remotion's runtime is not SSR-safe). next/dynamic
// with ssr:false gives us code-splitting + no hydration mismatch.
//
// The `loading` fallback uses PreviewEmptyState so the loading state is
// styled identically to every other "preview area can't paint right now"
// state — keeps the editor's center area from ever showing an unlabeled
// surface (Phase 0 of the video editor overhaul).
const PlayerNoSSR = dynamic(
  () => import("@remotion/player").then((m) => m.Player),
  {
    ssr: false,
    loading: () => (
      <div
        className="rounded-lg border border-line overflow-hidden"
        style={{ aspectRatio: "9 / 16", maxHeight: "70vh" }}
      >
        <PreviewEmptyState reason="runtime-loading" />
      </div>
    ),
  },
);

const FPS = 30;

// Resolve the canvas dims the Player + the editor frame should use. Phase
// 4 of _plans/2026-06-12-video-aspect-ratio.md: the aspect chip group in
// the Metadata panel feeds into config.aspect; this helper turns that
// into the right pixel pair without the page ever round-tripping. The
// fallback walks the SAME chain the renderer + pipeline walk (per-story
// override -> global default -> legacy 9:16) so the live Player always
// matches what the rendered MP4 will look like.
function editorCanvasDims(
  aspect: ShortVideoConfig["aspect"],
  globalDefault: VideoAspect,
) {
  const { width, height } = aspectDims(aspect ?? globalDefault);
  return { width, height };
}

type TabKey =
  | "trim"
  | "captions"
  | "caption-style"
  | "audio"
  | "overlays"
  | "metadata";

const TABS: { key: TabKey; label: string }[] = [
  { key: "trim", label: "Trim" },
  { key: "captions", label: "Captions" },
  { key: "caption-style", label: "Style" },
  { key: "audio", label: "Audio" },
  { key: "overlays", label: "Overlays" },
  { key: "metadata", label: "Metadata" },
];

// 30-second heartbeat. Matches the planned
// `video.editor.heartbeat_interval_ms` default in the settings spec and
// keeps the 2-minute STALE_SESSION_MS window in lib/edit-session.ts at
// 4 missed beats before another admin sees us as stale.
const HEARTBEAT_INTERVAL_MS = 30_000;

// 2-second polling for in-flight frame regens (Phase 5 of the editor
// overhaul plan). The image worker takes ~20s+ per regen so 2s is
// cheap and visibly responsive without hammering the server. Polling
// stops the moment every frame has settled.
const FRAME_POLL_INTERVAL_MS = 2_000;

export default function EditorClient({
  storyId,
  storyTitle,
  storyStatus,
  config,
  previewFrameUrls,
  audioUrl,
  derivedDefault,
  latestRender,
  videoRenderStale,
  frameRenderStatuses,
  frameEstimateCents,
  globalDefaultAspect,
  mySessionSpendCents,
  frameRegenSessionCapCents,
  foreignOwnerEmail,
  captionStyle,
  captionStylePreview,
  userCaptionPresets,
  editorIntro,
  editorOutro,
  editorIntroReason,
  editorOutroReason,
  previewSegmentFit,
}: {
  storyId: string;
  storyTitle: string;
  storyStatus: string;
  config: ShortVideoConfig;
  previewFrameUrls: string[];
  audioUrl: string | null;
  derivedDefault: boolean;
  latestRender: RenderRow | null;
  videoRenderStale: boolean;
  frameRenderStatuses: (ImageRenderRow | null)[];
  frameEstimateCents: number;
  /** What `video.default_aspect` is in settings, used by the Metadata
   *  panel's aspect chip when the per-story override is unset so the
   *  picker reflects what the renderer actually uses. */
  globalDefaultAspect: VideoAspect;
  mySessionSpendCents: number | null;
  frameRegenSessionCapCents: number;
  foreignOwnerEmail: string | null;
  captionStyle: ResolvedCaptionStyle;
  captionStylePreview: CaptionStyleForPreview;
  userCaptionPresets: CaptionPreset[];
  /** Resolved intro segment for inline preview playback, or null when
   *  none applies (story skipped it, no global default, aspect mismatch).
   *  See pickSegmentPure in @/lib/segment-resolver. */
  editorIntro: { url: string; durationMs: number; label: string | null } | null;
  editorOutro: { url: string; durationMs: number; label: string | null } | null;
  /** Resolver reasons — surfaced in the Metadata panel's Intro/outro
   *  Section so the admin sees WHY a segment is being skipped (most
   *  often: aspect-mismatch between a 9:16 segment and a 16:9 story). */
  editorIntroReason: string;
  editorOutroReason: string;
  /** How the preview renders a resolved intro/outro when the segment's
   *  actual pixel shape doesn't match the editor canvas. "cover" fills
   *  the frame and crops (the original look). "contain" letterboxes so
   *  shape mismatches are visible as black bars instead of silent
   *  zoom-crop artifacts. Sourced from `video.preview_segment_fit` in
   *  Settings; page.tsx reads the setting and passes the resolved value
   *  here. */
  previewSegmentFit: "cover" | "contain";
}) {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>("trim");
  const [selectedFrameIdx, setSelectedFrameIdx] = useState<number | null>(
    config.doodle_frames.length > 0 ? 0 : null,
  );

  // Concurrency model: if the server saw a foreign live session, we start
  // in "read-only" mode and show a banner. Clicking "Take over" calls
  // claimEditSession and flips us out of read-only. Clicking "Open
  // read-only" keeps the banner state but lets the admin browse. Reload
  // re-classifies — by then either the foreign session is stale or we own
  // the session.
  const [readOnly, setReadOnly] = useState(foreignOwnerEmail !== null);
  // Show the banner whenever a foreign session was detected on the server
  // render. The admin dismisses it implicitly by taking over OR by
  // navigating away — we don't add a close button to avoid surprises
  // (someone closing the banner and then clobbering another admin's edits).
  const [showForeignBanner, setShowForeignBanner] = useState(
    foreignOwnerEmail !== null,
  );

  // Heartbeat: stamp _edit_session on mount, then refresh heartbeat_at
  // every HEARTBEAT_INTERVAL_MS while we own the session. If a heartbeat
  // returns `session-stolen`, fall back to read-only so we don't keep
  // bumping the heartbeat over the new owner.
  useEffect(() => {
    if (readOnly) return; // don't claim if banner is up
    let cancelled = false;
    const stamp = async () => {
      try {
        const result = await heartbeatEditSession(storyId);
        if (!cancelled && !result.ok && result.error === "session-stolen") {
          setReadOnly(true);
          setShowForeignBanner(true);
          // Re-fetch the page to get the new owner's email for the banner.
          router.refresh();
        }
      } catch {
        /* transient — try again next tick */
      }
    };
    // Initial claim (writes started_at = now too).
    claimEditSession(storyId).catch(() => {
      /* worst case: the next heartbeat will retry */
    });
    const id = setInterval(stamp, HEARTBEAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [storyId, readOnly, router]);

  const handleTakeOver = () => {
    setShowForeignBanner(false);
    setReadOnly(false);
    claimEditSession(storyId).then(() => router.refresh());
  };

  // Phase 5 live polling: while any frame regen is queued or generating,
  // call router.refresh() every FRAME_POLL_INTERVAL_MS so the
  // frameRenderStatuses + previewFrameUrls (which both feed FrameCard)
  // come back fresh and the thumbnails + status pills update without
  // the user manually reloading. Stops the moment every frame has
  // settled (done/error/null) so we don't poll forever on an idle
  // editor.
  const anyFrameInFlight = frameRenderStatuses.some(
    (r) => r !== null && (r.status === "queued" || r.status === "generating"),
  );
  useEffect(() => {
    if (!anyFrameInFlight) return;
    // eslint-disable-next-line no-console -- rule 14
    console.info("[video editor regen] poll_started", { story_id: storyId });
    const id = setInterval(() => {
      router.refresh();
    }, FRAME_POLL_INTERVAL_MS);
    return () => {
      clearInterval(id);
      // eslint-disable-next-line no-console -- rule 14
      console.info("[video editor regen] poll_stopped", { story_id: storyId });
    };
  }, [anyFrameInFlight, router, storyId]);

  // Draft config: overlays user edits on top of the persisted config so the
  // Player previews unsaved changes. Reset on persist (server revalidates →
  // new `config` prop comes in → draft regenerates).
  //
  // NaN guards: `??` doesn't catch NaN (NaN != null/undefined), so a
  // malformed persisted config could otherwise carry a NaN into
  // `durationInFrames` below and the Player would throw a hard TypeError.
  // safePositiveInt clamps to a sane default in one place.
  const [draft, setDraft] = useState<DraftEdits>({
    clip_start_ms: safePositiveInt(config.clip_start_ms ?? 0, 0),
    clip_end_ms: safePositiveInt(
      config.clip_end_ms ?? config.duration_ms,
      Math.max(1, safePositiveInt(config.duration_ms, 1)),
    ),
  });

  // Caption draft is held separately from `draft` because it's an array
  // (so the equality comparison costs more) and it's only owned by the
  // captions tab. `null` means "no edits" — preview reads from `config`.
  const [draftCaptions, setDraftCaptions] = useState<
    ShortCaptionChunk[] | null
  >(null);

  // Overlays draft mirrors the captions pattern — null when untouched.
  const [draftOverlays, setDraftOverlays] = useState<Overlay[] | null>(null);

  // Aspect draft (caveat fix round 2 of
  // _plans/2026-06-12-video-aspect-ratio.md): lifted here so the in-
  // header chip group + the Metadata panel both share one source of
  // truth AND the Remotion Player flips orientation live when the
  // chip clicks — no save / page-revalidate round-trip needed. `null`
  // means "no draft override; preview reads the persisted aspect".
  const persistedAspect: VideoAspect =
    (config.aspect as VideoAspect | undefined) ?? globalDefaultAspect;
  const [draftAspect, setDraftAspect] = useState<VideoAspect | null>(null);
  const liveAspect: VideoAspect = draftAspect ?? persistedAspect;

  // The config the Player actually renders — persisted base with the
  // current draft fields merged in. Memoised so the Player doesn't see a
  // new object reference on every render.
  const livePreviewConfig = useMemo<ShortVideoConfig>(
    () => ({
      ...config,
      aspect: liveAspect,
      clip_start_ms: draft.clip_start_ms,
      clip_end_ms: draft.clip_end_ms,
      captions: draftCaptions ?? config.captions,
      overlays: draftOverlays ?? config.overlays,
    }),
    [
      config,
      liveAspect,
      draft.clip_start_ms,
      draft.clip_end_ms,
      draftCaptions,
      draftOverlays,
    ],
  );

  // Derived Player props — duration shrinks to the trimmed window so the
  // scrub bar matches what the rendered MP4 will be. Each step is NaN-
  // clamped because Math.max(1, NaN) returns NaN (Math.max doesn't treat
  // NaN as "lose to anything else"), so a single bad input would otherwise
  // propagate all the way to the Player and throw.
  const trimmedDurationMs = safePositiveInt(
    draft.clip_end_ms - draft.clip_start_ms,
    1,
  );
  const bodyDurationFrames = safePositiveInt(
    Math.ceil((trimmedDurationMs / 1000) * FPS),
    1,
  );
  // Intro / outro contribute their own frames when they resolve. The
  // Series inside PreviewComposition plays them inline; the Player's
  // outer duration grows accordingly so the scrub bar covers the full
  // intro + body + outro timeline. Math.max(0, ...) so a missing
  // duration_ms (legacy segment rows) doesn't poison the addition.
  const introDurationFrames = editorIntro
    ? Math.max(0, Math.round(((editorIntro.durationMs ?? 0) / 1000) * FPS))
    : 0;
  const outroDurationFrames = editorOutro
    ? Math.max(0, Math.round(((editorOutro.durationMs ?? 0) / 1000) * FPS))
    : 0;
  const durationInFrames = safePositiveInt(
    bodyDurationFrames + introDurationFrames + outroDurationFrames,
    1,
  );

  // Aspect-flip modal state lives at EditorClient so both the in-header
  // chip group + the Metadata-tab chip group route through one machinery.
  // `pendingAspect` holds the picker's choice while the admin reads the
  // modal copy; null = no modal. When sceneCount is zero we skip the
  // modal entirely and commit the change directly (no images to be
  // mis-cropped on the new canvas).
  const sceneCount = config.doodle_frames.length;
  const sceneRegenEstimateCents = sceneCount * frameEstimateCents;
  const [pendingAspectFlip, setPendingAspectFlip] = useState<{
    nextAspect: VideoAspect;
  } | null>(null);
  const [aspectSaving, startAspectTransition] = useTransition();
  const [aspectError, setAspectError] = useState<string | null>(null);

  function commitAspectSave(
    nextAspect: VideoAspect,
    regenAssets: readonly string[],
    onSettled?: () => void,
  ) {
    setAspectError(null);
    startAspectTransition(async () => {
      const result = await saveVideoConfigPatch(
        storyId,
        { aspect: nextAspect },
        ["aspect"],
      );
      if (!result.ok) {
        setAspectError(result.error ?? "Aspect save failed");
        // Revert preview to persisted on save failure so the chip can't
        // mislead about what the renderer will pick.
        setDraftAspect(null);
        onSettled?.();
        return;
      }
      // Sequential regen enqueue so the budget gate sees the running
      // total. Parallel would race on the cap and risk over-spend. A
      // mid-list failure stops the chain so the admin sees the actual
      // error instead of a partial enqueue silently swallowing it.
      for (const asset of regenAssets) {
        try {
          console.info("[admin ui] aspect flip + regen enqueue", {
            storyId,
            asset,
          });
          const r = await enqueueImageRegenAction({
            ownerKind: "story",
            ownerId: storyId,
            asset,
          });
          if (!r.ok) {
            setAspectError(
              r.error ?? `${asset} regen queue failed`,
            );
            onSettled?.();
            return;
          }
        } catch (e) {
          setAspectError(
            e instanceof Error
              ? e.message
              : `${asset} regen queue failed`,
          );
          onSettled?.();
          return;
        }
      }
      // Persisted value matches draft now — clear the draft so future
      // re-renders read off the (refreshed) persisted config.
      setDraftAspect(null);
      onSettled?.();
    });
  }

  // The top-level handler the header + the Metadata panel both call.
  // For stories with no scene images yet we skip the modal — there's
  // nothing to be mis-cropped on the new canvas.
  function handleAspectPick(nextAspect: VideoAspect) {
    if (nextAspect === persistedAspect) {
      // Picker re-clicked the same value: just clear any stale draft +
      // any prior error and don't fire the save.
      setDraftAspect(null);
      setAspectError(null);
      return;
    }
    setDraftAspect(nextAspect);
    setAspectError(null);
    if (sceneCount > 0) {
      setPendingAspectFlip({ nextAspect });
      return;
    }
    commitAspectSave(nextAspect, []);
  }

  // eslint-disable-next-line no-console -- rule 14
  console.info("[video editor] client mounted", {
    story_id: storyId,
    tab,
    frames: config.doodle_frames.length,
    preview_urls: previewFrameUrls.length,
    derived_default: derivedDefault,
    has_audio: Boolean(audioUrl),
  });

  return (
    <BulkConfirmProvider defaultEstimateCents={frameEstimateCents}>
    <div
      className="flex flex-col"
      style={{ height: "100svh", overflow: "hidden" }}
    >
      {showForeignBanner && foreignOwnerEmail && (
        <ForeignSessionBanner
          ownerEmail={foreignOwnerEmail}
          onTakeOver={handleTakeOver}
        />
      )}

      <Header
        storyId={storyId}
        storyTitle={storyTitle}
        storyStatus={storyStatus}
        frameCount={config.doodle_frames.length}
        frameEstimateCents={frameEstimateCents}
        durationMs={config.duration_ms}
        trimmedDurationMs={trimmedDurationMs}
        derivedDefault={derivedDefault}
        latestRender={readOnly ? null : latestRender}
        renderDisabled={readOnly}
        sessionSpendCents={mySessionSpendCents}
        sessionCapCents={frameRegenSessionCapCents}
        videoRenderStale={videoRenderStale}
        liveAspect={liveAspect}
        aspectSaving={aspectSaving}
        aspectError={aspectError}
        onAspectPick={readOnly ? undefined : handleAspectPick}
      />

      <div className="flex min-h-0 flex-1">
        {/* Left: frame timeline */}
        <aside
          className="flex shrink-0 flex-col overflow-hidden border-r border-line bg-surface"
          style={{ width: 300 }}
        >
          <div className="shrink-0 space-y-2 border-b border-line px-4 py-3">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
              Storyboard · {config.doodle_frames.length} frames
            </p>
            <a
              href="http://localhost:3001/"
              target="_blank"
              rel="noopener noreferrer"
              title="Requires `npx remotion studio` running in the /video/ project"
              className="block font-mono text-[10px] uppercase tracking-wider text-muted underline-offset-2 hover:text-accent hover:underline"
            >
              Open in Remotion Studio ↗
            </a>
          </div>
          <div className="flex-1 overflow-y-auto">
            {config.doodle_frames.length === 0 ? (
              <EmptyHint
                label="No frames yet"
                hint="Run the media + video pipeline to populate frames."
              />
            ) : (
              config.doodle_frames.map((frame, idx) => {
                const captionIdx = frame.caption_chunk_start_index;
                const captionText = config.captions[captionIdx]?.text ?? "";
                const selected = selectedFrameIdx === idx;
                const latestRender = frameRenderStatuses[idx] ?? null;
                const inFlight =
                  latestRender !== null &&
                  (latestRender.status === "queued" ||
                    latestRender.status === "generating");
                return (
                  <FrameCard
                    key={frame.id}
                    index={idx}
                    url={previewFrameUrls[idx] ?? ""}
                    caption={captionText}
                    filename={frameFilename(frame.url)}
                    isSelected={selected}
                    isRegenerating={inFlight}
                    onClick={() => setSelectedFrameIdx(idx)}
                    actions={
                      selected ? (
                        <FrameRegenActions
                          storyId={storyId}
                          frameId={frame.id}
                          latestRender={latestRender}
                          estimateCents={frameEstimateCents}
                          currentPrompt={frame.image_prompt ?? ""}
                          canRevert={Boolean(frame.prev_image)}
                          enabled={!readOnly}
                        />
                      ) : null
                    }
                  />
                );
              })
            )}
          </div>
        </aside>

        {/* Center: live Player */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-1 items-center justify-center overflow-hidden p-6">
            {config.doodle_frames.length > 0 ? (
              <PreviewHost
                storyId={storyId}
                config={livePreviewConfig}
                frameUrls={previewFrameUrls}
                audioUrl={audioUrl}
                durationInFrames={durationInFrames}
                captionStyle={captionStylePreview}
                globalDefaultAspect={globalDefaultAspect}
                intro={
                  editorIntro && introDurationFrames > 0
                    ? { url: editorIntro.url, durationFrames: introDurationFrames }
                    : null
                }
                outro={
                  editorOutro && outroDurationFrames > 0
                    ? { url: editorOutro.url, durationFrames: outroDurationFrames }
                    : null
                }
                bodyDurationFrames={bodyDurationFrames}
                previewSegmentFit={previewSegmentFit}
              />
            ) : (
              <EmptyPreview
                storyId={storyId}
                aspect={config.aspect}
                globalDefaultAspect={globalDefaultAspect}
              />
            )}
          </div>
          <div className="shrink-0 border-t border-line bg-surface px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-muted">
            {selectedFrameIdx !== null && config.doodle_frames[selectedFrameIdx]
              ? `frame ${selectedFrameIdx + 1} of ${config.doodle_frames.length} · ${frameFilename(config.doodle_frames[selectedFrameIdx].url)}`
              : `${config.captions.length} caption chunks · ${(config.duration_ms / 1000).toFixed(1)}s source`}
          </div>
        </main>

        {/* Right: tabs — pointer-events-none + reduced opacity when a
            foreign session owns the editor. The banner above the header
            is the user's only path forward (Take over). */}
        <aside
          className={`flex shrink-0 flex-col overflow-hidden border-l border-line bg-surface transition-opacity ${
            readOnly ? "pointer-events-none opacity-50" : ""
          }`}
          style={{ width: 340 }}
          aria-disabled={readOnly}
        >
          <div className="flex shrink-0 border-b border-line">
            {TABS.map((t) => {
              const isActive = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`flex-1 px-2 py-3 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                    isActive ? "text-ink" : "text-muted hover:text-ink"
                  }`}
                  style={{
                    borderBottom: isActive
                      ? "2px solid var(--color-accent)"
                      : "2px solid transparent",
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {tab === "trim" ? (
              <TrimPanel
                storyId={storyId}
                config={config}
                draft={draft}
                onDraftChange={setDraft}
              />
            ) : tab === "captions" ? (
              <CaptionsPanel
                storyId={storyId}
                config={config}
                draft={draftCaptions}
                onDraftChange={setDraftCaptions}
              />
            ) : tab === "caption-style" ? (
              <CaptionStylePanel
                storyId={storyId}
                resolved={captionStyle}
                userPresets={userCaptionPresets}
              />
            ) : tab === "audio" ? (
              <AudioPanel storyId={storyId} config={config} />
            ) : tab === "metadata" ? (
              <MetadataPanel
                storyId={storyId}
                config={config}
                editorIntro={editorIntro}
                editorOutro={editorOutro}
                editorIntroReason={editorIntroReason}
                editorOutroReason={editorOutroReason}
                storyAspect={liveAspect}
              />
            ) : tab === "overlays" ? (
              <OverlaysPanel
                storyId={storyId}
                config={config}
                draft={draftOverlays}
                onDraftChange={setDraftOverlays}
              />
            ) : (
              <TabStub tab={tab} config={config} />
            )}
          </div>
        </aside>
      </div>
      {pendingAspectFlip && (
        <AspectFlipModal
          fromAspect={persistedAspect}
          toAspect={pendingAspectFlip.nextAspect}
          sceneCount={sceneCount}
          sceneEstimateCents={sceneRegenEstimateCents}
          heroEstimateCents={frameEstimateCents * 2}
          pending={aspectSaving}
          onCancel={() => {
            if (aspectSaving) return;
            setPendingAspectFlip(null);
            // Revert the live preview to persisted so the chip can't
            // mislead about what the renderer will pick.
            setDraftAspect(null);
          }}
          onSaveOnly={() => {
            commitAspectSave(pendingAspectFlip.nextAspect, [], () =>
              setPendingAspectFlip(null),
            );
          }}
          onSaveAndRegenScenes={() => {
            commitAspectSave(
              pendingAspectFlip.nextAspect,
              ["scenes"],
              () => setPendingAspectFlip(null),
            );
          }}
          onSaveAndRegenAll={() => {
            commitAspectSave(
              pendingAspectFlip.nextAspect,
              // Hero is 2 images (portrait + landscape); the modal's
              // copy makes the cost explicit. Scenes count + cost
              // already reflect the active model rate.
              ["hero", "scenes"],
              () => setPendingAspectFlip(null),
            );
          }}
        />
      )}
    </div>
    </BulkConfirmProvider>
  );
}

// ─── Header ──────────────────────────────────────────────────────────────────

function Header({
  storyId,
  storyTitle,
  storyStatus,
  frameCount,
  frameEstimateCents,
  durationMs,
  trimmedDurationMs,
  derivedDefault,
  latestRender,
  renderDisabled = false,
  sessionSpendCents,
  sessionCapCents,
  videoRenderStale,
  liveAspect,
  aspectSaving,
  aspectError,
  onAspectPick,
}: {
  storyId: string;
  storyTitle: string;
  storyStatus: string;
  frameCount: number;
  /** Per-image cost estimate cents — drives the "Regenerate all images"
   *  button's displayed total. Same number the per-frame card chips show. */
  frameEstimateCents: number;
  durationMs: number;
  trimmedDurationMs: number;
  derivedDefault: boolean;
  latestRender: RenderRow | null;
  renderDisabled?: boolean;
  /** Cents spent on frame regens this session. null = this admin doesn't
   *  own the edit session (read-only). Hides the chip. */
  sessionSpendCents: number | null;
  /** Hard cap for the chip. Read from settings server-side. */
  sessionCapCents: number;
  /** True when the latest video render is stale because frames have been
   *  regenerated since. Renders a badge with a Re-render CTA. */
  videoRenderStale: boolean;
  /** The current live (draft-or-persisted) aspect — drives the in-header
   *  chip group so the admin can flip aspect without entering the
   *  Metadata tab. The preview updates immediately; the save fires via
   *  `onAspectPick` and surfaces through `aspectSaving` / `aspectError`. */
  liveAspect: VideoAspect;
  aspectSaving: boolean;
  aspectError: string | null;
  /** Undefined when the admin doesn't own the session — the chip
   *  renders disabled in that case. */
  onAspectPick: ((next: VideoAspect) => void) | undefined;
}) {
  const trimmed = trimmedDurationMs !== durationMs;
  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line bg-bg/85 px-5 py-3 backdrop-blur">
      <div className="flex min-w-0 items-center gap-4">
        <Link
          href={`/admin/stories/${storyId}`}
          className="font-mono text-[12px] uppercase tracking-wider text-muted transition-colors hover:text-ink"
        >
          &larr; Story
        </Link>
        <div className="min-w-0">
          <p className="truncate font-display text-[15px] font-bold tracking-tightest">
            {storyTitle}
          </p>
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
            video editor · {frameCount} frames ·{" "}
            {trimmed ? (
              <>
                {(trimmedDurationMs / 1000).toFixed(1)}s
                <span className="text-muted/70">
                  {" / "}
                  {(durationMs / 1000).toFixed(1)}s source
                </span>
              </>
            ) : (
              <>{(durationMs / 1000).toFixed(1)}s</>
            )}
            {derivedDefault && (
              <>
                {" · "}
                <span className="text-cat-entitled">
                  derived default — pipeline hasn’t written yet
                </span>
              </>
            )}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {videoRenderStale && !renderDisabled && (
          <span
            className="rounded-full border border-warn/40 bg-warn/15 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-warn"
            title="Frame images have been regenerated since the last MP4 render. Re-render to refresh the video."
            data-testid="stale-render-badge"
          >
            Stale render
          </span>
        )}
        <HeaderAspectPicker
          value={liveAspect}
          onPick={onAspectPick}
          saving={aspectSaving}
          error={aspectError}
        />
        <RegenerateAllImagesButton
          storyId={storyId}
          sceneCount={frameCount}
          perImageEstimateCents={frameEstimateCents}
          enabled={!renderDisabled}
        />
        {sessionSpendCents !== null && (
          <SessionSpendChip
            spentCents={sessionSpendCents}
            capCents={sessionCapCents}
          />
        )}
        <span
          className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${statusClass(
            storyStatus,
          )}`}
        >
          {storyStatus}
        </span>
        {renderDisabled ? (
          <button
            type="button"
            disabled
            className="rounded-md bg-accent/30 px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg/50 cursor-not-allowed"
            title="Another admin owns this session — take over to enable"
          >
            Render
          </button>
        ) : (
          <RenderControl storyId={storyId} latestRender={latestRender} />
        )}
      </div>
    </header>
  );
}

// ─── HeaderAspectPicker ──────────────────────────────────────────────────────
// Compact 2-chip aspect picker rendered in the editor header so the admin
// can flip between 16:9 and 9:16 without leaving the current tab. Clicking
// a chip immediately reflects in the live Player preview (lifted state in
// EditorClient) AND fires the save flow (with the regen-cost modal when
// scene images exist). When `onPick` is undefined the picker renders as a
// read-only display — the admin doesn't own the session.

function HeaderAspectPicker({
  value,
  onPick,
  saving,
  error,
}: {
  value: VideoAspect;
  onPick: ((next: VideoAspect) => void) | undefined;
  saving: boolean;
  error: string | null;
}) {
  const disabled = !onPick || saving;
  function btn(next: VideoAspect, label: string, frame: React.ReactNode) {
    const selected = value === next;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        data-aspect={next}
        disabled={disabled || selected}
        onClick={() => onPick?.(next)}
        title={
          !onPick
            ? "Another admin owns this session"
            : saving
              ? "Saving aspect…"
              : `Switch to ${next}`
        }
        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
          selected
            ? "border-accent bg-accent/15 text-ink"
            : "border-line bg-bg text-muted hover:border-ink hover:text-ink"
        } disabled:cursor-not-allowed`}
      >
        <span className="inline-flex">{frame}</span>
        <span>{label}</span>
      </button>
    );
  }
  return (
    <div
      role="radiogroup"
      aria-label="Video aspect"
      data-testid="header-aspect-picker"
      className="flex items-center gap-1"
      title={error ?? undefined}
    >
      {btn(
        "16:9",
        "16:9",
        <span
          aria-hidden
          className="block rounded-sm border border-line bg-surface2"
          style={{ width: 16, height: 9 }}
        />,
      )}
      {btn(
        "9:16",
        "9:16",
        <span
          aria-hidden
          className="block rounded-sm border border-line bg-surface2"
          style={{ width: 9, height: 16 }}
        />,
      )}
      {saving && (
        <span className="font-mono text-[9px] uppercase tracking-wider text-warn">
          saving…
        </span>
      )}
      {error && !saving && (
        <span
          className="font-mono text-[9px] uppercase tracking-wider text-danger"
          title={error}
        >
          save failed
        </span>
      )}
    </div>
  );
}

// ─── SessionSpendChip ────────────────────────────────────────────────────────
// Phase 4 of the video editor overhaul: running per-session spend on
// frame regens with the hard cap from settings. Counts completed regens
// at actual cost plus in-flight regens at the per-image estimate (the
// "hard" cap stays honest under double-click bursts). Color flips warn
// at 80% of cap and danger at 100% so the user gets a visible nudge
// before queueFrameImageRegen starts rejecting.

function SessionSpendChip({
  spentCents,
  capCents,
}: {
  spentCents: number;
  capCents: number;
}) {
  const fraction = capCents > 0 ? spentCents / capCents : 0;
  const tone =
    fraction >= 1
      ? "border-danger/40 bg-danger/15 text-danger"
      : fraction >= 0.8
        ? "border-warn/40 bg-warn/15 text-warn"
        : "border-line bg-surface2 text-muted";
  return (
    <span
      className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${tone}`}
      title={`Frame regens spent this editor session, hard cap from Settings → Video editor → Session cap`}
      data-testid="session-spend-chip"
    >
      Session ${(spentCents / 100).toFixed(2)} / ${(capCents / 100).toFixed(2)}
    </span>
  );
}

// ─── ForeignSessionBanner ────────────────────────────────────────────────────
// Yellow strip above the header when a foreign edit session is fresh. Two
// affordances: Take over (claims the session, hides banner, enables editing)
// or just stay in read-only and browse. The banner is informational — no
// server-side lock — but the editor stays disabled until the admin
// explicitly takes over, so we never silently clobber another admin's
// in-flight edits.

function ForeignSessionBanner({
  ownerEmail,
  onTakeOver,
}: {
  ownerEmail: string;
  onTakeOver: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-4 border-b border-high/40 bg-high/10 px-5 py-2">
      <p className="font-mono text-[11px] text-high">
        <span className="font-semibold uppercase tracking-wider">
          read-only
        </span>{" "}
        · <strong className="font-semibold">{ownerEmail}</strong> is editing
        this video. Take over to make changes — their edits stay saved.
      </p>
      <button
        type="button"
        onClick={onTakeOver}
        className="rounded-md border border-high/60 bg-high/30 px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-wider text-high transition-colors hover:bg-high/45"
      >
        Take over
      </button>
    </div>
  );
}

// ─── RenderControl ──────────────────────────────────────────────────────────
// Header-mounted Render button + status badge + polling.
//
// Flow:
//   1. Admin clicks → `queueRender` action inserts a video_renders row
//      (idempotent on the current persisted-config hash).
//   2. We start polling /api/renders/[id] every 2s while the row is
//      queued/rendering.
//   3. On done, router.refresh() so the page re-fetches the new video_url
//      and the latest-render header reflects it.
//   4. On error, show the error message under the button.
//
// The polling interval is intentionally constant (no exponential backoff)
// — renders take ~real-time on a laptop, so 2s is the right granularity.
// Server returns the row as-is; polling is read-only.

const POLL_INTERVAL_MS = 2000;

function RenderControl({
  storyId,
  latestRender,
}: {
  storyId: string;
  latestRender: RenderRow | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // We track the row we're watching separately from the server-supplied
  // `latestRender`. On click we hot-swap with the response from queueRender;
  // polling updates this state in place.
  const [active, setActive] = useState<RenderRow | null>(latestRender);

  // Re-sync when the server passes in a fresh latestRender (page revalidated
  // after queueRender's revalidatePath). React 19 forbids setState inside an
  // effect for this kind of prop-driven state sync; the sanctioned pattern is
  // to track the previous prop value during render and update state inline.
  // Compare by id to avoid clobbering mid-flight poll updates.
  const [prevServerRender, setPrevServerRender] =
    useState<RenderRow | null>(latestRender);
  if (latestRender !== prevServerRender) {
    setPrevServerRender(latestRender);
    if (!active || (latestRender && latestRender.id !== active.id)) {
      setActive(latestRender);
    }
  }

  // Poll while the active row is in flight. Stops cleanly on status
  // transition or unmount; never starts when nothing's in flight.
  const isInFlight =
    active !== null && (active.status === "queued" || active.status === "rendering");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isInFlight || !active) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/renders/${active.id}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const next = (await res.json()) as RenderRow;
        setActive(next);
        if (next.status === "done") {
          // Pull the new video_url into the server-rendered page state so
          // the preview composition mounts against the fresh config too.
          router.refresh();
        }
      } catch {
        /* transient poll error — try again next tick */
      }
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [isInFlight, active, router]);

  const handleClick = () => {
    setError(null);
    startTransition(async () => {
      const result = await queueRender(storyId);
      if (!result.ok) {
        if (result.error === "daily-cap-exceeded") {
          setError(
            `Daily render cap (${result.capLimit}) reached — ${result.capCount} renders in the last 24 h. Bump video.daily_renders_per_story in settings to lift the cap.`,
          );
        } else {
          setError(result.error ?? "Enqueue failed");
        }
        return;
      }
      if (result.render) setActive(result.render);
    });
  };

  const statusLabel = renderStatusLabel(active?.status, active?.progress);
  const buttonLabel = isInFlight
    ? statusLabel
    : pending
      ? "Queueing…"
      : "Render";

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {active && !isInFlight && (
          <RenderStatusBadge
            status={active.status}
            error={active.error}
          />
        )}
        <button
          type="button"
          onClick={handleClick}
          disabled={pending || isInFlight}
          className="rounded-md bg-accent px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
        >
          {buttonLabel}
        </button>
      </div>
      {error && (
        <p className="font-mono text-[10px] text-danger">{error}</p>
      )}
    </div>
  );
}

function RenderStatusBadge({
  status,
  error,
}: {
  status: RenderStatus;
  error: string | null;
}) {
  if (status === "done") {
    return (
      <span className="rounded-full border border-cat-wholesome/40 bg-cat-wholesome/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-cat-wholesome">
        last render: done
      </span>
    );
  }
  if (status === "error") {
    return (
      <span
        title={error ?? undefined}
        className="rounded-full border border-danger/40 bg-danger/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-danger"
      >
        last render: error
      </span>
    );
  }
  return null;
}

function renderStatusLabel(
  status: RenderStatus | undefined,
  progress: number | undefined,
): string {
  if (status === "queued") return "Queued…";
  if (status === "rendering") {
    const pct = Math.max(0, Math.min(100, Math.round((progress ?? 0) * 100)));
    return `Rendering ${pct}%`;
  }
  return "Render";
}

// ─── PreviewHost ──────────────────────────────────────────────────────────────

function PreviewHost({
  storyId,
  config,
  frameUrls,
  audioUrl,
  durationInFrames,
  captionStyle,
  globalDefaultAspect,
  intro,
  outro,
  bodyDurationFrames,
  previewSegmentFit,
}: {
  storyId: string;
  config: ShortVideoConfig;
  frameUrls: string[];
  audioUrl: string | null;
  durationInFrames: number;
  captionStyle: CaptionStyleForPreview;
  globalDefaultAspect: VideoAspect;
  intro: { url: string; durationFrames: number } | null;
  outro: { url: string; durationFrames: number } | null;
  bodyDurationFrames: number;
  /** 2026-06-14 toggle — see EditorClient's prop docstring. */
  previewSegmentFit: "cover" | "contain";
}) {
  // Phase 0 observability: log key inputs whenever they change so a user
  // reporting "the preview is broken" can paste the [video editor preview]
  // events from devtools and we can name the cause without a screen share.
  // We log the shape, not the full inputProps blob, to keep the console
  // useful instead of noisy.
  useEffect(() => {
    const resolvedFrames = frameUrls.filter((u) => Boolean(u)).length;
    // eslint-disable-next-line no-console -- rule 14
    console.info("[video editor preview] mounted", {
      story_id: storyId,
      frame_count: config.doodle_frames.length,
      preview_url_count: frameUrls.length,
      resolved_url_count: resolvedFrames,
      has_audio: Boolean(audioUrl),
      duration_in_frames: durationInFrames,
    });
  }, [
    storyId,
    config.doodle_frames.length,
    frameUrls,
    audioUrl,
    durationInFrames,
  ]);

  // Diagnostic: report the Player container's ACTUAL computed dimensions
  // a moment after mount. The 2026-06-12 bug that took 6 commits to find
  // was the container collapsing to 0×0 because `max-height: 70vh` +
  // `width: auto` + `aspect-ratio` inside a flex `items-center` parent
  // doesn't give the browser a defined dimension to derive the other
  // from. This log catches the same class of regression next time
  // without needing a devtools deep dive.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const t = setTimeout(() => {
      const rect = el.getBoundingClientRect();
      // eslint-disable-next-line no-console -- rule 14
      console.info("[video editor preview] container_size", {
        story_id: storyId,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }, 100);
    return () => clearTimeout(t);
  }, [storyId]);

  // Player wants `Record<string, unknown>` for inputProps + a similarly-
  // loose component type. We keep the strong PreviewProps type internally
  // and cast at the boundary — matches the SpikeClient pattern.
  // Computed before the empty-state early-return so the rules-of-hooks
  // contract is satisfied (hooks must run on every render); the empty
  // branch just doesn't use the memoised value.
  const inputProps = useMemo<PreviewProps>(
    () => ({
      config,
      frameUrls,
      audioUrl,
      captionStyle,
      intro,
      outro,
      bodyDurationFrames,
      previewSegmentFit,
    }),
    [
      config,
      frameUrls,
      audioUrl,
      captionStyle,
      intro,
      outro,
      bodyDurationFrames,
      previewSegmentFit,
    ],
  );

  // Pre-flight: if every URL is empty, there is nothing for the Player to
  // paint and the iframe would sit blank. Render the labeled diagnostic
  // straight away instead of mounting the Player into a void.
  // Phase 4 of _plans/2026-06-12-video-aspect-ratio.md: resolve the
  // canvas dims from the config's aspect so the Player matches the
  // shape the renderer will produce. Recomputed per render so flipping
  // aspect from the Metadata panel + saving updates the preview live.
  const { width: canvasWidth, height: canvasHeight } = editorCanvasDims(
    config.aspect,
    globalDefaultAspect,
  );

  const resolvedUrlCount = frameUrls.filter((u) => Boolean(u)).length;
  if (resolvedUrlCount === 0) {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[video editor preview] empty", {
      story_id: storyId,
      reason: "no-frame-urls",
      frame_count: config.doodle_frames.length,
    });
    return (
      <div
        className="rounded-lg border border-line overflow-hidden"
        style={{
          aspectRatio: `${canvasWidth} / ${canvasHeight}`,
          maxHeight: "70vh",
        }}
      >
        <PreviewEmptyState
          reason="no-frame-urls"
          detail={`${config.doodle_frames.length} frame(s) in config · 0 resolved URLs`}
          storyId={storyId}
        />
      </div>
    );
  }

  const Component = PreviewComposition as unknown as React.ComponentType<
    Record<string, unknown>
  >;
  const playerInputProps = inputProps as unknown as Record<string, unknown>;

  // If the composition throws inside the Player iframe, surface the
  // message inline (and log it) instead of letting the iframe disappear
  // and the container's backdrop read as an unlabeled void.
  const errorFallback: ErrorFallback = ({ error }) => {
    // eslint-disable-next-line no-console -- rule 14
    console.info("[video editor preview] player_error", {
      story_id: storyId,
      message: error.message,
    });
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
      >
        <PreviewEmptyState
          reason="player-error"
          detail={error.message}
          storyId={storyId}
        />
      </div>
    );
  };

  // Layout: the OUTER container has an explicit `height` (not max-height)
  // so `aspect-ratio` + `width: auto` actually computes width. Earlier
  // `max-height` alone left the box at 0×0 inside the flex parent. The
  // `PreviewEmptyState` sits BEHIND the Player at z-index 0 so even if
  // the iframe paints nothing the user sees labeled cream content rather
  // than the surrounding chrome blending through. The Player covers it
  // at z-index 1 when it actually renders.
  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        aspectRatio: `${canvasWidth} / ${canvasHeight}`,
        height: "min(70vh, 100%)",
        width: "auto",
        borderRadius: 12,
        overflow: "hidden",
        background: "#fbfaf4",
      }}
    >
      <div style={{ position: "absolute", inset: 0, zIndex: 0 }}>
        <PreviewEmptyState reason="runtime-loading" storyId={storyId} />
      </div>
      <PlayerNoSSR
        component={Component}
        inputProps={playerInputProps}
        errorFallback={errorFallback}
        durationInFrames={durationInFrames}
        compositionWidth={canvasWidth}
        compositionHeight={canvasHeight}
        fps={FPS}
        controls
        acknowledgeRemotionLicense
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          zIndex: 1,
        }}
      />
    </div>
  );
}

// ─── Trim panel (live) ────────────────────────────────────────────────────────
// Controlled component: receives `draft` + `onDraftChange` from EditorClient
// so the slider, the Player preview, and the saved config all read the same
// values. Lock indicators ride on the persisted config (not the draft) so a
// user dragging the slider doesn't visually unlock the field until they save.

interface DraftEdits {
  clip_start_ms: number;
  clip_end_ms: number;
}

// Phase C of the admin UI overhaul
// (_plans/2026-06-12-admin-ui-overhaul.md): one unified RangeSlider
// with two handles replaces the two-separate-sliders shape. Auto-save
// on a 500ms debounce — no Save button. Lock indicators stay on
// because the pipeline can still write these fields back if the user
// unlocks them.

function formatTrimTime(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds
    .toFixed(2)
    .padStart(5, "0")}`;
}

function TrimPanel({
  storyId,
  config,
  draft,
  onDraftChange,
}: {
  storyId: string;
  config: ShortVideoConfig;
  draft: DraftEdits;
  onDraftChange: (next: DraftEdits) => void;
}) {
  const total = config.duration_ms;
  const [, startTransition] = useTransition();

  const startLocked = Boolean(config._locks?.clip_start_ms);
  const endLocked = Boolean(config._locks?.clip_end_ms);
  const valid =
    draft.clip_start_ms >= 0 &&
    draft.clip_end_ms > draft.clip_start_ms &&
    draft.clip_end_ms <= total;

  const save = useDebouncedSave(
    async (next: { clip_start_ms: number; clip_end_ms: number }) => {
      return saveVideoConfigPatch(
        storyId,
        next,
        ["clip_start_ms", "clip_end_ms"],
      );
    },
    { debounceMs: 500 },
  );

  function update(low: number, high: number) {
    onDraftChange({ clip_start_ms: low, clip_end_ms: high });
    if (low >= 0 && high > low && high <= total) {
      save.request({ clip_start_ms: low, clip_end_ms: high });
    }
  }

  function handleUnlock(path: "clip_start_ms" | "clip_end_ms") {
    startTransition(async () => {
      await saveVideoConfigPatch(storyId, {}, [], [path]);
    });
  }

  function handleResetToFull() {
    update(0, total);
  }

  const clipMs = draft.clip_end_ms - draft.clip_start_ms;
  const trimmed = clipMs !== total;

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Trim window
          </p>
          <p className="text-[12px] leading-relaxed text-muted">
            Drag the handles to set the start and end. Auto-saves 500ms after
            you let go. The MP4 renders only the trimmed window.
          </p>
        </div>
        <AutoSaveStatus
          state={save.state}
          detail={save.lastError ?? undefined}
          hideIdle={false}
        />
      </header>

      <RangeSlider
        low={Math.max(0, Math.min(total, draft.clip_start_ms))}
        high={Math.max(0, Math.min(total, draft.clip_end_ms))}
        min={0}
        max={Math.max(total, 1)}
        step={50}
        onChange={update}
        label="Window"
        formatValue={formatTrimTime}
        endpoints={["START", "END"]}
        ariaLabelLow="Clip start"
        ariaLabelHigh="Clip end"
        disabled={total <= 0}
      />

      <div className="rounded-md border border-line bg-bg p-3">
        <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
          <span className="uppercase tracking-wider text-muted">
            Clip length
          </span>
          <span
            className={`tabular-nums ${valid ? "text-ink" : "text-danger"}`}
          >
            {(clipMs / 1000).toFixed(2)}s
            <span className="ml-2 text-muted/70">
              / {(total / 1000).toFixed(2)}s source
            </span>
          </span>
        </div>
      </div>

      {(startLocked || endLocked) && (
        <div className="space-y-2 rounded-md border border-accent/30 bg-accent/5 p-3 font-mono text-[10px]">
          <p className="uppercase tracking-wider text-muted">
            Locks
            <span className="ml-2 text-accent">
              {startLocked && "🔒 start"}
              {startLocked && endLocked && " · "}
              {endLocked && "🔒 end"}
            </span>
          </p>
          <p className="text-[11px] leading-relaxed text-muted">
            The pipeline won&apos;t overwrite locked fields on its next run.
          </p>
          <div className="flex gap-2">
            {startLocked && (
              <button
                type="button"
                onClick={() => handleUnlock("clip_start_ms")}
                className="rounded-md border border-line px-2.5 py-1 uppercase tracking-wider text-muted transition-colors hover:border-accent hover:text-accent"
              >
                Unlock start
              </button>
            )}
            {endLocked && (
              <button
                type="button"
                onClick={() => handleUnlock("clip_end_ms")}
                className="rounded-md border border-line px-2.5 py-1 uppercase tracking-wider text-muted transition-colors hover:border-accent hover:text-accent"
              >
                Unlock end
              </button>
            )}
          </div>
        </div>
      )}

      {trimmed && (
        <button
          type="button"
          onClick={handleResetToFull}
          className="font-mono text-[10px] uppercase tracking-wider text-muted underline-offset-2 hover:text-accent hover:underline"
        >
          Reset to full duration
        </button>
      )}

      {!valid && (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger">
          Invalid window — end must be greater than start, and both within
          source duration.
        </p>
      )}

      <p className="font-mono text-[10px] leading-relaxed text-muted">
        Preview reflects unsaved edits live. Render to produce the trimmed MP4.
      </p>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// `Math.max(1, NaN)` returns NaN — Math.max doesn't take NaN as "lose to
// anything else", it propagates. So `Math.max(1, ...)` is NOT enough to
// guard against NaN inputs. This helper does the explicit finite-check
// before clamping, and rounds down so the result is always a positive
// integer.
function safePositiveInt(n: number, fallback: number): number {
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

// ─── Captions panel ──────────────────────────────────────────────────────────
// Edit caption *text* per chunk; word-level timings are intentionally not
// editable in v1 (see plan §Decisions). The pipeline's forced alignment is
// the source of truth for `start_ms` / `end_ms` / `words[]`; we keep that
// structure verbatim and only swap the `text` string so the karaoke
// highlight keeps tracking the right audio window.
//
// Lock paths land per-chunk text (`captions[<i>].text`), so a pipeline
// re-run that produces new alignment can still apply the user's edited
// text to whichever chunks survived.

function CaptionsPanel({
  storyId,
  config,
  draft,
  onDraftChange,
}: {
  storyId: string;
  config: ShortVideoConfig;
  draft: ShortCaptionChunk[] | null;
  onDraftChange: (next: ShortCaptionChunk[] | null) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [okFlash, setOkFlash] = useState(false);

  // Source-of-truth captions for display. When draft is null (no edits),
  // we render the persisted config; the draft array tracks edits.
  const current = draft ?? config.captions;

  // Diff against persisted to figure out which chunks the user changed —
  // those are the lock paths we send.
  const dirtyIndices: number[] = [];
  if (draft) {
    for (let i = 0; i < draft.length; i++) {
      const persisted = config.captions[i]?.text ?? "";
      if (draft[i].text !== persisted) dirtyIndices.push(i);
    }
  }

  const dirty = dirtyIndices.length > 0;

  const handleEdit = (idx: number, newText: string) => {
    const base = draft ?? config.captions;
    const next = base.map((c, i) =>
      i === idx ? { ...c, text: newText } : c,
    );
    onDraftChange(next);
  };

  const handleSave = () => {
    if (!draft || !dirty) return;
    setError(null);
    setOkFlash(false);
    startTransition(async () => {
      const lockPaths = dirtyIndices.map((i) => `captions[${i}].text`);
      const result = await saveVideoConfigPatch(
        storyId,
        { captions: draft },
        lockPaths,
      );
      if (result.ok) {
        // Clearing the draft means the next render of EditorClient will
        // read from the freshly revalidated `config` — no stale overlay.
        onDraftChange(null);
        setOkFlash(true);
        setTimeout(() => setOkFlash(false), 1500);
      } else {
        setError(result.error ?? "Save failed");
      }
    });
  };

  const handleReset = () => {
    onDraftChange(null);
    setError(null);
  };

  const handleUnlock = (idx: number) => {
    startTransition(async () => {
      await saveVideoConfigPatch(
        storyId,
        {},
        [],
        [`captions[${idx}].text`],
      );
    });
  };

  if (current.length === 0) {
    return (
      <div className="space-y-3">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Captions
        </p>
        <p className="text-[12px] leading-relaxed text-muted">
          No caption chunks yet. The pipeline’s alignment step populates
          these from the voiceover transcript.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Captions · {current.length} chunks
        </p>
        <p className="text-[12px] leading-relaxed text-muted">
          Edit caption text per chunk. Timings stay locked to forced
          alignment so the karaoke highlight tracks the right audio window.
        </p>
      </div>

      <div className="space-y-2">
        {current.map((chunk, idx) => {
          const persistedText = config.captions[idx]?.text ?? "";
          const isDirty = draft ? chunk.text !== persistedText : false;
          const isLocked = Boolean(config._locks?.[`captions[${idx}].text`]);
          return (
            <CaptionRow
              key={idx}
              index={idx}
              chunk={chunk}
              isDirty={isDirty}
              isLocked={isLocked}
              onEdit={(t) => handleEdit(idx, t)}
              onUnlock={isLocked ? () => handleUnlock(idx) : undefined}
            />
          );
        })}
      </div>

      {error && (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || pending}
          className="flex-1 rounded-md bg-accent px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending
            ? "Saving…"
            : okFlash
              ? "Saved ✓"
              : dirty
                ? `Save ${dirtyIndices.length} caption${
                    dirtyIndices.length === 1 ? "" : "s"
                  }`
                : "Save"}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={!dirty || pending}
          className="rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Reset
        </button>
      </div>

      <p className="font-mono text-[10px] leading-relaxed text-muted">
        Saved edits stamp `captions[i].text` locks so the next pipeline run
        keeps your text. Unlock a chunk to let the pipeline rewrite it.
      </p>
    </div>
  );
}

// ─── Audio panel ─────────────────────────────────────────────────────────────
// Voiceover is read-only — it's derived from the pipeline's TTS step and
// the caption alignment is anchored to its waveform; swapping the URL would
// desync the karaoke. Music is editable: a single background track URL +
// fixed gain (no sidechain ducking, per the plan's "cut multi-track audio"
// decision). gain_db is clamped to [-24, 0] in the UI so the post-merge
// parseVideoConfig (which clamps to [-60, 12]) can never reject the save.

const MUSIC_GAIN_MIN = -24;
const MUSIC_GAIN_MAX = 0;
const MUSIC_GAIN_DEFAULT = -12;

function AudioPanel({
  storyId,
  config,
}: {
  storyId: string;
  config: ShortVideoConfig;
}) {
  const persistedUrl = config.music?.url ?? "";
  const persistedGain = config.music?.gain_db ?? MUSIC_GAIN_DEFAULT;
  const [musicUrl, setMusicUrl] = useState(persistedUrl);
  const [musicGain, setMusicGain] = useState(persistedGain);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [okFlash, setOkFlash] = useState(false);

  const dirty =
    musicUrl.trim() !== persistedUrl ||
    Math.round(musicGain) !== Math.round(persistedGain);
  const urlLocked = Boolean(config._locks?.["music.url"]);
  const gainLocked = Boolean(config._locks?.["music.gain_db"]);

  const handleSave = () => {
    setError(null);
    setOkFlash(false);
    const trimmedUrl = musicUrl.trim();
    // Empty URL clears the track; otherwise patch full music object so a
    // partial save (gain-only) still keeps the URL.
    const patch = trimmedUrl
      ? { music: { url: trimmedUrl, gain_db: musicGain } }
      : { music: undefined };
    const lockPaths: string[] = [];
    if (trimmedUrl !== persistedUrl) lockPaths.push("music.url");
    if (Math.round(musicGain) !== Math.round(persistedGain)) {
      lockPaths.push("music.gain_db");
    }
    startTransition(async () => {
      const result = await saveVideoConfigPatch(storyId, patch, lockPaths);
      if (result.ok) {
        setOkFlash(true);
        setTimeout(() => setOkFlash(false), 1500);
      } else {
        setError(result.error ?? "Save failed");
      }
    });
  };

  const handleReset = () => {
    setMusicUrl(persistedUrl);
    setMusicGain(persistedGain);
    setError(null);
  };

  const handleUnlock = (path: "music.url" | "music.gain_db") => {
    startTransition(async () => {
      await saveVideoConfigPatch(storyId, {}, [], [path]);
    });
  };

  return (
    <div className="space-y-5">
      <Section
        title="Voiceover"
        hint="Derived from the pipeline's TTS step. Editable URL would desync the caption alignment, so the editor leaves this read-only — re-render the story if the voiceover regenerates."
      >
        <FieldRow
          label="voiceover_url"
          value={config.voiceover_url || "(unset)"}
          mono
        />
        {config.voiceover_url && (
          <audio
            controls
            src={config.voiceover_url}
            className="mt-2 w-full"
            style={{ height: 28 }}
          />
        )}
      </Section>

      <Section
        title="Background music"
        hint={`Single track mixed at ${MUSIC_GAIN_DEFAULT} dB by default. No sidechain ducking — paste a public URL or leave blank for no music.`}
      >
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
              music.url
              {urlLocked && <span className="ml-1.5 text-accent">🔒</span>}
            </span>
          </div>
          <input
            type="url"
            value={musicUrl}
            onChange={(e) => setMusicUrl(e.target.value)}
            placeholder="https://… (mp3 / m4a)"
            className="w-full rounded border border-line bg-bg px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-accent"
          />
          {urlLocked && (
            <button
              type="button"
              onClick={() => handleUnlock("music.url")}
              className="font-mono text-[10px] uppercase tracking-wider text-muted underline-offset-2 hover:text-accent hover:underline"
            >
              Unlock — let the pipeline rewrite this
            </button>
          )}
        </div>

        <div className="space-y-1.5">
          <Slider
            value={musicGain}
            min={MUSIC_GAIN_MIN}
            max={MUSIC_GAIN_MAX}
            step={1}
            unit="dB"
            label={
              gainLocked ? "music.gain_db  🔒" : "music.gain_db"
            }
            onChange={setMusicGain}
            disabled={!musicUrl.trim()}
            tickValue={0}
            ariaLabel="music.gain_db"
          />
          {gainLocked && (
            <button
              type="button"
              onClick={() => handleUnlock("music.gain_db")}
              className="font-mono text-[10px] uppercase tracking-wider text-muted underline-offset-2 hover:text-accent hover:underline"
            >
              Unlock — let the pipeline rewrite this
            </button>
          )}
        </div>

        {musicUrl.trim() && (
          <audio
            controls
            src={musicUrl}
            className="mt-2 w-full"
            style={{ height: 28 }}
          />
        )}
      </Section>

      {error && (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || pending}
          className="flex-1 rounded-md bg-accent px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "Saving…" : okFlash ? "Saved ✓" : "Save audio"}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={!dirty || pending}
          className="rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

// ─── Metadata panel ──────────────────────────────────────────────────────────
// Title + channel_name + ken_burns. Intro/outro overrides live on the story
// row (intro_segment_id / outro_segment_id / skip_intro / skip_outro), not
// in video_config — those are managed from the story edit page. We link
// there so admins don't end up wondering where the override lives.

function MetadataPanel({
  storyId,
  config,
  editorIntro,
  editorOutro,
  editorIntroReason,
  editorOutroReason,
  storyAspect,
}: {
  storyId: string;
  config: ShortVideoConfig;
  /** Resolved intro pick — for the Intro/outro section's live status row. */
  editorIntro: { url: string; durationMs: number; label: string | null } | null;
  editorOutro: { url: string; durationMs: number; label: string | null } | null;
  /** Reason the resolver returned — surfaced so the admin sees WHY a segment
   *  is being skipped instead of guessing (the most common one in production
   *  is "aspect-mismatch" between a 9:16 segment and a 16:9 story). */
  editorIntroReason: string;
  editorOutroReason: string;
  /** Current live story aspect — included in the aspect-mismatch hint so
   *  the recommended action is obvious. */
  storyAspect: VideoAspect;
}) {
  // Aspect lives in the editor header now — the chip + the save flow +
  // the regen-cost modal all live one level up so the live preview can
  // track the picker without a round-trip. See `HeaderAspectPicker` and
  // the lifted `pendingAspectFlip` state in EditorClient.
  const persistedTitle = config.title ?? "";
  const persistedChannel = config.channel_name ?? "";
  const persistedKenBurns = config.ken_burns ?? false;
  // Motion beats. ken_burns is a top-level field (predates the motion
  // map); the other five live in config.motion (and default to off when
  // the row was written before the field existed). Each one renders as
  // its own toggle so the admin can suppress a beat per-video without
  // touching the global pipeline setting.
  const persistedMicroWiggle = config.motion?.micro_wiggle ?? false;
  const persistedLabelPop = config.motion?.label_pop ?? false;
  const persistedScribbleDraw = config.motion?.scribble_draw ?? false;
  const persistedPropSlide = config.motion?.prop_slide ?? false;
  const persistedMouthSwap = config.motion?.mouth_swap ?? false;
  const [title, setTitle] = useState(persistedTitle);
  const [channel, setChannel] = useState(persistedChannel);
  const [kenBurns, setKenBurns] = useState(persistedKenBurns);
  const [microWiggle, setMicroWiggle] = useState(persistedMicroWiggle);
  const [labelPop, setLabelPop] = useState(persistedLabelPop);
  const [scribbleDraw, setScribbleDraw] = useState(persistedScribbleDraw);
  const [propSlide, setPropSlide] = useState(persistedPropSlide);
  const [mouthSwap, setMouthSwap] = useState(persistedMouthSwap);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [okFlash, setOkFlash] = useState(false);

  const dirty =
    title !== persistedTitle ||
    channel !== persistedChannel ||
    kenBurns !== persistedKenBurns ||
    microWiggle !== persistedMicroWiggle ||
    labelPop !== persistedLabelPop ||
    scribbleDraw !== persistedScribbleDraw ||
    propSlide !== persistedPropSlide ||
    mouthSwap !== persistedMouthSwap;

  const titleLocked = Boolean(config._locks?.title);
  const channelLocked = Boolean(config._locks?.channel_name);
  const kenBurnsLocked = Boolean(config._locks?.ken_burns);

  const handleSave = () => {
    setError(null);
    setOkFlash(false);
    const patch: Record<string, unknown> = {};
    const lockPaths: string[] = [];
    if (title !== persistedTitle) {
      patch.title = title;
      lockPaths.push("title");
    }
    if (channel !== persistedChannel) {
      patch.channel_name = channel;
      lockPaths.push("channel_name");
    }
    if (kenBurns !== persistedKenBurns) {
      patch.ken_burns = kenBurns;
      lockPaths.push("ken_burns");
    }
    // Build the motion patch if any beat flipped. Spreading the current
    // motion preserves any future beats the editor doesn't know about
    // yet (config schema is additive-safe).
    const motionDirty =
      microWiggle !== persistedMicroWiggle ||
      labelPop !== persistedLabelPop ||
      scribbleDraw !== persistedScribbleDraw ||
      propSlide !== persistedPropSlide ||
      mouthSwap !== persistedMouthSwap;
    if (motionDirty) {
      patch.motion = {
        ...(config.motion ?? {}),
        micro_wiggle: microWiggle,
        label_pop: labelPop,
        scribble_draw: scribbleDraw,
        prop_slide: propSlide,
        mouth_swap: mouthSwap,
      };
      lockPaths.push("motion");
    }
    startTransition(async () => {
      const result = await saveVideoConfigPatch(storyId, patch, lockPaths);
      if (result.ok) {
        setOkFlash(true);
        setTimeout(() => setOkFlash(false), 1500);
      } else {
        setError(result.error ?? "Save failed");
      }
    });
  };

  const handleReset = () => {
    setTitle(persistedTitle);
    setChannel(persistedChannel);
    setKenBurns(persistedKenBurns);
    setMicroWiggle(persistedMicroWiggle);
    setLabelPop(persistedLabelPop);
    setScribbleDraw(persistedScribbleDraw);
    setPropSlide(persistedPropSlide);
    setMouthSwap(persistedMouthSwap);
    setError(null);
  };

  const handleUnlock = (
    path: "title" | "channel_name" | "ken_burns" | "motion",
  ) => {
    startTransition(async () => {
      await saveVideoConfigPatch(storyId, {}, [], [path]);
    });
  };

  return (
    <div className="space-y-5">
      <Section
        title="Title"
        hint="The big chip that fades in for ~1.2 s at the start of the short. Truncated by the pipeline if too long."
      >
        <LabeledTextInput
          label="title"
          value={title}
          locked={titleLocked}
          onChange={setTitle}
          onUnlock={titleLocked ? () => handleUnlock("title") : undefined}
        />
      </Section>

      <Section
        title="Channel branding"
        hint="The bottom @-pill. Keep it short — long names wrap and look weird at 1080×1920."
      >
        <LabeledTextInput
          label="channel_name"
          value={channel}
          locked={channelLocked}
          onChange={setChannel}
          onUnlock={
            channelLocked ? () => handleUnlock("channel_name") : undefined
          }
        />
      </Section>

      <Section
        title="Aspect ratio"
        hint="Lives in the editor header so the preview tracks your pick live. The save flow + the regen-cost confirmation modal are unchanged."
      >
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Pick from the chip group in the page header →
        </p>
      </Section>

      <Section
        title="Visual options"
        hint="Each toggle is a per-video override — turning it off here doesn't change the global Settings → General pipeline default, just this render."
      >
        <div className="space-y-2">
          <Toggle
            checked={kenBurns}
            onChange={setKenBurns}
            label={kenBurnsLocked ? "ken_burns  🔒" : "ken_burns — slow zoom/pan per scene"}
            ariaLabel="ken_burns"
          />
          {kenBurnsLocked && (
            <button
              type="button"
              onClick={() => handleUnlock("ken_burns")}
              className="font-mono text-[10px] uppercase tracking-wider text-muted underline-offset-2 hover:text-accent hover:underline"
            >
              Unlock ken_burns — let the pipeline rewrite this
            </button>
          )}
          <Toggle
            checked={mouthSwap}
            onChange={setMouthSwap}
            label="mouth_swap — bottom-left talking-head bust"
            ariaLabel="mouth_swap"
          />
          <Toggle
            checked={propSlide}
            onChange={setPropSlide}
            label="prop_slide — object cutouts slide in from edges"
            ariaLabel="prop_slide"
          />
          <Toggle
            checked={labelPop}
            onChange={setLabelPop}
            label="label_pop — caption first-word pops in a corner"
            ariaLabel="label_pop"
          />
          <Toggle
            checked={scribbleDraw}
            onChange={setScribbleDraw}
            label="scribble_draw — animated SVG stroke at scene cuts"
            ariaLabel="scribble_draw"
          />
          <Toggle
            checked={microWiggle}
            onChange={setMicroWiggle}
            label="micro_wiggle — tiny sinusoidal jitter on every frame"
            ariaLabel="micro_wiggle"
          />
        </div>
      </Section>

      <Section
        title="Intro / outro"
        hint="The preview splices these inline. Per-story override + skip flags live on the story row; the pickers live on the story edit page."
      >
        <div className="space-y-2">
          <SegmentStatusRow
            kind="intro"
            segment={editorIntro}
            reason={editorIntroReason}
            storyAspect={storyAspect}
          />
          <SegmentStatusRow
            kind="outro"
            segment={editorOutro}
            reason={editorOutroReason}
            storyAspect={storyAspect}
          />
          <Link
            href={`/admin/stories/${storyId}`}
            className="mt-2 inline-flex w-full items-center justify-center rounded-md border border-line bg-surface px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent"
          >
            Open story page →
          </Link>
          <Link
            href="/admin/segments"
            className="inline-flex w-full items-center justify-center rounded-md border border-line bg-surface px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent"
          >
            Manage segment library →
          </Link>
        </div>
      </Section>

      {error && (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || pending}
          className="flex-1 rounded-md bg-accent px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "Saving…" : okFlash ? "Saved ✓" : "Save metadata"}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={!dirty || pending}
          className="rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function AspectFlipModal({
  fromAspect,
  toAspect,
  sceneCount,
  sceneEstimateCents,
  heroEstimateCents,
  pending,
  onCancel,
  onSaveOnly,
  onSaveAndRegenScenes,
  onSaveAndRegenAll,
}: {
  fromAspect: VideoAspect;
  toAspect: VideoAspect;
  sceneCount: number;
  sceneEstimateCents: number;
  heroEstimateCents: number;
  pending: boolean;
  onCancel: () => void;
  onSaveOnly: () => void;
  onSaveAndRegenScenes: () => void;
  onSaveAndRegenAll: () => void;
}) {
  const scenesUsd = (sceneEstimateCents / 100).toFixed(2);
  const heroUsd = (heroEstimateCents / 100).toFixed(2);
  const allUsd = ((sceneEstimateCents + heroEstimateCents) / 100).toFixed(2);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="aspect-flip-title"
      data-testid="aspect-flip-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-6"
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-2xl">
        <h3
          id="aspect-flip-title"
          className="font-display text-[16px] font-bold text-ink"
        >
          Switch aspect to {toAspect}?
        </h3>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          This story has {sceneCount} scene image{sceneCount === 1 ? "" : "s"}
          {" generated at "}
          <span className="font-mono text-ink">{fromAspect}</span>. They&apos;ll
          object-fit-cover into the new {toAspect} canvas — meaning the
          subject will be cropped on the long axis. Regenerating the scenes
          at {toAspect} fixes that. The hero set (portrait + landscape) is
          aspect-agnostic so a re-render is optional, but the title baking
          + composition reflect the new orientation when you do.
        </p>
        <div className="mt-3 space-y-1 rounded-md border border-line bg-bg px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted">
          <div className="flex justify-between">
            <span>Scenes regen</span>
            <span className="text-ink">${scenesUsd}</span>
          </div>
          <div className="flex justify-between">
            <span>Hero regen (portrait + landscape)</span>
            <span className="text-ink">${heroUsd}</span>
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={onSaveAndRegenAll}
            disabled={pending}
            className="rounded-md bg-accent px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending
              ? "Saving…"
              : `Save & regen scenes + hero (~$${allUsd})`}
          </button>
          <button
            type="button"
            onClick={onSaveAndRegenScenes}
            disabled={pending}
            className="rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save & regen scenes only (~${scenesUsd})
          </button>
          <button
            type="button"
            onClick={onSaveOnly}
            disabled={pending}
            className="rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save without regen
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Overlays panel ──────────────────────────────────────────────────────────
// Add/edit/remove timed text overlays positioned by normalized (x, y) coords
// over the 1080×1920 canvas. Each overlay is anchored at its (x, y) point
// (centered via translate(-50%, -50%) in the renderer) so an overlay at
// (0.5, 0.5) sits dead-center regardless of text length.
//
// Locking model: the whole `overlays` key is locked on any save because
// overlays are an editor-only concept — the pipeline doesn't generate them.
// One lock path keeps the merge simple, and locked-overlays survive
// pipeline re-runs verbatim.

const NEW_OVERLAY_DEFAULTS = {
  text: "New overlay",
  start_ms: 0,
  end_ms: 2000,
  x: 0.5,
  y: 0.5,
};

function OverlaysPanel({
  storyId,
  config,
  draft,
  onDraftChange,
}: {
  storyId: string;
  config: ShortVideoConfig;
  draft: Overlay[] | null;
  onDraftChange: (next: Overlay[] | null) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [okFlash, setOkFlash] = useState(false);

  const persisted = config.overlays ?? [];
  const current = draft ?? persisted;
  const dirty =
    draft !== null &&
    JSON.stringify(draft) !== JSON.stringify(persisted);
  const locked = Boolean(config._locks?.overlays);

  const totalMs = config.duration_ms;

  const handleAdd = () => {
    const base = draft ?? persisted;
    const next: Overlay[] = [
      ...base,
      {
        ...NEW_OVERLAY_DEFAULTS,
        // Tail-pin the new overlay so a chain of adds doesn't stack at 0.
        start_ms: 0,
        end_ms: Math.min(NEW_OVERLAY_DEFAULTS.end_ms, totalMs),
      },
    ];
    onDraftChange(next);
  };

  const handleUpdate = (idx: number, patch: Partial<Overlay>) => {
    const base = draft ?? persisted;
    const next = base.map((o, i) => (i === idx ? { ...o, ...patch } : o));
    onDraftChange(next);
  };

  const handleRemove = (idx: number) => {
    const base = draft ?? persisted;
    onDraftChange(base.filter((_, i) => i !== idx));
  };

  const handleSave = () => {
    if (!draft) return;
    setError(null);
    setOkFlash(false);
    startTransition(async () => {
      const result = await saveVideoConfigPatch(
        storyId,
        { overlays: draft },
        ["overlays"],
      );
      if (result.ok) {
        onDraftChange(null);
        setOkFlash(true);
        setTimeout(() => setOkFlash(false), 1500);
      } else {
        setError(result.error ?? "Save failed");
      }
    });
  };

  const handleReset = () => {
    onDraftChange(null);
    setError(null);
  };

  const handleUnlock = () => {
    startTransition(async () => {
      await saveVideoConfigPatch(storyId, {}, [], ["overlays"]);
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Overlays · {current.length}
          {locked && <span className="ml-1.5 text-accent">🔒</span>}
        </p>
        <p className="text-[12px] leading-relaxed text-muted">
          Timed text plates positioned by (x, y) normalized to the 1080×1920
          canvas. Each anchors at its point and centers around it.
        </p>
      </div>

      <button
        type="button"
        onClick={handleAdd}
        disabled={pending}
        className="w-full rounded-md border border-dashed border-line bg-bg px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        + Add overlay
      </button>

      <div className="space-y-2">
        {current.length === 0 && (
          <p className="rounded-md border border-line bg-bg px-3 py-4 text-center font-mono text-[11px] uppercase tracking-wider text-muted">
            No overlays yet
          </p>
        )}
        {current.map((overlay, idx) => (
          <OverlayRow
            key={idx}
            index={idx}
            overlay={overlay}
            totalMs={totalMs}
            onUpdate={(patch) => handleUpdate(idx, patch)}
            onRemove={() => handleRemove(idx)}
          />
        ))}
      </div>

      {error && (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || pending}
          className="flex-1 rounded-md bg-accent px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "Saving…" : okFlash ? "Saved ✓" : "Save overlays"}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={!dirty || pending}
          className="rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Reset
        </button>
      </div>

      {locked && (
        <button
          type="button"
          onClick={handleUnlock}
          className="font-mono text-[10px] uppercase tracking-wider text-muted underline-offset-2 hover:text-accent hover:underline"
        >
          Unlock overlays — let the pipeline rewrite them
        </button>
      )}
    </div>
  );
}

function OverlayRow({
  index,
  overlay,
  totalMs,
  onUpdate,
  onRemove,
}: {
  index: number;
  overlay: Overlay;
  totalMs: number;
  onUpdate: (patch: Partial<Overlay>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-line bg-bg p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          overlay {String(index + 1).padStart(2, "0")}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="font-mono text-[10px] uppercase tracking-wider text-danger underline-offset-2 hover:underline"
        >
          remove
        </button>
      </div>

      <textarea
        value={overlay.text}
        onChange={(e) => onUpdate({ text: e.target.value })}
        rows={2}
        className="w-full resize-none rounded border border-line bg-surface px-2 py-1 text-[12px] leading-snug text-ink outline-none focus:border-accent"
      />

      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="start"
          suffix="ms"
          value={overlay.start_ms}
          min={0}
          max={totalMs}
          step={100}
          onChange={(v) =>
            onUpdate({ start_ms: clamp(v, 0, overlay.end_ms - 100) })
          }
        />
        <NumberField
          label="end"
          suffix="ms"
          value={overlay.end_ms}
          min={overlay.start_ms + 100}
          max={totalMs}
          step={100}
          onChange={(v) =>
            onUpdate({ end_ms: clamp(v, overlay.start_ms + 100, totalMs) })
          }
        />
      </div>

      <PositionPicker
        x={overlay.x}
        y={overlay.y}
        onChange={(x, y) => onUpdate({ x, y })}
        label="Position"
        maxWidth={140}
      />
    </div>
  );
}

function NumberField({
  label,
  suffix,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  suffix?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
        {label} {suffix ? `(${suffix})` : ""}
      </span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded border border-line bg-surface px-2 py-1 text-right font-mono text-[11px] tabular-nums text-ink outline-none focus:border-accent"
      />
    </label>
  );
}

function LabeledTextInput({
  label,
  value,
  locked,
  onChange,
  onUnlock,
}: {
  label: string;
  value: string;
  locked: boolean;
  onChange: (v: string) => void;
  onUnlock?: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          {label}
          {locked && <span className="ml-1.5 text-accent">🔒</span>}
        </span>
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-line bg-surface px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
      />
      {locked && onUnlock && (
        <button
          type="button"
          onClick={onUnlock}
          className="font-mono text-[10px] uppercase tracking-wider text-muted underline-offset-2 hover:text-accent hover:underline"
        >
          Unlock — let the pipeline rewrite this
        </button>
      )}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
          {title}
        </p>
        {hint && (
          <p className="text-[12px] leading-relaxed text-muted">{hint}</p>
        )}
      </div>
      <div className="space-y-3 rounded-md border border-line bg-bg p-3">
        {children}
      </div>
    </div>
  );
}

function CaptionRow({
  index,
  chunk,
  isDirty,
  isLocked,
  onEdit,
  onUnlock,
}: {
  index: number;
  chunk: ShortCaptionChunk;
  isDirty: boolean;
  isLocked: boolean;
  onEdit: (next: string) => void;
  onUnlock?: () => void;
}) {
  return (
    <div
      className="space-y-1.5 rounded-md border bg-bg p-3"
      style={{
        borderColor: isDirty
          ? "var(--color-accent)"
          : "var(--color-line)",
      }}
    >
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <span className="font-mono uppercase tracking-wider text-muted">
          chunk {String(index + 1).padStart(2, "0")}
          {isLocked && <span className="ml-1.5 text-accent">🔒</span>}
        </span>
        <span className="font-mono tabular-nums text-muted">
          {(chunk.start_ms / 1000).toFixed(2)}s &rarr;{" "}
          {(chunk.end_ms / 1000).toFixed(2)}s
        </span>
      </div>
      <textarea
        value={chunk.text}
        onChange={(e) => onEdit(e.target.value)}
        rows={2}
        className="w-full resize-none rounded border border-line bg-surface px-2 py-1 text-[12px] leading-snug text-ink outline-none focus:border-accent"
      />
      {isLocked && onUnlock && (
        <button
          type="button"
          onClick={onUnlock}
          className="font-mono text-[10px] uppercase tracking-wider text-muted underline-offset-2 hover:text-accent hover:underline"
        >
          Unlock — let the pipeline rewrite this
        </button>
      )}
    </div>
  );
}

// ─── Tab stubs ────────────────────────────────────────────────────────────────
// Each tab gets a tiny "what's coming" panel so the skeleton communicates
// the plan to whichever admin opens it before the editing surfaces ship.
// The plan reference is intentional — rule 7 says plans live in _plans/ and
// the UI should point at them rather than re-explain the roadmap.

function TabStub({
  tab,
  config,
}: {
  tab: TabKey;
  config: ShortVideoConfig;
}) {
  switch (tab) {
    case "trim":
      return null;
    case "captions":
      // Captions is now live (rendered by CaptionsPanel above the switch).
      return null;
    case "audio":
      // Audio is now live (rendered by AudioPanel above the switch).
      return null;
    case "overlays":
      // Overlays is now live (rendered by OverlaysPanel above the switch).
      return null;
    case "metadata":
      // Metadata is now live (rendered by MetadataPanel above the switch).
      return null;
  }
}

function ComingSoon({
  when,
  summary,
  detail,
  children,
}: {
  when: string;
  summary: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p className="font-mono text-[10px] uppercase tracking-wider text-accent">
          {when}
        </p>
        <p className="text-[13px] font-semibold text-ink">{summary}</p>
        <p className="text-[12px] leading-relaxed text-muted">{detail}</p>
      </div>
      {children && (
        <div className="space-y-1 rounded-md border border-line bg-bg p-3">
          {children}
        </div>
      )}
    </div>
  );
}

function FieldRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
        {label}
      </span>
      <span
        className={`min-w-0 truncate text-right text-[12px] text-ink ${
          mono ? "font-mono" : ""
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function EmptyHint({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
        {label}
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">{hint}</p>
    </div>
  );
}

function EmptyPreview({
  storyId,
  aspect,
  globalDefaultAspect,
}: {
  storyId: string;
  aspect: ShortVideoConfig["aspect"];
  globalDefaultAspect: VideoAspect;
}) {
  const { width, height } = editorCanvasDims(aspect, globalDefaultAspect);
  return (
    <div
      className="rounded-lg border border-dashed border-line overflow-hidden"
      style={{
        aspectRatio: `${width} / ${height}`,
        maxHeight: "70vh",
      }}
    >
      <PreviewEmptyState reason="no-frames" storyId={storyId} />
    </div>
  );
}

function frameFilename(url: string): string {
  const slash = url.lastIndexOf("/");
  return slash >= 0 ? url.slice(slash + 1) : url;
}

// Live row showing whether an intro/outro will splice on render. Pulls
// from the resolver's `reason` so the admin doesn't have to guess why a
// segment is missing — the most common one in production is an aspect
// mismatch between a 9:16 segment and a 16:9 story (or vice versa),
// because the pipeline's renderer can't concat clips of different
// shapes without letterboxing.
function SegmentStatusRow({
  kind,
  segment,
  reason,
  storyAspect,
}: {
  kind: "intro" | "outro";
  segment: { url: string; durationMs: number; label: string | null } | null;
  reason: string;
  storyAspect: VideoAspect;
}) {
  const label = kind === "intro" ? "Intro" : "Outro";
  if (segment) {
    return (
      <div className="rounded-md border border-line bg-bg p-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            {label}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-accent">
            plays inline
          </span>
        </div>
        <p className="mt-1 text-[12px] text-ink">
          {segment.label ?? "(unlabeled)"}{" "}
          <span className="font-mono text-[10px] text-muted">
            · {(segment.durationMs / 1000).toFixed(1)}s
          </span>
        </p>
      </div>
    );
  }
  // No segment resolved — explain why instead of staying silent.
  const explain = explainSegmentReason(reason, kind, storyAspect);
  return (
    <div className="rounded-md border border-line bg-bg p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          {label}
        </span>
        <span
          className={`font-mono text-[10px] uppercase tracking-wider ${
            explain.tone === "warn" ? "text-warn" : "text-muted"
          }`}
        >
          {explain.statusLabel}
        </span>
      </div>
      <p className="mt-1 text-[12px] text-muted">{explain.body}</p>
    </div>
  );
}

function explainSegmentReason(
  reason: string,
  kind: "intro" | "outro",
  storyAspect: VideoAspect,
): { statusLabel: string; body: string; tone: "muted" | "warn" } {
  const otherAspect = storyAspect === "16:9" ? "9:16" : "16:9";
  switch (reason) {
    case "skip-flag":
      return {
        statusLabel: "skipped",
        tone: "muted",
        body: `Per-story skip_${kind} is on. Turn it off on the story edit page if you want this ${kind} to play.`,
      };
    case "pinned-missing":
      return {
        statusLabel: "missing",
        tone: "warn",
        body: `Pinned ${kind} segment id doesn't exist in the library. Pick a different one on the story edit page or remove the pin.`,
      };
    case "master-disabled":
      return {
        statusLabel: "off (global)",
        tone: "muted",
        body: `Intro/outro is turned off globally (Settings → video.intro_outro_enabled). Flip it on to splice ${kind}s.`,
      };
    case "no-default":
      return {
        statusLabel: "none",
        tone: "muted",
        body: `No global active ${kind} is set. Pick one in the segment library or assign one to this story.`,
      };
    case "global-active-missing":
      return {
        statusLabel: "disabled",
        tone: "warn",
        body: `The global active ${kind} row is soft-disabled. Enable it in the segment library or pick a different one.`,
      };
    case "aspect-mismatch":
      return {
        statusLabel: "aspect mismatch",
        tone: "warn",
        body: `The picked ${kind} is ${otherAspect} but this story is ${storyAspect}. Upload a ${storyAspect} ${kind}, or flip the story to ${otherAspect}.`,
      };
    default:
      return {
        statusLabel: "not resolved",
        tone: "muted",
        body: `No ${kind} will splice (${reason}).`,
      };
  }
}
