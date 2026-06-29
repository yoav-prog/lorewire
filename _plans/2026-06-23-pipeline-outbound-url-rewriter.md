# R2 readiness across the media pipeline (post-migration completion)

- Date: 2026-06-23
- Branch: `fix/r2-pipeline-url-rewriter` (off `feat/multi-platform-shorts-publisher`)
- Status: PLAN — implementation in same PR
- Owner: Yoav

## Goal

Finish the R2 migration so the entire media pipeline — Python pipeline,
Vercel-side dispatcher, and Cloud Run video renderer — works end-to-end with R2
as the active media target. Today the migration is "read-rewriter on the Next
reader only," which leaves multiple outbound-URL leaks and a Cloud Run write
path that doesn't honor the R2 cutover flag. Visible failure: the admin's
"Generate hero + thumbnail from short" job fails because the pipeline ships
legacy GCS URLs to kie.ai.

## What the audit found

A code-wide audit on 2026-06-23 (this branch tip) surfaced four classes of issue:

### A. Python pipeline outbound URL leaks (the visible bug)

The hero+thumb finisher and the per-scene regen lanes pull URLs out of
`short_renders.props` (character_base_url, scene URLs, image_input_urls) and pass
them straight to kie's `input_urls`. Those URLs are pre-migration legacy
`storage.googleapis.com/<bucket>/<key>` strings. GCS public reads changed
post-migration, so kie's fetch returns 404 and the task fails. Probed live by
`scripts/probe_kie_hybrid_i2i.py` on 2026-06-23:

```
url_check character status=200    ← kie's own host, fetches fine
url_check scene[0]  status=404    ← legacy GCS URL, GCS public read off
url_check scene[5]  status=404    ← legacy GCS URL, GCS public read off
```

Sites that need the rewriter applied (file:line on this branch tip):

- `pipeline/images.py:97` — `generate()`, the chokepoint where `image_input` /
  `input_urls` cross out to kie. Rewriting here covers every caller.
- Defensive: any other site that takes a stored URL and ships it to a third
  party. None found in the audit beyond the kie path, but the rewriter being a
  pure function makes future leaks cheap to plug.

### B. Vercel-dispatcher outbound URL leak (Cloud Run inputProps)

`lorewire-app/src/app/api/render_short/route.ts:189-231` POSTs `inputProps` to
Cloud Run. The `inputProps` blob comes from `short_renders.props` and carries
the same legacy GCS URLs for scene images, audio, and the character base.
Cloud Run's Remotion render fetches these via HTTP through `resolveSrc`; if
they're legacy GCS and public reads are off, every fetch 404s.

The Next reader already has `lorewire-app/src/lib/media-url.ts:resolveMediaUrl`.
The dispatcher should walk inputProps and rewrite every legacy URL before
sending. Same applies to `segments.intro` / `segments.outro` — though those
go through `parseGcsSegmentUrl` and are downloaded by Cloud Run with the
authenticated GCS SDK (`video/server/render.ts:307`), so they're not at risk
of public-read 404s. Rewriting them anyway is consistent with the larger
"everything outbound resolves through the rewriter" rule.

### C. Cloud Run writes are not R2-aware

`video/server/render.ts:225-245` uploads the final MP4 to GCS unconditionally
via the GCS SDK, returns a `storage.googleapis.com/<bucket>/<key>` URL. There
is no `R2_MEDIA_WRITE_ENABLED` check on this path. Consequence: if the flag
is ever flipped on in production, the Python pipeline will write images/audio
to R2 (via `pipeline/gcs.py:_r2_configured`) but Cloud Run will keep writing
videos to GCS. The reader's rewriter would then redirect the persisted GCS
video URL to R2 where the object doesn't exist → broken playback for every
new short.

Fix: port `pipeline/gcs.py`'s flag-aware R2 path into `video/server/render.ts`,
so Cloud Run uploads to R2 when `R2_MEDIA_WRITE_ENABLED=true` + R2 creds +
`MEDIA_PUBLIC_BASE` are present. Same flag semantics as the Python side and
the Node reader. Cloud Run deploys carry their own env vars (per
`video/README-cloud-run-setup.md`); the R2_* env additions must be set on
Cloud Run before the flag flip.

### D. Operational follow-ups (not code)

1. **Re-run the migration script** to copy any GCS objects written between
   2026-06-22 (first migration) and the flag flip. `migrate_gcs_to_r2.py` is
   idempotent: pre-existing R2 objects with matching size are skipped, only
   new GCS objects get copied. Document this in the rollout section so the
   step doesn't get forgotten.
2. **Set R2_* env on Cloud Run** (`R2_ACCOUNT_ID` or `R2_ENDPOINT`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_MEDIA_BUCKET`,
   `MEDIA_PUBLIC_BASE`).
3. **Flip `R2_MEDIA_WRITE_ENABLED=true`** on Vercel AND Cloud Run, so the two
   write paths cut over together. Must be after step 1 and step 2.
4. **Verify** by rendering one short, confirm the persisted video_url is on
   `MEDIA_PUBLIC_BASE` and the object exists on R2.

## Alternatives rejected

- **Re-enable GCS public read as a hotfix.** Reverts the migration's intent and
  leaves the trap armed for the next time. Rejected.
- **Apply the rewriter only at call sites in `media.py` / `shorts.py`.** Loose
  — every new caller has to remember. Single chokepoint inside
  `images.generate` is harder to forget. Rejected.
- **Leave Cloud Run writing to GCS and add a post-render GCS→R2 copy in the
  dispatcher.** Doable but adds latency, requires Vercel-side GCS auth,
  and the migration step would then have to keep running forever. Rejected
  in favor of native R2 writes from Cloud Run.
- **Ship A only as a hotfix, do B + C + D in follow-ups.** Tempting (smaller
  blast radius today), rejected because the user explicitly asked for the
  full thing to work with R2 end-to-end. Smaller PRs would still need every
  piece eventually; bundling them keeps the operational cutover atomic.

## Scope (what changes in this PR)

1. **New `pipeline/media_url.py`** — direct port of
   `lorewire-app/src/lib/media-url.ts`. Exports `resolve_media_url(url) -> str`
   and `rewrite_stored_media_url(url, base) -> str` mirroring the TS exports.
2. **Wire it into `pipeline/images.py:generate()`** before the kie createTask
   body is built. Log resolved-from / resolved-to when the rewriter changes a
   URL (silent pass-through otherwise).
3. **Wire it into `pipeline/media.py:_generate_with_retry`** to also resolve
   the URL before passing to kie — defense in depth at the closer caller, in
   case `images.generate` ever gets bypassed.
4. **Wire the Node rewriter into `lorewire-app/src/app/api/render_short/route.ts`**
   to walk `inputProps` + `segments` and resolve every legacy GCS URL before
   POSTing to Cloud Run. Uses the existing `media-url.ts:resolveMediaUrl`.
5. **Add R2 support to `video/server/render.ts`** — port the flag-aware upload
   path from `pipeline/gcs.py:_r2_configured` / `_r2_upload`. Cloud Run uploads
   to R2 when the flag is on and all R2 envs are set, falls back to GCS
   otherwise. Same key naming, same `cacheControl: no-cache` metadata.
6. **Cloud Run package.json**: add `aws4fetch` (same client `r2.ts` uses for
   minimal bundle weight) and the R2 client wrapper.
7. **Improve observability** in `pipeline/media.py:_generate_with_retry`:
   return the final exception text (or include it via a sidechannel) so the
   `kie_failed` timeline event in `_build_hero_and_thumbnail_from_short`
   surfaces the real cause, not the generic "no URL after retries".
8. **Bring `scripts/probe_kie_hybrid_i2i.py` into this branch** so the
   diagnostic survives the merge.

## Security

- No new external surface, no new credentials parsed from user input.
- The rewriter is pure: takes a URL string, returns a URL string. No state.
- The rewriter only recognises `storage.googleapis.com` legacy URLs. Any other
  absolute URL (DiceBear avatars, OAuth pictures, kie's tempfile host, R2
  URLs that already match `MEDIA_PUBLIC_BASE`) passes through untouched.
- Cache-bust query strings (`?v=token`) are preserved across rewrite, mirroring
  `media-url.ts` exactly.
- Cloud Run gains R2 credentials in its env; these must be set with the
  same Object-Read-and-Write-only scope the Vercel side uses. Document in the
  Cloud Run setup README.
- The R2 SigV4 signer in Cloud Run runs against an HTTPS endpoint
  (`https://<account>.r2.cloudflarestorage.com`); no cleartext credential
  transit.

## Observability

- `pipeline/media_url.py`: log `[media url resolve] from=<host>/<key>
  to=<base>/<key>` only when the rewriter changes the URL. Silent on
  pass-through to avoid log spam.
- `pipeline/images.py:generate`: log `[kie i2i refs] count=<n> rewrote=<n>`
  once per call so a future "why didn't this resolve?" question is one grep
  away.
- `lorewire-app/src/app/api/render_short/route.ts`: log
  `[render_short rewrite] inputProps=<n> rewrote=<n> segments=<intro:y/n,outro:y/n>`
  in the existing namespaced logger.
- `video/server/render.ts`: log `[cloud-run render upload] target=r2|gcs key=...`
  per upload, plus the elapsed_ms already there.
- The `kie_failed` timeline event grows a `payload.error` field with the
  upstream exception text. The admin UI's event renderer already shows payload
  keys inline, so this surfaces verbatim without a UI change.

## Settings audit

Nothing new. The rewriter's only knob is `MEDIA_PUBLIC_BASE`, which already
exists. The writer cutover knob is `R2_MEDIA_WRITE_ENABLED`, which already
exists. No admin-facing setting is appropriate (this is platform plumbing,
not user-facing behavior).

## Testing

Per CLAUDE.md rule 18 — every change ships with tests, run before the task is
called done.

- `pipeline/tests/test_media_url.py` — new. Cover: pass-through when env
  unset, rewrite when set, preserve querystring + percent-encoding, leave
  non-GCS URLs alone, leave bare object keys alone, handle trailing-slash
  variants on the base, idempotency (already-rewritten URL passes through).
  Mirror every branch from `lorewire-app/src/lib/media-url.test.ts` so the
  two sides cannot drift silently.
- `pipeline/tests/test_images.py` — extend (or create). Mock kie's `_post`
  and `_get`; assert that when `MEDIA_PUBLIC_BASE` is set, the `input_urls`
  field in the outbound createTask body carries rewritten URLs, NOT the
  legacy GCS host.
- `lorewire-app/src/app/api/render_short/route.test.ts` — extend (or create)
  to assert `inputProps` and `segments` are rewritten before the Cloud Run
  POST.
- `video/server/render.test.mjs` — extend (or create) to assert: with
  `R2_MEDIA_WRITE_ENABLED=true` + R2 envs, the upload uses the R2 client and
  returns a `MEDIA_PUBLIC_BASE` URL; without the flag, falls back to GCS.

Full `pytest pipeline/tests` + `npm test` (Next) + Cloud Run tests must be
green before this PR is called done.

## Rollout

1. Merge this PR into `feat/multi-platform-shorts-publisher`.
2. Set R2_* env on Cloud Run (Class D step 2).
3. Re-run `python -m pipeline.migrate_gcs_to_r2` to sync any GCS objects
   written after 2026-06-22 (Class D step 1). Idempotent; safe to re-run.
4. Flip `R2_MEDIA_WRITE_ENABLED=true` on both Vercel AND Cloud Run env.
5. Verify by re-running the admin's "Generate hero + thumbnail from short"
   against `envelope`. Expected: five kie calls succeed, hero + thumbnail
   rows update with R2-hosted URLs (under `MEDIA_PUBLIC_BASE`).
6. Render one new short. Confirm the persisted `video_url` is under
   `MEDIA_PUBLIC_BASE` and the object exists in the R2 bucket.

## Risk

- **First contact between Cloud Run's R2 writer and real traffic.** Mitigated
  by tests + the GCS fallback when flag is off — until the flag flip on
  Cloud Run env, behavior is unchanged.
- **`migrate_gcs_to_r2.py` re-run on a populated R2 bucket.** Idempotent per
  its docstring; matching-size objects are skipped. Worst case: longer
  runtime than expected as it lists every object.
- **The flag flip itself.** Same as the original migration plan envisioned —
  if R2 has any incident, both new writes and old reads stop working. R2's
  SLA on this is the same as our original migration accepted.

## Out of scope (future work)

- Backfill / rewrite the legacy URLs persisted inside JSON columns
  (`short_renders.props`, `stories.pipeline_cache`). Today the read-time
  rewriter handles them transparently; a one-shot rewrite would only be
  needed if we ever retire `media-url.ts`.
- A live GCS→R2 sync. The flag flip makes this unnecessary; the
  migration script's idempotent re-run is the one-shot equivalent.
- Long-form video render (`/api/render_video`). Same Cloud Run service, same
  fix applies. Audit shows the long-form path is structurally identical, so
  if the user later flips it on, the same Cloud Run R2 support handles it.
