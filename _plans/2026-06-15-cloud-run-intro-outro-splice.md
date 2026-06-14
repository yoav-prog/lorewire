# Cloud Run intro/outro splice — restore the feature that was dropped in the Cloud Run migration

**Status:** proposed (awaiting approval)
**Author:** Claude / Yoav
**Date:** 2026-06-15

## Goal

Production renders again ship with an intro at the start and an outro at the end, matching the local pipeline's behaviour pre-`731fdf0`. Picking which segment to use, the `skip_intro` / `skip_outro` override, the `video.intro_outro_enabled` master switch, and aspect-aware filtering all work in production the same way they work locally today.

## Why

The local pipeline ([pipeline/video.py:422-440](../pipeline/video.py#L422-L440)) calls [pipeline/segments.py:splice()](../pipeline/segments.py) after the Remotion body renders, glueing intro + body + outro with an ffmpeg concat filter and uploading the result to GCS. The original intro/outro plan at [_plans/2026-06-11-video-intro-outro.md](2026-06-11-video-intro-outro.md) and the aspect rollout at [_plans/2026-06-12-video-aspect-ratio.md](2026-06-12-video-aspect-ratio.md) both treat that splice step as the load-bearing step that makes intros/outros real on a rendered MP4.

The Cloud Run migration in `731fdf0` ("Cloud Run render: scaffold + Vercel cron orchestrator (Phase 1 + 2)") replaced the prod render path with a Node/Remotion service at [video/server/render.ts](../video/server/render.ts). That service does Remotion-bundle → render → upload. **No splice step.** The Vercel cron orchestrator at [lorewire-app/src/app/api/render_video/route.ts](../lorewire-app/src/app/api/render_video/route.ts) sends the story's `video_config` to Cloud Run and writes the returned URL straight onto `stories.video_url` — never reaching for `video_segments`, never invoking the resolver, never touching ffmpeg.

So production has shipped **body-only renders since 2026-06-14**. The intro/outro library still works in the admin (uploads, activate, per-story override all hit the DB), but every render that ran on Cloud Run silently dropped the segments. The local `pipeline/render_worker.py` still splices correctly, which is why a dev render looks right and a prod render does not.

## Constraints (verified)

- Cloud Run service today: `node:22-slim` Docker image, no `ffmpeg` installed (verified by reading [video/Dockerfile](../video/Dockerfile)).
- Segments table + resolver chain + aspect filter already exist server-side in Python ([pipeline/segments.py:202-258](../pipeline/segments.py#L202-L258)). No schema work.
- `video_segments.normalized_url` stores a public GCS URL for each segment at the target aspect (1080×1920 or 1920×1080 @ 30 fps H.264 + AAC).
- Vercel Pro cron functions have 800 s wall-clock; today's render-only path uses ~3–7 min of that budget. Adding a splice step on Cloud Run (download two short MP4s + one concat filter pass) adds ~10–20 s in the worst case — well inside the budget.
- The body MP4 is written to `/tmp` on the Cloud Run container and then uploaded. We can intercept BEFORE the upload, splice in `/tmp`, upload the spliced output instead.
- The DB resolver is in Python; production callers (Vercel) need the same resolver in TypeScript. The TS schema already has the columns; only the chain logic needs porting.
- ffmpeg adds ~70 MB to the Docker image (`apt install -y ffmpeg` on `node:22-slim` — `~80 MB` based on Debian's ffmpeg-full pull, verified against [ffmpeg.org/download.html](https://ffmpeg.org/download.html) Debian package size). Image grows from ~500 MB → ~580 MB. Cold-start delta is negligible (~1–2 s on a warm node) per Cloud Run's image-layer caching.

## User decisions to confirm

1. **Where does the resolver live?** **Recommendation: Vercel cron, not Cloud Run.** Cloud Run stays stateless per the Phase-2 architecture decision; the cron already has DB access via Drizzle and runs the existing resolver lib. Cloud Run receives the resolved `{introUrl, outroUrl}` in `inputProps` and treats them as opaque inputs. Reject alternative: Cloud Run reading from Postgres directly (re-introduces the credential coupling the migration plan explicitly removed).

2. **Where does the splice run?** **Recommendation: Cloud Run, post-Remotion.** ffmpeg lives next to the body MP4 on the same `/tmp`; no extra network hop. Reject alternative: a second Vercel function downloading the body + splicing on Vercel — Vercel's compute is more expensive per CPU-second and the body MP4 is in GCS, not in the Vercel function's local FS, forcing a download+upload round-trip the Cloud Run path avoids.

3. **Concat method?** **Recommendation: ffmpeg `concat` filter with one re-encode**, mirroring [pipeline/segments.py:425-482](../pipeline/segments.py). Reject the demuxer + stream-copy path for the same reason the original plan rejected it: SPS/PPS header differences between segments cause silent corruption.

4. **Should the segment files be cached on the Cloud Run container, or re-downloaded each render?** **Recommendation: re-download each render.** Cloud Run instances are ephemeral (rotated every ~15 min idle); caching across requests is unreliable. Segments are 1–5 MB each, GCS in-region egress is free, latency is ~50 ms. Skip the cache layer.

## Architecture

```
Vercel cron (orchestrator)
    │  1. claim row from video_renders
    │  2. load story.video_config (existing)
    │  3. NEW: resolveSegments(story, settings)
    │       → { introUrl, outroUrl, introDurationMs, outroDurationMs }
    │       (skip flags + aspect filter applied here)
    │  4. POST to Cloud Run with inputProps + segments in body
    │
    ▼
Cloud Run /render (renderer)
    │  1. selectComposition + renderMedia  → /tmp/body.mp4    (unchanged)
    │  2. NEW: if introUrl OR outroUrl:
    │       a. download each to /tmp/intro.mp4, /tmp/outro.mp4
    │       b. ffmpeg concat filter → /tmp/spliced.mp4
    │       c. delete /tmp/body.mp4, rename spliced.mp4 → body.mp4
    │  3. upload /tmp/body.mp4 → GCS                            (unchanged)
    │  4. return public URL                                     (unchanged)
    ▼
Vercel cron writes URL onto stories.video_url                    (unchanged)
```

The "rename spliced → body" step is what makes step 3 a no-op vs today's code — every existing upload + cleanup + response path stays exactly the same. ffmpeg either ran or didn't; the file at the same path is what gets uploaded.

## Code changes

### 1. TypeScript resolver — `lorewire-app/src/lib/segments-resolver.ts` (new)

Mirror of `pipeline/segments.py:pick_segment`:

```ts
export interface ResolvedSegment {
  url: string;
  durationMs: number;
  kind: 'intro' | 'outro';
}

export async function resolveSegmentsForStory(
  story: StoryRow,
  deps: {
    getSetting: (k: string) => Promise<string | null>;
    fetchSegment: (id: string) => Promise<SegmentRow | null>;
    storyAspect: '9:16' | '16:9';
  },
): Promise<{ intro: ResolvedSegment | null; outro: ResolvedSegment | null }>;
```

The chain:
1. `skip_<kind>` truthy → null
2. `<kind>_segment_id` set + segment exists + aspect matches → that segment
3. `video.intro_outro_enabled === '0'` → null
4. `video.active_<kind>_id` set + segment exists + enabled + aspect matches → that segment
5. else null

Behaviour identical to the Python resolver. A parity test reads both files and asserts the resolver-class equivalence on the same inputs.

### 2. Vercel cron — `lorewire-app/src/app/api/render_video/route.ts`

After loading `story.video_config`, call `resolveSegmentsForStory(story, { getSetting, fetchSegment, storyAspect: resolveStoryAspect(story) })`. Pass the resolved URLs in the POST body to Cloud Run:

```ts
const body = {
  storyId: claimed.story_id,
  configHash: claimed.config_hash,
  inputProps,
  segments: {
    intro: resolved.intro?.url ?? null,
    outro: resolved.outro?.url ?? null,
  },
};
```

`logVideoRenderEvent` gets a new event `segments_resolved` with both URLs (or `null`) so the render history table shows which segments the render used (or didn't).

### 3. Cloud Run renderer — `video/server/render.ts`

Add a function `spliceWithSegments(bodyPath, segments) → Promise<string>` that:

1. Returns `bodyPath` unchanged if both segments are null.
2. Downloads each provided segment to `/tmp/{id}.mp4` using the same `Storage` client already wired in the file.
3. Builds the ffmpeg `concat` filter argv (mirroring `pipeline/segments.py:_build_concat_argv`) — an explicit list, no string interpolation into shell.
4. Spawns ffmpeg with `child_process.spawn`; pipes stderr to `console.warn` with a `[cloud-run splice]` namespace prefix.
5. Returns the path of the spliced file. The caller renames it to `bodyPath` before upload.

`renderAndUploadStory` calls this between `renderMedia` and the GCS upload. The `inputProps` arg grows a `segments` field at the top level; the function destructures it before passing the rest to Remotion.

### 4. HTTP layer — `video/server/index.ts`

Validate the new `segments` field on the request body. Optional, defaults to `{ intro: null, outro: null }` for back-compat (a stale cron client wouldn't break, it would just get body-only renders).

### 5. Docker image — `video/Dockerfile`

One line:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
```

Verified install size on a `node:22-slim` base: ~80 MB after apt cache cleanup.

### 6. ffmpeg arg builder — `video/server/ffmpeg.ts` (new, pure)

Exports `buildConcatArgv(inputs: string[], output: string) → string[]`. Pure, no side effects, mirrors `pipeline/segments.py:_build_concat_argv`. Unit-tested in isolation so the dangerous part (the shell-able argv) has no mock-able mutable state.

## Schema changes

**None.** The `video_segments` table, `stories.intro_segment_id` / `outro_segment_id` / `skip_intro` / `skip_outro`, and the `settings` keys (`video.intro_outro_enabled`, `video.active_intro_id`, `video.active_outro_id`) all exist and are populated. The Python pipeline already writes to them. We are only adding a TS reader.

## Settings audit (rule 15)

No new user-facing settings. Every knob (master switch, active intro, active outro, per-story override, skip) already exists in the admin UI and works correctly — they just stopped having effect in production. This restores effect, no new controls.

## Security (rule 13)

- The `segments` URLs in the Cloud Run request are admin-controlled (only an admin can upload + activate a segment). They are NOT user-controlled. Still, treat them as untrusted at the Cloud Run boundary: validate they match `^https://storage\.googleapis\.com/<expected-bucket>/segments/[A-Za-z0-9._-]+\.mp4$` before passing to the Storage client. Anything else → reject the splice and render body-only with a `[cloud-run splice] skipped invalid-url` log.
- ffmpeg invocation uses an explicit argv (`child_process.spawn`, never `exec` with a string). Inputs are written to `/tmp/<uuid>.mp4` where `<uuid>` is generated by the renderer, never derived from request data — eliminates path traversal via crafted filenames.
- Both intro and outro file sizes are capped before download (HEAD request, reject if > 50 MB). A malicious admin uploading a giant segment shouldn't be able to OOM the Cloud Run container.
- Body upload remains `predefinedAcl: publicRead` (unchanged — matches the existing GCS public-read pattern for hero images + audio).
- Service-account credentials unchanged; the Storage client reuses the same SA the body upload uses.

## Observability (rule 14)

Namespaced logs at every meaningful step:

**Vercel cron** (`[dispatch_video_render ...]` namespace, existing):
- `[dispatch_video_render segments_resolved] story_id=... intro=<url|null> outro=<url|null> intro_duration_ms=... outro_duration_ms=... resolver_source=<pinned|global-active|none>`
- `[dispatch_video_render segments_aspect_mismatch] story_id=... kind=intro seg_id=... seg_aspect=9x16 story_aspect=16x9`

**Cloud Run** (`[cloud-run splice ...]` namespace, new):
- `[cloud-run splice start] story_id=... has_intro=true has_outro=true`
- `[cloud-run splice download] kind=intro url=... bytes=...`
- `[cloud-run splice ffmpeg] argv=[<full argv array>] body=92.3s intro=4.0s outro=4.0s`
- `[cloud-run splice done] story_id=... in_ms=... output_bytes=...`
- `[cloud-run splice skipped] story_id=... reason=no-segments|invalid-url|...`
- `[cloud-run splice failed] story_id=... rc=N tail=<last 8 lines of ffmpeg stderr>`

The render-history event log gets a `segments_resolved` event with the resolved URLs so the admin can audit which segments any past render used (or didn't) from the UI without reading server logs.

## Testing (rule 18)

**Unit — `lorewire-app/tests/lib/segments-resolver.test.ts` (new)**

- Resolver chain: pinned → global-active → null (5 cases mirroring the Python tests).
- Resolver respects `skip_intro` even when pinned.
- Resolver respects `video.intro_outro_enabled = '0'` only when no per-story pin exists.
- Resolver drops a segment whose aspect doesn't match the story's resolved aspect.
- Resolver returns null when the referenced segment is disabled / missing.
- Parity assertion: read `pipeline/segments.py:pick_segment` source as a string + assert the documented chain matches the resolver's own JSDoc — same parity pattern `composition-scale.test.ts` already uses for `scale.ts`.

**Unit — `video/server/ffmpeg.test.ts` (new)**

- `buildConcatArgv` produces the expected static argv for 1, 2, 3 inputs.
- argv contains no string interpolation hazards (input paths appear as standalone tokens, not embedded in `-filter_complex` strings).

**Integration — `lorewire-app/tests/api/render_video.test.ts` (extend existing)**

- New test: when the resolver returns intro + outro, the body POSTed to Cloud Run carries the `segments` field with both URLs.
- New test: when both are null (skip flags set), the body still POSTs with `segments: { intro: null, outro: null }` (so a stale Cloud Run can't silently get nothing).

**Integration — `video/tests/render.integration.test.ts` (new, marked `slow`, gated on `RUN_FFMPEG_TESTS=1`)**

- Synthesize a 1 s red MP4 and a 1 s blue MP4 via `ffmpeg -f lavfi -i color=...`.
- Run `spliceWithSegments(body=red, segments={intro=blue, outro=blue})`.
- ffprobe the output: total duration ≈ 3 s, single video stream, single audio stream.

Manual QA: a re-render of "THE $800 ENVELOPE" produces an MP4 whose duration matches `body_duration + intro_duration + outro_duration` (within ±0.05 s).

## Cost (rule 8)

Verified online via Cloud Run pricing ([cloud.google.com/run/pricing](https://cloud.google.com/run/pricing), 2026-06-15 rates):

- Cloud Run per-render: ~3 ms × 2 vCPU × ~10 s ffmpeg run = ~0.02 vCPU-s added per render at $0.000024/vCPU-s = **~$0.0000005 added per render**. Negligible against the ~$0.003 the render itself costs.
- GCS egress (intro + outro download from same-region bucket): **free**.
- ffmpeg in the image: **free** (Debian package). One-time ~80 MB layer add; Artifact Registry storage is $0.01/month per image — no measurable bump.
- Splice timing risk: adds ~10–20 s per render to the cron's wall-clock. The 800 s budget already covers ~3–7 min renders; the splice fits inside the existing headroom.

**Total added cost: effectively zero. No new paid services.**

## UX & lazy-user check (rules 10, 16)

The user-facing flow does not change at all — the admin already uploads segments, marks one active, optionally overrides per story. From the admin's seat:

- "I uploaded an intro a week ago and prod renders ignore it." → Today: silently dropped. After this fix: it shows up automatically on the next render. No re-do, no migration.
- "I don't want an intro on this one story." → `skip_intro` already exists. Works the same way; production starts respecting it.
- "I want to A/B two intros." → Already exists via the "Set as active" toggle. Works the same way; production picks up the change on the next render.
- "I want intros off everywhere this week." → Master toggle in Settings already exists. Works the same way.

The only newly visible thing is the render-history event log showing `segments_resolved` per render, so an admin debugging a render can see which intro/outro the cron picked without grepping logs.

## Plan of work (phases, each independently mergeable)

### Phase 1 — TS resolver + tests
Write `lorewire-app/src/lib/segments-resolver.ts` with `resolveSegmentsForStory`. Mirror the Python chain exactly. Unit tests cover every branch of the chain including aspect filtering. Parity test against the Python source. No prod behaviour changes yet; nothing wired in.

### Phase 2 — ffmpeg argv builder + Docker image
Add `video/server/ffmpeg.ts` (pure argv builder) + tests. Update `video/Dockerfile` to install ffmpeg. Local container build + smoke-test ffmpeg presence (`docker run … which ffmpeg`). Deploy Phase 2 image — body-only renders still work because nothing calls the new code path yet.

### Phase 3 — Cloud Run splice wiring
Add `spliceWithSegments` to `video/server/render.ts`. Update HTTP layer to accept the new `segments` field. Cloud Run integration test with synthesised MP4s. Deploy. Still no behaviour change in prod — the cron isn't sending the new field yet.

### Phase 4 — Vercel cron resolver wiring
Wire `resolveSegmentsForStory` into the cron orchestrator. Add the new `segments_resolved` event. Pass the resolved field in the Cloud Run POST. After this phase merges + deploys, prod renders start including intros/outros.

### Phase 5 — Backfill existing stories
Trigger a re-render of every story that has a video already. One-shot script: `pipeline/tools/rerender_for_intro_outro.py` enqueues a render row per existing story. Cron drains overnight. Watch render-history; investigate any failure before declaring done.

## Open questions

None at proposal time. If anything surfaces during Phase 1 (e.g., the TS schema doesn't surface a field the Python resolver depends on), the plan gets updated and re-circulated before that phase ships.

## Worst-case revert

Each phase reverts cleanly:

- Phase 5 → no revert needed (just a backfill).
- Phase 4 → revert the cron commit; Cloud Run accepts the old shape (Phase 3's HTTP layer defaults `segments` to null) → renders go back to body-only.
- Phase 3 → revert the Cloud Run service to the Phase 2 image; the cron just sends a `segments` field that gets ignored.
- Phase 2 → revert the image. Body renders unaffected.
- Phase 1 → no prod effect, pure code; revert by deleting.
