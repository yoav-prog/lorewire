"use server";

// Server actions for the submission review queue. Co-located with the page to
// keep the feature self-contained. Every action re-checks authorization at the
// data source via requireCapability("content.manage") and routes the transition
// through setSubmissionStatus so the audit trail stays consistent with the AI
// path. Plan: _plans/2026-06-29-user-submitted-stories.md (Phase 2).

import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/dal";
import { setSetting } from "@/lib/repo";
import { setSubmissionStatus } from "@/lib/submissions";
import { approveAndPromote } from "@/lib/submission-promote";
import { categoryToReasonKey } from "@/lib/submission-reasons";

/** Approve and make the video: promote to a story + poll and enqueue the short
 *  render (budget-gated). Throws a visible error if the daily render budget is
 *  reached, so the reviewer can fall back to poll-only or wait. */
export async function approveAndRenderAction(id: string): Promise<void> {
  const session = await requireCapability("content.manage");
  await approveAndPromote(id, "video", session.userId);
  revalidatePath("/admin/submissions");
}

/** Approve as poll-only: promote to a story + poll and publish it without
 *  spending on a render (the cost release valve). */
export async function approvePollOnlyAction(id: string): Promise<void> {
  const session = await requireCapability("content.manage");
  await approveAndPromote(id, "poll_only", session.userId);
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

/** Site-wide kill switch for new submissions. Off stops new submissions from
 *  entering the queue (and any render spend); existing submissions and published
 *  stories are unaffected. */
export async function setSubmissionsEnabledAction(
  enabled: boolean,
): Promise<void> {
  await requireCapability("content.manage");
  await setSetting("submissions.enabled", enabled ? "1" : "0");
  revalidatePath("/admin/submissions");
}
