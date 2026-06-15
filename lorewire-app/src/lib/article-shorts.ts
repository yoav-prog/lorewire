// Server-only helpers for the article -> short_render scene image bridge.
//
// An article opts into borrowing scene images from a story's short by setting
// articles.story_id. The article editor's ShortScenesPanel reads through
// getLinkedShortFrames to render a thumbnail grid of the linked story's most
// recent successful short_render. Each frame can then be promoted into the
// article's hero_image, og_image, or gallery via the actions in
// app/admin/(panel)/articles/[id]/actions.ts.
//
// All reads are admin-side; this module is not part of the public reader
// surface and intentionally does not appear in articles-public.ts.

import "server-only";
import { all, one } from "@/lib/db";

export interface ShortFrameRef {
  id: string;
  url: string;
  caption_chunk_start_index: number | null;
}

export interface LinkedShortFrames {
  storyId: string;
  storyTitle: string | null;
  shortRenderId: string;
  frames: ShortFrameRef[];
}

interface DoodleFrameJson {
  id?: unknown;
  url?: unknown;
  caption_chunk_start_index?: unknown;
}

function parseFrame(raw: unknown): ShortFrameRef | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as DoodleFrameJson;
  if (typeof f.id !== "string" || typeof f.url !== "string") return null;
  const idx = f.caption_chunk_start_index;
  return {
    id: f.id,
    url: f.url,
    caption_chunk_start_index: typeof idx === "number" ? idx : null,
  };
}

// Resolve the chain: article -> story_id -> latest done short_render -> frames.
// Returns null when any link in the chain is missing: no article, no linked
// story, no successful render yet, or empty/malformed frames in props. The
// caller renders the panel conditionally on this returning non-null.
export async function getLinkedShortFrames(
  articleId: string,
): Promise<LinkedShortFrames | null> {
  const article = await one<{ story_id: string | null }>(
    "SELECT story_id FROM articles WHERE id = ?",
    [articleId],
  );
  if (!article || !article.story_id) return null;
  const storyId = article.story_id;
  const story = await one<{ title: string | null }>(
    "SELECT title FROM stories WHERE id = ?",
    [storyId],
  );
  // A dangling story_id (story deleted after the link was set) still surfaces
  // its frames if a successful render is in the DB — the panel shows
  // "Linked story: (deleted)" via the widget. We treat the render row as the
  // source of truth for "is there content to surface."
  const renders = await all<{
    id: string;
    props: string | null;
    finished_at: string | null;
  }>(
    "SELECT id, props, finished_at FROM short_renders " +
      "WHERE story_id = ? AND status = 'done' AND props IS NOT NULL " +
      "ORDER BY COALESCE(finished_at, requested_at) DESC LIMIT 1",
    [storyId],
  );
  const render = renders[0];
  if (!render || !render.props) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(render.props);
  } catch {
    console.warn("[article-shorts] props-unparseable", {
      articleId,
      storyId,
      shortRenderId: render.id,
    });
    return null;
  }
  const rawFrames = (parsed as { doodle_frames?: unknown } | null)
    ?.doodle_frames;
  if (!Array.isArray(rawFrames)) return null;
  const frames: ShortFrameRef[] = [];
  for (const raw of rawFrames) {
    const f = parseFrame(raw);
    if (f) frames.push(f);
  }
  if (frames.length === 0) return null;
  return {
    storyId,
    storyTitle: story?.title ?? null,
    shortRenderId: render.id,
    frames,
  };
}

// Look up a single frame by id, scoped to the article's linked short. The
// server actions use this so they never trust a frameUrl from the client —
// the client sends a frameId, the server resolves the URL from the linked
// render's props. Returns null when the frame is not in the linked render
// (article unlinked, frameId stale, etc.).
export async function getLinkedShortFrame(
  articleId: string,
  frameId: string,
): Promise<ShortFrameRef | null> {
  const linked = await getLinkedShortFrames(articleId);
  if (!linked) return null;
  return linked.frames.find((f) => f.id === frameId) ?? null;
}
