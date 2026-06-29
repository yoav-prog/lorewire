// Coverage for the victim report path (Phase 4). Invariants: a report is recorded
// only against a submission-origin story; a non-submission (Reddit) story is
// refused; the hourly per-reporter cap holds; and an admin takedown archives the
// story, unpublishes the submission, and clears the open reports. All DB, no
// network. Runs against the configured DB via all/one/run.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { one, run } from "@/lib/db";
import { approveAndPromote } from "@/lib/submission-promote";
import {
  createSubmissionReport,
  listOpenSubmissionReports,
  resolveReportsForStory,
} from "@/lib/submission-reports";
import {
  adminUnpublishSubmission,
  createSubmission,
  getSubmissionById,
  parseSubmissionInput,
} from "@/lib/submissions";

const USER = "u_report_test_owner";
const ADMIN = "admin_report_test";
const HASH = "report_test_hash";
const PLAIN_STORY = "story_no_sub_report_test";

const INPUT = {
  title: "My roommate keeps eating my food",
  body: "I label my own shelf in the fridge and she still eats my leftovers every week, then acts surprised when I bring it up at dinner.",
  question: "Am I wrong for hiding my own food?",
  optionA: "You're fine",
  optionB: "You're petty",
  lang: "en" as const,
};

async function seedUser(id: string): Promise<void> {
  const now = new Date().toISOString();
  await run(
    `INSERT INTO users
        (id, email, role, password_hash, name, picture_url,
         provider, provider_sub, anonymous_id, last_seen_at, created_at)
      VALUES (?, ?, 'user', NULL, ?, NULL, 'magic_link', ?, NULL, ?, ?)`,
    [id, `${id}@example.test`, "Amit G.", `sub_${id}`, now, now],
  );
}

async function publishedStory(): Promise<{ submissionId: string; storyId: string }> {
  const s = await createSubmission({
    userId: USER,
    input: parseSubmissionInput(INPUT),
    action: "submit",
  });
  const res = await approveAndPromote(s.id, "poll_only", ADMIN);
  return { submissionId: s.id, storyId: res!.story_id! };
}

async function cleanup(): Promise<void> {
  await run(`DELETE FROM submission_reports WHERE ip_ua_hash = ?`, [HASH]);
  const sub = `(SELECT id FROM submissions WHERE user_id = ?)`;
  const story = `(SELECT id FROM stories WHERE submission_id IN ${sub})`;
  await run(`DELETE FROM polls WHERE story_id IN ${story}`, [USER]);
  await run(`DELETE FROM short_renders WHERE story_id IN ${story}`, [USER]);
  await run(`DELETE FROM stories WHERE submission_id IN ${sub}`, [USER]);
  await run(`DELETE FROM submission_events WHERE submission_id IN ${sub}`, [USER]);
  await run(`DELETE FROM submissions WHERE user_id = ?`, [USER]);
  await run(`DELETE FROM users WHERE id = ?`, [USER]);
  await run(`DELETE FROM stories WHERE id = ?`, [PLAIN_STORY]);
}

beforeEach(async () => {
  await cleanup();
  await seedUser(USER);
});
afterEach(cleanup);

describe("createSubmissionReport", () => {
  it("records a report against a submission-origin story", async () => {
    const { storyId } = await publishedStory();
    const res = await createSubmissionReport({
      storyId,
      reason: "This names my coworker, a real person.",
      ipUaHash: HASH,
    });
    expect(res.ok).toBe(true);
    const open = await listOpenSubmissionReports(50);
    expect(open.some((r) => r.story_id === storyId)).toBe(true);
  });

  it("refuses a non-submission (Reddit) story", async () => {
    const now = new Date().toISOString();
    await run(
      `INSERT INTO stories (id, slug, title, body, status, created_at, updated_at)
       VALUES (?, ?, 't', 'b', 'published', ?, ?)`,
      [PLAIN_STORY, PLAIN_STORY, now, now],
    );
    const res = await createSubmissionReport({
      storyId: PLAIN_STORY,
      reason: "trying to report a reddit story",
      ipUaHash: HASH,
    });
    expect(res.ok).toBe(false);
  });

  it("enforces the hourly cap per reporter", async () => {
    const { storyId } = await publishedStory();
    for (let i = 0; i < 10; i++) {
      await createSubmissionReport({
        storyId,
        reason: `report number ${i}`,
        ipUaHash: HASH,
      });
    }
    const res = await createSubmissionReport({
      storyId,
      reason: "one too many",
      ipUaHash: HASH,
    });
    expect(res.ok).toBe(false);
  });
});

describe("admin takedown on a report", () => {
  it("archives the story, unpublishes the submission, and clears open reports", async () => {
    const { submissionId, storyId } = await publishedStory();
    await createSubmissionReport({
      storyId,
      reason: "this is about a real, identifiable person",
      ipUaHash: HASH,
    });

    await adminUnpublishSubmission(submissionId, ADMIN);
    await resolveReportsForStory(storyId, "actioned");

    expect((await getSubmissionById(submissionId))?.status).toBe("unpublished");
    const storyRow = await one<{ status: string }>(
      `SELECT status FROM stories WHERE id = ?`,
      [storyId],
    );
    expect(storyRow?.status).toBe("archived");
    const open = await listOpenSubmissionReports(50);
    expect(open.some((r) => r.story_id === storyId)).toBe(false);
  });
});
