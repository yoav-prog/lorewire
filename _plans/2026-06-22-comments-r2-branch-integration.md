# Comments + R2 branch integration (incident-driven)

Date: 2026-06-22
Branch: feat/r2-media-migration (the production deploy branch)

## What happened (the incident)

Every image on production (hero + Continue Watching + all rails) 404'd. Videos
still played.

Root cause: a build from `feat/article-comments` was promoted to Production.
That branch forked at `ca65f82` (about 7 hours earlier), BEFORE the R2 media
work landed, so it has no `src/lib/media-url.ts` and no `resolveMediaUrl` call
in `homepage-data.ts`. The shared production DB stores `.webp` URLs (the WebP
compress backfill rewrote them), and those `.webp` objects live ONLY in R2. With
the R2 read code absent from the deployed build, the app served the stored
`.webp` paths straight from `storage.googleapis.com`, where no `.webp` exists.
Hence 404 on every backfilled image. `video_url` is never backfilled, so videos
kept working.

The `MEDIA_PUBLIC_BASE` env var IS set in the prod environment (the site served
correctly from `media.lorewire.com` before this deploy). The regression was the
CODE, not the env: the comments build can't use `MEDIA_PUBLIC_BASE` because the
resolver that reads it doesn't exist on that branch.

Verified live during triage:
- `media.lorewire.com/<id>/hero.webp` -> 200 image/webp (R2 healthy, populated).
- `storage.googleapis.com/<id>/hero.webp` -> 404 NoSuchKey; `.../hero.png` -> 200.
- Videos exist in BOTH R2 and GCS (200/200).

## Immediate recovery (user action, Vercel dashboard)

Instant Rollback / Promote the last good Production deployment: "Staff 2FA
(TOTP)" (`605b453`, from feat/r2-media-migration). Restores R2 serving in
seconds. (CLI rollback was not possible from this machine: the local
`VERCEL_TOKEN` resolves to the personal account, not the `lore-wire` team.)

## The fix shipped here

Goal: keep the comments feature AND restore the R2 code = one branch carrying
both. Merged `feat/article-comments` into `feat/r2-media-migration`.

Conflicts (all additive) resolved:
- `vercel.json` — kept both crons (prune_magic_links + comments/drain_moderation).
- `schema.ts` — kept both branches' tables (admin audit/invites/login-attempts +
  comments/comment_likes/comment_reports/comment_moderation_events) and indexes.
- `request-origin.ts` — both branches independently created the same same-origin
  CSRF gate under different names; unified to one implementation exporting both
  `isSameOrigin` and `isAllowedOrigin`.
- `AdminSidebar.test.ts` — kept both nav entries in the real merged order.

## Two latent issues the merge surfaced (and how they were fixed)

1. Ungated admin nav + page. The comments feature predates the capability RBAC,
   so its `/admin/comments` nav item had no `capability` and the page + actions
   used `requireAdmin()` (any staff). Gated all of it under `content.manage`
   (comments are content; consistent with Content/Homepage/Polls). Nav, page,
   and all four server actions now agree.

2. GDPR gap (rule 13). Comments tables were not in the personal-data export
   registry or the deletion path. A drift-guard test caught it.
   - Export: registered `comments` (author_user_id), `comment_likes` (user_id),
     `comment_reports` (reporter_user_id) in `EXPORT_SOURCES`, dropping nonces.
   - Deletion: added `comment_likes` to `USER_DATA_TABLES`; `comment_reports`
     deleted outright; authored `comments` de-identified (null the account link,
     guest name, and the cookie/rate-limit nonces; flip status to 'deleted' so
     they leave the public thread) rather than hard-deleted, mirroring the
     existing poll_votes anonymization. Added test coverage.

## Open decision (flagged to the user)

Comments-on-account-deletion policy: this change ANONYMIZES a deleted user's
authored comments (keeps the de-identified body out of the public thread). The
alternative is a hard DELETE (cleaner erasure, but orphans replies that point at
the comment by parent_id). Swappable in `deleteUserCompletely` if preferred.

## Verification

- No conflict markers remain.
- `tsc --noEmit`: clean for all touched files (3 pre-existing test-file type
  errors are untouched by this merge and predate it).
- `vitest run`: 1558 passed, 4 skipped, 0 failed (incl. 2 new erasure tests).
- `next build`: succeeds.

## Outstanding (not done here)

- Deploy is the user's action (no push/deploy was performed). Deploy Production
  from `feat/r2-media-migration` (NOT from any branch that forked before the R2
  work). The recurring failure mode is several long-lived branches each able to
  deploy to the same Production; converging to one deploy branch is the real
  prevention and is worth a separate pass once the fire is out.
