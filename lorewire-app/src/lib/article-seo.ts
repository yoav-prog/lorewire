// SEO helpers for the articles CMS. Two distinct surfaces share this file:
// the SEO panel inside the editor (length budgets, JSON-LD preview), and
// the public reader page (Phase 4a) that will emit the actual schema.org
// markup and <meta> tags using the same generators. Keeping both off one
// helper means the editor's preview cannot drift from what the reader
// actually serves.

import type { ArticleRow, ArticleType } from "@/lib/repo";
import {
  parseArticlePayload,
  type ArticlePayload,
} from "@/lib/article-payload";

// --- length budgets ---------------------------------------------------------
// Google truncates title around 60 chars and description around 160. The
// SEO panel shows three states: under -> "ok", inside the upper margin ->
// "tight", over -> "long". `tight` is a soft warning to let writers know
// they're close to truncation without flat-out blocking them.

export const META_TITLE_OPTIMAL = 60;
export const META_TITLE_MAX = 70;
export const META_DESC_OPTIMAL = 160;
export const META_DESC_MAX = 170;

export type LengthBudgetState = "empty" | "ok" | "tight" | "long";

export function metaTitleState(value: string): LengthBudgetState {
  const n = value.trim().length;
  if (n === 0) return "empty";
  if (n <= META_TITLE_OPTIMAL) return "ok";
  if (n <= META_TITLE_MAX) return "tight";
  return "long";
}

export function metaDescState(value: string): LengthBudgetState {
  const n = value.trim().length;
  if (n === 0) return "empty";
  if (n <= META_DESC_OPTIMAL) return "ok";
  if (n <= META_DESC_MAX) return "tight";
  return "long";
}

// --- slug validation --------------------------------------------------------
// Per-language uniqueness lives in checkSlugAvailable (repo). This is the
// shape check the editor uses to refuse a write before it hits the server:
// lowercase a-z, digits, hyphens, no leading/trailing hyphen, no double
// hyphen, total length within the human-readable URL band.

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlugShape(slug: string): boolean {
  if (slug.length < 1 || slug.length > 120) return false;
  return SLUG_RE.test(slug);
}

// --- JSON-LD generators -----------------------------------------------------
// One generator per article type. All four return a plain JSON-serializable
// object the panel pretty-prints for preview and the reader serializes into
// <script type="application/ld+json">. We intentionally include only fields
// the row actually owns; missing fields are dropped rather than emitted as
// nulls (search engines treat nulls as worse than absence).

export interface JsonLdContext {
  article: ArticleRow;
  // Origin like "https://lorewire.example" — used to absolutize OG and
  // article URLs. Defaults to "" (relative URLs) for the editor preview
  // because the editor doesn't know the production origin; the reader page
  // will pass the real value.
  siteOrigin?: string;
  // Site-level brand name for publisher field. Falls back to "LoreWire".
  siteName?: string;
}

function articleUrl(ctx: JsonLdContext): string {
  const lang = ctx.article.language ?? "en";
  const slug = ctx.article.slug ?? ctx.article.id;
  const path = `/articles/${lang}/${slug}`;
  return ctx.siteOrigin ? `${ctx.siteOrigin}${path}` : path;
}

function maybe<T>(obj: Record<string, T | undefined | null>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v as T;
  }
  return out;
}

function publisherBlock(ctx: JsonLdContext): Record<string, unknown> {
  return {
    "@type": "Organization",
    name: ctx.siteName ?? "LoreWire",
  };
}

function authorBlock(name: string): Record<string, unknown> {
  return { "@type": "Person", name };
}

function imageBlock(url: string): string | undefined {
  return url ? url : undefined;
}

function newsJsonLd(
  ctx: JsonLdContext,
  payload: Extract<ArticlePayload, { type: "news" }>["payload"],
): Record<string, unknown> {
  const a = ctx.article;
  const dateline = [payload.datelineLocation, payload.datelineDate]
    .filter((s) => s.trim())
    .join(", ");
  return maybe({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: a.title ?? undefined,
    description: a.meta_description ?? a.summary ?? undefined,
    inLanguage: a.language ?? undefined,
    datePublished: a.published_at ?? undefined,
    dateModified: a.updated_at ?? undefined,
    image: imageBlock(a.og_image ?? a.hero_image ?? ""),
    mainEntityOfPage: articleUrl(ctx),
    publisher: publisherBlock(ctx),
    // Dateline is news-specific; we surface it under a custom field to
    // avoid lying about Schema.org coverage. Some readers will ignore it;
    // that's fine.
    dateline: dateline || undefined,
    // sourceOrganization populated only when sourceLabel is set — without
    // a label the URL alone is too brittle to attribute cleanly.
    sourceOrganization:
      payload.sourceLabel && payload.sourceUrl
        ? maybe({
            "@type": "Organization",
            name: payload.sourceLabel,
            url: payload.sourceUrl,
          })
        : undefined,
  });
}

function featureJsonLd(
  ctx: JsonLdContext,
  payload: Extract<ArticlePayload, { type: "feature" }>["payload"],
): Record<string, unknown> {
  const a = ctx.article;
  return maybe({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: a.title ?? undefined,
    alternativeHeadline: a.subtitle ?? undefined,
    description: a.meta_description ?? a.summary ?? undefined,
    inLanguage: a.language ?? undefined,
    datePublished: a.published_at ?? undefined,
    dateModified: a.updated_at ?? undefined,
    image: imageBlock(a.og_image ?? a.hero_image ?? ""),
    mainEntityOfPage: articleUrl(ctx),
    publisher: publisherBlock(ctx),
    author: payload.authorByline
      ? authorBlock(payload.authorByline)
      : undefined,
    timeRequired:
      payload.readingTimeMinutes > 0
        ? `PT${payload.readingTimeMinutes}M`
        : undefined,
  });
}

function listicleJsonLd(
  ctx: JsonLdContext,
  payload: Extract<ArticlePayload, { type: "listicle" }>["payload"],
): Record<string, unknown> {
  const a = ctx.article;
  // ItemList rendered with the original order. countdownOrder is a UI flag
  // for the reader template (largest-first display); the JSON-LD positions
  // still go 1..N in array order.
  return maybe({
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: a.title ?? undefined,
    description: a.meta_description ?? a.summary ?? undefined,
    inLanguage: a.language ?? undefined,
    itemListOrder: payload.countdownOrder
      ? "https://schema.org/ItemListOrderDescending"
      : "https://schema.org/ItemListOrderAscending",
    numberOfItems: payload.items.length,
    itemListElement: payload.items.map((item, idx) =>
      maybe({
        "@type": "ListItem",
        position: item.rank || idx + 1,
        name: item.title || undefined,
        description: item.body || undefined,
        image: imageBlock(item.imageUrl),
      }),
    ),
  });
}

function reviewJsonLd(
  ctx: JsonLdContext,
  payload: Extract<ArticlePayload, { type: "review" }>["payload"],
): Record<string, unknown> {
  const a = ctx.article;
  return maybe({
    "@context": "https://schema.org",
    "@type": "Review",
    name: a.title ?? undefined,
    description: a.meta_description ?? a.summary ?? undefined,
    inLanguage: a.language ?? undefined,
    datePublished: a.published_at ?? undefined,
    dateModified: a.updated_at ?? undefined,
    image: imageBlock(a.og_image ?? a.hero_image ?? ""),
    mainEntityOfPage: articleUrl(ctx),
    publisher: publisherBlock(ctx),
    reviewBody: a.summary ?? undefined,
    reviewRating:
      payload.rating > 0
        ? maybe({
            "@type": "Rating",
            ratingValue: payload.rating,
            bestRating: 10,
            worstRating: 0,
          })
        : undefined,
    // The reviewed item is intentionally generic: the schema requires an
    // itemReviewed, and a Thing with the article's title is the closest we
    // can get without a separate "what is this a review of" input. A
    // dedicated field is a Phase 5+ ask.
    itemReviewed: maybe({
      "@type": "Thing",
      name: a.title ?? undefined,
    }),
  });
}

export function buildArticleJsonLd(ctx: JsonLdContext): Record<string, unknown> {
  const type = (ctx.article.type ?? "feature") as ArticleType;
  const parsed = parseArticlePayload(type, ctx.article.payload);
  switch (parsed.type) {
    case "news":
      return newsJsonLd(ctx, parsed.payload);
    case "feature":
      return featureJsonLd(ctx, parsed.payload);
    case "listicle":
      return listicleJsonLd(ctx, parsed.payload);
    case "review":
      return reviewJsonLd(ctx, parsed.payload);
  }
}
