# Phase 3a deploy runbook (landscape OG poster)

Run this on a machine that is **provisioned for the Cloud Run deploy**:
gcloud installed + authed to the production GCP project, and a repo-root
`.env.local` carrying `GCS_CLIENT_EMAIL`, `CRON_SECRET`, `GCS_BUCKET`,
plus the R2 vars (see Stage 4). The original Phase 2 deploy machine is
the known-good one.

Do **not** run this on a box that only runs the app locally — it will be
missing the GCS deploy service-account creds and (critically)
`R2_MEDIA_WRITE_ENABLED`, and the render service will write posters to
GCS while production serves media from R2.

State as of writing:
- Branch `feat/phase-3-og-posters` at commit `5ca4691`, fully current
  with the production-source branch `feat/multi-platform-shorts-publisher`
  (0 commits behind).
- PR **#143** is OPEN, base `feat/multi-platform-shorts-publisher`,
  MERGEABLE. https://github.com/yoav-prog/lorewire/pull/143
- Local baseline verified: Phase 3 focused vitest 83/83, video server
  tests 76/76, full sweep 2290 passed / 1 failed / 4 skipped (the 1
  failure is the pre-existing `bulk-content-actions.test.ts` baseline,
  unrelated to this change).

The order is non-negotiable: **Cloud Run first, PR merge second,
backfill third.** If Vercel deploys the merge while Cloud Run is still
on the Phase 2 binary, every `aspect: "landscape"` POST 400s and page
metadata silently falls back to `hero_image`. Not a takedown, but a
known-degraded window.

---

## Stage 1 — sync to the exact commit

```bash
cd <repo root>            # the dir containing lorewire-app/ and video/
git fetch origin
git checkout feat/phase-3-og-posters
git log --oneline -1      # expect: 5ca4691 Phase 3a checkpoint: post-push state update
git status --short        # expect: clean
```

If `npm install` has never run on this machine for this branch, run it
in both `lorewire-app/` and `video/` (the video one is required — the
server tests and the deploy both need `aws4fetch`, which a stale
`node_modules` will be missing).

## Stage 2 — confirm toolchain + project

```bash
gcloud auth list                  # one ACTIVE account
gcloud config get-value project   # the lorewire production GCP project
```

Region note: the deploy wrapper uses `CLOUD_RUN_REGION` from `.env.local`
and defaults to `us-central1`. Use your real region in every gcloud
command below if it differs.

## Stage 3 — the R2 check (BEFORE deploying)

The render service writes posters to R2 only when ALL of
`R2_MEDIA_WRITE_ENABLED` (truthy) + R2 creds + `R2_MEDIA_BUCKET` +
`MEDIA_PUBLIC_BASE` are present on its env. Check what the live service
already has:

```bash
gcloud run services describe lorewire-render --region us-central1 \
  --format="value(spec.template.spec.containers[0].env)"
```

- `R2_MEDIA_WRITE_ENABLED` present + truthy (with `MEDIA_PUBLIC_BASE`,
  `R2_MEDIA_BUCKET`) → the live service is already R2-active. The
  redeploy preserves it; the wrapper uses `--update-env-vars` (merge,
  not replace).
- Absent → the deploy must SET it. That requires `R2_MEDIA_WRITE_ENABLED=true`
  plus the R2 creds in THIS machine's repo-root `.env.local`, so the
  wrapper forwards them. Confirm via Stage 4's stdout.

## Stage 4 — deploy, and watch the R2 line

```bash
cd video
npm run deploy:cloud-run
```

In the first few lines you MUST see:

```
[deploy:cloud-run] R2 env detected — forwarding R2_* + MEDIA_PUBLIC_BASE to the runtime
```

If you instead see:

```
[deploy:cloud-run] WARNING: partial R2 config (...) — skipping R2 env forward. The container will fall through to GCS.
```

then STOP, unless Stage 3 already showed R2 active on the live service.
The warning means this machine's `.env.local` is missing
`R2_MEDIA_WRITE_ENABLED`. Add `R2_MEDIA_WRITE_ENABLED=true` and re-run,
or posters write to GCS.

The wrapper's gate (in `video/scripts/deploy-cloud-run.mjs`) needs all
six of: `R2_MEDIA_WRITE_ENABLED`, `R2_ACCOUNT_ID` (or `R2_ENDPOINT`),
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_MEDIA_BUCKET`,
`MEDIA_PUBLIC_BASE`. The build runs from `--source .` and takes a few
minutes.

## Stage 5 — smoke-test the landscape render (Phase 3a-specific proof)

```bash
CR_URL=$(gcloud run services describe lorewire-render --region us-central1 --format="value(status.url)")
curl -sS -X POST "$CR_URL/render-poster" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId":"smoke-landscape-test",
    "hash":"a1b2c3d4e5f60718",
    "aspect":"landscape",
    "inputProps":{
      "scene_1_url":"https://media.lorewire.com/<a real existing scene image key>",
      "text":"Eight hundred dollars. Gone."
    }
  }'
```

PowerShell variants:
`$CR_URL = gcloud run services describe lorewire-render --region us-central1 --format="value(status.url)"`
and use `$env:CRON_SECRET` for the bearer.

Expect `200` + `{ url, elapsed_ms, hash }`. The returned `url` is the
whole test:

- `https://media.lorewire.com/...poster-landscape-...png` → R2 active.
  CORRECT.
- `https://storage.googleapis.com/...` → it went to GCS. The R2 forward
  did not take. Do NOT merge. Fix the env (Stage 4) and redeploy.

Open the returned URL in a browser; confirm a 1200x630 landscape PNG
renders. The `smoke-landscape-test` object is a throwaway; delete it
after if you like.

The smoke test mirrors exactly how the publisher calls the service
(same endpoint, same `Bearer CRON_SECRET`), so a green smoke test means
the publish-time path works.

If the smoke test or a real publish 403s right after deploy, check IAM —
the wrapper passes `--no-allow-unauthenticated`, and the dispatcher
authenticates only with `CRON_SECRET` at the app layer, so the service
must be publicly invocable at the platform layer:

```bash
gcloud run services get-iam-policy lorewire-render --region us-central1
# expect allUsers -> roles/run.invoker
```

## Stage 6 — merge the PR (Cloud Run must be live first)

Read this whole stage before running anything. Per
`lorewire-app/AGENTS.md`, the merge action itself is load-bearing.

```bash
gh pr checks 143        # confirm the Vercel preview built green
gh pr merge 143 --squash --delete-branch
```

PR #143 targets `feat/multi-platform-shorts-publisher` (the
production-source branch), NOT main. Merging it auto-deploys Vercel
production from the post-merge production-source state.

**Do NOT click "Promote to Production" / "Redeploy" / "Rebuild" on any
Vercel deployment in the UI.** The merge auto-deploys; manual promotion
bypasses the Production Branch tracking and has caused three takedowns
on this project. Once Vercel builds it, leave it alone.

Do NOT merge anything to `main` as part of this — main is 356 commits
behind production (the documented inverted state). Merging to main is a
production takedown.

## Stage 7 — one-shot backfill (spends money; go incremental)

After the Vercel deploy from the merge completes. Auth is an admin
session cookie (`requireCapability("content.manage")`), NOT CRON_SECRET.

```bash
# Dry-run first — candidate count, no spend.
curl -sS -X GET 'https://lorewire.com/api/admin/backfill_og_posters?dry=1&limit=500' \
  --cookie "<admin session cookie>"

# Real run — small batch first to confirm the pipeline end to end.
curl -sS -X POST 'https://lorewire.com/api/admin/backfill_og_posters?limit=5' \
  --cookie "<admin session cookie>"

# If the first 5 look right, run the backlog (route caps at 100/req).
curl -sS -X POST 'https://lorewire.com/api/admin/backfill_og_posters?limit=100' \
  --cookie "<admin session cookie>"
```

Each story = one Cloud Run render (compute cost) + one shared LLM call
(cached after first). The route returns counts + per-row outcomes. Tail
Vercel logs for `[backfill og-poster run]` and `[og poster ensure]`.

## Stage 8 — manual unfurl smoke

1. Open a backfilled story page, View Source, confirm:
   - `og:image` = `...poster-landscape-{hash}.png?v={hash}`
   - `og:image:width` = `1200`, `og:image:height` = `630`
   - `twitter:image` = the same poster URL
   - `twitter:card` = `summary_large_image`
2. Facebook Sharing Debugger (developers.facebook.com/tools/debug/) →
   confirm landscape renders → "Scrape Again" to flush.
3. LinkedIn Post Inspector (linkedin.com/post-inspector/).
4. Twitter Card Validator is deprecated — paste the URL into a draft
   tweet and confirm the unfurl preview. Do not post.
5. Share the URL to yourself on Discord / Slack / iMessage / WhatsApp.

## If something goes wrong

- Smoke-test URL is a `storage.googleapis.com` URL → R2 env did not
  forward. Fix `.env.local` (Stage 4), redeploy, re-smoke. Do not merge.
- Deploy 403s the dispatcher after merge → IAM (Stage 5 last block).
- A specific story renders a bad poster after backfill → set
  `og_poster_disabled: true` on that story's `short_config` (per-story
  kill switch); metadata falls back to `hero_image` without touching
  any global version.
- Need to undo the whole surface → the kill switch is the setting
  `og.short_poster.enabled` (`SETTING_OG_ENABLED` in
  `lorewire-app/src/lib/short-poster.ts`); turning it off stops new
  poster generation. Existing stamped URLs stay until cleared.
