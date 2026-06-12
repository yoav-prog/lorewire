// /admin/videos/[id] — full-bleed video editor host.
//
// Lives OUTSIDE the (panel) route group on purpose: the panel layout
// constrains content to max-w-[1100px], but the editor wants the whole
// viewport (3-col layout: timeline | preview | tabs). Auth is handled here
// inline since we don't share the panel layout's requireAdmin gate.
//
// Day 5 skeleton (see _plans/2026-06-11-video-editor.md §Sequencing):
// reads the story's video_config (or derives a default), wires
// observability + auth, renders the read-only 3-col shell. No editing
// surfaces yet — those land Day 6+.

import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/dal";
import { getStory, getUserById } from "@/lib/repo";
import {
  defaultVideoConfig,
  parseVideoConfig,
  type ShortVideoConfig,
} from "@/lib/video-config";
import { classifyEditSession } from "@/lib/edit-session";
import {
  isVideoRenderStale,
  latestRenderForStory,
} from "@/lib/video-render-queue";
import {
  estimateImageRegenCostCents,
  latestRenderForAsset,
  type ImageRenderRow,
} from "@/lib/image-render-queue";
import {
  getFrameRegenSessionCapCents,
  getSessionSpendCents,
} from "@/lib/frame-session-spend";
import { resolveCaptionStyle, toPreview } from "@/lib/caption-style";
import EditorClient from "./EditorClient";

export default async function VideoEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Server-side auth check, not just middleware (see plan §Security: rule 13).
  const session = await requireAdmin();
  const { id } = await params;
  const story = await getStory(id);
  if (!story) notFound();

  // Try the persisted config first; if it isn't there yet or fails the
  // validator, derive a default from the raw pipeline outputs so the editor
  // still has something to show. A pipeline re-run will overwrite the
  // derived shape with the canonical pipeline output once it lands.
  const parsed = story.video_config
    ? parseVideoConfig(safeJsonParse(story.video_config))
    : null;
  const config: ShortVideoConfig =
    parsed?.ok ? parsed.config : defaultVideoConfig(story);

  // Resolve each doodle_frame.url to a browser-accessible URL so the live
  // preview can render via plain <img>. The pipeline stores URLs in the
  // staticFile() format the Remotion CLI expects (e.g. "envelope/hero.png");
  // those files also exist under lorewire-app/public/generated/<id>/ so
  // prepending /generated/ is the safe browser-side path. Absolute URLs
  // (GCS, /generated/...) pass through.
  const previewFrameUrls = config.doodle_frames.map((f) =>
    toBrowserAssetUrl(f.url),
  );

  // The render-queue row for this story (latest by requested_at). The editor
  // shows its status in the header so the admin sees an in-flight render
  // without having to remember a render id across reloads.
  const latestRender = await latestRenderForStory(story.id);

  // Phase 4 stale-render badge: true when any per-frame regen finished
  // after the latest video render was requested, which means the MP4 at
  // stories.video_url still points at the old frames. The header
  // surfaces this with a Re-render CTA.
  const videoRenderStale = await isVideoRenderStale(story.id);

  // Per-frame regen status (Phase 3). For every doodle_frame, fetch the
  // latest IMAGE_RENDERS row keyed by `frame:<id>` so the storyboard rail
  // can show queued / generating / error states inline. Fanned out via
  // Promise.all because each frame's row is independent.
  const frameRenderStatuses: (ImageRenderRow | null)[] = await Promise.all(
    config.doodle_frames.map((f) =>
      latestRenderForAsset("story", story.id, `frame:${f.id}`),
    ),
  );

  // Cost estimate is per-image and depends on the active image model
  // setting; the asset slug only matters for bulk counts. One value
  // covers every frame card.
  const frameEstimateCents = await estimateImageRegenCostCents("frame:_");

  // Phase 4 running session spend chip + hard per-session cap. Only
  // computed when the current admin owns the edit session — a foreign
  // session means we're read-only and the chip would be misleading.
  // The cap setting is read regardless so the editor can still show a
  // "Read-only — current cap ~$Y" hint in future iterations.
  const frameRegenSessionCapCents = await getFrameRegenSessionCapCents();
  let mySessionSpendCents: number | null = null;
  if (
    config._edit_session &&
    config._edit_session.user_id === session.userId
  ) {
    const spend = await getSessionSpendCents(
      story.id,
      session.userId,
      config._edit_session.started_at,
    );
    mySessionSpendCents = spend.totalCents;
  }

  // Concurrency banner data. If a foreign session is fresh (<2 min), pull
  // the owner's email so the banner can name them — "<email> is editing".
  // Stale and self-owned sessions both render no banner.
  const sessionInfo = classifyEditSession(
    config._edit_session,
    session.userId,
  );
  let foreignOwnerEmail: string | null = null;
  if (sessionInfo.kind === "foreign-active" && sessionInfo.ownerUserId) {
    const owner = await getUserById(sessionInfo.ownerUserId);
    foreignOwnerEmail = owner?.email ?? sessionInfo.ownerUserId;
  }

  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info("[video editor] page render", {
    story_id: story.id,
    user_id: session.userId,
    has_video_config: Boolean(story.video_config),
    config_version: config.config_version ?? null,
    frames: config.doodle_frames.length,
    captions: config.captions.length,
    duration_s: Math.round(config.duration_ms / 100) / 10,
    locked_fields: Object.keys(config._locks ?? {}).length,
    has_video_url: Boolean(story.video_url),
    parse_error: parsed && !parsed.ok ? parsed.error : null,
  });

  // Resolve the per-video caption style now so the editor can render both
  // the live preview overlay AND the Caption style tab with the right
  // per-story-override values and inherited placeholders.
  const captionStyle = await resolveCaptionStyle({
    storyId: story.id,
    category: story.category,
  });
  const captionStylePreview = toPreview(captionStyle);

  return (
    <EditorClient
      storyId={story.id}
      storyTitle={story.title ?? "(untitled)"}
      storyStatus={story.status ?? "draft"}
      config={config}
      previewFrameUrls={previewFrameUrls}
      audioUrl={story.audio_url}
      derivedDefault={!parsed?.ok}
      latestRender={latestRender}
      videoRenderStale={videoRenderStale}
      frameRenderStatuses={frameRenderStatuses}
      frameEstimateCents={frameEstimateCents}
      mySessionSpendCents={mySessionSpendCents}
      frameRegenSessionCapCents={frameRegenSessionCapCents}
      foreignOwnerEmail={foreignOwnerEmail}
      captionStyle={captionStyle}
      captionStylePreview={captionStylePreview}
    />
  );
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toBrowserAssetUrl(raw: string): string {
  if (!raw) return "";
  // Absolute URLs (http://, https://, blob:, data:) and root-relative paths
  // pass through unchanged.
  if (
    raw.startsWith("http://") ||
    raw.startsWith("https://") ||
    raw.startsWith("/") ||
    raw.startsWith("data:") ||
    raw.startsWith("blob:")
  ) {
    return raw;
  }
  // staticFile-style relative path ("envelope/hero.png") — the same files
  // live under lorewire-app/public/generated/<id>/ so /generated is the
  // browser-side prefix.
  return `/generated/${raw}`;
}
