// Article CMS helpers. Pure functions that the admin actions and (later) the
// reader call into — kept separate from `src/lib/repo.ts` (DB I/O) and the
// React component layer. Anything imported here must be safe for both server
// and edge runtimes.

import type { ArticleType, ArticleLanguage } from "@/lib/repo";

// Display labels for the four article types. The keys match the DB column
// values; the labels are what we render in the admin UI. Adding a fifth type
// means updating ARTICLE_TYPES in repo.ts, this map, and the per-type editor
// preset (Phase 2) — keeping the three in one place makes drift obvious.
export const ARTICLE_TYPE_LABELS: Record<ArticleType, string> = {
  news: "News",
  feature: "Long-form feature",
  listicle: "Listicle",
  review: "Review",
};

export const ARTICLE_TYPE_DESCRIPTIONS: Record<ArticleType, string> = {
  news: "Short-form, timestamped, often pulled from external sources.",
  feature: "Multi-section essay or deep-dive with hero image.",
  listicle: "Numbered ranked items with images and blurbs.",
  review: "Verdict, rating, pros/cons.",
};

export const ARTICLE_LANGUAGE_LABELS: Record<ArticleLanguage, string> = {
  en: "English",
  he: "עברית",
};

// Direction per language. Drives both the editor (Tiptap `textDirection`
// option) and the reader (`dir` attribute on the article root). Hebrew is
// RTL; English is LTR. We default to LTR for unknown values rather than
// throwing — a stored article with a bad language is recoverable from the
// admin, while a thrown error makes the editor unreachable.
export function articleDirection(
  language: string | null | undefined,
): "ltr" | "rtl" {
  return language === "he" ? "rtl" : "ltr";
}

// Slug generator. The shape: a kebab-cased ASCII slice of the title plus a
// short suffix derived from the article id so two articles created from the
// same title don't collide at the same instant. Hebrew (or any title with no
// ASCII letters) falls back to `article-<suffix>`. Real per-language uniqueness
// is still enforced at the DB layer by `checkSlugAvailable`; this is the
// best-effort default the SEO panel (Phase 3) will let the editor override.
export function slugifyTitle(title: string, idHint: string): string {
  const suffix = idHint.replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase();
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/^-|-$/g, "");
  return base ? `${base}-${suffix}` : `article-${suffix}`;
}

// Lightweight type-guard predicates so server actions can validate form input
// without pulling Zod into modules that just need a string-narrowing check.
export function isArticleType(v: unknown): v is ArticleType {
  return v === "news" || v === "feature" || v === "listicle" || v === "review";
}

export function isArticleLanguage(v: unknown): v is ArticleLanguage {
  return v === "he" || v === "en";
}
