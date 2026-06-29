// Poll-vote reconciliation coverage. The UPDATE in
// reconcileVotesForCookieToken is bounded by two conditions:
//   - cookie_token = ?   (only this browser's votes)
//   - user_id IS NULL    (only anonymous votes)
//
// Both have to hold or sign-in could clobber another user's real votes,
// or every anonymous vote in the system could migrate to the signing-in
// user. We can't easily test the route-level cookies()-bound entry
// point in a unit test, so this file targets the SQL directly via a
// helper that mirrors what reconcileVotesForCookieToken does.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { all, run } from "@/lib/db";

async function clearVotes(): Promise<void> {
  await run("DELETE FROM poll_votes", []);
}

async function insertVote(opts: {
  poll: string;
  cookie: string | null;
  user: string | null;
  story?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await run(
    `INSERT INTO poll_votes
      (id, poll_id, story_id, article_id, category, side, cookie_token, user_id, ip_ua_hash, created_at)
     VALUES (?, ?, ?, NULL, 'Drama', 'A', ?, ?, NULL, ?)`,
    [id, opts.poll, opts.story ?? "s_x", opts.cookie, opts.user, new Date().toISOString()],
  );
  return id;
}

async function fetchVoteUser(id: string): Promise<string | null> {
  const rows = await all<{ user_id: string | null }>(
    `SELECT user_id FROM poll_votes WHERE id = ?`,
    [id],
  );
  return rows[0]?.user_id ?? null;
}

// Inlined SQL mirror of the route helper's UPDATE, so the test doesn't
// need cookies() and tests the actual statement shape.
async function reconcile(cookieToken: string, userId: string): Promise<void> {
  await run(
    `UPDATE poll_votes SET user_id = ?
      WHERE cookie_token = ? AND user_id IS NULL`,
    [userId, cookieToken],
  );
}

describe("poll vote reconciliation SQL invariants", () => {
  beforeEach(async () => {
    await clearVotes();
  });

  it("promotes only the matching browser's anonymous votes", async () => {
    const browserA = "cookie-aaa";
    const browserB = "cookie-bbb";
    const userA = "u_alpha";
    const a1 = await insertVote({ poll: "p1", cookie: browserA, user: null });
    const a2 = await insertVote({ poll: "p2", cookie: browserA, user: null });
    const b1 = await insertVote({ poll: "p3", cookie: browserB, user: null });
    await reconcile(browserA, userA);
    expect(await fetchVoteUser(a1)).toBe(userA);
    expect(await fetchVoteUser(a2)).toBe(userA);
    // Browser B's vote MUST stay untouched.
    expect(await fetchVoteUser(b1)).toBeNull();
  });

  it("never overwrites an already-authenticated vote", async () => {
    const browserA = "cookie-ccc";
    const existingUser = "u_existing";
    const newSigningInUser = "u_new";
    const claimed = await insertVote({
      poll: "p4",
      cookie: browserA,
      user: existingUser,
    });
    const anon = await insertVote({
      poll: "p5",
      cookie: browserA,
      user: null,
    });
    await reconcile(browserA, newSigningInUser);
    // The pre-existing authenticated vote is untouched.
    expect(await fetchVoteUser(claimed)).toBe(existingUser);
    // The anonymous one got promoted.
    expect(await fetchVoteUser(anon)).toBe(newSigningInUser);
  });

  it("a missing cookie token reconciles nothing", async () => {
    const browserA = "cookie-ddd";
    const userA = "u_d";
    const anon = await insertVote({ poll: "p6", cookie: browserA, user: null });
    // Reconciling with a different cookie value: no-op.
    await reconcile("cookie-other", userA);
    expect(await fetchVoteUser(anon)).toBeNull();
  });
});
