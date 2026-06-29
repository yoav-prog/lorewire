// Approval -> promotion for user submissions (Phase 3). Turns an approved
// submission into a real (submission-origin) story plus its poll, then either
// enqueues the short render (budget-gated) or publishes the poll without spending.
// Reuses the existing helpers: createStory, upsertPoll, enqueueShortRender, and the
// publish gate (which exempts submission-origin stories). The submission tracks the
// story via story_id so the dashboard can follow it.
//
// Plan: _plans/2026-06-29-user-submitted-stories.md (Phase 3).

import "server-only";
import { randomUUID } from "node:crypto";

import { createStory, setStatus } from "@/lib/repo";
import { upsertPoll } from "@/lib/polls";
import { enqueueShortRender } from "@/lib/short-render-queue";
import { getRenderBudget } from "@/lib/submission-render-budget";
import {
  SubmissionError,
  getSubmissionById,
  setSubmissionStatus,
  type SubmissionRow,
} from "@/lib/submissions";

export type ApproveMode = "video" | "poll_only";

// Default render knobs — null lets the pipeline pick its defaults, same as an
// admin-triggered short with no overrides.
const DEFAULT_NARRATION_STYLE: string | null = null;
const DEFAULT_LENGTH_PRESET: string | null = null;

/** Build a readable, unique-enough slug. Latin titles slugify directly; Hebrew
 *  (and anything non-latin) falls back to a stable id-suffixed slug. */
function slugify(title: string, id: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "story"}-${id.slice(0, 8)}`;
}

/** Approve a pending submission: promote it into a submission-origin story with a
 *  poll, then either enqueue the short render (mode 'video', budget-gated) or
 *  publish the poll without spending (mode 'poll_only', the release valve).
 *  Throws SubmissionError('invalid') on a bad state and SubmissionError('cap')
 *  when the daily render budget is exhausted (the reviewer can pick poll-only or
 *  wait). Returns the updated submission row. */
export async function approveAndPromote(
  submissionId: string,
  mode: ApproveMode,
  approvedBy: string,
): Promise<SubmissionRow | null> {
  const s = await getSubmissionById(submissionId);
  if (!s) {
    throw new SubmissionError("invalid", "That submission isn't available.");
  }
  if (s.status !== "pending_review") {
    throw new SubmissionError("invalid", "This submission isn't awaiting review.");
  }

  if (mode === "video") {
    const budget = await getRenderBudget();
    if (budget.exhausted) {
      const cap = (budget.capCents / 100).toFixed(0);
      throw new SubmissionError(
        "cap",
        `Daily render budget reached ($${cap}). Approve as poll-only, or try again tomorrow.`,
      );
    }
  }

  // Reuse a prior story_id if this submission was somehow promoted before; else a
  // fresh id. The pending_review guard above already makes double-promotion a
  // no-op in practice.
  const storyId = s.story_id || randomUUID();

  await createStory({
    id: storyId,
    slug: slugify(s.title, storyId),
    category: null,
    title: s.title,
    summary: s.body.slice(0, 160),
    body: s.body,
    status: "review",
    submissionId: s.id,
  });

  await upsertPoll({
    storyId,
    question: s.dilemma_question,
    optionA: s.option_a_text,
    optionB: s.option_b_text,
    enabled: true,
    category: null,
  });

  if (mode === "video") {
    await enqueueShortRender(
      storyId,
      DEFAULT_NARRATION_STYLE,
      DEFAULT_LENGTH_PRESET,
      approvedBy,
    );
    // The submission shows 'rendering' (the dashboard reads it as "making your
    // video") while the short generates. The story stays in 'review' until its
    // assets are ready and it is published. Publishing-after-render is the
    // remaining Phase 3 wire-up (a render-completion hook or the admin publish).
    return setSubmissionStatus(
      submissionId,
      "rendering",
      { storyId, approvedBy, renderChoice: "video" },
      approvedBy,
    );
  }

  // poll_only: publish the story now as a text poll, no render spend. The publish
  // gate exempts submission-origin stories (repo.ts).
  await setStatus(storyId, "published");
  return setSubmissionStatus(
    submissionId,
    "published",
    { storyId, approvedBy, renderChoice: "poll_only" },
    approvedBy,
  );
}
