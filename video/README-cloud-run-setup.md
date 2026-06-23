# Cloud Run render service — deploy

The render service uses ADC: the GCS service account is attached as the
Cloud Run runtime identity (`--service-account`) and the GCS client
resolves credentials through the metadata server. **No PEM env vars on
the container.** Runtime env vars are `CRON_SECRET` + `GCS_BUCKET` only.

The deploy script still needs `GCS_CLIENT_EMAIL` + `GCS_PRIVATE_KEY` in
your local `.env.local` — that's how it authenticates the *gcloud
session running the deploy* (and identifies which SA to attach as the
runtime identity). The runtime container never sees the key.

## One-time per environment

```powershell
# 1. Enable the Cloud Run + Build APIs (once per GCP project).
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# 2. Load the same env vars your Vercel deployment uses. Easiest way
#    is to pull them from Vercel:
vercel env pull .env.production.local  # or paste them into your shell

# 3. Deploy. This builds the image in Cloud Build and ships it.
cd video
npm run deploy:cloud-run
```

gcloud prints the service URL when it's done. Copy it.

## Tell Vercel about the new URL

In Vercel project settings → Environment Variables, add:

| Key | Value |
|---|---|
| `CLOUD_RUN_RENDER_URL` | the URL from above (no trailing slash) |

That's it. The Vercel cron (`/api/render_video`) starts dispatching to
the new service on the next minute boundary.

## Smoke check

```powershell
$svc = gcloud run services describe lorewire-render --region $env:CLOUD_RUN_REGION --format "value(status.url)"
curl "$svc/healthz"
# → {"ok":true}
```

## Re-deploying after a code change

Anything under `video/` changed (composition, server, deps):

```powershell
cd video
npm run deploy:cloud-run
```

`gcloud run deploy --source .` rebuilds the image in Cloud Build and
swaps the running revision. Takes ~90s on cache-warm builds.

## Region

Default is `us-central1`. Override per shell:

```powershell
$env:CLOUD_RUN_REGION = "europe-west3"
npm run deploy:cloud-run
```

Match your GCS bucket region for free in-region egress.

## R2 cutover (post-2026-06-22 migration)

The render service writes to **GCS by default** and switches to R2 when the
`R2_MEDIA_WRITE_ENABLED` flag flips. Both writers use the same upload key
(`<storyId>/video.mp4`) so the Next reader's host rewriter resolves URLs from
either backend to the same delivery URL — but new content only lands on R2
once this flag is on. Plan:
`_plans/2026-06-23-pipeline-outbound-url-rewriter.md`.

Before flipping the flag, set the R2 env on Cloud Run (one-time):

```powershell
gcloud run services update lorewire-render `
  --region $env:CLOUD_RUN_REGION `
  --update-env-vars `
  R2_ACCOUNT_ID=$env:R2_ACCOUNT_ID,`
  R2_ACCESS_KEY_ID=$env:R2_ACCESS_KEY_ID,`
  R2_SECRET_ACCESS_KEY=$env:R2_SECRET_ACCESS_KEY,`
  R2_MEDIA_BUCKET=$env:R2_MEDIA_BUCKET,`
  MEDIA_PUBLIC_BASE=$env:MEDIA_PUBLIC_BASE
```

Then run the migration script one more time to catch any GCS objects written
between the original migration (2026-06-22) and the flip — the script is
idempotent (matching-size objects are skipped) so a re-run is safe:

```powershell
python -m pipeline.migrate_gcs_to_r2
```

Flip the flag on BOTH Vercel and Cloud Run together so the Node + Python +
Cloud Run writers cut over atomically:

```powershell
# Vercel (web app + pipeline drains)
vercel env add R2_MEDIA_WRITE_ENABLED production
# → enter: true

# Cloud Run
gcloud run services update lorewire-render `
  --region $env:CLOUD_RUN_REGION `
  --update-env-vars R2_MEDIA_WRITE_ENABLED=true
```

Render one short and confirm the persisted `video_url` is under
`MEDIA_PUBLIC_BASE` (not `storage.googleapis.com`) and the object resolves
through the Cloudflare edge.

To roll back, set `R2_MEDIA_WRITE_ENABLED=false` on both surfaces. GCS reads
still work because the Next reader passes legacy URLs through unchanged when
the rewriter is off, and the Python pipeline's `pipeline/media_url.py` does
the same.

## Killing it (revert path)

```powershell
gcloud run services delete lorewire-render --region $env:CLOUD_RUN_REGION
```

The Vercel cron starts returning errors (the URL is dead), the row
flips to `status='error'`, and the editor's local-worker path
(`python -m pipeline.render_worker`) still works as before.
