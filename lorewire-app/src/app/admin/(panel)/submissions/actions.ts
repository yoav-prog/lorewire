"use server";

// Server actions for the submission review queue. Co-located with the page to
// keep the feature self-contained. Every action re-checks authorization at the
// data source via requireCapability("content.manage") and routes the transition
// through setSubmissionStatus so the audit trail stays consistent with the AI
// path. Plan: _plans/2026-06-29-user-submitted-stories.md (Phase 2).

import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/dal";
import { setSetting } from "@/lib/repo";
import { adminUnpublishSubmission, setSubmissionStatus } from "@/lib/submissions";
import { approveAndPromote } from "@/lib/submission-promote";
import {
  CUSTOM_REASON_CATEGORY,
  CUSTOM_REASON_MAX,
  categoryToReasonKey,
} from "@/lib/submission-reasons";
import { resolveReportsForStory } from "@/lib/submission-reports";

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

/** Reject with a reason. With a `customMessage` (the free-text "Other" path) the
 *  reviewer's own note is stored under the `custom` sentinel and shown to the
 *  author verbatim; otherwise the category is normalized to a taxonomy key so the
 *  author sees the matching user-safe message. Either way it's resubmittable. */
export async function rejectSubmissionAction(
  id: string,
  category: string,
  customMessage?: string,
): Promise<void> {
  const session = await requireCapability("content.manage");
  const custom = (customMessage ?? "").trim().slice(0, CUSTOM_REASON_MAX);
  await setSubmissionStatus(
    id,
    "rejected",
    custom
      ? { category: CUSTOM_REASON_CATEGORY, reason: custom }
      : {
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

/** Act on a victim report: take the story off the public site (archive + unpublish
 *  the submission) and mark its open reports actioned. */
export async function takeDownReportedAction(
  submissionId: string,
  storyId: string,
): Promise<void> {
  const session = await requireCapability("content.manage");
  await adminUnpublishSubmission(submissionId, session.userId);
  await resolveReportsForStory(storyId, "actioned");
  revalidatePath("/admin/submissions");
}

/** Dismiss a victim report: keep the story up, clear its open reports. */
export async function dismissReportedAction(storyId: string): Promise<void> {
  await requireCapability("content.manage");
  await resolveReportsForStory(storyId, "dismissed");
  revalidatePath("/admin/submissions");
}
