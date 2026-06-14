# Production video rendering via Google Cloud Run

**Status:** Phase 1 starting 2026-06-14
**Owner:** Yoav (info@flexelent.com)
**Date:** 2026-06-14
**Trigger:** video_renders queue rows sit in `status='queued'` forever in prod because Remotion needs Node + headless Chrome, which Vercel's Python and Node runtimes can't host. User pivot from AWS Lambda to Cloud Run because the codebase already has GCS + Google service-account auth + Google TTS wired.

## Goals

- Admin clicks **Render** in the editor; the video MP4 lands in `stories.video_url` (GCS) within ~1–5 minutes without any local worker running.
- Existing `pipeline/render_worker.py` keeps working in local dev — only the prod path changes.
- One cloud provider (Google). No AWS account, no IAM mapping, no S3 → GCS round-trip.
- One cron (dispatcher). No separate drain.

## Non-goals

- Replacing Remotion (it stays — only the *host* changes).
- Streaming progress to the editor UI (can be a Phase 6 follow-up if needed).
- Auto-scaling beyond Cloud Run's defaults (max 100 instances is plenty for current volume).

## Chosen path (locked from user pick + Vercel Pro confirmation)

**Cloud Run as a stateless render service + Vercel Pro cron as the orchestrator.** Cloud Run hosts a Node service that exposes `POST /render`. The service renders + uploads to GCS + **returns the URL synchronously**. The Vercel Pro cron (800s timeout) waits for the response and writes the final URL back to Postgres.

**Why this is simpler than the original Cloud Run idea:**
- Cloud Run is fully stateless. No Postgres connection, no auth juggling, no schema knowledge. Pure compute service.
- Vercel owns all DB writes. Single source of truth for video_renders status transitions.
- No "two writers, two sources of truth" coordination needed.

## Architecture

```
Editor "Render" click
        │
        ▼
INSERT into video_renders (existing flow, unchanged)
        │
        ▼  (Vercel Pro cron every 1 min, up to 800s per invocation)
/api/render_video.ts
        │   1. Atomic claim: UPDATE video_renders SET status='rendering'
        │      WHERE id = (SELECT id ... ORDER BY requested_at LIMIT 1
        │                  FOR UPDATE SKIP LOCKED) AND status = 'queued'
        │   2. Build inputProps from story.video_config
        │   3. POST {compositionId, inputProps} to Cloud Run URL
        │      (synchronous, awaits up to ~780s — 20s headroom under
        │       Vercel Pro's 800s cron ceiling)
        │   4. Cloud Run returns { url: "https://storage.googleapis.com/..." }
        │   5. UPDATE video_renders SET status='done', output_url=...
        │   6. UPDATE stories SET video_url=..., updated_at=NOW()
        ▼
Editor reloads → stories.video_url is fresh
```

**Why this is simpler than the original Cloud Run idea (Cloud Run owns DB):**
- One cron, one service, one writer.
- Cloud Run image doesn't need Postgres drivers, the DATABASE_URL, or auth complexity.
- Local dev path (`pipeline/render_worker.py`) and prod path (Cloud Run) share NO state beyond GCS — fewer drift risks.

**Why this is simpler than Lambda:**
- One cloud provider. The service account that uploads to GCS today is the same one Cloud Run uses.
- No S3 intermediate. MP4 lands in GCS directly.
- Cloud Run renders complete inside one cron invocation (Vercel Pro's 800s window) — no kick/drain split needed.

## Cost (rule 8 — re-verify before merging Phase 4)

- Cloud Run: ~$0.000024/vCPU-second × 2 vCPU × 60s = ~$0.003 per render.
- Cloud Run egress to GCS in the same project: **free**.
- Cloud Run free tier: 2 million requests + 360,000 vCPU-seconds/month. LoreWire's current volume is bill-free.
- Container Registry / Artifact Registry storage: ~$0.01/month for the image.
- **Total: ~$0.003 per render, ~free at current scale.**

## Phases

Each phase independently mergeable. Worst-case revert: kill the Cloud Run service; local worker keeps working.

### Phase 1 — Cloud Run service scaffold + Dockerfile

- `video/Dockerfile`: `node:22-slim` base + `chromium` + Remotion deps + composition source. Multi-stage build keeps the image lean (~500 MB).
- `video/server.ts`: tiny Express handler. POST /render takes `{ compositionId, inputProps }`, validates auth, renders to `/tmp/<uuid>.mp4`, uploads to GCS, returns `{ url }`. Stateless — no DB connection.
- `video/package.json`: add `express`, `@remotion/renderer`, `@google-cloud/storage`. Add npm scripts: `build:image`, `deploy:cloud-run`, `dev:server`.
- `video/README-cloud-run-setup.md`: one-time setup runbook (enable Cloud Run + Artifact Registry, push image, deploy service, set env vars).
- No app code yet. No schema changes (Cloud Run is stateless — no new columns needed). No tests yet (Phase 3 adds them with the orchestrator).

### Phase 2 — Vercel cron orchestrator endpoint

- `lorewire-app/api/render_video.ts`: Vercel Node runtime cron, every 1 min, Vercel Pro 800s timeout.
- CRON_SECRET Bearer auth on the incoming cron call.
- Pseudocode:
  1. Atomic claim of the oldest queued row.
  2. Build inputProps from the row's story.video_config (mirror what `pipeline/video.py:generate_video` builds today).
  3. POST `{ compositionId, inputProps }` to `process.env.CLOUD_RUN_RENDER_URL` with `Authorization: Bearer <CLOUD_RUN_SECRET>`, await up to ~780s.
  4. On success: write the returned URL into video_renders + stories.
  5. On Cloud Run error: write the message into video_renders.error.
- Tests: stub fetch to Cloud Run, verify the claim → POST → DB-write orchestration. Auth path, error path, timeout path.

### Phase 3 — vercel.json cron + end-to-end smoke + plan finalization

- Add `/api/render_video` to `lorewire-app/vercel.json` crons (`*/1 * * * *`, maxDuration 800).
- Manual smoke: enqueue an envelope render, watch the Vercel + Cloud Run logs, confirm the MP4 lands in GCS and the row flips to 'done' within ~5 minutes.
- Mark plan shipped.

## Security (rule 13)

- `CRON_SECRET` shared between Vercel cron + Cloud Run service — same secret already used by other drains.
- Cloud Run service requires the secret on every POST. No public access.
- Service account permissions: GCS bucket write + Cloud SQL / Neon read+write only. No project-wide IAM.
- DATABASE_URL passed via Cloud Run's encrypted env vars; never logged.

## Observability (rule 14)

Namespaces:
- `[dispatch_video_render]` — Vercel cron dispatching logs.
- `[cloud-run render claim]` — Cloud Run claim attempt logs.
- `[cloud-run render done]` — successful render + GCS upload.
- `[cloud-run render error]` — failure with the exception class + first 200 chars.

## Settings (rule 15)

- `video.cloud_run_dispatch_cap_per_tick` (default 3) — max rows dispatched per cron firing.

## Testing (rule 18)

- Python: 3 tests for `try_claim_render` (happy + race-loss + bad id).
- TS: stubbed-orchestration tests for both `/render` (Cloud Run) and `/api/dispatch_video_render` (Vercel).
- One manual smoke test before marking Phase 5 shipped.

## What the admin does NOT have to do after Phase 5

- Run a local worker for prod renders. Local dev keeps the `python -m pipeline.render_worker` flow.
- Manage S3 → GCS transfers (Cloud Run writes directly to GCS).
- Watch for stuck queue rows (Cloud Run owns the lifecycle).

## Open questions for setup

- Which Google Cloud project? Probably the same one that hosts `GCS_BUCKET`.
- Memory + CPU sizing: starting at 2 vCPU + 4 GB RAM. Adjust after the first real render.
