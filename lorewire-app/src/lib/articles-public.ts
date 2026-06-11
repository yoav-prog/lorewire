// Public read API for articles. This module is the seam where a future
// monorepo sibling package (@lorewire/articles) would attach: every
// dependency here is repo-internal or a peer-safe import, no admin code,
// no React, no Tiptap-React. The renderer (article-html.ts) is the matching
// half — both modules together are everything a reader surface needs.
//
// Default behaviour is "show published only." A caller that wants the
// editor-grade unfiltered view goes through repo.ts directly; the public
// surface refuses to leak drafts even if a caller forgets the filter,
// because every function here hardcodes the predicate.

import "server-only";
import {
  all,
  one,
} from "@/lib/db";
import type {
  ArticleListRow,
  ArticleRow,
  ArticleLanguage,
  ArticleType,
} from "@/lib/repo";

// Columns mirror repo.ts. We duplicate the constant so the SQL strings live
// next to the function that uses them — a future extraction of this module
// into its own package shouldn't have to reach back across the seam.
const PUBLIC_LIST_COLS =
  "id, type, language, slug, title, summary, hero_image, og_image, meta_description, created_at, updated_at, published_at, noindex";
const PUBLIC_FULL_COLS =
  "id, type, language, slug, title, subtitle, summary, document, hero_image, status, author_id, meta_title, meta_description, og_image, payload, source_sheet_row_id, created_at, updated_at, published_at, noindex";

export interface PublicArticleListRow extends ArticleListRow {
  summary: string | null;
  og_image: string | null;
  meta_description: string | null;
}

export interface ListPublishedOpts {
  language?: ArticleLanguage;
  type?: ArticleType;
  limit?: number;
  // Keyset-style cursor: ISO timestamp string from a previous page. Rows
  // strictly older than this are returned. Null / undefined means "first
  // page." We use published_at descending because the reader index is
  // newest-first and that's the field readers expect a feed to flow by.
  beforePublishedAt?: string | null;
}

export async function listPublishedArticles(
  opts: ListPublishedOpts = {},
): Promise<PublicArticleListRow[]> {
  const where: string[] = ["status = 'published'", "published_at IS NOT NULL"];
  const params: unknown[] = [];
  if (opts.language) {
    where.push("language = ?");
    params.push(opts.language);
  }
  if (opts.type) {
    where.push("type = ?");
    params.push(opts.type);
  }
  if (opts.beforePublishedAt) {
    where.push("published_at < ?");
    params.push(opts.beforePublishedAt);
  }
  const limit = opts.limit ? Math.max(1, Math.min(100, Math.trunc(opts.limit))) : 20;
  const clause = `WHERE ${where.join(" AND ")}`;
  const rows = await all<PublicArticleListRow>(
    `SELECT ${PUBLIC_LIST_COLS} FROM articles ${clause} ORDER BY published_at DESC LIMIT ${limit}`,
    params,
  );
  console.info("[articles reader] list", {
    count: rows.length,
    language: opts.language ?? null,
    type: opts.type ?? null,
    limit,
    cursor: opts.beforePublishedAt ?? null,
  });
  return rows;
}

// Single article fetch, scoped to published. Returns null for drafts /
// archived / review / unknown slug so the reader page can call notFound()
// uniformly without leaking the existence of an unpublished article.
export async function getPublishedArticleBySlug(
  language: ArticleLanguage,
  slug: string,
): Promise<ArticleRow | null> {
  if (!language || !slug) return null;
  return one<ArticleRow>(
    `SELECT ${PUBLIC_FULL_COLS} FROM articles WHERE language = ? AND slug = ? AND status = 'published'`,
    [language, slug],
  );
}

// Count of published articles for a language. Used by the RSS feed and the
// index page's "X articles" header. One small COUNT(*) keeps the index page
// cheap to render even with thousands of articles.
export async function countPublishedArticles(
  language?: ArticleLanguage,
): Promise<number> {
  if (language) {
    const r = await one<{ c: number | string }>(
      "SELECT COUNT(*) AS c FROM articles WHERE status = 'published' AND language = ?",
      [language],
    );
    return Number(r?.c ?? 0);
  }
  const r = await one<{ c: number | string }>(
    "SELECT COUNT(*) AS c FROM articles WHERE status = 'published'",
    [],
  );
  return Number(r?.c ?? 0);
}
