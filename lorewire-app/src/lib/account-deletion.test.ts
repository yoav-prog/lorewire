// deleteUserCompletely coverage. This is the single function both the Meta
// data-deletion callback and the self-serve delete funnel through, so the
// invariants that matter are: (1) every user_id-keyed table is wiped, (2) the
// user's poll votes are re-anonymized (kept for the aggregate, but every
// identifier nulled), (3) a DIFFERENT user's data is never touched, and
// (4) a second call is a clean no-op. Tests run against the configured DB via
// all/run, same pattern as poll-vote-reconciliation.test.ts.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  USER_DATA_TABLES,
  deleteUserCompletely,
  getDeletionRequest,
  recordDeletionRequest,
} from "@/lib/account-deletion";
import { all, one, run } from "@/lib/db";

const VICTIM = "u_del_victim";
const BYSTANDER = "u_del_bystander";

async function seedUser(id: string): Promise<void> {
  const now = new Date().toISOString();
  await run(
    `INSERT INTO users
        (id, email, role, password_hash, name, picture_url,
         provider, provider_sub, anonymous_id, last_seen_at, created_at)
      VALUES (?, ?, 'user', NULL, ?, NULL, 'facebook', ?, NULL, ?, ?)`,
    [id, `${id}@example.test`, id, `fbsub_${id}`, now, now],
  );
  await run(
    `INSERT INTO user_saves (id, user_id, story_id, created_at) VALUES (?, ?, 's1', ?)`,
    [randomUUID(), id, now],
  );
  await run(
    `INSERT INTO user_likes (id, user_id, story_id, created_at) VALUES (?, ?, 's1', ?)`,
    [randomUUID(), id, now],
  );
  await run(
    `INSERT INTO user_fav_categories (id, user_id, category, created_at) VALUES (?, ?, 'Drama', ?)`,
    [randomUUID(), id, now],
  );
  await run(
    `INSERT INTO user_recently_viewed (id, user_id, story_id, viewed_at) VALUES (?, ?, 's1', ?)`,
    [randomUUID(), id, now],
  );
  await run(
    `INSERT INTO user_continue (id, user_id, story_id, position_ms, position_pct, updated_at)
      VALUES (?, ?, 's1', 1000, NULL, ?)`,
    [randomUUID(), id, now],
  );
  await run(
    `INSERT INTO comment_likes (id, comment_id, user_id, cookie_token, created_at)
      VALUES (?, 'c1', ?, NULL, ?)`,
    [randomUUID(), id, now],
  );
}

async function seedVote(
  userId: string,
  poll: string,
  cookie: string | null,
): Promise<string> {
  const id = randomUUID();
  await run(
    `INSERT INTO poll_votes
        (id, poll_id, story_id, article_id, category, side, cookie_token, ip_ua_hash, created_at, user_id)
      VALUES (?, ?, 's1', NULL, 'Drama', 'A', ?, 'iphash', ?, ?)`,
    [id, poll, cookie, new Date().toISOString(), userId],
  );
  return id;
}

async function countFor(table: string, userId: string): Promise<number> {
  const rows = await all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`,
    [userId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function cleanup(): Promise<void> {
  for (const id of [VICTIM, BYSTANDER]) {
    for (const table of USER_DATA_TABLES) {
      await run(`DELETE FROM ${table} WHERE user_id = ?`, [id]);
    }
    await run("DELETE FROM poll_votes WHERE user_id = ?", [id]);
    await run("DELETE FROM poll_votes WHERE poll_id IN ('pv_v', 'pv_b')", []);
    await run("DELETE FROM comments WHERE article_id = 'a1'", []);
    await run("DELETE FROM comment_reports WHERE comment_id = 'c-other'", []);
    await run("DELETE FROM users WHERE id = ?", [id]);
  }
}

describe("deleteUserCompletely", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("wipes every user_id-keyed table and the users row", async () => {
    await seedUser(VICTIM);
    const res = await deleteUserCompletely(VICTIM);

    expect(res.deletedUser).toBe(true);
    for (const table of USER_DATA_TABLES) {
      expect(await countFor(table, VICTIM)).toBe(0);
    }
    expect(await one("SELECT id FROM users WHERE id = ?", [VICTIM])).toBeNull();
  });

  it("re-anonymizes the user's poll votes instead of deleting them", async () => {
    await seedUser(VICTIM);
    const voteId = await seedVote(VICTIM, "pv_v", "cookie-victim");

    await deleteUserCompletely(VICTIM);

    const row = await one<{
      user_id: string | null;
      cookie_token: string | null;
      ip_ua_hash: string | null;
      side: string;
    }>("SELECT user_id, cookie_token, ip_ua_hash, side FROM poll_votes WHERE id = ?", [
      voteId,
    ]);
    // The vote row survives (aggregate integrity) but carries no identifier.
    expect(row).not.toBeNull();
    expect(row?.user_id).toBeNull();
    expect(row?.cookie_token).toBeNull();
    expect(row?.ip_ua_hash).toBeNull();
    expect(row?.side).toBe("A");
  });

  it("never touches a different user's data", async () => {
    await seedUser(VICTIM);
    await seedUser(BYSTANDER);
    const bystanderVote = await seedVote(BYSTANDER, "pv_b", "cookie-bystander");

    await deleteUserCompletely(VICTIM);

    for (const table of USER_DATA_TABLES) {
      expect(await countFor(table, BYSTANDER)).toBe(1);
    }
    expect(
      await one("SELECT id FROM users WHERE id = ?", [BYSTANDER]),
    ).not.toBeNull();
    const v = await one<{ user_id: string | null }>(
      "SELECT user_id FROM poll_votes WHERE id = ?",
      [bystanderVote],
    );
    expect(v?.user_id).toBe(BYSTANDER);
  });

  it("is idempotent — a second call is a clean no-op", async () => {
    await seedUser(VICTIM);
    const first = await deleteUserCompletely(VICTIM);
    const second = await deleteUserCompletely(VICTIM);
    expect(first.deletedUser).toBe(true);
    expect(second.deletedUser).toBe(false);
  });

  it("erases comment data: reports deleted, authored comments de-identified", async () => {
    await seedUser(VICTIM);
    const now = new Date().toISOString();
    const commentId = randomUUID();
    await run(
      `INSERT INTO comments
          (id, article_id, parent_id, author_user_id, guest_name, body, lang,
           status, cookie_token, ip_ua_hash, created_at)
        VALUES (?, 'a1', NULL, ?, NULL, 'my words', 'en', 'published', 'nonce', 'iphash', ?)`,
      [commentId, VICTIM, now],
    );
    const reportId = randomUUID();
    await run(
      `INSERT INTO comment_reports
          (id, comment_id, reporter_user_id, cookie_token, reason, status, created_at)
        VALUES (?, 'c-other', ?, NULL, 'spam', 'open', ?)`,
      [reportId, VICTIM, now],
    );

    await deleteUserCompletely(VICTIM);

    // The report (a private action) is gone.
    expect(
      await one("SELECT id FROM comment_reports WHERE id = ?", [reportId]),
    ).toBeNull();

    // The authored comment survives for thread integrity, fully de-identified
    // and pulled from the public ('published') thread.
    const c = await one<{
      author_user_id: string | null;
      guest_name: string | null;
      cookie_token: string | null;
      ip_ua_hash: string | null;
      status: string;
    }>(
      `SELECT author_user_id, guest_name, cookie_token, ip_ua_hash, status
         FROM comments WHERE id = ?`,
      [commentId],
    );
    expect(c).not.toBeNull();
    expect(c?.author_user_id).toBeNull();
    expect(c?.guest_name).toBeNull();
    expect(c?.cookie_token).toBeNull();
    expect(c?.ip_ua_hash).toBeNull();
    expect(c?.status).toBe("deleted");
  });

  it("rejects an empty user id", async () => {
    await expect(deleteUserCompletely("")).rejects.toThrow();
  });
});

describe("recordDeletionRequest", () => {
  const CODE = "test-conf-code-0001";

  beforeEach(async () => {
    await run("DELETE FROM data_deletion_requests WHERE confirmation_code = ?", [
      CODE,
    ]);
  });
  afterEach(async () => {
    await run("DELETE FROM data_deletion_requests WHERE confirmation_code = ?", [
      CODE,
    ]);
  });

  it("writes an audit row keyed by confirmation_code without raw PII", async () => {
    await recordDeletionRequest({
      confirmationCode: CODE,
      source: "facebook",
      subject: "fb-app-scoped-id-12345",
      deleted: true,
    });
    const rec = await getDeletionRequest(CODE);
    expect(rec?.source).toBe("facebook");
    expect(rec?.deleted).toBe(1);
    // The raw subject must never appear; only its hash.
    expect(rec?.subject_hash).not.toContain("fb-app-scoped-id-12345");
    expect(rec?.subject_hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("ignores a duplicate confirmation_code (Meta retry safe)", async () => {
    await recordDeletionRequest({
      confirmationCode: CODE,
      source: "facebook",
      subject: "subj",
      deleted: true,
    });
    // Second call with the same code must not throw or overwrite.
    await recordDeletionRequest({
      confirmationCode: CODE,
      source: "self_serve",
      subject: "subj",
      deleted: false,
    });
    const rec = await getDeletionRequest(CODE);
    expect(rec?.source).toBe("facebook");
    expect(rec?.deleted).toBe(1);
  });
});
