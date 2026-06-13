# Segments: auto-detect aspect on upload + override on the server

**Date:** 2026-06-14
**Status:** Approved by user. Council skipped (carve-out: concrete
diagnosis, narrow scope, no architecture ambiguity left).
**Triggered by:** Production diagnosis 2026-06-14 — user uploaded
3840×2160 (16:9) intro and outro source files via the admin segments
form. The form's aspect chip defaulted to `9:16`, the user didn't click
to override, and the server stamped `aspect='9:16'` on both rows. The
normalize worker then read that 9:16 value, ran ffmpeg to squash both
sources into 1080×1920 canvases, and the segment-resolver now drops
both with `aspect-mismatch` on every 16:9 story. Rule 10 (lazy user)
failure on the form.

## Goal

A 16:9 source file uploaded through the admin segments form lands in
the DB with `aspect='16:9'`, regardless of what the chip says — the
file shape is ground truth, not the form. Two layers of defense:

1. **Client (UX layer):** the form auto-detects aspect from the picked
   file BEFORE the admin clicks Upload, sets the chip to match, and
   shows a small note. Manual override still possible (an admin who
   wants letterboxing intentionally can click the other chip), with a
   warning when they do.
2. **Server (truth layer):** the segments worker probes the downloaded
   source with ffprobe, computes the actual aspect from width/height,
   overrides the row's `aspect` column when it disagrees with the
   client claim, and feeds the corrected value to ffmpeg normalize.
   This closes the loophole a tampered/buggy client could still create.

## Files I expect to touch

- `pipeline/aspect.py` — add pure `infer_aspect_from_dims(w, h)`.
- `lorewire-app/src/lib/aspect.ts` — mirror of the same helper.
- `pipeline/segments.py` — add `_probe_video_dims(path)` (mirrors the
  existing `_probe_duration_ms` shape).
- `pipeline/segments_worker.py::process_segment` — probe dims after
  download, override row aspect on mismatch, log the decision.
- `pipeline/store.py` — extend `_SEGMENT_PATCH_COLUMNS` to allow the
  worker to patch the `aspect` column alongside the status flip.
- `lorewire-app/src/app/admin/(panel)/segments/SegmentUploadForm.tsx` —
  read videoWidth/videoHeight via a hidden HTMLVideoElement on file
  pick, set the chip to the detected aspect, show the detection note +
  manual-override warning.
- Tests in both directions.

## Out of scope for this PR

- Re-normalizing already-broken rows. The user's existing 9:16 rows
  are squashed copies of 16:9 source; the worker fix only helps NEW
  uploads. The unblock path is: delete the broken rows, re-upload, and
  the form + server will land them correctly. I'll surface this in the
  end-of-task message.
- Image segments / other upload paths. Only video segments
  (intro / outro) have the aspect column today.

## The new shape

### Pure helper

`infer_aspect_from_dims(width: number, height: number) -> VideoAspect`:

- `width > height` → `16:9`
- `width <= height` → `9:16`
- Width or height ≤ 0 → fall through to `LEGACY_DEFAULT_ASPECT` so a
  malformed probe doesn't crash the worker; logged at the call site.

This is the only ambiguity-resolution rule the project needs. We
deliberately don't support `1:1`, `4:3`, etc. — the renderer only emits
9:16 and 16:9, and any other input must collapse to one of those.

### Client (A)

In `SegmentUploadForm.tsx`:

1. On file pick (existing input handler), create a hidden
   `HTMLVideoElement`, set `src = URL.createObjectURL(file)`, wait for
   `loadedmetadata`.
2. Read `videoWidth` / `videoHeight`. Call `inferAspectFromDims`.
3. `setAspect(detected)` and stash `detectedAspect` in component state.
4. Below the chip group, show:
   - `"Detected 16:9 from file metadata."` when chip == detected
   - `"Detected 16:9 — overriding to 9:16 will letterbox the video."`
     when admin manually flips to a different chip
5. `URL.revokeObjectURL` once `loadedmetadata` fires (or 5s timeout).

The detection runs entirely in the browser; no extra network call. If
the browser can't decode the file (rare — server probe still backs
this up), the chip stays at the legacy default and the server fix
catches the mismatch.

### Server (B)

In `pipeline/segments_worker.py::process_segment`, right after the
existing `download(...)` call:

1. Run `_probe_video_dims(source_path)` → `(w, h)` or `None`.
2. If we got dims, compute `actual = infer_aspect_from_dims(w, h)`.
3. If `actual != seg_aspect`:
   - Log `[segments worker] aspect override id=... declared=9:16 actual=16:9`.
   - Set `seg_aspect = actual` so the normalize call uses the right
     target canvas.
   - Mark `corrected_aspect = actual` so the final `set_status('ready',
     ...)` call patches the column to match reality.
4. If probe fails, log and proceed with declared (legacy behavior).
5. Add `aspect` to `_SEGMENT_PATCH_COLUMNS` in `store.py` so the
   `set_status` patch is allowed to write it.

This is the load-bearing fix — even if a future client UI regression
silently sends the wrong aspect, the row that lands in the DB will
match the file.

## Security (rule 13)

- **No new attack surface.** ffprobe runs on bytes we already trust
  (they came through the GCS-signed PUT and the admin-only finalize
  flow). The output is parsed as integers and clamped to two known
  enum values. No shell, no exec, no eval.
- **Allow-list extension.** Adding `aspect` to `_SEGMENT_PATCH_COLUMNS`
  is the only privilege change. The set still rejects unknown columns,
  so a misspelled key still crashes loudly.
- **Client-side blob.** `URL.createObjectURL(file)` creates a local
  blob URL only visible to this tab. Revoked on `loadedmetadata` or a
  5s timeout so a forgotten metadata event can't leak the handle.

## Observability (rule 14)

Every aspect decision gets a print so a future "wrong aspect" report
is one grep away:

- `[segments worker] aspect probe id=X dims=WxH actual=16:9 declared=9:16`
- `[segments worker] aspect override id=X declared=9:16 actual=16:9`
- `[segments worker] aspect probe FAILED id=X — using declared 9:16`
- Client: `console.info('[segment upload aspect]', { detected, dims })`
  so an admin can debug an off-by-one detection in DevTools.

## Settings audit (rule 15)

No new settings. Aspect detection is correctness, not a feature flag.
A "trust client claim" override would be a footgun that the same UX
trap could re-poison through; leave the server probe always on.

## Testing (rule 18)

- `pipeline/tests/test_aspect.py` (extend) — `infer_aspect_from_dims`
  table-tested for square, portrait, landscape, zero, negative.
- `lorewire-app/src/lib/aspect.test.ts` (extend) — same tests in TS,
  enforces parity with the Python helper.
- `pipeline/tests/test_segments_worker.py` (extend) — three new tests:
  - Probe says 16:9, row declared 9:16 → row gets `aspect='16:9'` and
    normalize is called with `'16:9'`.
  - Probe matches declared → no override, `aspect` patch omitted, row
    aspect stays unchanged.
  - Probe fails (None) → declared used, no override, no crash.
- `pipeline/tests/test_segments.py` (extend) — `_probe_video_dims`
  parses ffprobe output cleanly and returns None on garbage.
- Manual QA: re-upload an intro through the form, watch the chip flip
  to 16:9 the moment the file is picked; confirm the DB row has
  `aspect='16:9'` after worker finishes.

## Open questions

1. **Browser `videoWidth/Height` covers most files but not all** —
   esoteric codecs the browser can't decode (rare for intro/outro
   formats) will silently leave the chip at its default. Mitigation:
   the server probe is the safety net. If we see a real "browser
   couldn't decode" case, add a fallback to file.type-based heuristics.
2. **Letterbox-on-purpose case** — an admin who really wants a 16:9
   source rendered into a 9:16 canvas (with bars) can manually pick
   9:16; the warning surfaces the consequence but doesn't block. The
   server probe will see the source is 16:9 but the row stays 9:16
   because the warn-and-override path is intentional. **DECISION
   NEEDED on first encounter:** if this case turns out common, we
   may want to track the admin's intent on the row (`aspect_override:
   true`) so the server probe doesn't undo it. Out of scope for v1.
3. **Existing broken rows** are not auto-fixed by this PR. The
   end-of-task message tells the user to delete and re-upload — both
   sides of the fix only help new uploads.
