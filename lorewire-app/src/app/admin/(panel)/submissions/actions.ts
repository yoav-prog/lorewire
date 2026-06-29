"use server";

// Server actions for the submission review queue. Co-located with the page to
// keep the feature self-contained. Every action re-checks authorization at the
// data source via requireCapability("content.manage") and routes the transition
// through setSubmissionStatus so the audit trail stays consistent with the AI
// path. Plan: _plans/2026-06-29-user-submitted-stories.md (Phase 2).

import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/dal";
import { setSubmissionStatus } from "@/lib/submissions";
import { categoryToReasonKey } from "@/lib/submission-reasons";

/** Approve: the submission is cleared by a person. It moves to `approved`; the
 *  render-on-approval that turns it into a published short lands in Phase 3. */
export async function approveSubmissionAction(id: string): Promise<void> {
  const session = await requireCapability("content.manage");
  await setSubmissionStatus(
    id,
    "approved",
    { approvedBy: session.userId },
    session.userId,
  );
  revalidatePath("/admin/submissions");
}

/** Reject with a reason. The category is normalized to a reason-taxonomy key so
 *  the author sees the matching user-safe message and can fix and resubmit. */
export async function rejectSubmissionAction(
  id: string,
  category: string,
): Promise<void> {
  const session = await requireCapability("content.manage");
  await setSubmissionStatus(
    id,
    "rejected",
    {
      category: categoryToReasonKey(category),
      reason: "Rejected by a reviewer.",
    },
    session.userId,
  );
  revalidatePath("/admin/submissions");
}
