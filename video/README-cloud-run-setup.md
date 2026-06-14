# Cloud Run render service — deploy

The render service reuses the **same GCS credentials your Vercel
deployment already has** (`GCS_BUCKET`, `GCS_CLIENT_EMAIL`,
`GCS_PRIVATE_KEY`, `CRON_SECRET`). No separate IAM role, no service
account juggling.

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

## Killing it (revert path)

```powershell
gcloud run services delete lorewire-render --region $env:CLOUD_RUN_REGION
```

The Vercel cron starts returning errors (the URL is dead), the row
flips to `status='error'`, and the editor's local-worker path
(`python -m pipeline.render_worker`) still works as before.
