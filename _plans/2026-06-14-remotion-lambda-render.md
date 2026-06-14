# Production video rendering via Remotion Lambda

**Status:** Phase 1 starting 2026-06-14
**Owner:** Yoav (info@flexelent.com)
**Date:** 2026-06-14
**Trigger:** video_renders queue rows sit in `status='queued'` forever in prod because Remotion needs Node + headless Chrome, which Vercel's Python and Node runtimes can't host. User asked for "a real fix for production, not a quick workaround."

## Goals

- Admin clicks **Render** in the editor; the video MP4 lands in `stories.video_url` (GCS) within ~1–5 minutes without any local worker running.
- Existing `pipeline/render_worker.py` keeps working in local dev — only the prod path changes.
- Pay-per-use (no idle infra bill) and scales to multiple concurrent renders.
- Same observability + auth pattern as the other drains (CRON_SECRET, `[drain_video_renders <event>]` logs).

## Non-goals

- Replacing the renderer (Remotion stays — only the *host* changes).
- Multi-region. One AWS region (us-east-1) — Remotion's `serveUrl` must be in the same region as the Lambda function, so going multi-region multiplies S3 buckets.
- Real-time progress in the editor UI. Render status flips queued → processing → done via existing column writes; polling can be a Phase 6 follow-up.

## Chosen path (locked from user pick)

**Option A — Remotion Lambda.** Official Remotion serverless renderer. `renderMediaOnLambda()` kicks off a render; `getRenderProgress()` polls until `done=true`; the output MP4 lands in an S3 bucket whose URL we read and copy to GCS so `stories.video_url` stays canonically on our infra.

## Architecture overview

```
Editor "Render" click
        │
        ▼
INSERT into video_renders (existing flow, unchanged)
        │
        ▼  (Vercel cron every 1 min)
/api/render_video.ts
        │   reads queued rows
        │   calls @remotion/lambda renderMediaOnLambda()
        │   writes lambda_render_id + bucket + function back to row
        │   flips status to 'processing'
        ▼
AWS Lambda spins up Chrome, renders MP4, writes to S3
        │
        ▼  (Vercel cron every 1 min)
/api/drain_video_renders.ts
        │   reads 'processing' rows that have lambda_render_id
        │   calls getRenderProgress()
        │   if done: download from S3 -> upload to GCS -> stories.video_url
        │   flip row to 'done' or 'error'
```

Two crons keep the kick + drain decoupled — a slow render doesn't block new kicks.

## Cost (rule 8 — to re-verify when AWS pricing changes)

- Lambda Compute (us-east-1, 2GB, ~60s per render): ~$0.0000333/s × 60s = ~$0.002 per render.
- S3 storage (output MP4, ~5 MB, lifecycle-deleted after 24h): ~$0.0001 per render-day.
- S3 transfer out to GCS (~5 MB per render): ~$0.0005 per render.
- **Total: ~$0.003 per video render** at current AWS pricing. Free when idle.

For a 100-renders/day workload: ~$0.30/day = ~$9/month. Comfortable headroom for the existing daily budget cap.

## Phases

Each phase is independently mergeable. Worst-case revert: drop the new columns + remove the two API routes; local worker keeps working.

### Phase 1 — AWS setup + npm scripts (no app code)

- One-time AWS provisioning the admin runs locally:
  - Create IAM user with `getRolePolicy()` permissions.
  - `npx remotion lambda functions deploy --memory 2048 --timeout 240 --disk 2048`
  - `npx remotion lambda sites create video/src/index.ts --site-name lorewire`
- Add three env vars to Vercel:
  - `REMOTION_AWS_ACCESS_KEY_ID`
  - `REMOTION_AWS_SECRET_ACCESS_KEY`
  - `REMOTION_LAMBDA_FUNCTION_NAME` (output of functions deploy)
  - `REMOTION_LAMBDA_SERVE_URL` (output of sites create)
  - `REMOTION_AWS_REGION=us-east-1`
- Add npm scripts:
  - `remotion:deploy-function`
  - `remotion:deploy-site` (re-runs whenever video/src/* changes)
  - `remotion:list-functions` (sanity check)
- Document the setup in [_plans/2026-06-14-remotion-lambda-render.md] (this file) with the exact CLI commands.
- No app code changes. Pure ops.

### Phase 2 — video_renders schema additions

- Add columns to `video_renders` (Python + TS schema mirrors):
  - `lambda_render_id TEXT` — the ID `renderMediaOnLambda()` returns.
  - `lambda_bucket_name TEXT` — the S3 bucket the render writes to.
  - `lambda_function_name TEXT` — which Lambda function processed it (multi-function future-proof).
- All three nullable; local dev (`pipeline/render_worker.py`) leaves them NULL.
- Tests: schema migration is idempotent; lookup helpers (`latest_render_for_story`, `get_video_render`) include the new columns.

### Phase 3 — `lorewire-app/api/render_video.ts` (Vercel cron, kicks renders)

- Vercel Node runtime (not Python — `@remotion/lambda` is a Node package).
- CRON_SECRET Bearer auth.
- Postgres advisory lock distinct from the other drains (`VIDEO_RENDERS_KICK_LOCK_KEY = 8472304`).
- Reads up to N (configurable, default 3) queued video_renders rows.
- For each: builds composition inputProps from the story row + video_config, calls `renderMediaOnLambda()`, writes `lambda_render_id` + `lambda_bucket_name` + `lambda_function_name` to the row, flips status to `processing`.
- Structured `[render_video kick]` logs.
- Tests: auth, idempotency on advisory lock, payload shape against a stubbed `renderMediaOnLambda`.

### Phase 4 — `lorewire-app/api/drain_video_renders.ts` (Vercel cron, polls + completes)

- Vercel Node runtime.
- CRON_SECRET Bearer auth.
- Distinct advisory lock (`VIDEO_RENDERS_DRAIN_LOCK_KEY = 8472305`).
- Reads up to N `processing` rows that have `lambda_render_id` set.
- For each: calls `getRenderProgress()`; if `done`, downloads from S3 → uploads to GCS → updates `stories.video_url` + flips row to `done`; if `fatalErrorEncountered`, flips to `error` with the message.
- Two crons combined or split — start with split for cleaner failure modes.
- Tests: progress states (in-progress / done / error), GCS upload happy path, status transitions.

### Phase 5 — vercel.json + flip cron + final wiring

- Add two crons to `lorewire-app/vercel.json`:
  - `/api/render_video` every 1 min
  - `/api/drain_video_renders` every 1 min
- Verify both endpoints work end-to-end against a real Lambda function.
- Update the editor's stale-render badge to show "Render in progress" when a `processing` row exists.
- Plan section marks Phase 4 shipped.

### Phase 6 (deferred follow-up)

- Editor polling for live render status (currently relies on revalidate-on-refresh).
- Multi-region Lambda for users outside us-east-1.
- Lifecycle policy on the S3 output bucket (auto-delete after 24h).
- Cost telemetry: write Lambda billed duration to `video_renders.cost_cents`.

## Security (rule 13)

- AWS credentials live in Vercel env vars only — never committed.
- IAM user has the minimum policy from `getRolePolicy()` — render + bucket access, nothing else.
- CRON_SECRET protects both endpoints (no unauthenticated render kick → no free Lambda spend).
- `renderMediaOnLambda` `privacy: 'public'` is acceptable because the bucket holds short-lived MP4s we immediately copy to GCS; document the 24h S3 lifecycle policy in Phase 6.

## Observability (rule 14)

- `[render_video kick]` — render submitted to Lambda
- `[render_video drain]` — progress poll outcome (in-progress / done / error)
- `[render_video gcs-publish]` — MP4 uploaded to GCS
- `[render_video fatal]` — Lambda errored

## Settings (rule 15)

- `video.lambda_kick_cap_per_tick` (default 3) — max renders kicked per cron firing.
- `video.lambda_max_concurrency` (Lambda-side limit) — passed through `renderMediaOnLambda`'s `concurrency` arg if set.

## Testing (rule 18)

- TS tests for both API routes with `@remotion/lambda` mocked (renderMediaOnLambda + getRenderProgress).
- Python tests for the schema mirror + the new column lookups.
- One manual smoke test: real Lambda render of envelope story end-to-end before marking Phase 5 shipped.

## What the admin does NOT have to do after Phase 5

- Run a local worker for prod renders. Local dev keeps the existing `python -m pipeline.render_worker` flow.
- Re-trigger renders on cron failure — Lambda handles retries via `maxRetries`.
- Watch S3 for completed files — the drain handles transfer to GCS automatically.

## Open questions

- AWS account: does Yoav already have one with billing enabled? If not, that's a 10-minute prerequisite before Phase 1.
- Existing IAM user / new IAM user? Phase 1 will create a dedicated `remotion-lambda-user` if no existing one fits.
