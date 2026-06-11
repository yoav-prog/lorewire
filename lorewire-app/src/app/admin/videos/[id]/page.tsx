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
import { getStory } from "@/lib/repo";
import {
  defaultVideoConfig,
  parseVideoConfig,
  type ShortVideoConfig,
} from "@/lib/video-config";
import { latestRenderForStory } from "@/lib/video-render-queue";
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
