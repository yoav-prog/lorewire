import type { MetadataRoute } from "next";
import { listPublishedArticles } from "@/lib/articles-public";
import { listCategories } from "@/lib/categories/repo";
import { listPublishedStories } from "@/lib/stories-public";
import { getSiteSeo, resolveSiteOrigin } from "@/lib/site-seo";

// Sitewide sitemap. Honors:
//   - seo.site_url for the canonical origin (falls back to
//     NEXT_PUBLIC_SITE_ORIGIN, then to a relative empty origin)
//   - seo.sitemap_max_age_days to drop pieces older than N days (0 = keep
//     everything forever)
//   - per-row noindex: pieces marked noindex never appear here
//   - articles + stories: both listed; articles include the language path
//     segment so the canonical URL matches the public reader
//   - static trust/info pages and the active /c/{category} landing pages
//     (both were missing until 2026-07-05 — the category pages existed but
//     were orphaned: no sitemap entry and no crawlable inbound link)
//
// Output limit: Google's sitemap-protocol cap is 50,000 URLs. We don't
// approach it today; if we ever do, this becomes a generateSitemaps()
// shard rather than a single export.

const ARTICLE_FETCH_LIMIT = 5000;
const STORY_FETCH_LIMIT = 5000;

// Public static pages. All are indexable (none set robots noindex) —
// keep in sync with src/app/* when a trust/info page is added.
// /data-deletion is deliberately absent: it only exists as the dynamic
// per-request status page /data-deletion/[code], so the bare path 404s.
const STATIC_PAGES = [
  "/about",
  "/faq",
  "/contact",
  "/community-guidelines",
  "/accessibility",
  "/privacy",
  "/terms",
  "/dmca",
  "/cookie-policy",
  "/imprint",
] as const;

function isExpired(
  publishedAt: string | null,
  maxAgeDays: number,
): boolean {
  if (maxAgeDays <= 0) return false;
  if (!publishedAt) return false;
  const ts = Date.parse(publishedAt);
  if (!Number.isFinite(ts)) return false;
  const ageMs = Date.now() - ts;
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

// Minimal structural slices of PublicStoryListRow / the articles row —
// just the fields the sitemap reads, so the builder stays testable
// without a DB.
interface SitemapStory {
  slug: string | null;
  published_at: string | null;
  updated_at: string | null;
}

interface SitemapArticle extends SitemapStory {
  language: string | null;
}

export interface SitemapInputs {
  origin: string;
  maxAgeDays: number;
  articles: SitemapArticle[];
  stories: SitemapStory[];
  /** Active category slugs — each becomes a /c/{slug} entry. */
  categorySlugs: string[];
}

// Pure builder, split from the default export so entry composition is
// unit-testable without settings_kv or the content tables.
export function buildSitemapEntries(
  inputs: SitemapInputs,
): MetadataRoute.Sitemap {
  const { origin, maxAgeDays, articles, stories, categorySlugs } = inputs;
  const entries: MetadataRoute.Sitemap = [];

  // Homepage + articles index. The homepage is always indexable; the
  // articles index inherits the same.
  entries.push({
    url: `${origin}/`,
    lastModified: new Date(),
    changeFrequency: "daily",
    priority: 1,
  });
  entries.push({
    url: `${origin}/articles`,
    lastModified: new Date(),
    changeFrequency: "daily",
    priority: 0.8,
  });

  // Category landing pages (/c/roommate-hell etc.) — the topical hubs
  // that link out to their stories.
  for (const slug of categorySlugs) {
    if (!slug) continue;
    entries.push({
      url: `${origin}/c/${slug}`,
      changeFrequency: "daily",
      priority: 0.6,
    });
  }

  // Static trust/info pages. Legal pages change rarely; monthly is honest.
  for (const path of STATIC_PAGES) {
    entries.push({
      url: `${origin}${path}`,
      changeFrequency: "monthly",
      priority: 0.4,
    });
  }

  for (const a of articles) {
    if (isExpired(a.published_at, maxAgeDays)) continue;
    if (!a.slug || !a.language) continue;
    entries.push({
      url: `${origin}/articles/${a.language}/${a.slug}`,
      lastModified: a.updated_at
        ? new Date(a.updated_at)
        : a.published_at
          ? new Date(a.published_at)
          : undefined,
      changeFrequency: "weekly",
      priority: 0.7,
    });
  }

  for (const s of stories) {
    if (isExpired(s.published_at, maxAgeDays)) continue;
    if (!s.slug) continue;
    entries.push({
      url: `${origin}/v/${s.slug}`,
      lastModified: s.updated_at
        ? new Date(s.updated_at)
        : s.published_at
          ? new Date(s.published_at)
          : undefined,
      changeFrequency: "weekly",
      priority: 0.7,
    });
  }

  return entries;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const seo = await getSiteSeo();
  const origin = resolveSiteOrigin(seo.siteUrl);
  const maxAgeDays = seo.sitemapMaxAgeDays;

  const [articles, stories, categories] = await Promise.all([
    listPublishedArticles({ limit: ARTICLE_FETCH_LIMIT }),
    listPublishedStories({ limit: STORY_FETCH_LIMIT }),
    listCategories(),
  ]);

  const entries = buildSitemapEntries({
    origin,
    maxAgeDays,
    articles,
    stories,
    categorySlugs: categories.map((c) => c.slug),
  });

  console.info("[sitemap] generated", {
    origin,
    article_count: articles.length,
    story_count: stories.length,
    category_count: categories.length,
    static_count: STATIC_PAGES.length,
    max_age_days: maxAgeDays,
    total_entries: entries.length,
  });

  return entries;
}
