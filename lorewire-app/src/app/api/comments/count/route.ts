// GET /api/comments/count — minimal count + kill-switch + resolved
// article id for the homepage TitleSheet tab label. Avoids fetching the
// full thread just to show "COMMENTS (N)" before the user opens the tab.
//
// Story → article resolution: when a `storyId` is passed, this looks up
// the matching published article (articles.story_id is the optional
// per-article link to a pipeline story; set explicitly via the admin's
// LinkedStoryWidget). If found, comments unify on the article's id so
// the homepage TitleSheet thread is the SAME thread the article reader
// at /articles/[locale]/[slug] shows. If not found, the storyId is
// used verbatim — that story gets its own thread, independent of any
// future article that might link to it.
//
// `articleId` is still accepted (article reader callers, future
// admin tools) and used directly without resolution. The endpoint
// returns the RESOLVED id back so the caller can use it for all
// subsequent thread fetches without re-resolving.
//
// Read-only, no origin gate — same posture as GET /api/comments. The
// returned `enabled` mirrors commentsEnabledForArticle (site-wide kill
// switch + per-article override; default open when unset). Returns 200
// even on bad input with count=0 so the tab label silently degrades to
// "COMMENTS (0)" instead of blocking the modal from opening.

import { NextResponse, type NextRequest } from "next/server";

import { one } from "@/lib/db";
import { commentsEnabledForArticle } from "@/lib/comments";
import { countPublishedComments } from "@/lib/comments-read";

interface ArticleIdRow {
  id: string;
}

async function resolveCommentArticleId(opts: {
  articleIdParam: string | null;
  storyIdParam: string | null;
}): Promise<string> {
  // articleId wins when supplied — the article reader page already knows
  // the canonical id, no resolution needed.
  const article = opts.articleIdParam?.trim();
  if (article) return article;
  const story = opts.storyIdParam?.trim();
  if (!story) return "";
  // articles.story_id links an article to a pipeline story. When set, the
  // article id is the canonical comments key for that piece of content;
  // both the article reader and the homepage TitleSheet land on the same
  // thread. We restrict to status='published' so a draft/archived link
  // doesn't quietly redirect comments to an article the public can't
  // open.
  const row = await one<ArticleIdRow>(
    "SELECT id FROM articles WHERE story_id = ? AND status = 'published' LIMIT 1",
    [story],
  );
  return row?.id ?? story;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const articleId = await resolveCommentArticleId({
    articleIdParam: url.searchParams.get("articleId"),
    storyIdParam: url.searchParams.get("storyId"),
  });
  if (!articleId) {
    return NextResponse.json({ articleId: "", count: 0, enabled: false });
  }
  const [count, enabled] = await Promise.all([
    countPublishedComments(articleId),
    commentsEnabledForArticle(articleId),
  ]);
  return NextResponse.json({ articleId, count, enabled });
}
