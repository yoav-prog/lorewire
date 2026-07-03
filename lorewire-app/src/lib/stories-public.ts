// Public read API for stories. Mirrors articles-public.ts: drafts and
// archived rows never leak through — only status='published' with a non-null
// published_at is returned. Slug-based lookup matches the URL contract at
// /v/[slug]; stories without slugs are not publicly readable by design.

import "server-only";
import { all, one } from "@/lib/db";
import { resolveMediaUrl } from "@/lib/media-url";
import type { StoryRow } from "@/lib/repo";

// Mirror the full StoryRow shape so callers don't get a partial type lie.
// The reader page filters down to the fields it actually renders; this keeps
// the typing honest and avoids a parallel PublicStoryRow that drifts.
// submission_id is the origin marker for user-submitted stories. It drives the
// public "Submitted by" byline + the victim-report link footer in /v/[slug]; it
// was missing from this list, so both rendered against an undefined value (the
// report footer never showed). Keep it selected here.
// short_config was missing from this list until 2026-07-03 — the reader's
// generateMetadata reads story.short_config for the Phase 3 OG poster, so
// the poster silently never served on /v pages (the field arrived
// undefined and the code fell through to the hero fallback).
// The artwork variants (landscape hero, baked-title flag, thumbnails) are
// selected for the og:image fallback chain: heroes render clean, so the
// titled 16:9 thumbnail is what a share card should show.
// props feeds the Skip Intro window resolver (lib/intro-window-resolve) on
// the reader page. Server-side only — the page passes the two derived
// numbers to the client, never the raw blob.
const PUBLIC_COLS =
  "id, reddit_id, submission_id, slug, category, title, summary, body, teleprompter, status, source_url, hero_image, images, audio_url, video_url, duration, alignment, intro_segment_id, outro_segment_id, skip_intro, skip_outro, video_config, short_config, props, tokens, cost_cents, created_at, updated_at, published_at, payload, noindex, hero_image_landscape, hero_has_baked_title, thumbnail_image, thumbnail_image_landscape, thumbnail_image_square";

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
  const rows = await all<PublicStoryListRow>(
    `SELECT ${LIST_COLS} FROM stories ${clause} ORDER BY published_at DESC ${limit}`,
    params,
  );
  // Resolve hero/video onto the delivery base (lib/media-url); passthrough when
  // MEDIA_PUBLIC_BASE is unset.
  return rows.map((s) => ({
    ...s,
    hero_image: resolveMediaUrl(s.hero_image),
    video_url: resolveMediaUrl(s.video_url),
  }));
}

export async function getPublishedStoryBySlug(
  slug: string,
): Promise<StoryRow | null> {
  if (!slug) return null;
  const row = await one<StoryRow>(
    `SELECT ${PUBLIC_COLS} FROM stories WHERE slug = ? AND status = 'published' AND published_at IS NOT NULL`,
    [slug],
  );
  if (!row) return null;
  // Resolve media onto the delivery base (lib/media-url); passthrough when
  // MEDIA_PUBLIC_BASE is unset. source_url is the external Reddit link, NOT our
  // media, so it is left untouched. getLiveStoryMedia may re-resolve these via
  // its slug fallback; resolveMediaUrl is idempotent so that is safe.
  return {
    ...row,
    video_url: resolveMediaUrl(row.video_url),
    hero_image: resolveMediaUrl(row.hero_image),
    hero_image_landscape: resolveMediaUrl(row.hero_image_landscape),
    thumbnail_image: resolveMediaUrl(row.thumbnail_image),
    thumbnail_image_landscape: resolveMediaUrl(row.thumbnail_image_landscape),
    thumbnail_image_square: resolveMediaUrl(row.thumbnail_image_square),
    audio_url: resolveMediaUrl(row.audio_url),
  };
}

export async function countPublishedStories(): Promise<number> {
  const r = await one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM stories WHERE status = 'published' AND published_at IS NOT NULL AND slug IS NOT NULL",
  );
  return r?.n ?? 0;
}
