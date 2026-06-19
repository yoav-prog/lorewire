// Poll-vote reconciliation step. Runs on first sign-in for a browser so
// the votes the user cast as an anonymous visitor get linked to their
// new (or now-linked) public-user row. Cross-device payoff: signing in
// on a second device sees the votes through the user_id index without
// any further work.
//
// The single SQL statement here is the load-bearing line:
//
//   UPDATE poll_votes
//      SET user_id = ?
//    WHERE cookie_token = ?
//      AND user_id IS NULL
//
// Why `user_id IS NULL` matters: it caps reconciliation to votes that
// truly are anonymous on this browser today. Without it, signing in
// later as a DIFFERENT account from the same browser would overwrite
// the FIRST account's votes — losing real data.
//
// Why `cookie_token = ?` matters: it scopes to the votes from THIS
// browser only. Without it, you'd promote every anonymous vote in the
// system to the signing-in user. Obviously bad.
//
// Why we ignore the partial unique index (poll_id, user_id) WHERE
// user_id IS NOT NULL: the only way reconciliation could violate it is
// if the user already has an authenticated vote on the same poll from
// a previous device, AND this browser also cast an anonymous vote on
// that same poll. In that case the UPDATE would create a duplicate
// (poll_id, user_id) pair and the partial unique index would reject the
// statement. We don't need extra app-level logic: the DB constraint
// catches it, the route handler catches the error and logs it as
// "reconcile-failed", and sign-in proceeds normally. The user just
// doesn't get a free second vote — which is the right outcome.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §Polls + auth integration.

import "server-only";
import { cookies } from "next/headers";

import { all, run } from "@/lib/db";
import { VOTE_COOKIE } from "@/lib/poll-cookie";

/** Run the reconciliation for the signing-in user. Reads the current
 *  request's lw_vote cookie; if absent (the browser never voted
 *  anonymously) this is a no-op. Returns the number of rows updated for
 *  observability. */
export async function reconcileVotesForCookieToken(
  userId: string,
): Promise<number> {
  if (!userId) return 0;
  const store = await cookies();
  const cookieToken = store.get(VOTE_COOKIE)?.value;
  if (!cookieToken) return 0;

  // Count first (cheap) so we can log a meaningful number even when
  // run() doesn't expose a row count consistently across SQLite +
  // Postgres drivers. The two queries run in the same connection
  // sequentially — no transactional guarantee needed, the SELECT is
  // just an observability quanta.
  const candidates = await all<{ id: string }>(
    `SELECT id FROM poll_votes
      WHERE cookie_token = ?
        AND user_id IS NULL`,
    [cookieToken],
  );
  if (candidates.length === 0) return 0;

  await run(
    `UPDATE poll_votes
        SET user_id = ?
      WHERE cookie_token = ?
        AND user_id IS NULL`,
    [userId, cookieToken],
  );
  console.info("[auth reconcile votes]", {
    user_id_hash: userId.slice(0, 8),
    promoted: candidates.length,
  });
  return candidates.length;
}
