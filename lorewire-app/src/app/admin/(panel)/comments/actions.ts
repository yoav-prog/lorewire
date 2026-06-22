"use server";

// Server actions for the comment moderation queue. Co-located with the page
// (rather than in the shared admin/actions.ts) to keep the comments feature
// self-contained. Every action re-checks authorization at the data source via
// requireAdmin, and routes the transition through setCommentStatus so the
// reply_count and the audit trail stay consistent with the AI path.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/dal";
import { setCommentStatus } from "@/lib/comments";

export async function approveCommentAction(commentId: string): Promise<void> {
  const session = await requireAdmin();
  await setCommentStatus(
    commentId,
    "published",
    { source: "human", reason: "Approved by a moderator." },
    session.userId,
  );
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
  revalidatePath("/admin/comments");
}
