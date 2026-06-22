# Comments feature restoration

Date: 2026-06-22
Status: In progress.
Branch: `feat/article-comments-restored` (cut from `main`).
Source: `origin/feat/article-comments` (commits `3cc8a3c..6c20e1e`, plus
the moderation eval and the original plan).
Related plan: `_plans/2026-06-22-article-comments-ai-moderation.md` —
the original feature plan, ported with this work for reference.

## Goal

Restore the article-comments feature to the active codebase. The original
work shipped on `feat/article-comments`, was merged into the abandoned
`feat/r2-media-migration` branch, and was lost when the cleaner R2 work
landed via a different PR. None of the comments code currently lives on
`main` or on `feat/multi-platform-shorts-publisher` (today's active
branch). This port brings it back, rebased onto today's `main`, with the
integration points hand-merged against the current shape of the four
files the comments series touched.

Success looks like: the article reader shows a working comments thread
on a real article; the admin queue at `/admin/comments` lists held and
rejected comments; the moderation drain cron is scheduled; `tsc` is
clean; the comments test suite is green; the rest of `main`'s tests
still pass; no other feature breaks.

## Constraints

- **Do no harm.** No silent edits to unrelated code. The four
  integration points (`schema.ts`, the article reader page,
  `AdminSidebar.tsx`, `vercel.json`) get their comments-specific
  additions only — everything else on those files stays as `main`
  has it today.
- **Match the most recent code.** The comments branch is built on a
  pre-R2, pre-anonymous-auth base. Where the source branch's version
  of an integration file differs from `main` for reasons unrelated
  to comments (R2 media paths, anon-auth schema), `main`'s version
  wins.
- **Schema reconciliation.** `feat/article-comments` redefines the
  `users` table to add provider/anonymous-id columns. Those columns
  already exist on `main` via the shipped anonymous-first auth work.
  Keep `main`'s `users` shape verbatim; only add the new
  `comments`-domain tables.
- **No mocks where the real path is testable.** Per the integration
  tests already in the source branch, comment-moderation lib has both
  unit and integration tests against the real DB seam.
- **Leave the active branch alone.** Today's WIP on
  `feat/multi-platform-shorts-publisher` (Facebook OAuth) is unrelated
  and must not be entangled with this port.

## Chosen approach

1. Cut `feat/article-comments-restored` from `origin/main`.
2. Copy the comments-only files verbatim from
   `origin/feat/article-comments`:
   - `lorewire-app/src/app/api/comments/route.ts`
   - `lorewire-app/src/app/api/comments/[id]/route.ts`
   - `lorewire-app/src/app/api/comments/like/route.ts`
   - `lorewire-app/src/app/api/comments/report/route.ts`
   - `lorewire-app/src/app/api/comments/appeal/route.ts`
   - `lorewire-app/src/app/api/comments/drain_moderation/route.ts`
   - `lorewire-app/src/app/admin/(panel)/comments/page.tsx`
   - `lorewire-app/src/app/admin/(panel)/comments/ModerationActions.tsx`
   - `lorewire-app/src/app/admin/(panel)/comments/CommentsKillSwitch.tsx`
   - `lorewire-app/src/app/admin/(panel)/comments/actions.ts`
   - `lorewire-app/src/components/CommentsSection.tsx`
   - `lorewire-app/src/lib/comments.ts`
   - `lorewire-app/src/lib/comments.test.ts`
   - `lorewire-app/src/lib/comments-read.ts`
   - `lorewire-app/src/lib/comments-read.test.ts`
   - `lorewire-app/src/lib/comment-cookie.ts`
   - `lorewire-app/src/lib/comment-rate-limit.ts`
   - `lorewire-app/src/lib/comment-moderation.ts`
   - `lorewire-app/src/lib/comment-moderation.test.ts`
   - `lorewire-app/src/lib/comment-moderation.integration.test.ts`
   - `lorewire-app/src/lib/openai-moderation.ts`
   - `lorewire-app/src/lib/request-origin.ts`
   - `lorewire-app/scripts/moderation-eval/*`
3. Hand-merge the four integration points against today's `main`:
   - **`lorewire-app/src/lib/schema.ts`**: keep `main`'s `USERS`
     verbatim. Append the new comments-domain tables (`COMMENTS`,
     `COMMENT_LIKES`, `COMMENT_APPEALS`, `COMMENT_REPORTS`,
     `COMMENT_MODERATION_EVENTS`) and the matching indexes /
     post-table DDL the source branch added.
   - **`lorewire-app/src/app/articles/[locale]/[slug]/page.tsx`**:
     mount `<CommentsSection>` and re-add the article fetch shape the
     comments source branch needed (id, comments_enabled). Keep
     today's R2 media path code unchanged.
   - **`lorewire-app/src/app/admin/AdminSidebar.tsx`** + test: add
     the "Comments" nav entry in the same slot the source branch put
     it, update the test snapshot accordingly.
   - **`lorewire-app/vercel.json`**: add the cron entry for the
     moderation drain endpoint.
4. Run the suite, fix any drift introduced by `main`'s changes (rename
   imports, repo-helper renames, etc.).
5. Open a PR against `main`.

## Alternatives considered and rejected

- **Cherry-pick `3cc8a3c..6c20e1e` onto a branch from `main`.**
  Rejected: the source branch sits on top of pre-R2, pre-anon-auth
  `main`. A cherry-pick conflicts on every integration point and on
  `schema.ts` in particular, and it carries stale shape from old code
  the source branch happened to touch. Verbatim file copy + manual
  integration is cleaner and easier to review.
- **Port onto today's `feat/multi-platform-shorts-publisher`.**
  Rejected: tangles the comments port with in-flight Facebook OAuth
  work that touches the same `users` surface. Two reviews are better
  than one combined diff that hides regressions.
- **Re-merge `feat/r2-media-migration` and resolve.** Rejected:
  that branch was abandoned for cause — the R2 work that actually
  shipped came in via a different, cleaner branch. Reviving it would
  re-introduce the same stale code that caused the original mess.

## Security (rule 13)

The source branch already enforced the heavy lifting; the port keeps
it intact and re-verifies nothing regressed:

- **Two-tier moderation.** Tier 1 is the OpenAI Moderation API
  (free, fast, toxicity-focused). Tier 2 is the LLM judge (gpt-5-nano)
  gated behind "Tier 1 was ambiguous" — caps spend, caps p99 latency,
  fails closed visibly (the comment stays held, the author sees the
  status).
- **Quarantine-and-alert path.** CSAM and credible-threat categories
  bypass the held queue and go straight to `quarantined` with admin
  alerting — non-discretionary, not a tunable knob.
- **Statement of reasons + appeal** on every rejection (EU DSA
  Article 17).
- **Guest abuse surface.** Rate limiter (`comment-rate-limit.ts`) is
  DB-backed and keyed by network origin (`request-origin.ts`), not
  by an easily-spoofed email. Salted IP/UA hash for audit, never
  the raw IP.
- **Kill switch.** `CommentsKillSwitch` flips a settings row that
  the write path checks first; if comments are off, the API returns
  503 immediately and the reader hides the box. Tested.
- **GDPR.** Soft-delete is the default for owner edits / deletes;
  hard erasure goes through the same `setCommentStatus` chokepoint
  so the audit row is preserved without the body.
- **Auth surface.** The route handlers honor the `lw_comment` cookie
  for guests (signed) and the standard session for signed-in users.
  No change to the auth model — the comments code consumes the
  existing session helpers.

Open security items for the port itself:
- Re-verify the moderation eval still passes against today's
  `gpt-5-nano` — the FINDINGS doc is from 2026-06-22; if the model
  has moved, the thresholds in `comment-moderation.ts` may need a
  re-tune before this hits production. Flag this in the PR.

## Observability (rule 14)

The source branch already namespaces logs by subsystem. The port
keeps these and adds nothing new:

- `[comments write]` — POST path: rate-limit hit, tier1 result,
  tier2 invocation, final status.
- `[comments mod]` — moderation lib: each tier's decision, latency,
  confidence buckets.
- `[comments drain]` — cron-driven retry of stuck-held items.
- `[comments admin]` — moderator actions, audit entries.

If the port introduces a new log line, it gets the same namespace
shape.

## Settings (rule 15)

The source branch already exposes:
- Comments kill switch (global on/off).
- Hold threshold + reject threshold (judge confidence cutoffs).
- Guest-comments toggle (separate from the global kill switch).

The port surfaces these in the existing `/admin/comments` page, not
in `/admin/settings`, because they cluster naturally with the queue.
If the user wants them in the global settings page instead, that's a
five-line follow-up.

## Testing (rule 18)

Three test surfaces in the source branch, all carried into the port:

- `lib/comments.test.ts` — CRUD + status transitions + audit trail.
- `lib/comments-read.test.ts` — thread shape, viewer-liked join,
  pagination.
- `lib/comment-moderation.test.ts` + `.integration.test.ts` —
  decision logic; integration test hits a real DB seam (not mocked).

The port runs the full Next-app test suite (`npm test` /
`vitest run`) to confirm:
1. The comments suite is green.
2. Nothing else regressed.
3. `tsc --noEmit` is clean.
4. `next build` succeeds.

If a test fails because of unrelated drift on `main` (e.g. a repo
helper got renamed), fix the test, don't skip it.

## UI / UX (rules 10, 16)

Reader view: thread loads inline below the article, sort toggle
(newest / top), reply once-deep, like with persisted liked-state,
report button with one-line confirmation. Empty state is plain and
specific ("Be the first to comment"), error states are explicit
("Couldn't post — try again" with the actual reason), held-status is
explicit to the author ("This comment is awaiting review").

Admin view: queue groups by status (held → reported → rejected),
one-click moderation actions, kill switch as a dedicated panel at
the top of the page, not buried in a menu.

No design changes from the source branch in this port — the source
branch already passed a UI/UX pass when it was built. If anything
looks stale relative to today's admin styling (e.g. new sidebar
chrome), that's a follow-up commit, not part of this port.

## Open questions

- Is there a published article on `main` today suitable for
  smoke-testing the reader thread? If not, the manual QA pass will
  need a fixture article (the comments code keys on `article_id`,
  not a specific slug).
- The original plan called for a re-eval of `gpt-5-nano` against the
  Hebrew dataset before flipping the kill switch on in production.
  That eval is in the source branch; it should be re-run on this
  port's branch before the feature is enabled live.

## Out of scope

- Threading more than one reply deep.
- Reactions other than like.
- Notifications when a comment gets a reply.
- Comments on shorts (article-only in v1).
- Surfacing the editorial signal columns (stance/sentiment/topic).
