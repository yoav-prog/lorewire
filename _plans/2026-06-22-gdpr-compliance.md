# GDPR compliance remediation — LoreWire

Date: 2026-06-22
Status: approved, in progress
Branch: `feat/gdpr-compliance`
Author: Yoav + Claude
Council: pressure-tested 2026-06-22 (verdict summarized in §Council below)

## Goal

Make LoreWire genuinely GDPR-compliant on the engineering side, and produce
(but not legally sign off on) the organizational paperwork. The trigger:
the site is **live with real EU/UK users** and its published privacy policy
makes promises the code does not keep. That is the active liability we are
closing.

## Decisions locked (2026-06-22)

- Site is **live with real users** → urgency is real, sequence stops the
  active bleeding first.
- DSAR model: **self-serve in-app** (export + delete + disconnect), not
  manual-email-only.
- Scope: **code + drafted paperwork** (ROPA, lawful-basis register, vendor/DPA
  tracker, DPIA) + a lawyer checklist. We do not provide legal sign-off.
- Children: **adults-only**. State a minimum age (16, the GDPR digital-consent
  default), no child-consent / parental-consent machinery.
- Export format: **JSON (Art. 20 portability) + a human-readable summary** so a
  normal person understands what they received.
- Step 0 (policy correction): **ship now as its own commit**, decoupled from
  the multi-day build.

## Verified current state (read from code, not assumed)

- Stack: Next.js 16.2.9 (App Router). SQLite (dev) / Postgres via Neon (prod).
  Raw SQL, **no ORM, no foreign keys, no cascade deletes**.
- Auth: email+password (scrypt), magic-link (SHA-256 hashed tokens, email via
  Brevo), OAuth Google / Microsoft / Reddit (arctic, PKCE + state). Sessions are
  httpOnly signed-JWT cookies (`lw_user`, `lw_session`), separate secrets.
- Cookies: `lw_session`, `lw_user`, `lw_anon` (365d), `lw_vote` (365d),
  `lw_consent` (client-readable), `lw_oauth_*` (short-lived). All first-party,
  all functional. **No third-party tracking, analytics, ad, or pixel code at
  all.**
- Consent: honest Accept/Reject banner, no dark pattern; Reject clears stored
  device state. Accept issues the `lw_anon` continuity nonce.
- Personal-data tables tied to a public user: `users`, `user_saves`,
  `user_likes`, `user_fav_categories`, `user_recently_viewed`, `user_continue`,
  `poll_votes` (user_id + cookie_token + ip_ua_hash), `magic_link_tokens`
  (keyed by email).
- Third-party processors: Neon, Vercel, Brevo, Google (TTS + OAuth + GCS),
  Microsoft, Reddit, OpenAI, Kie.ai, ElevenLabs, Decodo.
- Existing: `/privacy`, `/terms` (effective 2026-06-16). Meta data-deletion
  webhook exists but is Phase 0 (logs only, no token revocation).

## Verified gaps

1. **Privacy policy contains multiple false statements to live users:**
   - §9 "Deletion: close your account from the settings page" — no such control
     or endpoint exists.
   - §3 / §7 "exactly two cookies" / "one session + one theme cookie" — false;
     there are 5+ first-party cookie families.
   - §2 omits reader-activity data and the user-side sign-in providers.
   - §5 omits Microsoft, Reddit, Brevo as processors.
   - Terms §8 repeats the false "close from settings page" deletion promise.
   - §10 references "under 13"; should be 16 (GDPR) and adults-only.
2. **No self-serve data export** (Art. 15 access / Art. 20 portability).
3. **Retention promises not enforced in code:** the 24h `ip_ua_hash` prune, the
   expired `magic_link_tokens` prune, and the `user_recently_viewed` 50-row cap
   have **no cron** in `vercel.json`.
4. **No FK / cascade** → account deletion is a hand-written multi-table sweep.
   A missed table = certified-but-incomplete erasure (worse than no delete).
5. Hardening: `lw_anon` / `lw_vote` 365-day TTL; OAuth avatar URLs hot-linked
   from providers; Meta data-deletion webhook still Phase 0.

## Council verdict (summary)

- Fix the lying policy **first** (hours), do not let the multi-day build sit on
  a known-false policy.
- The no-FK schema is the **core legal risk**, not a hardening afterthought.
  Build a single typed **personal-data registry** (every table + column holding
  `user_id` / `email` / `cookie_token` / `ip_ua_hash`), with a guard test that
  fails when a new personal-data table is added unregistered. The registry
  **doubles as the ROPA** — one artifact, two purposes. Delete, export, and
  retention all derive from it.
- Build delete/export **synchronous and simple**: one transaction, inline JSON,
  re-auth gated, scoped to the session's own user, never trust a `user_id` from
  the request body, rate-limited. No async queues / signed URLs / warehouse
  anonymization at this scale.
- Re-auth gap: OAuth / magic-link users have **no password** → provide a
  fresh-magic-link re-verify path for the confirmation step.
- Missing entirely and non-negotiable: DSAR identity verification, the 30-day
  clock, breach-notification runbook, Art. 27 EU representative, consent
  records, lawful basis per purpose, controller of record.
- Peer-review blind spots: no signed **Art. 28 DPAs** with processors; backups
  / logs / third-party copies survive a transaction-perfect delete (document
  the backup-expiry cycle honestly); past data collected under the false policy
  is a lawyer item; name the data controller.
- Rejected framing: privacy-as-personalization (export feeding recommendations)
  invents a new processing purpose with no lawful basis and fights data
  minimization. Discarded.

## Chosen approach (phased)

### Phase 0 — Stop the lie (ship first, own commit)
Correct every currently-false statement in `/privacy` and `/terms` to describe
what exists today, promising nothing new:
- Deletion right → "email info@lorewire.com; honored within 30 days" (both
  privacy §9 and terms §8).
- Cookies (§3, §7) → accurate enumeration of the first-party functional cookie
  families; keep the truthful "no tracking/ads/analytics" claim.
- Data collected (§2) → add reader-activity category + user-side sign-in
  providers (Google/Microsoft/Reddit, magic-link via Brevo) + the IP+UA
  rate-limit hash and the anonymous device identifier, described conservatively
  (no 24h-prune promise until the cron lands in Phase 3).
- Sharing (§5) → add Microsoft, Reddit, Brevo.
- Children (§10 / terms §2) → 16+ minimum, not directed at under-16s.
- Bump effective date to 2026-06-22.
- Preserve §6 (YouTube-review-required) verbatim-style and all Google/Meta/
  TikTok disclosures.

### Phase 1 — Personal-data registry (foundation)
A typed registry in `src/lib/` listing every personal-data table, its key
column(s) (`user_id` / `email` / `cookie_token`), and per-table delete + export
behavior (delete row vs. de-identify). Guard test fails the build if a schema
table holding a known identifier column is missing from the registry.

### Phase 2 — Self-serve DSAR (the real fix)
On `/auth/account`:
- **Export my data**: registry-driven read, returns JSON download + a readable
  on-page summary.
- **Delete my account**: registry-driven multi-table sweep in one transaction;
  de-identify `poll_votes` (null `user_id`) rather than delete to preserve
  aggregate integrity; delete `magic_link_tokens` by email. Re-auth gated
  (password OR fresh magic-link for passwordless users), typed confirmation,
  plain-language "this is permanent / here is exactly what is removed" copy,
  success confirmation screen, and a visible "contact a human about your data"
  link. Endpoint: POST only, origin-gated, rate-limited, scoped strictly to the
  session user, never accepts a `user_id` from the body.

### Phase 3 — Retention enforcement
Add Vercel crons: null `poll_votes.ip_ua_hash` older than 24h, prune expired
`magic_link_tokens`, cap `user_recently_viewed` at 50/user. Reduce `lw_anon` /
`lw_vote` TTL from 365d to 90d. Then tighten privacy §8 to match the now-enforced
windows.

### Phase 4 — Hardening
Proxy/store OAuth avatars instead of hot-linking; finish Meta data-deletion
token revocation (Phase 0 → 1); add logout-all / session rotation.

### Phase 5 — Paperwork (generated from the registry)
ROPA (Art. 30), lawful-basis register (per processing purpose), processor/DPA
tracker (link each vendor's DPA), short DPIA, consent versioning note. Plus a
**lawyer checklist**: sign Art. 28 DPAs, appoint Art. 27 EU representative,
Chapter V transfer mechanism (SCCs) for US processors, name the controller of
record, breach-notification process, review of data collected under the prior
(false) policy.

## Alternatives considered and rejected

- **Manual-email-only DSAR** (no self-serve): cheaper, legally sufficient, but
  fails the lazy-user bar, keeps the policy's settings-page promise false, and
  does not scale. Rejected per user decision.
- **Bundle the policy fix into the full build**: cleaner single change, but the
  policy keeps lying to live users for the duration of the build. Rejected per
  council + user decision (hotfix first).
- **Cascade-delete via real FKs**: the correct long-term shape, but a schema
  migration on a live shared SQLite/Postgres store (also written by the Python
  pipeline) is high-risk and out of scope for this pass. The typed registry +
  transaction sweep + guard test achieves equivalent safety without the
  migration. Revisit later.
- **Privacy-as-personalization** (export seeds recommendations): rejected — new
  processing purpose with no lawful basis, conflicts with data minimization.

## Security and safety (rule 13)

- Sensitive data: emails, password hashes, OAuth identifiers, IP+UA hashes,
  reading activity. Attack surface: the new export (data-exfil if identity is
  weakly verified) and delete (account-takeover → destruction).
- Controls: every DSAR endpoint POST-only, origin-gated, rate-limited, scoped to
  the authenticated session's own user id (never a body-supplied id), re-auth
  before destructive/exfil actions, fresh-magic-link path for passwordless
  users. Delete runs in a single transaction; idempotent by construction.
- Fail closed: a registry/guard-test failure blocks the build rather than
  silently shipping an incomplete sweep.
- We deliberately do not log exported payloads or deleted PII; we do log the
  fact of a DSAR request (timestamp, user id hash) as proof of fulfillment.
- Backups/logs/third parties: document honestly that erasure from live stores is
  immediate, while encrypted backups expire on their normal cycle and are not
  selectively restored.

## Open questions (for the lawyer / Yoav)

- Controller of record: is "Flexelent" the controller? Confirm legal entity +
  address (currently a TODO in the policy/terms files).
- EU establishment? If none, Art. 27 EU representative is required.
- Governing law in Terms is a TODO ("State of Israel"). Confirm.
- Which processors will sign Art. 28 DPAs / provide SCCs (Decodo and Kie.ai are
  the least certain).
