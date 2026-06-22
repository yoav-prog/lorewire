"use server";

// Server actions for the comment moderation queue. Co-located with the page
// (rather than in the shared admin/actions.ts) to keep the comments feature
// self-contained. Every action re-checks authorization at the data source via
// requireAdmin, and routes the transition through setCommentStatus so the
// reply_count and the audit trail stay consistent with the AI path.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/dal";
import { resolveReports, setCommentStatus } from "@/lib/comments";
import { setSetting } from "@/lib/repo";

export async function approveCommentAction(commentId: string): Promise<void> {
  const session = await requireAdmin();
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
  const session = await requireAdmin();
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
  await requireAdmin();
  await resolveReports(commentId, "dismissed");
  revalidatePath("/admin/comments");
}

/** Site-wide kill switch. Off closes commenting on every article at once
 *  (existing comments stay visible). Per-article overrides live under
 *  comments.article_off.<id>. */
export async function setSiteCommentsEnabledAction(enabled: boolean): Promise<void> {
  await requireAdmin();
  await setSetting("comments.enabled", enabled ? "1" : "0");
  revalidatePath("/admin/comments");
}
