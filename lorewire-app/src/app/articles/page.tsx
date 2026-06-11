// /articles — the public reader index.
//
// Newest-first feed of published articles. Filter chips along the top
// (language + type) drive a keyset-paginated list. A "More" link at the
// bottom uses the oldest visible article's published_at as the cursor for
// the next page, so pagination stays stable across new publishes.
//
// This page is uncached and dynamic — published_at moves forward in real
// time when an editor flips an article to published, and we want that
// surface to land instantly without manual revalidation. The cost is one
// slim query per request; with the published_at index baked into the
// ORDER BY it stays cheap.

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  ARTICLE_TYPES,
  ARTICLE_LANGUAGES,
  type ArticleLanguage,
  type ArticleType,
} from "@/lib/repo";
import {
  ARTICLE_TYPE_LABELS,
  ARTICLE_LANGUAGE_LABELS,
  articleDirection,
} from "@/lib/articles";
import {
  listPublishedArticles,
  countPublishedArticles,
} from "@/lib/articles-public";

const PAGE_SIZE = 20;

function isLanguage(v: string | undefined): v is ArticleLanguage {
  return v === "he" || v === "en";
}

function isType(v: string | undefined): v is ArticleType {
  return (
    v === "news" || v === "feature" || v === "listicle" || v === "review"
  );
}

export const metadata: Metadata = {
  title: "Articles — LoreWire",
  description: "Editorial features, news, listicles, and reviews from LoreWire.",
  openGraph: {
    title: "Articles — LoreWire",
    description: "Editorial features, news, listicles, and reviews from LoreWire.",
    type: "website",
  },
  alternates: {
    types: {
      "application/rss+xml": [
        { url: "/articles/en/rss.xml", title: "LoreWire articles (English)" },
        { url: "/articles/he/rss.xml", title: "LoreWire articles (עברית)" },
      ],
    },
  },
};

export default async function ArticlesIndex({
  searchParams,
}: {
  searchParams: Promise<{
    language?: string;
    type?: string;
    before?: string;
  }>;
}) {
  const sp = await searchParams;
  const language = isLanguage(sp.language) ? sp.language : undefined;
  const type = isType(sp.type) ? sp.type : undefined;
  const before = sp.before || undefined;

  const [rows, total] = await Promise.all([
    listPublishedArticles({
      language,
      type,
      limit: PAGE_SIZE,
      beforePublishedAt: before ?? null,
    }),
    countPublishedArticles(language),
  ]);

  if (before && rows.length === 0) {
    // A bogus cursor (or one past the end) becomes a 404 rather than
    // silently rendering an empty page that looks identical to "no articles."
    notFound();
  }

  const baseQs = (override: Partial<Record<string, string | undefined>>) => {
    const next = new URLSearchParams();
    const merged = { language, type, ...override };
    for (const [k, v] of Object.entries(merged)) {
      if (v) next.set(k, v);
    }
    const qs = next.toString();
    return qs ? `?${qs}` : "";
  };

  const chip = (href: string, label: string, active: boolean) => (
    <Link
      key={`${label}-${href}`}
      href={href}
      className={`rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${
        active
          ? "border-ink/30 bg-surface2 text-ink"
          : "border-line text-muted hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );

  const nextCursor =
    rows.length === PAGE_SIZE ? rows[rows.length - 1].published_at : null;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-3">
        <h1 className="font-display text-[32px] font-extrabold tracking-tightest">
          {language ? ARTICLE_LANGUAGE_LABELS[language] : "Articles"}
        </h1>
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted">
          {total} total
        </span>
      </header>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Type
          </span>
          {chip(`/articles${baseQs({ type: undefined })}`, "All", !type)}
          {ARTICLE_TYPES.map((t) =>
            chip(
              `/articles${baseQs({ type: t })}`,
              ARTICLE_TYPE_LABELS[t],
              type === t,
            ),
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Language
          </span>
          {chip(`/articles${baseQs({ language: undefined })}`, "All", !language)}
          {ARTICLE_LANGUAGES.map((l) =>
            chip(
              `/articles${baseQs({ language: l })}`,
              ARTICLE_LANGUAGE_LABELS[l],
              language === l,
            ),
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface p-8 text-center text-muted">
          No published articles match this filter.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((a) => {
            const lang = (a.language ?? "en") as ArticleLanguage;
            const dir = articleDirection(lang);
            return (
              <li key={a.id}>
                <Link
                  href={`/articles/${lang}/${a.slug ?? a.id}`}
                  className="block rounded-xl border border-line bg-surface p-4 transition-colors hover:border-accent"
                >
                  <span className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted">
                    <span>{ARTICLE_TYPE_LABELS[a.type as ArticleType] ?? a.type}</span>
                    <span>·</span>
                    <span>{ARTICLE_LANGUAGE_LABELS[lang]}</span>
                    {a.published_at && (
                      <>
                        <span>·</span>
                        <span>{a.published_at.slice(0, 10)}</span>
                      </>
                    )}
                  </span>
                  <span dir={dir} className="block text-[18px] text-ink">
                    {a.title || a.slug || a.id}
                  </span>
                  {a.summary && (
                    <span dir={dir} className="mt-1 block text-[14px] text-muted">
                      {a.summary}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {nextCursor && (
        <div className="flex justify-center">
          <Link
            href={`/articles${baseQs({ before: nextCursor ?? undefined })}`}
            className="rounded-full border border-line px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:border-accent hover:text-ink"
          >
            Older →
          </Link>
        </div>
      )}
    </div>
  );
}
