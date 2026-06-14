# Cloud Run render service — one-time setup

Phase 1 of [_plans/2026-06-14-cloud-run-render.md](../_plans/2026-06-14-cloud-run-render.md).

This runbook walks the one-time setup for the LoreWire video render
service: a Cloud Run container that runs Remotion + headless Chromium,
exposes `POST /render`, and writes the finished MP4 to GCS.

Run this once per environment (probably just `prod` — local dev keeps
using `python -m pipeline.render_worker`).

---

## Prerequisites

- Google Cloud project with **billing enabled**. The same project that
  hosts your `GCS_BUCKET` is the natural choice (no cross-project IAM).
- `gcloud` CLI authenticated as a project owner / editor:
  ```
  gcloud auth login
  gcloud config set project <PROJECT_ID>
  ```
- `docker` installed locally (only needed if you want to build images
  yourself — `gcloud run deploy --source .` builds in Cloud Build for
  you).
- The repo's existing service account JSON — the same one already used
  for GCS uploads (`GCS_BUCKET`) and Google TTS. Cloud Run runs as a
  service account by default; we reuse the existing one rather than
  minting a fresh identity, so the GCS write permissions just work.

---

## 1. Enable the APIs

```
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com
```

Cloud Build is what `gcloud run deploy --source .` uses to build the
image. Artifact Registry holds the resulting container.

---

## 2. Pick a region

Pick the **same region** your Neon Postgres instance lives in. The plan
assumes `us-central1` (matches the existing Neon `c-4` zone). If yours
is elsewhere, set `CLOUD_RUN_REGION` in your shell and every `npm run
deploy:cloud-run` invocation reads it.

```
export CLOUD_RUN_REGION=us-central1
```

Region matters because Cloud Run → Neon round-trip latency dominates
the small writes (claim + upsert). Cross-region adds ~80-150 ms per
write; in-region is single-digit ms.

---

## 3. Stash the env vars Cloud Run needs

```
export CRON_SECRET="<same-secret-the-vercel-cron-uses>"
export DATABASE_URL="<your-neon-postgres-url>"
export GCS_BUCKET="<the-bucket-that-hosts-renders>"
```

`CRON_SECRET` MUST match the value in Vercel's env vars (`CRON_SECRET`
in your Vercel project settings) — that's the shared key Vercel uses
to call `/render` and the service uses to authenticate the inbound
request.

---

## 4. Deploy

From the repo root:

```
cd video
npm run deploy:cloud-run
```

`gcloud run deploy --source .` will:

1. Tarball `video/` (respecting `.dockerignore`).
2. Upload to Cloud Build.
3. Build the image per the multi-stage `Dockerfile`.
4. Push to Artifact Registry under the project.
5. Deploy as a Cloud Run service named `lorewire-render` in
   `$CLOUD_RUN_REGION` with 2 vCPU + 4 GiB + 60-min request timeout.
6. Print the URL.

The first build takes ~5-8 min (Chromium download + Remotion install).
Subsequent deploys are ~90s because Cloud Build caches the apt layer
and the npm cache layer.

The `--no-allow-unauthenticated` flag means the service is private —
even with the URL, no caller without `CRON_SECRET` can invoke it. The
Vercel cron dispatcher (Phase 4) is the only caller.

---

## 5. Smoke the scaffold

Grab the URL printed by the deploy and curl `/healthz`:

```
curl https://<your-service-url>/healthz
# → {"ok":true}
```

Hit `/render` with the secret to confirm auth + JSON parsing work:

```
curl -X POST https://<your-service-url>/render \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"storyId":"smoke","configHash":"deadbeef","inputProps":{}}'
# → {"accepted":true,"scaffold":true,"story_id":"smoke"}
```

A 401 means the secret didn't make it through. Check both `CRON_SECRET`
in your local shell and the value Cloud Run was deployed with
(`gcloud run services describe lorewire-render --region $CLOUD_RUN_REGION`).

---

## 6. Tell Vercel where the service lives

In the Vercel project settings, add:

- `CLOUD_RUN_RENDER_URL` = the URL from step 4 (no trailing slash).

The Phase 4 dispatcher (`lorewire-app/api/dispatch_video_render.ts`)
reads this env var to know where to POST. Until Phase 4 ships this is
just a documented placeholder — nothing reads it yet.

---

## Updating after Phase 3 / Phase 4 ship

Whenever the composition or server changes:

```
cd video
npm run deploy:cloud-run
```

That's the whole loop. The Vercel cron picks up the next render from
the queue on its next firing (~1 min later) and dispatches to the
freshly-deployed URL.

---

## Cost

Per the plan: ~$0.003 per render at current scale. Free tier covers
LoreWire's monthly volume by a wide margin. Verify on each deploy via:

```
gcloud billing accounts list
# pick the one tied to this project, then:
gcloud billing budgets list --billing-account=<ID>
```

Set a $5/month budget alert as a paranoid backstop.

---

## Killing the service (revert path)

If anything goes sideways and you need the local worker to be the only
render path:

```
gcloud run services delete lorewire-render --region $CLOUD_RUN_REGION
```

The Vercel cron dispatcher will start returning 5xx (or refusing to
dispatch when `CLOUD_RUN_RENDER_URL` is unset); the editor's Render
button falls back to the existing video_renders queue + local worker
flow, which never went away.
