# Backups and security hardening

Date: 2026-07-05
Status: approved ("go"), phase 1 in progress
Branch: chore/backups-and-security-hardening

## Goals

Close the two gaps found in the 2026-07-05 infrastructure audit:

1. **No backups anywhere.** The Neon Postgres DB (53 tables, all content,
   users, render state) has no dump, no documented restore path, and we do
   not know which Neon plan tier (and therefore which instant-restore
   window) production runs on. Media buckets (GCS `aporia-unleash`, R2
   `lorewire-*-prod`) have no versioning and no second copy.
2. **Thin hardening layer.** Production serves only the HSTS header Vercel
   adds automatically. No dependency scanning. Staff MFA exists but is
   opt-in. No rate limiting on public write endpoints.

What the audit confirmed is fine (no work needed): secrets are NOT in git
(only `.env.example` ever committed - verified across full history),
capability-based authz with per-request DB recheck, `CRON_SECRET` on all
cron routes, Zod at boundaries, fully parameterized SQL, a standing secret
rotation runbook (`_plans/2026-06-11-secret-rotation.md`, next pass due
around 2026-09-11).

## Constraints

- Keep recurring cost at effectively zero: GitHub Actions free tier
  (2,000 min/month private repo) and R2 free tier (10 GB) cover the
  backup pipeline. The only real cost lever is the Neon plan tier.
- No new SaaS dependencies (build it, don't rent it).
- Production deploys from `main` via Vercel; nothing here may touch
  `main` directly. PR flow only.

## Chosen approach (phase 1, this branch)

### 1. Nightly logical DB backup to R2

- New private R2 bucket `lorewire-backups` (created via Cloudflare API,
  no public access).
- GitHub Actions workflow `.github/workflows/db-backup.yml`:
  - cron 03:30 UTC nightly + `workflow_dispatch` for manual runs.
  - `pg_dump -Fc` with the PostgreSQL 17 client (server is 17.10; client
    major must be >= server major) over the UNPOOLED Neon connection
    (pg_dump is not reliable through the transaction-mode pooler).
  - Integrity gate before upload: `pg_restore --list` must succeed and
    the dump must be at least 256 KB, otherwise the job fails loudly.
  - Upload to `daily/lorewire-YYYY-MM-DD.dump`; on the 1st of the month
    also to `monthly/`.
- R2 lifecycle rules: `daily/` objects deleted after 35 days, `monthly/`
  after 400 days, incomplete multipart uploads aborted after 7 days.
  Worst case ~35 dumps + 13 monthlies retained.
- GitHub emails the repo owner on workflow failure by default; the run
  log prints dump size and archive entry count for every run.

### 2. Security headers (all routes)

`next.config.ts` gains a `/:path*` header block:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN` (the only iframe in the app embeds
  external providers; nothing frames lorewire cross-origin)
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

HSTS stays with Vercel (already served, max-age 2 years). A full CSP is
deliberately deferred - it needs an inline-script/nonce audit and is a
project of its own.

### 3. Dependency scanning

- `.github/dependabot.yml`: weekly npm (lorewire-app, minor+patch
  grouped), pip (pipeline), and github-actions update PRs.
- Dependabot vulnerability alerts enabled on the repo via API.

## Phase 2 (documented, not in this branch)

- **Enforce MFA for the admin role** (currently opt-in TOTP). Real auth
  flow change: gate session issuance or admin capabilities on enrollment.
- **Rate limiting on public write endpoints** (comments, polls,
  submissions). Needs a design pass: no Redis/KV exists; options are a
  DB-backed counter or Vercel WAF rules (pricing check required first).
- **Media bucket second copy**: weekly `rclone sync` of R2 media +
  usercontent buckets, and GCS object versioning with a 30-day noncurrent
  lifecycle on `aporia-unleash`. R2 still has no native versioning
  (verified July 2026; "on the roadmap").
- **Restore drill**: restore a nightly dump into a scratch Neon branch
  and boot the app against it. A backup is not real until this passes.
- **Verify the Neon plan tier** in the Neon/Vercel console. Launch =
  7-day instant restore ($0.35/GB-mo storage + $0.20/GB-mo history),
  Scale = 30-day. Free = 6 hours only.

## Alternatives rejected

- **Neon instant restore alone**: protects against bad migrations, not
  against account/billing/provider loss; window depends on plan tier we
  have not verified. Kept as a layer, not the answer.
- **pg_dump alone**: up to 24h data loss and no fast point-in-time undo.
- **Storing dumps as GitHub Actions artifacts**: 500 MB cap and 90-day
  expiry make it a toy; R2 is effectively free at this size.
- **Client-side encryption of dumps**: adds a key-management failure mode
  (lose the key = lose every backup) for marginal gain; R2 is private,
  encrypted at rest, and access needs scoped keys. Revisit if compliance
  requires it.
- **DENY for X-Frame-Options**: SAMEORIGIN chosen so any future
  self-framing (admin previews) does not break; equal protection against
  cross-origin clickjacking.

## Security

- New attack surface: the `lorewire-backups` bucket now holds full DB
  dumps including user emails and password hashes. Mitigations: bucket is
  private (no public access binding), credentials live only in GitHub
  Actions secrets, lifecycle rules bound retention.
- The backup workflow gets a DB credential. It is the unpooled read path;
  scoped-down Postgres roles are not available per-URL on Neon's Vercel
  integration, so the secret is the full connection string - GitHub
  Actions secrets are write-only and masked in logs.
- No secrets in the workflow file itself; everything via
  `secrets.*` references.

## Observability

- Workflow logs: dump byte size, `pg_restore --list` entry count, upload
  target keys, per-step failures. Failure notifications via GitHub's
  built-in workflow-failure email.
- Headers are observable directly: `curl -sI https://lorewire.com/`.

## Testing

- `tests/next-config.test.ts` (vitest): asserts the four security headers
  on the catch-all route and that the existing `sw.js` /
  `manifest.webmanifest` cache headers survived the edit.
- The workflow itself is external I/O (Actions runner + Neon + R2) and
  not unit-testable; it is validated by a manual `workflow_dispatch` run
  after merge, checking the run log and the object landing in R2.
- Full `npm test` suite must be green before commit.

## Settings audit

No user-facing settings. Backup schedule/retention are operator concerns
and live in the workflow file + lifecycle rules, not the admin UI.
Intentionally not exposed: users cannot influence backup cadence.

## Deploy

- This branch -> PR -> `main` -> Vercel auto-deploy. The header change is
  the only part that ships to production; backup workflow and dependabot
  activate on merge to the default branch (Actions schedules run from
  `main`).
- Rollback: revert the PR; headers revert on next deploy. The R2 bucket
  and GitHub secrets are inert without the workflow.
- Per the standing rule: no push without explicit approval; never touch
  `main` directly.

## Open questions

- Which Neon plan tier is production on? (Determines instant-restore
  window; user checks console.)
- Do the existing R2 API credentials have account-wide object write (can
  reuse for the backups bucket) or are they scoped to the media buckets
  (need a new scoped token)? Resolved during implementation by testing an
  upload.
