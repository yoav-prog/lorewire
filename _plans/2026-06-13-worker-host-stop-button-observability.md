# Worker hosting + Stop button + Observability

**Date:** 2026-06-13
**Status:** Council-revised draft (pending Yoav approval)
**Trigger:** Production "Rebuild All" on the AITA story enqueued 4 rows
that sat at "Queued" indefinitely because there is no production worker.
Symptom uncovered three real gaps.

---

## Council overrule summary

The original draft proposed Phase 1 = Stop button, Phase 2 = events
table, Phase 3 = cron drain. The LLM Council (rule 11) overruled it
4-1: ship the cron drain **first** and properly hardened, defer the
events table indefinitely, build the Stop button **second** (Yoav still
wants it this week). Council also caught four blind spots the original
plan missed: cron auth, lease-based claim recovery, overlapping-tick
concurrency, and verification of kie.ai's billing semantics. All four
are folded in below.

Verdict file: this plan (revision 2).

## Goals

1. **Phase 1 — Production drain.** `image_renders` rows enqueued on
   Vercel get drained without depending on Yoav's laptop. Chosen path:
   Vercel Cron + Python serverless function, hardened per council.
2. **Phase 2 — Stop button.** Any queued or in-flight rebuild can be
   cancelled from the admin UI without database surgery. New
   `cancelled` status the worker respects.
3. **Phase 3 (deferred) — Per-row event timeline.** Re-evaluate after
   one week of live operation. Council consensus: until then, structured
   `logger.info` from Phase 1 → Vercel function logs is enough.

## Non-goals

- Hosting `render_worker.py` (video composition) or `segments_worker.py`
  in production. They stay local. Different deploy shape (ffmpeg, ~2GB
  segment material).
- A bespoke `image_render_events` table. Replaced with structured
  Python logging that goes to Vercel function logs. Re-evaluate after
  one week (see Phase 3).
- A generic `jobs` table abstraction. Expansionist proposed it; council
  flagged it 5/5 as premature abstraction for a one-user system.
- Real-time WebSocket / SSE log streaming. Polling at 3s is enough.

## Verified upstream facts (kie.ai — rule 9, principle 1)

- **Billing model: kie charges on success, not submission.** "If a
  generation task fails, KIE will not charge credits for that failed
  task." Source: kie.ai docs, common-API quickstart. This invalidates
  the council's "soft cancel still pays kie" concern *partially* — see
  cancel semantics below.
- **Async model: submit → task_id → poll or webhook.** The 3-30s "wall
  time per image" in the worker is the *polling loop*, not a single
  blocking HTTP call. Cancellation between polls is therefore strictly
  better than killing an in-flight HTTP.
- **No public cancel endpoint** in the kie docs as of 2026-06-13. The
  task continues on kie's side after our worker stops polling. Whether
  Yoav's account is billed for an unfetched-but-succeeded result is the
  one remaining unknown — flagged as an open question; if kie charges
  on completion regardless of fetch, soft cancel costs the same as
  hard cancel.

## Constraints

- Vercel plan: **confirm Pro is active** before Phase 1 ships. Hobby
  cron is 1/day, which kills the design. If Hobby, switch to Fly.
- Vercel function timeout: 300s default, Pro can go 800s.
- Vercel Cron has no execution guarantee on Hobby (silent skips). Pro
  fires every minute reliably.
- Pipeline deps for image_render_worker are tiny: `google-auth` +
  `psycopg[binary]`. Under Vercel's 500MB function bundle limit.
- Postgres in prod (driver auto-selected by `DATABASE_URL`).

## Cost analysis (rule 8)

| Service | Phase 1 hit | Real current price |
| --- | --- | --- |
| Vercel Cron slot | One every-minute slot | Free with Pro plan |
| Vercel Function (cron drain) | ~1440 invocations/day. Empty-queue tick <100ms, active tick up to 55s (per concurrency guard, see below). | Active CPU billing — idle ticks bill near zero. Verify Pro plan tier before estimating dollar load. |
| kie image gen | Unchanged | nano-banana-2 ~$0.045/img, nano-banana-pro ~$0.09/img (verified earlier). 27-scene rebuild ≈ $1.35. **kie does not charge on failed tasks** per their docs. |
| Postgres | Adds `claimed_at` column + a reaper UPDATE per tick. Few extra reads/writes. | No new tier. |

**Cost guardrails:**
1. Top-of-handler early-exit if `SELECT count(*) FROM image_renders
   WHERE status IN ('queued','processing') = 0`. Empty-queue ticks
   spend ~50ms.
2. Daily budget gate (existing) still applies — `estimateImageRegenCostCents`
   blocks enqueue when daily spend would exceed cap.
3. Hard per-tick row cap (default 6) — see Settings section.

---

## Phase 1 — Vercel Cron + Python serverless drain (hardened)

### Architecture

- New Python serverless function at
  `lorewire-app/api/drain_image_renders.py`.
- Pipeline package vendored into the Vercel deploy via a pre-build
  step: `npm prebuild` copies `pipeline/` → `lorewire-app/api/_lib/pipeline/`.
- Function entrypoint imports from `_lib.pipeline.image_render_worker`.
- Council flagged this packaging step as fragile. Mitigations: (a) the
  prebuild script is one shell command, (b) a smoke test runs the
  drain endpoint with an empty queue in CI before deploy, (c) if the
  smoke test fails twice in a row we abandon Vercel and move the
  worker to Fly.

### Vercel config (`lorewire-app/vercel.ts`, new file)

```ts
import { type VercelConfig } from '@vercel/config/v1';

export const config: VercelConfig = {
  crons: [
    { path: '/api/drain_image_renders', schedule: '*/1 * * * *' },
  ],
  functions: {
    'api/drain_image_renders.py': { maxDuration: 60 },
  },
};
```

Note `maxDuration: 60` — deliberately short. Council math: a 270s tick
overlapping a 60s cadence creates dual workers. 60s tick on 60s cadence
gives exactly one worker live at any moment, and the advisory lock
below makes overlap impossible regardless.

### Handler (sketch)

```python
import os, time, json, logging
from _lib.pipeline import image_render_worker, store

LOG = logging.getLogger("[drain]")
DEADLINE_S = 55  # leave 5s for response, well under 60s function cap

def handler(request):
    # 1. CRON_SECRET auth (council blind spot #1)
    expected = f"Bearer {os.environ['CRON_SECRET']}"
    if request.headers.get("authorization") != expected:
        LOG.warning("[drain auth fail]", extra={"ip": request.headers.get("x-forwarded-for")})
        return {"status": 401}

    start = time.monotonic()

    # 2. Advisory lock — no two ticks ever drain at once (council blind spot #2)
    with store.advisory_lock("image_render_drain"):

        # 3. Lease reaper — orphaned rows from crashed prior ticks (blind spot #3)
        reaped = store.reap_stale_image_render_claims(stale_after_s=600)
        if reaped:
            LOG.info("[drain reaped]", extra={"count": reaped})

        # 4. Fast-exit if queue empty
        pending = store.count_pending_image_renders()
        if pending == 0:
            LOG.info("[drain idle]")
            return {"status": 200, "body": {"drained": 0, "remaining": 0}}

        # 5. Drain loop within deadline + per-tick row cap
        drained = 0
        cap = int(os.environ.get("DRAIN_MAX_ROWS_PER_TICK", "6"))
        while drained < cap and (time.monotonic() - start) < DEADLINE_S:
            row = store.claim_one_image_render()  # SELECT FOR UPDATE SKIP LOCKED + claimed_at = now
            if row is None:
                break
            LOG.info("[drain claim]", extra={"id": row["id"], "asset": row["asset"]})
            try:
                output_url, cost_cents = image_render_worker._default_regen(row)
                store.mark_image_render_done(row["id"], output_url, cost_cents)
                LOG.info("[drain done]", extra={"id": row["id"], "cost_cents": cost_cents, "url": output_url})
            except Exception as e:
                store.mark_image_render_error(row["id"], str(e))
                LOG.error("[drain err]", extra={"id": row["id"], "error": str(e)})
            drained += 1

    remaining = store.count_pending_image_renders()
    LOG.info("[drain tick]", extra={"drained": drained, "remaining": remaining, "elapsed_s": time.monotonic() - start})
    return {"status": 200, "body": {"drained": drained, "remaining": remaining}}
```

### Schema additions (additive, both engines)

```sql
ALTER TABLE image_renders ADD COLUMN IF NOT EXISTS claimed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_image_renders_claimed_at
  ON image_renders(claimed_at) WHERE status = 'processing';
```

Status values: `queued | processing | done | error`. Phase 2 adds
`cancelled`.

### `store.py` additions

- `advisory_lock(name) -> ContextManager` — `pg_try_advisory_lock` on
  Postgres, no-op on SQLite (which only has the local worker anyway).
- `reap_stale_image_render_claims(stale_after_s) -> int` — flips
  `status='processing' AND claimed_at < now() - interval` rows back to
  `queued`, clears claimed_at, returns count.
- `claim_one_image_render() -> dict | None` — atomic claim:
  `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1`, then
  `UPDATE ... SET status='processing', claimed_at=now() WHERE id = ...`.
- `count_pending_image_renders() -> int` — `WHERE status IN ('queued','processing')`.

### Env vars to set in Vercel

- `DATABASE_URL` — Postgres connection (likely already set)
- `KIE_API_KEY`
- `GCS_BUCKET`, `GCS_SERVICE_ACCOUNT_JSON` (or whatever current names are)
- `CRON_SECRET` (Vercel can auto-provision)
- `DRAIN_MAX_ROWS_PER_TICK` (optional, default 6)

### Security (rule 13)

- `CRON_SECRET` Bearer check on every request to `/api/drain_image_renders`.
  401 on miss. This was the council's #1 blind spot — without it the
  endpoint is a free DoS vector for kie.ai credit drain.
- All log fields are operational (ids, durations, costs). No story body
  text logged. Prompts are not logged in Phase 1 (deferred until events
  table evaluation in Phase 3).
- Vercel envs hold the secrets; no service-account JSON in source.

### Observability (rule 14)

Structured `logger.info / .warning / .error` at every step:
- `[drain auth fail]` — bad bearer
- `[drain reaped]` — N rows returned to queued
- `[drain idle]` — no rows to do
- `[drain claim]` — row id + asset
- `[drain done]` — row id + cost + url
- `[drain err]` — row id + error
- `[drain tick]` — summary at end of tick

All visible in Vercel function logs. Grep-friendly bracketed namespaces
per CLAUDE.md rule 14. **This is the events table, just in stdout
form.** Council compromise honored.

### Settings (rule 15)

- `media.cron_max_rows_per_tick` (default 6). Why 6: 6 × ~7s avg per
  scene = 42s, comfortably under 55s deadline. Why not 8 (originally
  proposed): leave a margin for the reaper + final summary write.
- Surface in Settings → Pipeline group.

### Testing (rule 18)

- Unit: handler returns 401 when CRON_SECRET wrong.
- Unit: handler exits in <100ms when queue empty (mock store).
- Unit: reaper resets rows older than threshold.
- Unit: `claim_one_image_render` atomic — concurrent calls return
  different rows (Postgres-only test, SQLite skips).
- Integration (against local SQLite + stub kie): drain 3 rows → done,
  cost summed correctly.
- Pre-deploy smoke test: hit the deployed endpoint with the bearer +
  empty queue, assert 200 + `{drained: 0, remaining: 0}`.

---

## Phase 2 — Stop button (this week, after Phase 1 stable)

### Schema

- Add `'cancelled'` as a valid `status` value. Column is TEXT, no
  migration; just teach code about it.
- Add `cancelled_at TEXT NULL`, `cancel_reason TEXT NULL`.

### Server actions (`lorewire-app/src/app/admin/actions.ts`)

- `cancelImageRenderAction({ renderId, reason? })` — flips one row to
  `cancelled` if status in `('queued','processing')`. Logs via
  `console.info("[cancel image render]", { renderId, reason })`.
- `cancelAllImageRendersAction({ ownerKind, ownerId, reason? })` —
  bulk. Returns `{ ok, cancelled: number }`.
- Both gated by `requireAdmin()`.

### Worker behavior (`pipeline/image_render_worker.py` + drain handler)

- The drain handler polls kie for the task_id result. Between polls,
  re-fetch the row's status. If `cancelled`:
  - Stop polling kie.
  - Don't write the URL back even if the next poll would have succeeded.
  - Log `[drain cancelled]` with row id.
- Caveat: kie may still bill if their task completes server-side
  regardless of whether we fetch. Open question (see below). Even if
  so, stopping the poll saves all DB + GCS work after the cancel point.

### Admin UI

- New `<StopButton renderId>` next to `<RegenButton>` on each
  `MediaRegenPanel` row when status is queued/processing.
- "Stop all" in the panel header next to "Rebuild all" when
  `activeRows > 0`. Confirm modal.
- Cancelled rows show muted gray "Cancelled — Xs ago" via the existing
  `LatestRenderLine` component.

### Tests (rule 18)

- Unit: cancel rejects done/error rows ("nothing to cancel").
- Unit: cancel queued → status flips, drain handler skips it.
- Unit: cancel during polling → drain stops polling + writes nothing.
- UI: stop button only renders for transitional statuses.

### Open questions for Phase 2

- **Does kie charge for tasks we stop polling?** Need to ask kie
  support. If yes, we should add a kie cancel call if one exists, OR
  document that "Stop" only saves admin time + DB consistency, not
  money.
- **Should cancelled rows count against the daily budget?** Lean: no,
  since `cost_cents` reflects actual spend.

---

## Phase 3 (deferred) — Per-row event timeline

**Council ruling: do not build now.** Re-evaluate after one week of
Phase 1 + Phase 2 in production. If Yoav finds himself wanting to ask
"what is the worker doing right now" and grep on Vercel logs isn't
enough, ship a minimal version then.

When/if it ships, scope it to:
- One new `image_render_events` table (no generic `jobs` rewrite).
- Worker writes events at the same checkpoints `logger.info` already
  hits in Phase 1.
- Per-row expandable timeline + "Recent activity" panel polled every
  3s while transitional.
- Retention default 7 days, cleaned up during empty-queue cron ticks.

Until then: `vercel logs` + grep for `[drain claim]` / `[drain done]`
is the event log.

---

## Alternatives considered (worker hosting)

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **Vercel Cron + Python serverless (chosen)** | Single platform, cheap when idle, cron config in `vercel.ts`, kie's "no charge on failure" reduces cancel-cost concern | Pro plan required; pre-build copy step is fragile; 60s cap forces small batches; concurrency risk if cap chosen wrong | Yoav's pick; council blessed with conditions (advisory lock, lease reaper, auth, structured logs) |
| Fly.io machine | Always-on, no cold starts, drains continuously, ~$3/mo, no packaging acrobatics | Extra deploy target | Strong second; documented as the abort destination if Vercel pre-build copy fails twice on first deploy |
| Railway / Render | Same shape as Fly | Same cons + pricier | Pass |
| GitHub Actions cron | Free | 5-min granularity, hard to claim atomically | Pass |
| Keep workers local | Free | Only works when laptop is on — already the bug | The current state we're leaving |

---

## Files touched (preview)

```
lorewire-app/
  api/
    drain_image_renders.py            [new, Phase 1]
    _lib/pipeline/                    [new, Phase 1 — prebuild-copied]
  vercel.ts                            [new, Phase 1]
  package.json                         [Phase 1 — prebuild script]
  src/
    app/admin/
      actions.ts                       [Phase 2 — cancel actions]
      (panel)/_components/
        MediaRegenPanel.tsx            [Phase 2 — stop button]
        StopButton.tsx                 [new, Phase 2]
        StopAllButton.tsx              [new, Phase 2]
        RebuildAllButton.tsx           [Phase 2 — header glue]
      (panel)/settings/page.tsx        [Phase 1 — max-rows setting]
    lib/
      image-render-queue.ts            [Phase 1, 2 — cancel + lease helpers]
      schema.ts                        [Phase 1 — claimed_at; Phase 2 — cancelled]
pipeline/
  image_render_worker.py               [Phase 2 — honor cancel between polls]
  store.py                             [Phase 1 — advisory_lock, reaper, claim]
  tests/
    test_drain_image_renders.py        [new, Phase 1]
    test_image_render_worker.py        [Phase 2 — cancel tests]
```

## Open questions for Yoav

1. **Vercel plan?** Hobby = stop, switch to Fly. Pro = continue.
2. **Does kie bill for tasks where we stop polling?** Needs answer
   before Phase 2 ships. (My investigation found their docs are silent
   on this — they bill on success, not failure; the gray area is
   "success but we never fetched.")
3. **Are you OK with Phase 3 (events table) deferred?** Council says
   yes; you can still override.
