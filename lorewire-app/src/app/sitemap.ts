import type { MetadataRoute } from "next";
import { listPublishedArticles } from "@/lib/articles-public";
import { listPublishedStories } from "@/lib/stories-public";
import { getSiteSeo } from "@/lib/site-seo";

// Sitewide sitemap. Honors:
//   - seo.site_url for the canonical origin (falls back to
//     NEXT_PUBLIC_SITE_ORIGIN, then to a relative empty origin)
//   - seo.sitemap_max_age_days to drop pieces older than N days (0 = keep
//     everything forever)
//   - per-row noindex: pieces marked noindex never appear here
//   - articles + stories: both listed; articles include the language path
//     segment so the canonical URL matches the public reader
//
// Output limit: Google's sitemap-protocol cap is 50,000 URLs. We don't
// approach it today; if we ever do, this becomes a generateSitemaps()
// shard rather than a single export.

const ARTICLE_FETCH_LIMIT = 5000;
const STORY_FETCH_LIMIT = 5000;

function resolveOrigin(siteUrlSetting: string): string {
  return (
    siteUrlSetting || process.env.NEXT_PUBLIC_SITE_ORIGIN || ""
  ).replace(/\/$/, "");
}

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

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const seo = await getSiteSeo();
  const origin = resolveOrigin(seo.siteUrl);
  const maxAgeDays = seo.sitemapMaxAgeDays;

  const [articles, stories] = await Promise.all([
    listPublishedArticles({ limit: ARTICLE_FETCH_LIMIT }),
    listPublishedStories({ limit: STORY_FETCH_LIMIT }),
  ]);

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

  console.info("[sitemap] generated", {
    origin,
    article_count: articles.length,
    story_count: stories.length,
    max_age_days: maxAgeDays,
    total_entries: entries.length,
  });

  return entries;
}
