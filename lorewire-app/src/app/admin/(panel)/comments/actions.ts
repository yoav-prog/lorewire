"use server";

// Server actions for the comment moderation queue. Co-located with the page
// (rather than in the shared admin/actions.ts) to keep the comments feature
// self-contained. Every action re-checks authorization at the data source via
// requireCapability("content.manage"), and routes the transition through
// setCommentStatus so the reply_count and the audit trail stay consistent with
// the AI path.

import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/dal";
import { resolveReports, setCommentStatus } from "@/lib/comments";
import { setSetting } from "@/lib/repo";

export async function approveCommentAction(commentId: string): Promise<void> {
  const session = await requireCapability("content.manage");
  await setCommentStatus(
    commentId,
    "published",
    { source: "human", reason: "Approved by a moderator." },
    session.userId,
  );
  // Approving overrules any open reports on it.
  await resolveReports(commentId, "dismissed");
  revalidatePath("/admin/comments");
}

export async function rejectCommentAction(commentId: string): Promise<void> {
  const session = await requireCapability("content.manage");
  await setCommentStatus(
    commentId,
    "rejected",
    { source: "human", reason: "Rejected by a moderator." },
    session.userId,
  );
  await resolveReports(commentId, "actioned");
  revalidatePath("/admin/comments");
}

/** Keep a reported comment published and clear its reports (the reports were
 *  overruled). No status change, so no setCommentStatus / audit transition. */
export async function dismissReportsAction(commentId: string): Promise<void> {
  await requireCapability("content.manage");
  await resolveReports(commentId, "dismissed");
  revalidatePath("/admin/comments");
}

/** Site-wide kill switch. Off closes commenting on every article at once
 *  (existing comments stay visible). Per-article overrides live under
 *  comments.article_off.<id>. */
export async function setSiteCommentsEnabledAction(enabled: boolean): Promise<void> {
  await requireCapability("content.manage");
  await setSetting("comments.enabled", enabled ? "1" : "0");
  revalidatePath("/admin/comments");
}

/** Per-article close. Closing one article does NOT touch the site-wide
 *  kill switch; the public guard is the AND of (site-wide enabled) AND
 *  (NOT article-specific closed). `articleId` here is the RESOLVED
 *  comments key — for stories that link to a published article this is
 *  the article.id; for unlinked stories it's the story.id itself. The
 *  caller (story edit page) does the resolution before invoking. */
export async function setArticleCommentsClosedAction(
  articleId: string,
  closed: boolean,
  /** Revalidation hint — pass the edit page path so the toggle's
   *  state matches reality on the next render. */
  revalidate?: string,
): Promise<void> {
  await requireCapability("content.manage");
  if (!articleId) return;
  // "1" = closed; clearing back to "0" / unset is the open state.
  // We write "0" rather than deleting the row so the audit trail is
  // explicit ("was once closed, now opened") instead of "set never set".
  await setSetting(`comments.article_off.${articleId}`, closed ? "1" : "0");
  if (revalidate) revalidatePath(revalidate);
}
