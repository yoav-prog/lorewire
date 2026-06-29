// Data-layer coverage for user submissions (Phase 1). The invariants that matter:
// (1) input is validated at the boundary, (2) a draft saves uncapped while a
// submit is cap-checked and enters review, (3) the per-user pending + daily caps
// trip at their thresholds, (4) only the owner can edit and only a draft/rejected
// one, (5) a resubmit clears the rejection and bumps the counter, and (6) every
// status change writes exactly one audit row. Runs against the configured DB via
// all/run, same pattern as account-deletion.test.ts.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { all, one, run } from "@/lib/db";
import {
  SubmissionError,
  assertWithinCap,
  createSubmission,
  getSubmissionById,
  listUserSubmissions,
  parseSubmissionInput,
  setSubmissionStatus,
  updateSubmission,
} from "@/lib/submissions";

const USER = "u_sub_test_owner";
const OTHER = "u_sub_test_other";

const VALID = {
  title: "My roommate keeps eating my food",
  body: "I label my own shelf in the fridge and she still eats my leftovers every week, then acts surprised when I bring it up.",
  question: "Am I wrong for hiding my own food?",
  optionA: "You're fine",
  optionB: "You're petty",
  lang: "en" as const,
};

async function seedUser(id: string, name: string | null): Promise<void> {
  const now = new Date().toISOString();
  await run(
    `INSERT INTO users
        (id, email, role, password_hash, name, picture_url,
         provider, provider_sub, anonymous_id, last_seen_at, created_at)
      VALUES (?, ?, 'user', NULL, ?, NULL, 'magic_link', ?, NULL, ?, ?)`,
    [id, `${id}@example.test`, name, `sub_${id}`, now, now],
  );
}

async function insertRow(
  userId: string,
  status: string,
  fields: Partial<{ reject_category: string; created_at: string }> = {},
): Promise<string> {
  const id = randomUUID();
  const now = fields.created_at ?? new Date().toISOString();
  await run(
    `INSERT INTO submissions
        (id, user_id, display_name, lang, title, body, dilemma_question,
         option_a_text, option_b_text, status, reject_category, resubmit_count,
         created_at, updated_at)
      VALUES (?, ?, 'X', 'en', 't', 'a story body that is plenty long enough here',
              'q?', 'a', 'b', ?, ?, 0, ?, ?)`,
    [id, userId, status, fields.reject_category ?? null, now, now],
  );
  return id;
}

async function eventCount(submissionId: string): Promise<number> {
  const r = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM submission_events WHERE submission_id = ?`,
    [submissionId],
  );
  return r?.n ?? 0;
}

async function cleanup(): Promise<void> {
  for (const u of [USER, OTHER]) {
    await run(
      `DELETE FROM submission_events
        WHERE submission_id IN (SELECT id FROM submissions WHERE user_id = ?)`,
      [u],
    );
    await run(`DELETE FROM submissions WHERE user_id = ?`, [u]);
    await run(`DELETE FROM users WHERE id = ?`, [u]);
  }
  await run(
    `DELETE FROM settings WHERE key IN ('submissions.cap.max_pending', 'submissions.cap.max_per_day')`,
    [],
  );
}

beforeEach(async () => {
  await cleanup();
  await seedUser(USER, "Amit G.");
  await seedUser(OTHER, "Someone Else");
});
afterEach(cleanup);

describe("parseSubmissionInput", () => {
  it("accepts and trims a valid submission", () => {
    const out = parseSubmissionInput({ ...VALID, title: "  Spaced  " });
    expect(out.title).toBe("Spaced");
    expect(out.lang).toBe("en");
  });

  it("rejects a too-short story", () => {
    expect(() => parseSubmissionInput({ ...VALID, body: "too short" })).toThrow(
      SubmissionError,
    );
  });

  it("rejects identical options", () => {
    try {
      parseSubmissionInput({ ...VALID, optionA: "Yes", optionB: "yes" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SubmissionError);
      expect((err as SubmissionError).kind).toBe("invalid");
    }
  });

  it("defaults an unknown lang to en and honors he", () => {
    expect(parseSubmissionInput({ ...VALID, lang: "fr" }).lang).toBe("en");
    expect(parseSubmissionInput({ ...VALID, lang: "he" }).lang).toBe("he");
  });
});

describe("createSubmission", () => {
  it("saves a draft uncapped, snapshotting the display name, with one audit row", async () => {
    const input = parseSubmissionInput(VALID);
    const s = await createSubmission({ userId: USER, input, action: "draft" });
    expect(s.status).toBe("draft");
    expect(s.display_name).toBe("Amit G.");
    expect(s.resubmit_count).toBe(0);
    expect(await eventCount(s.id)).toBe(1);
  });

  it("submits into pending_review", async () => {
    const input = parseSubmissionInput(VALID);
    const s = await createSubmission({ userId: USER, input, action: "submit" });
    expect(s.status).toBe("pending_review");
    const listed = await listUserSubmissions(USER);
    expect(listed.map((x) => x.id)).toContain(s.id);
  });
});

describe("per-user cap", () => {
  it("trips the pending cap at the default of 3", async () => {
    await insertRow(USER, "pending_review");
    await insertRow(USER, "pending_review");
    await insertRow(USER, "pending_review");
    await expect(assertWithinCap(USER)).rejects.toMatchObject({ kind: "cap" });
    // and createSubmission(submit) refuses, leaving no new row
    const input = parseSubmissionInput(VALID);
    await expect(
      createSubmission({ userId: USER, input, action: "submit" }),
    ).rejects.toBeInstanceOf(SubmissionError);
  });

  it("trips the daily cap at the default of 5 even when nothing is pending", async () => {
    // Five rejected rows: none are 'pending' (so the pending cap is clear) but
    // all five count toward the daily limit.
    for (let i = 0; i < 5; i++) await insertRow(USER, "rejected");
    await expect(assertWithinCap(USER)).rejects.toMatchObject({ kind: "cap" });
  });

  it("a draft does not count toward the daily cap", async () => {
    for (let i = 0; i < 6; i++) await insertRow(USER, "draft");
    await expect(assertWithinCap(USER)).resolves.toBeUndefined();
  });
});

describe("updateSubmission", () => {
  it("refuses a submission the caller does not own", async () => {
    const id = await insertRow(USER, "draft");
    const input = parseSubmissionInput(VALID);
    await expect(
      updateSubmission({ id, userId: OTHER, input, action: "draft" }),
    ).rejects.toBeInstanceOf(SubmissionError);
  });

  it("refuses to edit a non-editable submission", async () => {
    const id = await insertRow(USER, "published");
    const input = parseSubmissionInput(VALID);
    await expect(
      updateSubmission({ id, userId: USER, input, action: "draft" }),
    ).rejects.toBeInstanceOf(SubmissionError);
  });

  it("resubmits a rejection: clears the reason, bumps the counter, re-enters review", async () => {
    const id = await insertRow(USER, "rejected", { reject_category: "real_person" });
    const input = parseSubmissionInput(VALID);
    const updated = await updateSubmission({ id, userId: USER, input, action: "submit" });
    expect(updated.status).toBe("pending_review");
    expect(updated.resubmit_count).toBe(1);
    expect(updated.reject_category).toBeNull();
  });
});

describe("setSubmissionStatus", () => {
  it("stamps approved_at on approval and writes an audit row", async () => {
    const created = await createSubmission({
      userId: USER,
      input: parseSubmissionInput(VALID),
      action: "submit",
    });
    const before = await eventCount(created.id);
    const approved = await setSubmissionStatus(
      created.id,
      "approved",
      { approvedBy: "admin1", storyId: "story-1" },
      "admin1",
    );
    expect(approved?.status).toBe("approved");
    expect(approved?.approved_at).toBeTruthy();
    expect(approved?.story_id).toBe("story-1");
    expect(await eventCount(created.id)).toBe(before + 1);
  });

  it("records a rejection reason", async () => {
    const created = await createSubmission({
      userId: USER,
      input: parseSubmissionInput(VALID),
      action: "submit",
    });
    const rejected = await setSubmissionStatus(
      created.id,
      "rejected",
      { category: "real_person", reason: "identifies a real third party" },
      "ai",
    );
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.reject_category).toBe("real_person");
  });
});
