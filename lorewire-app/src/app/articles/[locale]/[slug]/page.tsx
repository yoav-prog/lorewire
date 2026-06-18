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
import { PollWidget } from "@/components/PollWidget";
import {
  computeArticlePollAggregate,
  getAggregateByStoryId,
  getPollByArticleId,
  getPollByStoryId,
  getVoteSideForCookie,
  resolvePublicFloor,
  topDivisive,
  toResultView,
  type PollResultView,
  type PollRow,
  type PollSide,
} from "@/lib/polls";
import { readVoteToken } from "@/lib/poll-cookie";

// Phase 2 + §15 (standalone-article polls) of
// _plans/2026-06-17-engagement-polls.md.
//
// Resolution priority on the article reader:
//   1. The article's OWN poll (polls.article_id = article.id) wins.
//      Authored directly on /admin/articles/[id]. Aggregates compute
//      live via computeArticlePollAggregate (no projection row).
//   2. The linked story's poll (polls.story_id = article.story_id)
//      is the fallback inheritance from Phase 2. Aggregates come
//      from poll_aggregates (cron-refreshed projection).
//   3. No widget renders when neither resolves.
//
// The follow-up "see another close call" link only fires for the
// story-attached path because the divisive rail is story-only by
// design. An article-only poll renders without a follow-up.
interface PollRender {
  pollId: string;
  question: string;
  optionA: string;
  optionB: string;
  result: PollResultView;
  votedSide: PollSide | null;
  followUp: { href: string; title: string } | null;
}

async function loadPollForArticle(
  article: ArticleRow,
): Promise<PollRender | null> {
  // Priority 1: article-own poll. When the article CMS author wrote
  // a poll directly on this article, it wins regardless of any linked
  // story's poll. The author's intent for THIS article reads.
  const ownPoll = await getPollByArticleId(article.id);
  if (ownPoll && ownPoll.enabled === 1) {
    return await buildArticleOwnPollRender(ownPoll);
  }
  // Priority 2: linked-story inheritance. Same behavior as Phase 2.
  if (!article.story_id) return null;
  const storyPoll = await getPollByStoryId(article.story_id);
  if (!storyPoll || storyPoll.enabled !== 1) return null;
  return await buildLinkedStoryPollRender(article.story_id, storyPoll);
}

async function buildArticleOwnPollRender(
  poll: PollRow,
): Promise<PollRender> {
  const voteToken = await readVoteToken();
  const [aggregate, votedSide, floor] = await Promise.all([
    computeArticlePollAggregate(poll),
    getVoteSideForCookie(poll.id, voteToken),
    resolvePublicFloor(),
  ]);
  return {
    pollId: poll.id,
    question: poll.question,
    optionA: poll.option_a_text,
    optionB: poll.option_b_text,
    result: toResultView(aggregate, floor),
    votedSide,
    // Article-own polls don't ride the story-only divisive rail, so
    // no follow-up. Could change later if we add an article-only
    // rail surface; flagged for the V3 personalization work.
    followUp: null,
  };
}

async function buildLinkedStoryPollRender(
  storyId: string,
  poll: PollRow,
): Promise<PollRender> {
  const [voteToken, aggregate, floor] = await Promise.all([
    readVoteToken(),
    getAggregateByStoryId(storyId),
    resolvePublicFloor(),
  ]);
  const votedSide = await getVoteSideForCookie(poll.id, voteToken);
  // Phase 4: same follow-up resolver shape as /v/[slug]. Falls back
  // silently when the rail has no other entries in this category.
  const followUp = await resolveFollowUp(storyId, poll.category);
  return {
    pollId: poll.id,
    question: poll.question,
    optionA: poll.option_a_text,
    optionB: poll.option_b_text,
    result: toResultView(aggregate, floor),
    votedSide,
    followUp,
  };
}

async function resolveFollowUp(
  currentStoryId: string,
  category: string | null,
): Promise<{ href: string; title: string } | null> {
  try {
    const rows = await topDivisive({
      category,
      excludeStoryId: currentStoryId,
      limit: 1,
    });
    const top = rows[0];
    if (!top || !top.slug || !top.title) return null;
    return { href: `/v/${top.slug}`, title: top.title };
  } catch (err) {
    console.warn("[articles reader] follow-up resolve failed", {
      story_id: currentStoryId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

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

  // Inherits the linked story's poll if one exists + is enabled.
  // Renders after the body so the reader finishes the piece before
  // being asked to take a side.
  const pollRender = await loadPollForArticle(article);

  console.info("[articles reader] render", {
    id: article.id,
    type,
    language,
    slug: article.slug,
    docLen: article.document?.length ?? 0,
    has_poll: pollRender !== null,
    poll_already_voted: pollRender ? pollRender.votedSide !== null : false,
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

      {pollRender && (
        <PollWidget
          pollId={pollRender.pollId}
          question={pollRender.question}
          optionA={pollRender.optionA}
          optionB={pollRender.optionB}
          initialResult={pollRender.result}
          initialVotedSide={pollRender.votedSide}
          followUp={pollRender.followUp}
        />
      )}
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
