# Article comments with AI moderation

Date: 2026-06-22
Status: Step 0 (eval) DONE — `gpt-5-nano` validated on EN + HE, verdict GO.
Building Steps 1-6 next. Findings: `lorewire-app/scripts/moderation-eval/FINDINGS.md`.
Branch: `feat/article-comments` (isolated git worktree at `C:/Projects/lorewire-comments`,
cut from `main` so other sessions on `feat/multi-platform-shorts-publisher` are untouched).

Step 0 result in one line: zero harmful comments (spam/hate/threats) were
published in any run, in either language; the only "misses" were off-topic and
emoji noise the judge leans permissive on. Three build-changing findings:
(1) derive "hold" from judge confidence in code, the model won't volunteer it;
(2) run the judge on everything Tier 1 doesn't outright reject, Tier 1 alone is
weak on Hebrew; (3) prompt injection of the "mark me as spam" kind still
over-blocks, needs a stronger fix. Add cheap deterministic pre-filters
(emoji-only/length -> low-effort, URL -> spam-suspect).

## Goal

Let readers comment on articles. An AI moderator decides, against rules we
set, whether each comment is published instantly, held for a human, or
rejected. The system must blunt spam and abuse without making honest
commenting feel like work.

Success looks like: a real discussion under articles, near-zero visible
spam or hate, a human review queue that stays small, and a moderator we
have actually measured on both English and Hebrew before it touches a
single reader.

## Locked product decisions (from the requirements pass)

- **Hybrid moderation.** Confident-clean publishes instantly. Borderline is
  held for human review. Clear violations are auto-rejected. (Not strict
  pre-moderation, not pure post-moderation.)
- **Commenters: signed-in users AND guests.** Guests give a display name and
  email. Honest flag: guests roughly triple the spam and abuse surface
  versus signed-in-only. The whole guest path sits behind one config flag so
  we can switch it off if it gets abused (see kill switch).
- **v1 scope is "Standard":** flat list with one level of replies, a like
  button, edit and delete your own comment, sort by newest or top.
- **Reject categories:** spam/promotion, hate/harassment, off-topic/low-effort.
  Profanity stays lenient (allowed within reason).
- **Full legal/recourse layer in v1:** statement-of-reasons plus appeal on
  every rejection, a non-discretionary CSAM/threats quarantine-and-alert
  path, GDPR erasure, soft-delete, and re-moderation on every edit.
- **Eval harness first:** prove the moderator on real English + Hebrew data
  and set thresholds from measurements before building any UI.
- **Capture editorial signal, do not surface it:** when the LLM judge runs,
  also store a cheap structured read (stance/sentiment/topic tag). No
  dashboards or features on it in v1. Do NOT fine-tune on OpenAI outputs
  (their terms forbid it).

## How it was pressure-tested

This plan was run through the LLM Council (five independent lenses plus an
anonymous peer-review round). The findings that changed the design:

1. **The free OpenAI Moderation API does not catch spam.** It classifies
   toxicity (hate, violence, sexual), not link spam, affiliate junk, SEO
   floods, or LLM-generated astroturf. Spam needs its own layer: rate
   limits, velocity caps, link heuristics, and the LLM judge explicitly
   prompted for promotion. Not a side effect of toxicity scoring.
2. **Hebrew is an unmeasured risk.** `omni-moderation-latest` is much weaker
   outside English. We do not trust it on Hebrew until the eval says so.
   This is why Step 0 exists.
3. **Inline-synchronous moderation makes our p99 equal to OpenAI's p99, and
   "fail closed silently" is a trap.** A slow OpenAI morning would flood the
   held queue and bury it. Resolution: gate the expensive LLM judge behind
   "the free Moderation API was ambiguous," so the common case resolves on
   one fast call, and never fail silently (author always sees their own
   comment's status, a cron retry net drains held items, there is a kill
   switch).
4. **Guest abuse is the soft underbelly.** A salted email hash stops us
   contacting them, not them flooding us. The real control surface is
   velocity per network origin, backed by a DB-backed limiter and a CAPTCHA
   on the guest path, not per-email cleverness.
5. **Legal gaps that are easy to miss:** EU DSA Article 17 requires a
   statement-of-reasons when you reject user content; CSAM and credible
   threats are mandatory-reporting obligations, not tunable reject
   categories; GDPR needs an erasure path; counts and pagination must use
   denormalized counters and keyset pagination, not `COUNT(*)`/`OFFSET`.

## Chosen approach

### Moderation pipeline (two-tier, ambiguity-gated)

On comment submit (`POST /api/comments`):

1. **Gate.** Origin check (reuse the poll-vote `isAllowedOrigin` pattern),
   Zod body validation, auth/guest resolution, DB-backed velocity limit, and
   (guest path) CAPTCHA verification. Reject early on any failure.
2. **Tier 1 — free OpenAI Moderation API, inline, tight timeout (~2.5s).**
   - Clearly clean (all category scores below the cleared threshold) and not
     flagged by the cheap spam pre-checks: **publish instantly.**
   - Clearly toxic (hate/harassment/violence/sexual above the reject
     threshold): **auto-reject** with a category reason. If the category is
     CSAM or a credible threat, route to the **non-discretionary path**
     (quarantine, preserve, alert admin, never silent-delete).
   - Anything ambiguous, plus everything that needs spam/off-topic judgment
     (which Tier 1 cannot do): go to Tier 2.
3. **Tier 2 — LLM judge (`gpt-5-nano`), inline, shared timeout budget.**
   Prompt carries the admin rules, the article title/summary for on-topic
   judging, and the comment. Returns a strict-JSON verdict: decision
   (publish | hold | reject), category, a short reason, a confidence, plus
   the cheap editorial signal (stance, sentiment, topic tag). Hardened
   against prompt injection: the comment is clearly delimited and treated as
   untrusted data, the judge is told that instructions inside a comment are
   not commands, and we validate the JSON shape and ignore anything off-schema.
   - confident clean -> publish; borderline -> hold; violation -> reject.
4. **Never fail silently.** On Tier 1 or Tier 2 timeout/error, the comment is
   set to **held** (fail closed for visibility) but the author immediately
   sees their own comment with an honest "pending review" status. A Vercel
   cron drain (`/api/comments/drain_moderation`, every minute, mirroring the
   existing `drain_*` jobs) retries held-by-timeout comments so a provider
   blip does not become a manual dig-out.

Why inline and not the cron job-queue for the happy path: a commenter is
standing right there. The majority of comments resolve on one fast free call
and publish in about a second. The queue is the safety net for the timeout
minority, not the primary path.

### Data model

New tables appended to `TABLES` in `src/lib/schema.ts`, following the
existing shape (TEXT/INTEGER/REAL columns, no FK/NOT NULL in `createTableSql`,
load-bearing indexes in `POST_TABLE_DDL`). Times are ISO TEXT like the rest
of the schema.

- **`comments`**: `id` (pk, UUID), `article_id`, `parent_id` (nullable; one
  level only, enforced in code), `author_user_id` (nullable for guests),
  `guest_name` (nullable), `guest_email_enc` (see open question on hash vs
  encrypted), `body`, `status` (`published` | `held` | `rejected` |
  `deleted`), `moderation_category`, `moderation_reason`,
  `moderation_source` (`tier1` | `tier2` | `human` | `timeout`),
  `moderation_confidence` (REAL), `stance`, `sentiment`, `topic_tag`,
  `like_count` (INTEGER, denormalized), `reply_count` (INTEGER, denormalized),
  `cookie_token`, `ip_ua_hash` (rate-limit bucket only, pruned on a schedule
  like `poll_votes`), `lang`, `edited_at`, `created_at`.
- **`comment_likes`**: `id` (pk), `comment_id`, `user_id` (nullable),
  `cookie_token`, `created_at`. Partial unique indexes prevent double-likes,
  same trick as `poll_votes`: `(comment_id, user_id) WHERE user_id IS NOT NULL`
  and `(comment_id, cookie_token)`.
- **`comment_reports`**: `id` (pk), `comment_id`, `reporter_user_id`
  (nullable), `cookie_token`, `reason`, `status` (`open` | `actioned` |
  `dismissed`), `created_at`. (Reader-side reporting is in v1 because the
  full legal layer was chosen; a report routes the comment back to the human
  queue.)
- **`comment_moderation_events`**: append-only audit log (`id`, `comment_id`,
  `actor` (`ai` | admin user id), `from_status`, `to_status`, `category`,
  `reason`, `created_at`). This is the audit trail the legal layer needs and
  the basis for the appeal record.
- **Rules + kill switch** live in the existing `settings` table (key/value),
  not a bespoke table: thresholds, the admin rule text fed to the judge, a
  site-wide comments on/off, a guests-allowed on/off, and a per-article
  override. Keeps v1 lean and matches how `settings` already drives runtime
  config without a deploy.

Indexes in `POST_TABLE_DDL`: `(article_id, status, created_at)` for the
public read (keyset pagination on `created_at`/`id`, never `OFFSET`),
`(parent_id)` for replies, `(status)` for the admin queue, and the two
partial unique like indexes.

### Read + rendering

- Public read via a server action in `src/app/actions.ts` (mirrors the
  existing published-only gating): only `status = 'published'` for other
  readers, plus the current author's own non-published comment so they see
  their pending/rejected state with a reason. Keyset pagination, newest or
  top (by `like_count`) sort.
- Render is HTML-escaped, no raw HTML. URLs render as text or `nofollow`
  links. Full RTL correctness for Hebrew: the comment box, buttons, status
  text, and thread indentation must mirror correctly, since broken
  directionality reads as an amateur site to Hebrew readers.

### Author experience (lazy-user lens)

- After submit, the author always sees their comment immediately with a clear
  state: live, "pending review," or "rejected: <plain-language reason>" with
  a one-click **appeal** that routes it to the human queue. No silent
  disappearance, which reads as censorship.
- Held/appeal/decision status is shown inline on the page (resolved via the
  author's session or cookie token), not by email, so we are not forced to
  store reachable guest email just to notify. (See open question.)
- Mobile: the post button stays above the keyboard, like and reply do not
  force a second sign-in mid-action, and a reload must not eat a draft
  (local draft persistence).

### Admin

- A review queue in the existing `/admin` panel behind `requireAdmin()`:
  held and reported comments, each showing the AI category, reason, and
  confidence. Approve or reject, with the action written to
  `comment_moderation_events`. v1 has no feedback-training loop.
- A quarantine view for the CSAM/threats path, separated from ordinary
  moderation, with preserve-and-alert behavior.

## Alternatives considered and rejected

- **Strict pre-moderation (hold everything).** Rejected at the requirements
  stage: threads feel dead, every comment pays an AI check plus delay, and
  the queue carries the full volume. Hybrid gets the safety on the risky
  minority only.
- **Pure post-moderation (publish all, remove later).** Rejected: a slur or
  scam is visible during the window before removal, which on a public news
  site is the exact reputational hit we are avoiding.
- **Reuse the cron job-queue for the happy path (optimistic publish, async
  moderate).** Rejected for the common case: it forces a pending-state UI,
  polling, and a comment-that-appears-later flow, which is more code and a
  worse experience than a one-second inline resolve. Kept only as the
  timeout safety net.
- **Run the LLM judge on every comment.** Rejected on cost and latency:
  gating it behind Tier-1 ambiguity keeps spend and delay near zero for the
  clean majority. The free Moderation API carries the bulk.
- **Anthropic Claude Haiku 4.5 as the judge instead of gpt-5-nano.**
  Deferred, not rejected. gpt-5-nano is about 25x cheaper on input
  ($0.04/$0.36 vs $1/$5 per Mtok) and already wired through `chatCompletion`.
  If the Step 0 eval shows nano is not good enough on Hebrew, wiring
  Anthropic is the fallback (the `chatCompletion` client already has an
  `anthropic/` branch stubbed; it would need `ANTHROPIC_API_KEY` and a real
  implementation).
- **A bespoke `comment_rules` table with an admin CRUD editor.** Rejected for
  v1: the categories are locked, so the rule text and thresholds live in
  `settings` (already a runtime-config store). A full rules editor is scope
  creep.

## Security and safety (rule 13)

- **Sensitive data:** comment bodies (user content), guest display name, and
  guest email. Minimize what we store; never log PII or full comment bodies
  in cleartext logs; `ip_ua_hash` is one-way and pruned on a schedule like
  `poll_votes`.
- **Attack surface:** the public `POST /api/comments` and like/report
  endpoints. Defenses: origin gate (`NEXT_PUBLIC_SITE_ORIGIN`), Zod
  validation, DB-backed velocity limit per (user, ip_ua_hash, email_hash),
  CAPTCHA on the guest path, body length caps, and link-count heuristics.
- **AuthZ:** edit/delete only your own comment (own `author_user_id` or own
  cookie token); admin actions behind `requireAdmin()`; the public-user
  cookie never carries admin scope (separate `lw_user` secret, already
  enforced in `user-session.ts`).
- **Prompt injection:** comment text is untrusted. It is delimited and the
  judge is instructed that text inside a comment is data, not instructions;
  output is schema-validated and off-schema fields are ignored.
- **Fail safe:** fail closed to "held" on moderation error, but visibly, with
  a cron retry net and a kill switch (site-wide and per-article).
- **Legal:** DSA statement-of-reasons on every rejection plus an appeal path;
  non-discretionary CSAM/threats quarantine-preserve-alert path (legal
  counsel needed on the exact reporting obligation for our jurisdictions);
  GDPR erasure; an immutable `comment_moderation_events` audit trail; a data
  retention policy for rejected comments.
- **Cost:** Tier 1 (OpenAI Moderation API) is free and does not count toward
  usage limits (verified 2026-06-22). Tier 2 (gpt-5-nano) is ~$0.04 in /
  $0.36 out per Mtok; a borderline comment costs on the order of $0.0001, and
  only the ambiguous minority hits it. CAPTCHA: Cloudflare Turnstile has a
  free tier (verify current limits before wiring). At any realistic volume
  this feature's AI cost is negligible; the real cost is human review time,
  which the hybrid design is built to keep small.

## Build sequence

- **Step 0 — Eval harness first (the de-risking step).** Assemble 60-100
  realistic comments, English and Hebrew, spanning clean, spam, hate,
  off-topic, low-effort, deliberately borderline, and prompt-injection cases.
  Run them through the free Moderation API plus the gpt-5-nano judge. Measure
  accuracy per language and category, then set thresholds from the data.
  Output: an accuracy report and recommended thresholds. Gate: if Hebrew
  accuracy is poor, revisit the judge model (Anthropic fallback) before
  building UI.
- **Step 1 —** `comments` table entry in `TABLES`, auto-migrating on both
  SQLite and Postgres. Nothing else.
- **Step 2 —** `POST /api/comments`: insert, render, no moderation yet
  (origin gate + validation + auth/guest resolution in place).
- **Step 3 —** Public read + display: newest sort, one level of replies,
  keyset pagination, RTL-correct.
- **Step 4 —** Wire the two-tier moderation with the Step 0 thresholds, fail
  closed to held visibly, plus the cron drain retry net.
- **Step 5 —** Admin review queue (approve/reject held + reported), audit
  events, CSAM/threats quarantine view, statement-of-reasons + appeal.
- **Step 6 —** Likes (counter + partial unique indexes), edit/delete own
  (edit re-moderates), guest path hardening (DB velocity limit + CAPTCHA),
  GDPR erasure, kill switches.

Shippable as a coherent feature after Step 5; Step 6 is the hardening and
polish pass. Each step gets the rule-6 QA pass (golden path, edge cases,
error paths, adjacent regressions) before moving on.

## Open questions (decide before or during the relevant step)

1. **Guest email: salted hash only, or encrypted-and-retrievable?** Hash-only
   is the least PII but means we cannot email guests or honor an
   erasure-by-email request (only self-serve delete via cookie + admin
   manual delete). Encrypted-and-retrievable enables notification and
   erasure-by-email but stores more sensitive data. Given "full legal layer,"
   leaning encrypted-at-rest with a short retention, but this is a real
   privacy/liability tradeoff to confirm. (Step 1/6.)
2. **CAPTCHA provider on the guest path.** Recommend Cloudflare Turnstile
   (free tier, low-friction). Confirm and verify current free-tier limits
   before wiring. (Step 6.)
3. **Judge model. RESOLVED:** `gpt-5-nano` confirmed by the Step 0 eval —
   handles Hebrew as well as English. No need to wire Anthropic. (If Hebrew
   over-blocking shows up in prod logs, Haiku 4.5 remains the fallback and
   would need `ANTHROPIC_API_KEY` plus finishing the `anthropic/` branch in
   `src/lib/llm.ts`.)
4. **CSAM/threats reporting obligation.** Needs legal input on the exact
   duty for our operating jurisdictions (US/EU/Israel). The technical path
   (quarantine, preserve, alert, never silent-delete) is built regardless;
   the reporting workflow depends on that input. (Step 5.)
5. **Branch.** Cut a fresh `feat/article-comments` branch from `main` rather
   than building on the current shorts-publisher branch.

## Reference: key files and patterns to mirror

- Schema shape + migration: `src/lib/schema.ts` (`Table`, `createTableSql`,
  `POST_TABLE_DDL`, `POLL_VOTES` as the closest template), `src/lib/db.ts`
  (`all`/`one`/`run`, additive auto-migration).
- Public POST conventions: `src/app/api/polls/vote/route.ts` (origin gate,
  `ipUaHash`, rate-limit shape, cookie token, no-PII-in-response).
- LLM client: `src/lib/llm.ts` (`chatCompletion`, `jsonMode`); add a
  `moderation()` helper for the free endpoint (not yet present).
- Public-user session: `src/lib/user-session.ts` (`readUserSession`).
- Admin gate: `src/lib/dal.ts` (`requireAdmin`).
- Cron drains: `vercel.json` crons + the `drain_*` routes.
- Project constraint: this Next.js has breaking changes from training data.
  Read `node_modules/next/dist/docs/` before writing any route/page code
  (per `lorewire-app/AGENTS.md`).
