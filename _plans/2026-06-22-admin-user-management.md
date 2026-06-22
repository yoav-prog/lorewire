# Admin User Management — RBAC, moderation, audit, invites

Date: 2026-06-22
Branch: `feat/gdpr-compliance` (consider a dedicated `feat/admin-users` branch before Phase 2)
Status: Approved. Phase 0 in progress.

## Goal

Give the admin full, robust, intuitive control over every account in the system:
the public people who sign up (Google / Microsoft / Facebook / Reddit / magic-link /
email) and the internal staff who run the studio. One Users area with named roles,
moderation actions, email invites, an audit trail, hard safety guardrails, and a
fast search + filter on every list.

This was scoped with the user (decided answers below) and the architecture was
pressure-tested through the LLM Council before approval. The council's findings are
folded into the design (see "Security & council findings").

## Decided scope (from the user)

1. **RBAC with named roles** — Admin, Editor, Moderator, Viewer. Admin pages gate by
   *capability*, not all-or-nothing.
2. **Actions on public users** — view profile + activity, suspend / ban (reversible),
   delete (GDPR wipe), impersonate / view-as.
3. **Staff onboarding** — email invite link (invitee sets own password, one-time
   expiring token).
4. **Guardrails** — protect the last admin, searchable audit log of all admin actions,
   re-auth (password) for sensitive actions, email the user on suspend / delete.
5. **Search + filter** — fast, debounced, server-side search plus filters on every
   relevant list (Members, Team, Audit log, per-user activity).
6. **Data model** — keep the single shared `users` table with hard guards (chosen over
   splitting staff into its own table).

## Hard constraints (the existing system we must fit)

- **Auth is stateless JWT** in two HttpOnly cookies: `lw_session` (admin staff; payload
  `{userId,email,role}`, HS256, 7-day, password-only login at `/admin/login`) and
  `lw_user` (public users; `role` hard-locked to `"user"`). `src/lib/session.ts`,
  `src/lib/user-session.ts`.
- **Authorization re-reads the DB each request.** `requireAdmin()` / `currentUser()` in
  `src/lib/dal.ts` verify the cookie then re-read the user row and check
  `user.role === "admin"`. This is load-bearing: it means a role/status change in the DB
  takes effect on the *next request* without a session store. The capability checks must
  use the **DB row's** role, never the cookie's (the cookie can be stale).
- **One `users` table** holds staff (`password_hash` set, `provider` NULL) and public
  users (`provider` set, `password_hash` NULL). `role` is a free-text column, today only
  `"admin"` / `"user"`. Two `UserRow` shapes exist: slim 5-column in `src/lib/repo.ts`
  (admin path), rich full-row in `src/lib/users.ts` (public path) — reconcile in the
  management layer.
- **DB is a custom dual-driver layer** (Postgres prod / SQLite local) with **NO foreign
  keys**; additive migrations run on boot (`CREATE TABLE IF NOT EXISTS` + `ALTER ADD
  COLUMN` in `src/lib/db.ts` / `src/lib/schema.ts`). Helpers: `all` / `one` / `run`.
- **Next.js 16.2.9** — `AGENTS.md` warns this has breaking changes vs training data.
  Read `node_modules/next/dist/docs/` + Context7 before writing any cookie / JWT /
  server-action code (Phases 5-7 especially). `cookies()` is async.
- **Reusable infra**: `magic_link_tokens` table + email sending (for invites), and
  `deleteUserCompletely(userId)` GDPR cascade in `src/lib/account-deletion.ts`.
- **UI**: Tailwind v4 custom tokens, hand-built components, server actions +
  `revalidatePath`, RSC data loading. Patterns to match: `SettingsShell`, `AdminSidebar`,
  `FieldRow`, `Toggle`, `ChipGroup`, `UserMenu`, the voiceovers pages. Test runner:
  **vitest**.

## Chosen approach (architecture)

### RBAC — capabilities in code, roles as bundles
- `src/lib/authz.ts`: a `CAPABILITIES` constant, a `ROLE_CAPABILITIES` map (Admin = all,
  Editor = content + settings + users.view, Moderator = users.view + users.moderate +
  audit.view, Viewer = users.view + audit.view), and `hasCapability(role, cap)` /
  `capabilitiesFor(role)` / `isStaffRole(role)`. Pure, no DB, no library, unit-tested.
- Keep the single `role` column; validate writes against `STAFF_ROLES` at the boundary.
- `dal.ts` gains `requireCapability(cap)` and `requireStaff()` alongside the existing
  `requireAdmin()`. Pages and server actions gate by capability.
- **Rejected: DB roles / role_permissions tables.** In a no-FK, dual-driver,
  boot-migration schema that means hand-rolling referential integrity and writing every
  migration twice — the scope-creep trap the council flagged. Code-defined bundles give
  the same named roles with none of that cost.
- **Rejected: granular per-user permission toggles.** Over-engineering at this team
  scale; harder to use, easy to misconfigure.

### Suspend / ban — enforced at the DB-read layer
- Add `status` (`active` | `suspended`), `suspended_at`, `suspended_reason` columns to
  `users` (additive ALTER).
- Enforce in the central read paths so a suspended user is locked out on their next
  request (no denylist needed — the per-request DB re-read IS the revocation mechanism):
  `requireAdmin()` / `requireCapability()` / `currentUser()` reject non-active staff.
- **Must-verify (council blind spot #1):** confirm the public path actually hits the DB.
  `readUserSession()` only verifies the JWT today. Add a status check to the public
  current-user resolution so a suspended/banned public user is logged out next request,
  not after 7 days. If a page reads only the JWT, route it through a DB-checking helper.
- On suspend/delete, also best-effort clear the target's session cookie where reachable;
  the DB re-read is the real guarantee across devices.

### Impersonation — separate cookie, actor-gated, time-boxed (build LAST)
- Admin's `lw_session` stays intact. Mint a separate short-lived (15-30 min) signed
  cookie `lw_impersonate` carrying `{actorId, targetUserId, exp}`.
- The public current-user resolution, when `lw_impersonate` is present AND the actor
  still holds `users.impersonate` (re-checked from DB), resolves the effective user as
  the target but exposes `impersonatedBy = actorId`.
- **Every sensitive / admin action gates on the ACTOR (`lw_session`), never the
  impersonated effective user** — otherwise impersonation is privilege laundering
  (council's top finding). View-as is read-only by default; writes-as-target are blocked
  or heavily gated.
- Loud persistent banner the entire time ("Viewing as X — Exit"). Hard time-box. Clean
  "Exit" that deletes the cookie. Start/stop and any action logged with `actorId`.
- **Cannot impersonate another staff/admin.** Cannot impersonate while the actor is
  suspended. Token self-expires (interrupted impersonation falls back cleanly).
- Relabel in UI to **"View as (support)"** — the council's Outsider flagged "impersonate"
  reads as a privacy violation.

### Step-up re-auth — honest about state
- Password is re-entered **inside the confirm dialog** for destructive actions (delete,
  role change, impersonate start). The simplest correct form; no fake "stateless" token.
- The primary mis-click protection is the dialog **naming the person** ("Delete Yoav,
  info@flexelent.com — wipes all their data, cannot be undone") and requiring the admin
  to type the target's email (or `DELETE`) for hard actions. Password is the second
  factor of intent; it alone does not stop muscle memory (council Outsider).
- Optional later: a 5-minute signed elevation cookie to avoid re-typing during a batch —
  acknowledged as a second short session, not "stateless." Deferred unless the UX needs it.

### Audit log — the spine (build EARLY)
- New append-only table `admin_audit_log`: `id, actor_id, actor_label, action,
  target_type, target_id, target_label, metadata (JSON), ip_hash, created_at`.
- **PII-free:** store hashed/truncated email labels via the existing `hashForLog` SHA-256
  pattern, plus a self-contained snapshot label so the row survives target deletion with
  zero dangling-PII leak (council finding #3 / orphan-row concern). The row references
  nothing by FK; a deleted `target_id` carries no PII.
- Generic `target_type` / `target_id` (the one cheap future-proofing hook worth taking —
  any future entity becomes auditable). No speculative analytics/event-stream scope.
- One `audit(actorId, action, {targetType,targetId,...meta})` writer that every sensitive
  action calls. **No update/delete server actions on audit rows** — append-only by
  construction is the tamper-resistance at this scale.
- Searchable + filterable (actor, action, target, date range).

### Email invites — dedicated table, server-bound role
- New `staff_invites` table: `id, email, role, token_hash, invited_by, expires_at (~72h),
  accepted_at, revoked_at`. Single-use.
- The role is **bound server-side in the invite** and never taken from the client at
  accept time — a leaked token can only grant the role the inviter chose. Acceptance
  requires setting a password; creates the staff row with the bound role.
- Separate from `magic_link_tokens` on purpose: invites carry an intended *role* and are
  staff-scoped; conflating them risks privilege confusion.
- Reuse the existing email sender.

### Guardrails (council blind spots #2, #5)
- **Last-admin protection** enforced *inside the write* (re-count holders of the
  highest privilege in the same statement / immediately re-verify), not as a pre-check —
  closes the concurrent-admin race. Reflected in UI (disabled button + tooltip).
- **No self-lockout:** cannot demote yourself below the last admin, cannot delete
  yourself, cannot impersonate yourself.
- **Admins are targets too** (they live in the same table): admin-on-admin suspend /
  delete / role-change all run through the same guards; cannot impersonate staff.
- **Rate-limiting** on `/admin/login` and sensitive actions (brute-force defense).

### UX (lazy-user)
- One **Users** area, three clear tabs: **Team** (staff, roles, invites), **Members**
  (public sign-ups), **Audit log**.
- Instant debounced server-side search + filters (role, status, provider, joined date)
  on every list; `/` focuses search (matches existing GlobalSearch convention).
- Click a person → detail panel: profile, provider(s), join / last-seen, status, their
  activity (saves / likes / history), role control, per-user actions with plain-language
  explainers ("Suspend blocks sign-in but keeps their data. Reversible.").
- Destructive actions: named confirm + typed confirmation + password. Suspend is clearly
  labeled reversible. Role change and (carefully) email change are first-class actions —
  the council's Outsider noted these ordinary tasks were missing from the original ask.
- Email change is risky (email is the identity anchor); deferred to a careful verified
  flow or left out of v1. Flagged as open question.

## Phasing (build order)

- **Phase 0 — Capability foundation (no migration).** `src/lib/authz.ts` +
  `requireCapability` / `requireStaff` in `dal.ts` + unit tests. Behavior-preserving:
  existing admins hold every capability. *(in progress)*
- **Phase 1 — Audit log.** `admin_audit_log` table + `audit()` writer + read/search/
  filter helpers. Built before any mutation so everything writes through it.
- **Phase 2 — Members list (read-only) + search/filter + per-user detail/activity.**
  Ship value early; add the capability-gated Users nav. Reconcile the two UserRow shapes.
- **Phase 3 — Suspend / ban.** `status` columns + enforcement in read paths (incl. the
  public-path verification) + suspend email + last-admin / self guards.
- **Phase 4 — GDPR delete.** Wrap `deleteUserCompletely` + named/typed confirm + audit +
  delete email.
- **Phase 5 — Team management.** Role change, email invites (`staff_invites` + accept
  flow). Migrate existing admin pages from `requireAdmin()` to `requireCapability(...)`
  and switch the panel layout from admin-only to any-staff so Editor/Moderator/Viewer
  can actually sign in.
- **Phase 6 — Step-up re-auth** for destructive actions.
- **Phase 7 — Impersonation** (riskiest, last): `lw_impersonate` cookie, actor-gated,
  banner, time-box, full audit.
- **Phase 8 (fast-follow, optional)** — login + action rate-limiting, optional TOTP MFA
  for staff (council universal miss: harden the admin accounts themselves).

## Security & council findings (rule 13)

- **Sensitive data:** credentials (`password_hash`), session secrets, user PII (emails,
  OAuth subs, activity). Audit log stores **hashes/labels only**, never raw PII or
  secrets (continues the `hashForLog` pattern).
- **Attack surface:** admin login (brute force), invite tokens (leak / replay →
  single-use, hashed, server-bound role, short expiry), impersonation (privilege
  laundering → actor-gated + audited + time-boxed), role escalation (validate role writes
  against `STAFF_ROLES`; never trust client-supplied role).
- **AuthZ:** capability checks on every page and every server action, read from the DB
  role, fail closed (redirect / 403 on any doubt).
- **Revocation:** suspend / ban / delete take effect next request via the DB re-read —
  but only if every protected path performs that read (Phase 3 must-verify on the public
  path).
- **Fail-safe:** last-admin and self-lockout guards enforced inside the write; cannot
  delete the final admin; cannot lock yourself out.
- **Logging:** every sensitive action writes an append-only audit row (actor, action,
  target, time, ip_hash). Never log credentials or raw PII.
- **Council's highest-risk pieces:** impersonation and step-up re-auth — built last,
  deliberately, with the constraints above.

## Cost (rule 8)

Zero new paid services. Reuses the existing DB (Postgres/SQLite) and the existing email
sender (magic-link infra). No third-party RBAC/identity vendor. Optional Phase 8 TOTP MFA
uses a free standard (`otplib`-style TOTP); no recurring cost.

## Alternatives rejected

- **Split staff into its own table** — cleaner domain separation, but a large migration
  touching every auth path with no FK support to lean on; little near-term gain. Chose
  one table + guards.
- **DB-stored RBAC (roles/permissions tables)** — referential integrity by hand in a
  no-FK dual-driver schema; rejected for code-defined capability bundles.
- **Granular per-user permissions** — over-engineered for the team size.
- **Stateful step-up token presented as "stateless"** — dishonest and adds a second
  session to revoke; rejected for per-action password re-entry.

## Open questions

1. Admin-initiated **email change** for a user — include in v1 (with a verified flow) or
   defer? Currently leaning defer (email is the identity anchor).
2. **MFA for staff** — Phase 8 nice-to-have or a launch requirement? Leaning fast-follow.
3. Should **Moderator** see the full audit log or only their own actions? Currently grants
   `audit.view` (full, read-only); confirm.
4. Notification email **copy/tone** for suspend/delete — needs wording sign-off.

## Verification rule reminders

- Consult Context7 + the bundled Next 16 docs before writing cookie / JWT / server-action
  code (Phases 5-7).
- QA each phase: golden path, edge cases (suspended-then-acts, last-admin race,
  expired/leaked invite, impersonation exit, deleted-user audit row), error paths, and
  adjacent regressions (existing `requireAdmin` callers).
