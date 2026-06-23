// GET /api/comments/count?articleId=X — minimal count + kill-switch read
// for the homepage TitleSheet tab label. Avoids fetching the full thread
// just to show "COMMENTS (N)" before the user opens the tab.
//
// Read-only, no origin gate — same posture as the GET /api/comments
// thread fetch. `commentsEnabled` mirrors the article reader's
// commentsEnabledForArticle (site-wide kill switch + per-article
// override; default open when unset). Returns 200 even on bad input
// with count=0 so the tab label silently degrades to "COMMENTS (0)"
// instead of blocking the modal from opening.

import { NextResponse, type NextRequest } from "next/server";

import { commentsEnabledForArticle } from "@/lib/comments";
import { countPublishedComments } from "@/lib/comments-read";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const articleId = new URL(req.url).searchParams.get("articleId")?.trim() ?? "";
  if (!articleId) {
    return NextResponse.json({ count: 0, enabled: false });
  }
  const [count, enabled] = await Promise.all([
    countPublishedComments(articleId),
    commentsEnabledForArticle(articleId),
  ]);
  return NextResponse.json({ count, enabled });
}
