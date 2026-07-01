// Server-only read layer for the data-driven category tables (PR2,
// _plans/2026-07-01-category-taxonomy-multitag.md). The `categories`
// registry and the `story_tags` join table are seeded/backfilled in db.ts;
// this module is how the app reads them. PR2 does not yet wire these onto
// the homepage/classifier read paths (that is PR3) — the layer exists so the
// read-only admin view and PR3 have a typed, tested entry point.

import "server-only";

import { all, one, run } from "@/lib/db";

export interface CategoryRow {
  slug: string;
  label: string;
  glyph: string | null;
  color: string | null;
  /** 0 | 1. A homepage rail with a curated color when 1. */
  is_rail: number;
  rail_surface: string | null;
  rail_title: string | null;
  sort: number | null;
  /** 'active' | 'archived'. Archived rows are soft-deleted. */
  status: string;
  description: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface StoryTagRow {
  story_id: string;
  category_slug: string;
  /** 0 | 1. Exactly one primary per story (partial unique index). */
  is_primary: number;
  source: string | null;
  confidence: number | null;
  created_at: string | null;
}

/** Categories in admin/display order. Excludes archived rows unless asked. */
export async function listCategories(
  opts: { includeArchived?: boolean } = {},
): Promise<CategoryRow[]> {
  const where = opts.includeArchived ? "" : "WHERE status = 'active' ";
  return all<CategoryRow>(
    `SELECT slug, label, glyph, color, is_rail, rail_surface, rail_title, ` +
      `sort, status, description, created_at, updated_at ` +
      `FROM categories ${where}ORDER BY sort ASC, label ASC`,
  );
}

/** One category by its immutable slug, or null. */
export async function getCategoryBySlug(
  slug: string,
): Promise<CategoryRow | null> {
  return one<CategoryRow>(
    "SELECT slug, label, glyph, color, is_rail, rail_surface, rail_title, " +
      "sort, status, description, created_at, updated_at " +
      "FROM categories WHERE slug = ?",
    [slug],
  );
}

/** All tags for a story, primary first then by slug. */
export async function getStoryTags(storyId: string): Promise<StoryTagRow[]> {
  return all<StoryTagRow>(
    "SELECT story_id, category_slug, is_primary, source, confidence, created_at " +
      "FROM story_tags WHERE story_id = ? " +
      "ORDER BY is_primary DESC, category_slug ASC",
    [storyId],
  );
}

/** The story's primary tag, or null if it has none yet. */
export async function getPrimaryTag(
  storyId: string,
): Promise<StoryTagRow | null> {
  return one<StoryTagRow>(
    "SELECT story_id, category_slug, is_primary, source, confidence, created_at " +
      "FROM story_tags WHERE story_id = ? AND is_primary = 1",
    [storyId],
  );
}

export interface WriteTag {
  slug: string;
  confidence?: number | null;
}

/** Replace a story's tags with `tags` (most-confident first — the first
 *  becomes is_primary). Delete-then-insert so the one-primary-per-story index
 *  always holds. Mirrors the Python `store.replace_story_tags`. Reversible:
 *  stories.category is left untouched, so the pre-reclassification tags can be
 *  rebuilt by re-running the backfill. Callers must pass validated slugs. */
export async function setStoryTags(
  storyId: string,
  tags: WriteTag[],
  source: string = "llm",
): Promise<void> {
  await run("DELETE FROM story_tags WHERE story_id = ?", [storyId]);
  const now = new Date().toISOString();
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    await run(
      "INSERT INTO story_tags " +
        "(story_id, category_slug, is_primary, source, confidence, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
      [storyId, t.slug, i === 0 ? 1 : 0, source, t.confidence ?? null, now],
    );
  }
}

export interface CategoryStoryRow {
  id: string;
  slug: string | null;
  title: string | null;
  summary: string | null;
  hero_image: string | null;
  is_primary: number;
}

/** Published stories tagged with `slug`, primary-first then newest. Powers the
 *  /c/<slug> category landing pages. Reads story_tags (the applied multi-tag
 *  classification), so it reflects the new taxonomy regardless of the legacy
 *  stories.category value. */
export async function getStoriesForCategory(
  slug: string,
  limit = 60,
): Promise<CategoryStoryRow[]> {
  const cap = Math.max(1, Math.min(limit, 200));
  return all<CategoryStoryRow>(
    "SELECT s.id, s.slug, s.title, s.summary, s.hero_image, t.is_primary " +
      "FROM stories s " +
      "JOIN story_tags t ON t.story_id = s.id AND t.category_slug = ? " +
      "WHERE s.status = 'published' " +
      "ORDER BY t.is_primary DESC, COALESCE(s.published_at, s.created_at) DESC " +
      `LIMIT ${cap}`,
    [slug],
  );
}
