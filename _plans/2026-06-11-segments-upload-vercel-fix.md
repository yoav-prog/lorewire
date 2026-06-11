# Intro/outro upload: move off Vercel Server Actions, onto direct-to-GCS

Date: 2026-06-11
Status: planning, awaiting approval
Section in handoff: Wave 3 Phase 4 fix-up
Council: skipped — direction (Option A) already chosen after the diagnosis
pass below; this doc is execution planning, not architecture debate.

## Problem

`/admin/segments` upload fails in prod (Vercel) with Chrome's
"This page couldn't load" / `ERR_HTTP2_PROTOCOL_ERROR`. The current path in
[lorewire-app/src/app/admin/(panel)/segments/page.tsx](../lorewire-app/src/app/admin/(panel)/segments/page.tsx)
and [lorewire-app/src/app/admin/actions.ts](../lorewire-app/src/app/admin/actions.ts)
posts the raw video bytes into a Next.js Server Action, then shells out to
`ffmpeg-static` in [lorewire-app/src/lib/segments-server.ts](../lorewire-app/src/lib/segments-server.ts),
then uploads to GCS. Three ceilings make that impossible on Vercel:

1. Vercel Function request-body hard cap: **4.5 MB** (not raisable). Typical
   intro is 5–30 MB. Every prod upload trips
   `FUNCTION_PAYLOAD_TOO_LARGE`; HTTP/2 stream aborts; Chrome surfaces it as
   "page couldn't load". Source: Vercel Functions Limits.
2. Next.js Server Action default body limit: **1 MB**.
   `next.config.ts` has no override.
3. `ffmpeg-static` (~80 MB) + `ffprobe-static` (~25 MB) bloat the function
   bundle near the 250 MB unzipped cap and pay full cold-start every upload.
   `maxDuration` is unset (defaults to 10s on serverless) — ffmpeg normalize
   of a 30 MB clip routinely exceeds that.

Prod `video_segments` has 0 rows — no upload has ever succeeded against
the deployed admin. Local dev (with system ffmpeg on PATH and no 4.5 MB cap)
is the only place this has worked.

## Goal

Make intro/outro upload work in prod **without weakening security,
observability, or the local dev loop**, and stop carrying a 100 MB+ pair of
binaries inside the web bundle.

## Decisions (locked)

1. **Browser → GCS resumable upload, direct.** The video bytes never enter a
   Vercel Function. The web tier only sees a small JSON request
   (`{kind,label,filename,size}`) and returns a signed resumable session URI.
2. **`pipeline/` owns normalize.** `pipeline/segments.py:normalize` already
   exists, already shells to system ffmpeg with the *exact same* output
   contract the broken TypeScript copy uses. We delete the TypeScript copy
   rather than maintain two.
3. **Worker is poll-based**, 5s tick. Pipeline machine runs a long-lived
   `python -m pipeline.segments_worker` process; polls
   `video_segments WHERE status='pending'`; downloads source from GCS;
   normalizes; uploads normalized; updates row to `status='ready'`. On any
   exception: writes `status='error'` with a one-line `error` message.
4. **Local dev keeps a multipart fallback** — when `GCS_BUCKET` is unset on
   `next dev`, the form posts to a Route Handler (not a Server Action — no
   1 MB cap, and no 4.5 MB cap because there's no Vercel proxy in dev) that
   runs the existing inline normalize-and-publish, but writes to
   `lorewire-app/public/segments/...` instead of GCS. URLs become
   `/segments/<id>...`. Same row shape, just local files. One branch,
   one log line, easy to remove later.
5. **`ffmpeg-static` / `ffprobe-static` come out of lorewire-app
   `dependencies`.** They move to `optionalDependencies` for the local
   route handler (devs already have system ffmpeg anyway — these become a
   convenience, not a hard requirement, and they don't ship to prod).

## Requirements

- Admin uploads an .mp4/.mov from a browser. File can be up to 500 MB
  (raise the previous 200 MB cap — GCS resumable handles it fine).
- Within ~5s of finishing the upload, the row appears in the admin list as
  "Normalizing…". Within ~30s for a typical 4-second intro, it flips to
  "Ready" and is selectable as Active.
- If the pipeline worker is down, uploads pile up as `pending` and process
  when it comes back. The UI must say this honestly, not silently spin.
- Per-story override (Wave 3 Phase 4) keeps working unchanged.
- Local `next dev` with no GCS keeps working.
- Zero changes to the splice path in `pipeline/segments.py:splice` or to
  the per-story override write.

## Architecture

### Data model

One new column on `video_segments`, additive (matches the pattern in
`pipeline/store.py` and `lorewire-app/src/lib/schema.ts`):

```sql
ALTER TABLE video_segments ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ready';
ALTER TABLE video_segments ADD COLUMN IF NOT EXISTS error  TEXT;
ALTER TABLE video_segments ADD COLUMN IF NOT EXISTS uploaded_at TEXT;
```

`status` values:

- `pending`   — row inserted by signed-URL action; source bytes not yet
              confirmed in GCS.
- `uploading` — client called finalize; bytes are in GCS; worker hasn't
              picked it up.
- `normalizing` — worker holds it; ffmpeg running.
- `ready`     — `normalized_url` populated, ready to be activated.
- `error`     — see `error` column.

Default `'ready'` keeps the empty prod table and any future legacy row safe
(the worker only picks up `pending` / `uploading`, never `ready`).

### Flow (prod)

```
[browser]                                 [vercel function]      [GCS]                [pipeline worker]
   |                                              |                |                          |
   |--POST /api/admin/segments/sign-upload------->|                |                          |
   |   {kind, label, filename, size}              |                |                          |
   |                                              |--init resumable session URI-->|           |
   |                                              |  (server-to-server, GCS JSON  |           |
   |                                              |   API, service account JWT)   |           |
   |                                              |<------ Location: <sessionUri>-|           |
   |                                              |                |                          |
   |                                              |--INSERT video_segments(status='pending')->|
   |<------------- 200 {segId, sessionUri} -------|                                            |
   |                                              |                                            |
   |--PUT bytes (chunked) to sessionUri-------------------------->>>|                          |
   |<--------------------------- 200 (or 308 + Range during) ------|                          |
   |                                              |                |                          |
   |--POST /api/admin/segments/finalize---------->|                |                          |
   |   {segId}                                    |                |                          |
   |                                              |--UPDATE status='uploading'--|             |
   |<------------- 303 -> /admin/segments---------|                              |             |
   |                                                                            |
   |                                              [5s tick]                     |             |
   |                                                                            |<--poll SELECT WHERE status IN ('pending','uploading')
   |                                              [if 'pending' for >5 min:     |
   |                                               assume abandoned, mark      |
   |                                               status='error']             |
   |                                                                            |
   |                                              [worker]                      |
   |                                                                            |--download source from sourceUrl
   |                                                                            |--ffmpeg normalize (system binary)
   |                                                                            |--upload normalized to GCS
   |                                                                            |--UPDATE status='ready',
   |                                                                            |        normalized_url=...,
   |                                                                            |        duration_ms=...
```

The two Vercel actions stay tiny (JSON in, JSON or redirect out, well under
4.5 MB), and `ffmpeg-static` leaves the web bundle entirely.

### Flow (dev, no GCS)

```
[browser]                              [next dev]
   |                                       |
   |--POST multipart /api/admin/segments/upload-local
   |   (200 MB body, no Vercel proxy)      |
   |                                       |--write to tmp
   |                                       |--system ffmpeg normalize -> tmp
   |                                       |--cp both to lorewire-app/public/segments/<id>.{source.ext,norm.mp4}
   |                                       |--INSERT video_segments(status='ready',
   |                                       |        source_url='/segments/<id>.source.ext',
   |                                       |        normalized_url='/segments/<id>.norm.mp4')
   |<--303 -> /admin/segments--------------|
```

One route handler. Refuses to run in prod (returns 503 with a log line) so
nobody accidentally exposes it. Gated by `process.env.VERCEL !== '1'`.

### Files we touch

```
lorewire-app/
  next.config.ts                                  # no bodySizeLimit change needed (we use Route Handlers / JSON SA)
  package.json                                    # ffmpeg-static, ffprobe-static -> optionalDependencies
  src/
    app/
      admin/
        (panel)/
          segments/
            page.tsx                              # replace <form action=server-action> with <SegmentUploadForm/>
            SegmentUploadForm.tsx                 # NEW: client component, picks signed-URL or local path
        actions.ts                                # delete uploadSegmentAction; keep setActive/rename/enable/delete
      api/
        admin/
          segments/
            sign-upload/route.ts                  # NEW: POST {kind,label,filename,size} -> {segId, sessionUri}
            finalize/route.ts                     # NEW: POST {segId} -> 303
            upload-local/route.ts                 # NEW: dev-only multipart fallback
    lib/
      gcs.ts                                      # +createResumableUploadSession(key, contentType)
      schema.ts                                   # +status, +error, +uploaded_at on video_segments
      repo.ts                                     # +listPendingSegments, +setSegmentStatus
      segments-server.ts                          # DELETE (or shrink to types only)
      segments-local.ts                           # NEW: dev-only normalize-and-publish-to-public/

pipeline/
  segments.py                                     # +normalize_from_gcs(segment_row) helper
  segments_worker.py                              # NEW: poll loop, 5s tick
  store.py                                        # +list_pending_segments, +set_segment_status
                                                  # +schema migration (status/error/uploaded_at)
  tests/
    test_segments_worker.py                       # NEW: pickup, success, failure, idempotency

_plans/
  2026-06-11-segments-upload-vercel-fix.md        # this file
```

### Signed-URL action: shape

```ts
// POST /api/admin/segments/sign-upload
// body: { kind: "intro"|"outro", label: string, filename: string, size: number, contentType: string }
// 200:  { segId: string, sessionUri: string, sourceUrl: string }
// 4xx:  { error: string }

export async function POST(req: Request) {
  await requireAdmin();  // same DAL as today

  const { kind, label, filename, size, contentType } = await parseJsonBody(req);

  if (!ACCEPTED_KINDS.has(kind))      return json(400, "bad-kind");
  if (size > MAX_UPLOAD_BYTES)        return json(400, "too-large");      // 500 MB
  if (!ACCEPTED_MIME.has(contentType)) return json(400, "bad-mime");
  const ext = extFromFilename(filename);
  if (!ACCEPTED_EXT.has(ext))         return json(400, "bad-ext");

  const segId      = newSegmentId();
  const sourceKey  = `segments/${segId}.source${ext}`;
  const sessionUri = await createResumableUploadSession(sourceKey, contentType);

  await upsertSegment({
    id: segId,
    kind,
    label: sanitizeLabel(label),
    source_url: `${PUBLIC_BASE}/${env.GCS_BUCKET}/${sourceKey}`,
    normalized_url: null,
    duration_ms: null,
    enabled: 0,                        // not enabled until ready
    status: "pending",
    uploaded_at: null,
  });

  console.info(`[admin segments] sign kind=${kind} id=${segId} size=${size}`);

  return Response.json({ segId, sessionUri, sourceUrl: ... });
}
```

CORS is not an issue: the PUT is browser → `https://storage.googleapis.com`,
not browser → Vercel.

### Finalize action: shape

```ts
// POST /api/admin/segments/finalize
// body: { segId: string }
// 303 -> /admin/segments?uploaded=<segId>

export async function POST(req: Request) {
  await requireAdmin();
  const { segId } = await parseJsonBody(req);
  const seg = await getSegment(segId);
  if (!seg || seg.status !== "pending") return json(404, "segment-not-found");
  await setSegmentStatus(segId, "uploading", { uploaded_at: nowIso() });
  console.info(`[admin segments] finalize id=${segId}`);
  revalidatePath("/admin/segments");
  return Response.redirect("/admin/segments?uploaded=" + segId, 303);
}
```

No byte-confirmation here. The worker is the source of truth — if the
client claimed `finalize` but bytes aren't actually in GCS, ffmpeg fails,
worker writes `status='error', error='source missing'`, admin sees the row
in red. That's strictly safer than trying to HEAD the GCS object from the
action (which would cost a roundtrip and still race with eventual consistency).

### Worker: shape

```python
# pipeline/segments_worker.py
def main(interval_s: float = 5.0) -> None:
    print("[segments worker] start")
    store.init()
    while True:
        rows = store.list_pending_segments(limit=1)
        if not rows:
            time.sleep(interval_s)
            continue
        row = rows[0]
        seg_id = row["id"]
        try:
            store.set_segment_status(seg_id, "normalizing")
            print(f"[segments worker] pick id={seg_id} kind={row['kind']}")

            source_path = _download_source(row["source_url"], seg_id)
            normalized_path = source_path.with_suffix(".norm.mp4")
            meta = segments.normalize(source_path, normalized_path, segment_id=seg_id)

            normalized_url = gcs.upload(
                normalized_path,
                f"segments/{seg_id}.norm.mp4",
            )
            store.set_segment_status(
                seg_id, "ready",
                normalized_url=normalized_url,
                duration_ms=meta["duration_ms"],
                enabled=1,
                error=None,
            )
            print(f"[segments worker] done id={seg_id} duration_ms={meta['duration_ms']}")
        except Exception as e:
            err = repr(e)[:500]
            store.set_segment_status(seg_id, "error", error=err)
            print(f"[segments worker] FAILED id={seg_id}: {err}")
            # don't crash the loop — keep serving other rows.

        # tiny tmp cleanup
        # ...
```

A row stuck `pending` for >5 min (no finalize call ever came) is swept by
the same loop: it picks the row, finds no bytes at `source_url`, fails
loudly, marks `error`. That's the failure mode of "user closed the tab
mid-upload" and matches the UX of every other resumable uploader.

`segments_worker` is added to the run scripts the same way `pipeline.run`
already is. Optionally we can also run it inline inside the existing
pipeline orchestrator (one process, one cron) — leaning toward separate so
crashes in normalize don't take down render.

### UI changes

`SegmentUploadForm.tsx` is a small client component:

```
1. file picker + label input + Upload button (unchanged visually)
2. on submit:
   a. POST /api/admin/segments/sign-upload (small JSON)
   b. PUT file in 8 MB chunks to sessionUri (resumable spec)
      - render a progress bar (0..100)
      - on 308 with Range header, keep going
      - on 5xx, retry with exponential backoff (3 attempts)
   c. POST /api/admin/segments/finalize
3. on success: redirect to /admin/segments?uploaded=<segId>
4. on failure mid-PUT: show the message, leave the row in 'pending' so the
   user can retry-or-delete. The worker's 5-min sweeper will eventually
   mark it 'error' if abandoned.
```

The list view shows status per row:

- `ready`: existing UI, with "Active" badge + controls.
- `pending`/`uploading`/`normalizing`: yellow chip "Processing…" + spinner.
  Disabled "Set as active" button with tooltip "wait for normalize".
- `error`: red chip with the `error` string and a "Delete" button.

This is the only piece that needs polling on the admin side. Use the
existing route's `searchParams.uploaded` to short-circuit one immediate
refresh; for live updates, a 5s `router.refresh()` runs while any row on
the page is in a non-`ready` state. No websockets.

## Security (rule 13)

- Every action (`sign-upload`, `finalize`, `upload-local`) re-checks
  `requireAdmin()`. The DAL is unchanged.
- `sign-upload` validates `kind`, `contentType`, `size`, `filename ext`
  before signing. A signed session URI is bound to:
  - the exact object key (`segments/<segId>.source<ext>`),
  - the exact content-type,
  - a 1-hour TTL.
  An attacker who steals a session URI can only PUT bytes into that one
  object key, which they could already control through `enabled=0` /
  `status='pending'` until an admin activates. They cannot overwrite an
  existing `ready` segment because the key uses a fresh `segId`.
- `segId` is 16 random hex chars from `crypto.randomBytes` (unchanged from
  today). 64 bits of entropy is more than enough for an unguessable URL.
- GCS objects are still `publicRead` ACL (matches today). If we later want
  signed-download URLs for segments, that's a separate change.
- No client-supplied path components are ever interpolated into the GCS
  key. We construct keys server-side from `segId + ext` only.
- `sanitizeLabel` is unchanged — same allow-list as today.
- `upload-local` route handler refuses to run in prod
  (`process.env.VERCEL === '1'` → 503). Defense-in-depth; this also means
  someone porting the project to a non-Vercel prod env has to think before
  enabling local-mode upload there.
- Worker writes `error` strings that may include exception details. We
  `[:500]`-truncate and the column is never rendered as HTML, only as text.
  No PII risk: labels are admin-typed; filenames are admin-chosen.
- Service-account JSON key (`GCS_PRIVATE_KEY`) is unchanged from today's
  setup. Still env-only, never logged, never echoed to the client.

Best-practices check before code (rule 13 + rule 1): consult
[Google Cloud Storage resumable upload docs] live for any auth header /
status-code subtleties before writing `createResumableUploadSession` and
the client-side chunked PUT. Don't rely on training-data memory for the
exact `X-Goog-Resumable: start` + `Location:` ritual or the 308-with-Range
semantics.

## Observability (rule 14)

Browser console (in the client upload component):

```
[segments upload] start kind=intro file=brand.mp4 size=18234567
[segments upload] sign-ok segId=abcd1234 sessionUri=<redacted>
[segments upload] chunk 0..8388608 of 18234567 (45%)
[segments upload] chunk 8388608..16777216 of 18234567 (91%)
[segments upload] chunk 16777216..18234567 of 18234567 (100%)
[segments upload] finalize-ok segId=abcd1234
[segments upload] redirect /admin/segments?uploaded=abcd1234
```

Vercel action logs:

```
[admin segments] sign kind=intro id=abcd1234 size=18234567 contentType=video/mp4
[admin segments] finalize id=abcd1234
[admin segments] revalidate path=/admin/segments
```

Pipeline worker logs (system journal / `pm2 logs` / whatever runs it):

```
[segments worker] start interval_s=5
[segments worker] tick 0 pending=0
[segments worker] pick id=abcd1234 kind=intro source_url=https://...
[segment normalize id=abcd1234] start ...
[segment normalize id=abcd1234] done in 4.8s output=2.3 MB duration=4180ms
[segments worker] done id=abcd1234 duration_ms=4180 normalized_url=https://...
[segments worker] FAILED id=ef56cd09: RuntimeError(...)
```

All three namespaces are greppable and contain *values*, not just events
(per rule 14's "log values, not 'X happened'").

## Settings audit (rule 15)

Three new keys, grouped under "Intro / outro" in the admin settings page:

- `video.segments.max_upload_mb`         — default `500`. Soft cap surfaced
                                           to the admin; hard cap stays in
                                           `sign-upload` so the client
                                           can't lie its way past it.
- `video.segments.worker_interval_s`     — default `5`. The worker reads
                                           this on each tick so admins can
                                           dial up the latency without a
                                           code change.
- `video.segments.abandoned_after_min`   — default `5`. How long a row
                                           sits in `pending` before the
                                           worker sweeps it as `error`.

Defaults are picked so the feature works out of the box; we don't surface
content-type or chunk size as settings — those are correctness, not
preference.

## Cost (rule 8)

- **Vercel**: zero new services. We're moving *work off* Vercel, not onto.
  Per-action billing footprint shrinks (small JSON in, small JSON out vs.
  multi-MB body + ffmpeg cold start). No new Function Duration.
- **GCS**: same bucket, same ACL, same object naming pattern. Resumable
  uploads are billed identically to single-shot uploads on GCS — there's
  no per-session cost. We add **two** PUTs per segment (source + normalized)
  same as today. Storage cost unchanged.
- **Pipeline machine**: one more long-running process (`segments_worker`)
  on the same box that already runs the render pipeline. Idle CPU; spikes
  only when an upload comes in. No new hardware.
- **No third-party**: not adding Vercel Blob, not adding `ffmpeg.wasm`,
  not adding a queue service. Cheapest viable path.

## Testing (rule 18)

Unit, both sides:

```
lorewire-app/src/lib/segments-server.ts           (kept-tests on sanitizeLabel/extension)
lorewire-app/src/app/api/admin/segments/sign-upload/route.test.ts
  - rejects non-admin
  - rejects too-large size
  - rejects bad ext / bad mime
  - returns segId + sessionUri on the happy path
  - INSERTs row with status='pending' and source_url shaped as <bucket>/segments/<id>.source<ext>

lorewire-app/src/app/api/admin/segments/finalize/route.test.ts
  - rejects non-admin
  - 404 on unknown segId
  - flips status pending -> uploading
  - rejects flip from ready (idempotency: 200 no-op or 409? -> 200 no-op)

pipeline/tests/test_segments_worker.py
  - picks up only status in ('pending','uploading')
  - normalize success path -> status='ready' + normalized_url set + duration_ms > 0 + enabled=1
  - normalize failure (ffmpeg rc != 0) -> status='error' + error message captured
  - source missing in GCS -> status='error', loop continues
  - abandoned sweep: row pending > N minutes -> status='error'
  - two workers picking the same row -> SELECT FOR UPDATE / row-versioning
    prevents double-pickup (Postgres path); SQLite path uses a single
    process by design so race is moot
```

Integration:

- A Playwright smoke test (`lorewire-app/tests/e2e/segments-upload.spec.ts`)
  that runs against `next dev` only (uses the local route handler):
  open `/admin/segments`, drop a tiny fixture .mp4, see it appear as
  Ready, set active, see it on `/admin/settings`. Skipped in CI if
  Playwright isn't installed yet — flag if not, propose adding.

- A manual prod-flow checklist (run from the staging Vercel deployment):
  1. Upload a 50 MB .mov → progress reaches 100%
  2. Worker logs show pickup within 5s
  3. Row flips ready in ≤30s
  4. Setting active works, render pipeline picks it up next run
  5. Force a corrupt source (rename .pdf to .mp4) → status='error',
     message includes "ffmpeg rc"
  6. Kill the worker mid-upload → row stays `uploading`, restart worker,
     row processes
  7. Hit `/api/admin/segments/upload-local` in prod → 503

## QA pass (rule 6)

Golden path, edge cases, error paths, regressions:

- Golden: 5 MB intro upload in prod → ready in <30s, set-active works.
- Edge: 499 MB upload → completes (slow but completes).
- Edge: 501 MB upload → rejected client-side by `MAX_UPLOAD_BYTES`, no
  network round-trip.
- Edge: re-upload same filename → different `segId`, no overwrite.
- Edge: two admins upload at the same time → two independent rows.
- Error: GCS PUT 5xx → client retries with backoff, surfaces clearly if
  all retries fail.
- Error: tab closed mid-upload → row stays `pending`; sweeper marks
  `error` after `abandoned_after_min`.
- Error: worker down → uploads pile as `pending`; UI shows "processing";
  no data loss; works as soon as worker restarts.
- Regression: per-story override (Wave 3 Phase 4) reads + writes
  unchanged.
- Regression: existing `setActive` / `rename` / `enable/disable` / `delete`
  actions unchanged — they keep using the server-action pattern because
  their payloads are tiny.
- Regression: render pipeline `splice` path in `pipeline/segments.py`
  reads `normalized_url` exactly as today.

## Sequencing (~3 days)

**Day 1** — schema + worker
- Add columns (`status`, `error`, `uploaded_at`) to both
  `pipeline/store.py` and `lorewire-app/src/lib/schema.ts`.
- Build `pipeline/segments_worker.py` + tests.
- Run worker locally against a hand-inserted `status='pending'` row to
  verify the normalize path end-to-end before any UI work.

**Day 2** — web tier
- `createResumableUploadSession` in `lorewire-app/src/lib/gcs.ts` (+ tests
  for happy + auth-failure paths).
- `sign-upload` + `finalize` route handlers.
- `SegmentUploadForm.tsx` client component with chunked PUT + progress.
- Wire the list view to show non-ready statuses with a polite chip.
- Delete `lorewire-app/src/lib/segments-server.ts` and the old
  `uploadSegmentAction` from `actions.ts`.
- Move `ffmpeg-static`/`ffprobe-static` to `optionalDependencies`.

**Day 3** — dev fallback + QA
- `upload-local` route handler + `segments-local.ts`.
- Run the QA pass (golden + edge + error + regression).
- Manual prod-flow checklist on a preview deployment.
- Ship behind a feature flag? No — the old action is broken in prod, so
  shipping the new one is strictly an improvement.

## Rejected alternatives

- **Raise `bodySizeLimit` in `next.config.ts` and call it done.** Capped at
  4.5 MB by Vercel platform anyway; doesn't solve the ffmpeg bundle / cold
  start / timeout problems. Fails on the first real intro.
- **Vercel Blob + `ffmpeg.wasm` (Option B from the diagnosis).** Adds a new
  service (Vercel Blob, paid), duplicates the normalize logic we already
  have in Python, runs 5–10× slower than native ffmpeg, needs Fluid Compute
  + `maxDuration=300`. Worse fit when `pipeline/segments.py:normalize`
  already exists and works.
- **CLI-only upload (Option C from the diagnosis).** Drops the
  non-engineer-friendly upload affordance. Real UX regression.
- **Push (webhook) from Vercel to pipeline instead of poll.** Requires the
  pipeline box to expose a public HTTPS endpoint with auth + replay
  protection. Polling is 5 lines of Python with zero new attack surface.
  We can switch later if 5s latency ever becomes a problem (it won't at
  the volume of "an admin uploads an intro twice a year").
- **Multi-worker / queue table with leasing.** Premature at this volume.
  One worker, one process, one row at a time. If we ever need parallelism,
  add a `SELECT ... FOR UPDATE SKIP LOCKED` lease pattern and revisit.
- **Stop using `publicRead` ACL on segments and switch to signed download
  URLs.** Out of scope for this fix — file a separate ticket if we want
  to lock down the bucket. The current intro/outro splice path reads the
  public URL from `pipeline/video.py`; switching to signed URLs is a
  broader change.

## Open questions

1. **How is `pipeline/segments_worker` supervised in prod?** Today the
   pipeline runs on demand (`python -m pipeline.run ...`). A long-running
   worker needs a supervisor (`systemd`, `pm2`, `tmux`+restart-on-crash,
   ...). Propose: simplest possible — a `tmux` session you can re-attach
   to, with the worker running `while True` and printing logs to stdout.
   `systemd` is the long-term right answer; we don't need it day one.
2. **Should the worker also clean up the source file from GCS after
   normalize succeeds?** No (default plan): keep the source so a future
   re-normalize at a different target spec can run without re-upload.
   Storage cost is trivial (intros are seconds long). Confirm before
   coding the delete-on-success path.
3. **Do we want a "re-normalize" admin action?** Useful if we ever change
   the target spec. Out of scope here; flag for a follow-up.
4. **Are we OK with the 5s tick latency for the "Processing… → Ready" UI
   flip, or do we want a server-sent-event push from the worker?** SSE
   needs a way for the worker to talk to the web tier (it can't —
   different machines). Polling on the admin page is simpler and the
   admin is the only audience.
