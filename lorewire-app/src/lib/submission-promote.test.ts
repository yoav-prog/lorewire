// Coverage for approve -> promotion (Phase 3). The invariants that matter:
// (1) approving with video promotes the submission into a submission-origin story
// + poll and queues a short render; (2) poll-only publishes the story with no
// render (proving the publish-gate exemption works for submission-origin stories);
// (3) the render budget cap blocks video but not poll-only; (4) a non-pending
// submission is refused. All DB, no network. Runs against the configured DB via
// all/run, same pattern as account-deletion.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { one, run } from "@/lib/db";
import { setSetting } from "@/lib/repo";
import { RENDER_BUDGET_CAP_SETTING_KEY } from "@/lib/submission-render-budget";
import { approveAndPromote } from "@/lib/submission-promote";
import {
  createSubmission,
  eraseSubmission,
  getSubmissionById,
  parseSubmissionInput,
} from "@/lib/submissions";

const USER = "u_promote_test_owner";
const ADMIN = "admin_promote_test";

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

async function pendingSubmission(): Promise<string> {
  const s = await createSubmission({
    userId: USER,
    input: parseSubmissionInput(INPUT),
    action: "submit",
  });
  return s.id; // status pending_review (Phase 1 create has no moderation inline)
}

async function cleanup(): Promise<void> {
  const sub = `(SELECT id FROM submissions WHERE user_id = ?)`;
  const story = `(SELECT id FROM stories WHERE submission_id IN ${sub})`;
  await run(`DELETE FROM polls WHERE story_id IN ${story}`, [USER]);
  await run(`DELETE FROM short_renders WHERE story_id IN ${story}`, [USER]);
  await run(`DELETE FROM stories WHERE submission_id IN ${sub}`, [USER]);
  await run(`DELETE FROM submission_events WHERE submission_id IN ${sub}`, [USER]);
  await run(`DELETE FROM submissions WHERE user_id = ?`, [USER]);
  await run(`DELETE FROM users WHERE id = ?`, [USER]);
  await run(`DELETE FROM settings WHERE key = ?`, [RENDER_BUDGET_CAP_SETTING_KEY]);
}

beforeEach(async () => {
  await cleanup();
  await seedUser(USER);
});
afterEach(cleanup);

describe("approveAndPromote — video", () => {
  it("promotes to a submission-origin story + poll and queues a short render", async () => {
    const id = await pendingSubmission();
    const res = await approveAndPromote(id, "video", ADMIN);

    expect(res?.status).toBe("rendering");
    expect(res?.render_choice).toBe("video");
    expect(res?.story_id).toBeTruthy();
    const storyId = res!.story_id!;

    const story = await one<{ submission_id: string; status: string }>(
      `SELECT submission_id, status FROM stories WHERE id = ?`,
      [storyId],
    );
    expect(story?.submission_id).toBe(id);
    expect(story?.status).toBe("review");

    const poll = await one<{ question: string }>(
      `SELECT question FROM polls WHERE story_id = ?`,
      [storyId],
    );
    expect(poll?.question).toBe(INPUT.question);

    const render = await one<{ status: string }>(
      `SELECT status FROM short_renders WHERE story_id = ?`,
      [storyId],
    );
    expect(render?.status).toBe("queued");
  });
});

describe("approveAndPromote — poll only", () => {
  it("publishes the story with no render (publish-gate exemption works)", async () => {
    const id = await pendingSubmission();
    const res = await approveAndPromote(id, "poll_only", ADMIN);

    expect(res?.status).toBe("published");
    const story = await one<{ status: string }>(
      `SELECT status FROM stories WHERE id = ?`,
      [res!.story_id!],
    );
    expect(story?.status).toBe("published");

    const render = await one<{ id: string }>(
      `SELECT id FROM short_renders WHERE story_id = ?`,
      [res!.story_id!],
    );
    expect(render).toBeNull();
  });
});

describe("approveAndPromote — budget + state guards", () => {
  it("blocks video when the render budget is exhausted, but poll-only still works", async () => {
    await setSetting(RENDER_BUDGET_CAP_SETTING_KEY, "0");
    const id = await pendingSubmission();
    await expect(approveAndPromote(id, "video", ADMIN)).rejects.toMatchObject({
      kind: "cap",
    });
    // The cap-throw happens before any promotion, so the submission is untouched
    // and poll-only (no spend) still goes through.
    const res = await approveAndPromote(id, "poll_only", ADMIN);
    expect(res?.status).toBe("published");
  });

  it("refuses a submission that isn't awaiting review", async () => {
    const id = await pendingSubmission();
    await approveAndPromote(id, "poll_only", ADMIN); // now published
    await expect(approveAndPromote(id, "video", ADMIN)).rejects.toMatchObject({
      kind: "invalid",
    });
  });
});

describe("eraseSubmission — self-takedown", () => {
  it("archives the story, disables its poll, and marks the submission erased", async () => {
    const id = await pendingSubmission();
    const res = await approveAndPromote(id, "poll_only", ADMIN);
    const storyId = res!.story_id!;

    expect(await eraseSubmission(id, USER)).toBe(true);
    expect((await getSubmissionById(id))?.status).toBe("erased");

    const story = await one<{ status: string }>(
      `SELECT status FROM stories WHERE id = ?`,
      [storyId],
    );
    expect(story?.status).toBe("archived");

    const poll = await one<{ enabled: number }>(
      `SELECT enabled FROM polls WHERE story_id = ?`,
      [storyId],
    );
    expect(Number(poll?.enabled)).toBe(0);
  });

  it("refuses a submission the caller does not own", async () => {
    const id = await pendingSubmission();
    expect(await eraseSubmission(id, "u_not_the_owner")).toBe(false);
  });
});
