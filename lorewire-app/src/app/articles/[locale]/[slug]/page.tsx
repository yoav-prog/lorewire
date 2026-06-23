// /articles/[locale]/[slug] — the public reader for a single article.
//
// Server component. Loads the row via the public-read API (so drafts /
// archived rows resolve to notFound), renders the body via the same
// server-side Tiptap renderer the RSS feed uses, and emits OG metadata
// plus an inline JSON-LD <script> the editor's SEO panel already previews.
// Type-specific extras (news dateline, listicle items, review verdict +
// pros/cons) wrap the body so each type reads how the writer intends.

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getPublishedArticleBySlug,
} from "@/lib/articles-public";
import { renderArticleHtml } from "@/lib/article-html";
import {
  parseArticlePayload,
  type ArticlePayload,
} from "@/lib/article-payload";
import { buildArticleJsonLd } from "@/lib/article-seo";
import {
  ARTICLE_LANGUAGE_LABELS,
  ARTICLE_TYPE_LABELS,
  articleDirection,
} from "@/lib/articles";
import type { ArticleLanguage, ArticleRow, ArticleType } from "@/lib/repo";
import { getSiteSeo, buildPageTitle } from "@/lib/site-seo";
import { readCommentToken } from "@/lib/comment-cookie";
import { readUserSession } from "@/lib/user-session";
import { countPublishedComments, loadCommentThread } from "@/lib/comments-read";
import { commentsEnabledForArticle } from "@/lib/comments";
import { CommentsSection } from "@/components/CommentsSection";

function isLanguage(v: string): v is ArticleLanguage {
  return v === "he" || v === "en";
}

interface Params {
  locale: string;
  slug: string;
}

async function loadArticle(params: Params): Promise<ArticleRow | null> {
  if (!isLanguage(params.locale)) return null;
  return getPublishedArticleBySlug(params.locale, params.slug);
}

// Origin used to absolutize OG/canonical URLs. Prefer the admin-configured
// seo.site_url; fall back to the NEXT_PUBLIC_SITE_ORIGIN env var; empty
// string for local dev produces sensible relative URLs.
function resolveOrigin(siteUrlSetting: string): string {
  return (
    siteUrlSetting || process.env.NEXT_PUBLIC_SITE_ORIGIN || ""
  ).replace(/\/$/, "");
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const article = await loadArticle(await params);
  const seo = await getSiteSeo();
  if (!article) {
    return {
      title: buildPageTitle("Not found", seo.titleTemplate, seo.siteName),
    };
  }
  const origin = resolveOrigin(seo.siteUrl);
  const canonical = `${origin}/articles/${article.language}/${article.slug}`;
  const pageTitle =
    article.meta_title ?? article.title ?? "Article";
  const title = buildPageTitle(pageTitle, seo.titleTemplate, seo.siteName);
  const description =
    article.meta_description ?? article.summary ?? seo.defaultMetaDescription;
  const ogImage =
    article.og_image ??
    article.hero_image ??
    (seo.defaultOgImage || `${origin}/articles/og/${article.id}`);

  const noindex = article.noindex === 1;

  return {
    title,
    description,
    alternates: { canonical },
    robots: noindex
      ? { index: false, follow: false }
      : { index: true, follow: true },
    openGraph: {
      title,
      description,
      type: "article",
      url: canonical,
      siteName: seo.siteName,
      images: ogImage ? [{ url: ogImage }] : undefined,
      locale: article.language ?? "en",
    },
    twitter: {
      card: seo.twitterCardType,
      title,
      description,
      images: ogImage ? [ogImage] : undefined,
      site: seo.twitterHandle || undefined,
    },
    // Verification metas (Google Search Console, Bing Webmaster) attach
    // to every public page via the metadata tree.
    verification: {
      google: seo.googleVerification || undefined,
      other: seo.bingVerification
        ? { "msvalidate.01": seo.bingVerification }
        : undefined,
    },
  };
}

export default async function ArticleReader({
  params,
}: {
  params: Promise<Params>;
}) {
  const resolved = await params;
  const article = await loadArticle(resolved);
  if (!article) notFound();

  const language = (article.language ?? "en") as ArticleLanguage;
  const type = (article.type ?? "feature") as ArticleType;
  const dir = articleDirection(language);
  const payload = parseArticlePayload(type, article.payload);

  const bodyHtml = renderArticleHtml(article.document);
  const seo = await getSiteSeo();
  const jsonLd = buildArticleJsonLd({
    article,
    siteOrigin: resolveOrigin(seo.siteUrl),
    siteName: seo.siteName,
  });

  // Comment thread: first page server-rendered for SEO + no-flash, with the
  // viewer resolved so they see their own held/rejected comments inline.
  // readUserSession is a shim (always null) until the public-side auth surface
  // ships — see src/lib/user-session.ts. Until then every viewer is treated
  // as a guest keyed by the `lw_comment` cookie token.
  const commentSession = await readUserSession();
  const commentToken = await readCommentToken();
  const [commentThread, commentCount, commentsEnabled] = await Promise.all([
    loadCommentThread({
      articleId: article.id,
      sort: "newest",
      viewerUserId: commentSession?.userId ?? null,
      viewerCookieToken: commentToken,
    }),
    countPublishedComments(article.id),
    commentsEnabledForArticle(article.id),
  ]);

  console.info("[articles reader] render", {
    id: article.id,
    type,
    language,
    slug: article.slug,
    docLen: article.document?.length ?? 0,
    comment_count: commentCount,
    comments_enabled: commentsEnabled,
  });

  return (
    <article dir={dir} className="space-y-6">
      {/* JSON-LD lives next to the article so view-source confirms the
          markup the SEO panel previewed. Inline avoids a metadata-only
          escape that some crawlers don't follow. */}
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <Link
        href="/articles"
        className="font-mono text-[11px] uppercase tracking-wider text-muted hover:text-ink"
      >
        ← All articles
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-muted">
          <span>{ARTICLE_TYPE_LABELS[type] ?? type}</span>
          <span>·</span>
          <span>{ARTICLE_LANGUAGE_LABELS[language] ?? language}</span>
          {article.published_at && (
            <>
              <span>·</span>
              <time dateTime={article.published_at}>
                {article.published_at.slice(0, 10)}
              </time>
            </>
          )}
        </div>

        {/* News-only dateline above the title — newspaper convention so the
            reader sees the where + when before the headline lands. */}
        {payload.type === "news" &&
          (payload.payload.datelineLocation || payload.payload.datelineDate) && (
            <p className="font-mono text-[11px] uppercase tracking-wider text-muted">
              {[
                payload.payload.datelineLocation,
                payload.payload.datelineDate,
              ]
                .filter(Boolean)
                .join(" — ")}
            </p>
          )}

        <h1 className="font-display text-[36px] font-extrabold leading-[1.1] tracking-tightest">
          {article.title}
        </h1>

        {article.subtitle && (
          <p className="text-[18px] text-muted">{article.subtitle}</p>
        )}

        {payload.type === "feature" && payload.payload.authorByline && (
          <p className="font-mono text-[11px] text-muted">
            {payload.payload.authorByline}
            {payload.payload.readingTimeMinutes > 0 && (
              <>
                <span className="mx-2">·</span>
                <span>{payload.payload.readingTimeMinutes} min read</span>
              </>
            )}
          </p>
        )}
      </header>

      {article.hero_image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={article.hero_image}
          alt=""
          className="w-full rounded-xl border border-line"
        />
      )}

      {article.summary && (
        <p className="rounded-lg border-l-2 border-accent bg-surface px-4 py-3 text-[17px] leading-relaxed text-ink">
          {article.summary}
        </p>
      )}

      {/* Review block sits ABOVE the body so the score + verdict + pros/cons
          frame whatever the writer wrote underneath. Mirrors what print
          reviews do: verdict first, justification second. */}
      {payload.type === "review" && <ReviewBlock payload={payload.payload} />}

      <div
        className="article-body space-y-3 text-[17px] leading-[1.7]"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: bodyHtml }}
      />

      {/* Listicle items come AFTER the intro body — the writer's body is
          usually a short setup, then the numbered items carry the meat. */}
      {payload.type === "listicle" && <ListicleBlock payload={payload.payload} />}

      <CommentsSection
        articleId={article.id}
        initial={commentThread}
        initialCount={commentCount}
        signedIn={commentSession !== null}
        enabled={commentsEnabled}
      />
    </article>
  );
}

function ReviewBlock({
  payload,
}: {
  payload: Extract<ArticlePayload, { type: "review" }>["payload"];
}) {
  if (
    payload.rating === 0 &&
    !payload.verdict &&
    payload.pros.length === 0 &&
    payload.cons.length === 0
  ) {
    return null;
  }
  return (
    <aside className="rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        {payload.rating > 0 && (
          <span className="flex items-baseline gap-1">
            <span className="font-display text-[40px] font-extrabold text-accent">
              {payload.rating.toFixed(1)}
            </span>
            <span className="font-mono text-[12px] uppercase tracking-wider text-muted">
              / 10
            </span>
          </span>
        )}
        {payload.verdict && (
          <p className="text-[16px] text-ink">{payload.verdict}</p>
        )}
      </div>
      {(payload.pros.length > 0 || payload.cons.length > 0) && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {payload.pros.length > 0 && (
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-cat-wholesome">
                Pros
              </div>
              <ul className="list-inside list-disc space-y-1 text-[14px] text-ink">
                {payload.pros.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {payload.cons.length > 0 && (
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-cat-entitled">
                Cons
              </div>
              <ul className="list-inside list-disc space-y-1 text-[14px] text-ink">
                {payload.cons.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function ListicleBlock({
  payload,
}: {
  payload: Extract<ArticlePayload, { type: "listicle" }>["payload"];
}) {
  if (payload.items.length === 0) return null;
  // Countdown order means visually largest-first; the data is still ordered
  // 1..N by rank, so we reverse on render rather than reorder the JSON-LD
  // positions (which always go 1..N).
  const ordered = payload.countdownOrder
    ? [...payload.items].slice().reverse()
    : payload.items;
  return (
    <ol className="space-y-4">
      {ordered.map((item, idx) => {
        // `displayRank` is the user-visible number. In countdown order the
        // top item is N, not 1; we use the original rank to keep parity
        // with the JSON-LD positions.
        const displayRank = item.rank || idx + 1;
        return (
          <li
            key={`${item.rank}-${idx}`}
            className="rounded-xl border border-line bg-surface p-4"
          >
            <div className="flex items-baseline gap-3">
              <span className="font-display text-[28px] font-extrabold text-accent">
                #{displayRank}
              </span>
              <span className="text-[18px] text-ink">{item.title || "—"}</span>
            </div>
            {item.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.imageUrl}
                alt={item.imageAlt}
                className="mt-3 w-full rounded-md border border-line"
              />
            )}
            {item.body && (
              <p className="mt-2 text-[15px] text-muted">{item.body}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
