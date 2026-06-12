// Public read API for stories. Mirrors articles-public.ts: drafts and
// archived rows never leak through — only status='published' with a non-null
// published_at is returned. Slug-based lookup matches the URL contract at
// /v/[slug]; stories without slugs are not publicly readable by design.

import "server-only";
import { all, one } from "@/lib/db";
import type { StoryRow } from "@/lib/repo";

// Mirror the full StoryRow shape so callers don't get a partial type lie.
// The reader page filters down to the fields it actually renders; this keeps
// the typing honest and avoids a parallel PublicStoryRow that drifts.
const PUBLIC_COLS =
  "id, reddit_id, slug, category, title, summary, body, teleprompter, status, source_url, hero_image, images, audio_url, video_url, duration, alignment, intro_segment_id, outro_segment_id, skip_intro, skip_outro, video_config, tokens, cost_cents, created_at, updated_at, published_at, payload, noindex";

export interface PublicStoryListRow {
  id: string;
  slug: string | null;
  category: string | null;
  title: string | null;
  summary: string | null;
  hero_image: string | null;
  video_url: string | null;
  duration: string | null;
  created_at: string | null;
  updated_at: string | null;
  published_at: string | null;
}

const LIST_COLS =
  "id, slug, category, title, summary, hero_image, video_url, duration, created_at, updated_at, published_at";

export interface ListPublishedStoriesOpts {
  category?: string;
  limit?: number;
  beforePublishedAt?: string | null;
}

export async function listPublishedStories(
  opts: ListPublishedStoriesOpts = {},
): Promise<PublicStoryListRow[]> {
  // noindex filter mirrors articles-public — any story marked
  // noindex stays out of the public list, RSS, and sitemap.
  const where: string[] = [
    "status = 'published'",
    "published_at IS NOT NULL",
    "slug IS NOT NULL",
    "(noindex IS NULL OR noindex = 0)",
  ];
  const params: unknown[] = [];
  if (opts.category) {
    where.push("category = ?");
    params.push(opts.category);
  }
  if (opts.beforePublishedAt) {
    where.push("published_at < ?");
    params.push(opts.beforePublishedAt);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const limit = opts.limit ? `LIMIT ${Math.trunc(opts.limit)}` : "";
  return all<PublicStoryListRow>(
    `SELECT ${LIST_COLS} FROM stories ${clause} ORDER BY published_at DESC ${limit}`,
    params,
  );
}

export async function getPublishedStoryBySlug(
  slug: string,
): Promise<StoryRow | null> {
  if (!slug) return null;
  return one<StoryRow>(
    `SELECT ${PUBLIC_COLS} FROM stories WHERE slug = ? AND status = 'published' AND published_at IS NOT NULL`,
    [slug],
  );
}

export async function countPublishedStories(): Promise<number> {
  const r = await one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM stories WHERE status = 'published' AND published_at IS NOT NULL AND slug IS NOT NULL",
  );
  return r?.n ?? 0;
}
