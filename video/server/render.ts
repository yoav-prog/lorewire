// Phase 3 of _plans/2026-06-14-cloud-run-render.md.
//
// The render core: bundle Remotion once at server startup, then on
// each /render request select the composition (with the request's
// inputProps so calculateMetadata picks the right dimensions),
// renderMedia to /tmp/<storyId>.mp4, upload to GCS, return the URL.
//
// Split off from server/index.ts so the HTTP layer can be tested
// (request parsing + auth) WITHOUT pulling in @remotion/bundler at
// import time — that package wants the full Remotion runtime which
// breaks vitest's node environment. The HTTP layer mocks
// `renderAndUploadStory` from this module instead.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import {
  renderMedia,
  renderStill,
  selectComposition,
  type RenderMediaOptions,
} from "@remotion/renderer";
import { Storage } from "@google-cloud/storage";

import { buildConcatArgv } from "./ffmpeg.js";
import {
  isR2MediaActive,
  mediaBucket,
  publicMediaUrl,
  putR2Object,
} from "./r2.js";

const COMPOSITION_ID = "DoodleShort";
const POSTER_COMPOSITION_ID = "PosterStill";

/** Maximum size of a single intro/outro segment download, in bytes. Set
 *  generously — normalized 4 s segments at the 1080p contract weigh in
 *  around 2–5 MB; this guards against a misconfigured row pointing at a
 *  100 MB upload (the segments table caps source upload at 200 MB but the
 *  normalized output should always be small). Reject above this — we
 *  don't want a single bad row OOM'ing the container. */
const MAX_SEGMENT_BYTES = 50 * 1024 * 1024;

// Bundle the Remotion project once. The first call kicks the actual
// Webpack build (30-60s); subsequent calls return the cached promise.
// Module-level cache means parallel requests during cold start all
// await the SAME bundle promise — no double-bundling.
let bundlePromise: Promise<string> | null = null;

function getOrCreateBundle(): Promise<string> {
  if (bundlePromise) return bundlePromise;
  // entryPoint relative to the working directory inside the container —
  // see video/Dockerfile's WORKDIR + COPY src ./src.
  const entryPoint = path.join(process.cwd(), "src", "Root.tsx");
  console.info(
    "[cloud-run render bundle] start",
    JSON.stringify({ entry: entryPoint }),
  );
  const started = Date.now();
  bundlePromise = bundle({ entryPoint })
    .then((serveUrl) => {
      console.info(
        "[cloud-run render bundle] done",
        JSON.stringify({
          serve_url: serveUrl,
          elapsed_ms: Date.now() - started,
        }),
      );
      return serveUrl;
    })
    .catch((err: unknown) => {
      // Reset the cache on failure so the NEXT request retries the
      // bundle. Leaving a rejected promise here would cause every
      // subsequent /render to short-circuit on the same error.
      bundlePromise = null;
      throw err;
    });
  return bundlePromise;
}

export interface RenderResult {
  /** Public GCS URL the dispatcher writes into stories.video_url. */
  url: string;
  /** Wall-clock milliseconds the render + upload took. Surfaced in
   *  the response body so the cron log carries timing without an
   *  extra log line. */
  elapsed_ms: number;
}

/** Phase 2 poster renderer body. Input props the PosterStill
 *  composition consumes (mirrors `video/src/PosterStill.tsx`'s
 *  `PosterStillProps` shape; intentionally not imported across the
 *  package boundary to keep the HTTP layer testable without pulling
 *  Remotion into the test environment). Per
 *  _plans/2026-06-28-phase-2-social-poster-render.md.
 *
 *  `text` is the climax-revealing line the helper already resolved
 *  (cached `short_config.poster_text`, freshly-generated LLM line, or
 *  fallback to the spoken hook). PosterStill does NOT pick — the
 *  social-only LLM call lives upstream in
 *  `lorewire-app/src/lib/short-poster.ts::ensureShortPoster` so video
 *  script generation stays byte-identical to a pre-Phase-2 run. */
export interface PosterInputProps {
  scene_1_url: string;
  text: string;
  brand_text?: string;
}

/** Result shape of /render-poster. URL points to the uploaded PNG;
 *  `hash` is echoed back so the dispatcher can stamp it into the
 *  helper's cache record without re-deriving. */
export interface PosterRenderResult {
  url: string;
  elapsed_ms: number;
  hash: string;
}

/** Resolved intro / outro public GCS URLs the dispatcher picked for this
 *  story. Either may be null — null means "no segment for that end" (the
 *  resolver chose to skip, or no global active is set). Phase 3 of
 *  _plans/2026-06-15-cloud-run-intro-outro-splice.md. */
export interface SpliceSegments {
  intro: string | null;
  outro: string | null;
  /** Seconds of held-frame + silent-audio pad to insert on the body's
   *  tail when an outro is also present. Mirrors
   *  `outro_lead_in_sec` on `pipeline/segments.py:splice`. Undefined or
   *  0 leaves the splice unchanged. The dispatcher (Vercel cron) reads
   *  the `video.outro_lead_in_ms` setting and POSTs the resolved value
   *  here so this service stays config-free. */
  outroLeadInSec?: number;
  /** Seconds at which the body's cold-open hook ends. When > 0 AND an
   *  intro is present, the splice reorders to hook-first:
   *  [body_hook][intro][body_rest][outro] so the cold-open spoken hook
   *  lands BEFORE the brand stinger. Per
   *  _plans/2026-06-28-hook-before-brand-intro.md (manager directive:
   *  the first 1.5-3 s the viewer hears must be the story, not the
   *  brand). The dispatcher computes this from the alignment data
   *  (last spoken word of `script.hook`) and POSTs it here so this
   *  service stays content-free. Undefined or 0 leaves the splice on
   *  the legacy [intro][body][outro] ordering. */
  hookEndSec?: number;
}

/** Test-side seam so the HTTP layer can stub the heavy lifting
 *  without pulling in @remotion/bundler or the GCS client at import
 *  time. Production wires the real function in via `server/index.ts`. */
export type RenderFn = (
  storyId: string,
  inputProps: unknown,
  segments?: SpliceSegments,
) => Promise<RenderResult>;

/** Phase 2 — same seam pattern for the poster renderer. The HTTP
 *  layer stubs this for tests; production wires
 *  `renderPosterAndUploadStory`. Caller supplies the cache hash so
 *  one place (the helper) owns invalidation logic. */
export type RenderPosterFn = (
  storyId: string,
  hash: string,
  inputProps: PosterInputProps,
) => Promise<PosterRenderResult>;

/** Real implementation. Production server passes this through to the
 *  HTTP handler; tests pass a stub.
 *
 *  Lifecycle:
 *    1. Ensure the Remotion bundle exists (one-shot on cold start).
 *    2. selectComposition with the request's props so
 *       calculateMetadata can resolve the right dimensions (the
 *       composition's aspect override).
 *    3. renderMedia to /tmp/<storyId>.mp4. The container's /tmp is
 *       writable; everything else (the runtime's deployed source) is
 *       read-only.
 *    4. Upload to GCS at <storyId>/video.mp4. The Cloud Run service
 *       account already has objectAdmin on the bucket (existing GCS
 *       pipeline writes go through the same SA), so no per-call IAM
 *       fiddling.
 *    5. Best-effort cleanup of the /tmp file. Cloud Run's /tmp is
 *       512 MiB shared across requests; leaking a 50 MiB render per
 *       invocation would fill it in ~10 renders without cleanup.
 *    6. Return the public URL + elapsed time. */
export async function renderAndUploadStory(
  storyId: string,
  inputProps: unknown,
  segments: SpliceSegments = { intro: null, outro: null },
): Promise<RenderResult> {
  const started = Date.now();
  const gcsBucket = process.env.GCS_BUCKET;
  if (!gcsBucket) {
    throw new Error("GCS_BUCKET not configured");
  }

  // Build the Storage client once and reuse it for BOTH the segment
  // downloads (splice path) and the final body upload. ADC: the
  // attached Cloud Run runtime service account (set via
  // --service-account on deploy) carries the bucket IAM; the GCS
  // client resolves credentials through the metadata server.
  const storage = new Storage();

  const serveUrl = await getOrCreateBundle();

  console.info(
    "[cloud-run render select]",
    JSON.stringify({ story_id: storyId, composition: COMPOSITION_ID }),
  );
  const composition = await selectComposition({
    serveUrl,
    id: COMPOSITION_ID,
    inputProps: inputProps as Record<string, unknown>,
  });

  // Per CLAUDE.md rule 1: write to /tmp explicitly. The path is
  // deterministic per (storyId, attempt-counter) so a concurrent
  // retry won't clobber an in-flight render on the same container.
  const tmpPath = path.join(
    "/tmp",
    `${sanitizeForFs(storyId)}-${Date.now()}.mp4`,
  );

  const renderOpts: RenderMediaOptions = {
    composition,
    serveUrl,
    codec: "h264",
    // CRF 23 (high-quality web standard) instead of Remotion's default 18 —
    // ~40% smaller, quality still excellent for the flat doodle art.
    // See _plans/2026-06-22-media-compression.md.
    crf: 23,
    outputLocation: tmpPath,
    inputProps: inputProps as Record<string, unknown>,
    chromiumOptions: {
      // The container runs Chromium without a sandbox because Cloud
      // Run already sandboxes the whole container — running an inner
      // Chromium sandbox needs CAP_SYS_ADMIN which Cloud Run doesn't
      // grant. Without this flag every render fails on startup with
      // "Running as root without --no-sandbox is not supported".
      disableWebSecurity: false,
    },
    // Aggressive concurrency would compete with itself on a 2vCPU
    // container; leaving it at the default lets Remotion pick a sane
    // value per the host's reported CPU count.
  };

  console.info(
    "[cloud-run render media] start",
    JSON.stringify({
      story_id: storyId,
      output: tmpPath,
      duration_frames: composition.durationInFrames,
      width: composition.width,
      height: composition.height,
    }),
  );
  await renderMedia(renderOpts);
  const renderEnd = Date.now();
  console.info(
    "[cloud-run render media] done",
    JSON.stringify({
      story_id: storyId,
      elapsed_ms: renderEnd - started,
    }),
  );

  // Splice intro + body + outro IF the dispatcher resolved any. When
  // both segments are null, this is a no-op and the body MP4 at
  // tmpPath gets uploaded as-is — byte-identical to the pre-Phase-3
  // render output. When one or both are set, ffmpeg downloads each to
  // /tmp, concats them around the body, and replaces tmpPath with the
  // spliced file in place. Downstream upload + cleanup paths don't
  // need to know which happened.
  await spliceWithSegments({
    storyId,
    bodyPath: tmpPath,
    segments,
    storage,
    gcsBucket,
  });

  const key = `${sanitizeForFs(storyId)}/video.mp4`;
  // CRITICAL: every short re-render writes to the SAME key (one canonical
  // MP4 per story). Force a revalidate-on-every-play Cache-Control so the
  // editor's <video> player picks up the freshly-uploaded bytes the moment
  // they land. The HEAD+ETag round-trip adds <100 ms per play — trivial
  // against the human-perception bar. (On R2 this overrides the long
  // immutable cache the media bucket uses by default; on GCS it overrides
  // the public-read 1-hour default.) Plan:
  // _plans/2026-06-23-pipeline-outbound-url-rewriter.md.
  const mp4CacheControl = "no-cache, max-age=0, must-revalidate";
  let publicUrl: string;
  if (isR2MediaActive()) {
    // R2 writer: upload the MP4 bytes to the R2 media bucket and return the
    // MEDIA_PUBLIC_BASE delivery URL. This branch fires only when ALL of
    // R2_MEDIA_WRITE_ENABLED, R2 credentials, R2_MEDIA_BUCKET, and
    // MEDIA_PUBLIC_BASE are set — same gate as the Python pipeline and the
    // Next-app writer use, so the three writers cut over together.
    const bytes = await fs.readFile(tmpPath);
    await putR2Object(mediaBucket(), key, new Uint8Array(bytes), {
      contentType: "video/mp4",
      cacheControl: mp4CacheControl,
    });
    publicUrl = publicMediaUrl(key);
    console.info(
      "[cloud-run render upload]",
      JSON.stringify({ target: "r2", key, url: publicUrl }),
    );
  } else {
    // GCS writer (current default until the R2 flag flip): legacy behavior
    // unchanged. The bucket grants `roles/storage.objectViewer` to
    // `allUsers` so the public URL serves directly.
    await storage.bucket(gcsBucket).upload(tmpPath, {
      destination: key,
      contentType: "video/mp4",
      predefinedAcl: "publicRead",
      metadata: { cacheControl: mp4CacheControl },
    });
    publicUrl = `https://storage.googleapis.com/${gcsBucket}/${key}`;
    console.info(
      "[cloud-run render upload]",
      JSON.stringify({ target: "gcs", key, url: publicUrl }),
    );
  }

  // Cleanup. Best-effort: a leaked /tmp file is fixable on container
  // recycle (every 15 min by default) but logging it lets us catch
  // a leak pattern early.
  try {
    await fs.unlink(tmpPath);
  } catch (e) {
    console.warn(
      "[cloud-run render cleanup-fail]",
      JSON.stringify({
        path: tmpPath,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }

  return { url: publicUrl, elapsed_ms: Date.now() - started };
}

// Strip filesystem-hostile chars from a story id before using it in
// /tmp and the GCS key. Matches what pipeline/media.py:_sanitize_id
// does so a story rendered locally lands at the SAME GCS key the
// Cloud Run service would write. Without this parity, a story
// re-rendered via Cloud Run would shadow (not overwrite) the local
// MP4 at a slightly-different key.
function sanitizeForFs(storyId: string): string {
  const cleaned = storyId.replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}

// ─── Phase 2: social poster renderer ─────────────────────────────────────────
//
// _plans/2026-06-28-phase-2-social-poster-render.md (Part 2).
//
// renderStill against the `PosterStill` composition registered in
// video/src/Root.tsx. Same bundle handle + same R2 / GCS gate as the
// video renderer — every operational concern (auth, sanitization, upload)
// is shared with `renderAndUploadStory` above. The poster differs in only
// three ways: it's a single still (PNG, not MP4), the GCS key is
// content-hash-keyed (`{storyId}-short/poster-{hash}.png`, immutable cache
// allowed), and there's no splice / segment plumbing.

export async function renderPosterAndUploadStory(
  storyId: string,
  hash: string,
  inputProps: PosterInputProps,
): Promise<PosterRenderResult> {
  const started = Date.now();
  const gcsBucket = process.env.GCS_BUCKET;
  if (!gcsBucket) {
    throw new Error("GCS_BUCKET not configured");
  }

  // Same bundle handle the video render uses — Webpack bundles both
  // compositions (DoodleShort + PosterStill) in one pass.
  const serveUrl = await getOrCreateBundle();

  console.info(
    "[cloud-run poster select]",
    JSON.stringify({
      story_id: storyId,
      composition: POSTER_COMPOSITION_ID,
      hash,
    }),
  );
  const composition = await selectComposition({
    serveUrl,
    id: POSTER_COMPOSITION_ID,
    inputProps: inputProps as unknown as Record<string, unknown>,
  });

  // /tmp filename includes the hash so a concurrent retry for the same
  // story (different hash) doesn't clobber an in-flight render.
  const tmpPath = path.join(
    "/tmp",
    `${sanitizeForFs(storyId)}-poster-${hash}.png`,
  );

  console.info(
    "[cloud-run poster render] start",
    JSON.stringify({
      story_id: storyId,
      hash,
      output: tmpPath,
      width: composition.width,
      height: composition.height,
    }),
  );
  await renderStill({
    composition,
    serveUrl,
    output: tmpPath,
    imageFormat: "png",
    inputProps: inputProps as unknown as Record<string, unknown>,
  });
  const renderEnd = Date.now();
  console.info(
    "[cloud-run poster render] done",
    JSON.stringify({
      story_id: storyId,
      hash,
      elapsed_ms: renderEnd - started,
    }),
  );

  // Upload key includes the hash so the URL is deterministic per
  // (story, content). The publisher's HEAD-check uses the same path.
  const key = `${sanitizeForFs(storyId)}-short/poster-${hash}.png`;
  // Unlike the MP4 (which overwrites the same key on every re-render and
  // needs revalidation), the poster URL changes per content hash — the
  // BYTES at a given URL never change once written. Long-immutable cache
  // is safe and matches the IG / FB / YT thumbnail-host expectation.
  const pngCacheControl = "public, max-age=31536000, immutable";

  let publicUrl: string;
  if (isR2MediaActive()) {
    const bytes = await fs.readFile(tmpPath);
    await putR2Object(mediaBucket(), key, new Uint8Array(bytes), {
      contentType: "image/png",
      cacheControl: pngCacheControl,
    });
    publicUrl = publicMediaUrl(key);
    console.info(
      "[cloud-run poster upload]",
      JSON.stringify({ target: "r2", key, url: publicUrl }),
    );
  } else {
    const storage = new Storage();
    await storage.bucket(gcsBucket).upload(tmpPath, {
      destination: key,
      contentType: "image/png",
      predefinedAcl: "publicRead",
      metadata: { cacheControl: pngCacheControl },
    });
    publicUrl = `https://storage.googleapis.com/${gcsBucket}/${key}`;
    console.info(
      "[cloud-run poster upload]",
      JSON.stringify({ target: "gcs", key, url: publicUrl }),
    );
  }

  // Best-effort cleanup of the staging PNG. Same pattern as the MP4
  // renderer — Cloud Run /tmp is 512 MiB shared across requests, so
  // leaking 150 KB per invocation would fill it in ~3500 renders.
  try {
    await fs.unlink(tmpPath);
  } catch (e) {
    console.warn(
      "[cloud-run poster cleanup-fail]",
      JSON.stringify({
        path: tmpPath,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }

  return { url: publicUrl, elapsed_ms: Date.now() - started, hash };
}

// ─── Phase 3: intro/outro splice ─────────────────────────────────────────────
//
// _plans/2026-06-15-cloud-run-intro-outro-splice.md.
//
// The dispatcher (Vercel cron) resolves which intro/outro to use and passes
// the public GCS URLs in the /render request body. Here we download each
// to /tmp, run one ffmpeg concat-filter pass, and replace the body MP4 at
// `bodyPath` with the spliced output. The caller then uploads `bodyPath`
// unchanged, so every existing path (URL shape, GCS key, cleanup) carries
// over without modification.

function spliceLog(event: string, fields: Record<string, unknown>): void {
  console.info(`[cloud-run splice ${event}]`, JSON.stringify(fields));
}

/** Parse a public GCS URL of the shape
 *  `https://storage.googleapis.com/<bucket>/<key>.mp4` and return the key
 *  (the part after the bucket). Returns null if the URL doesn't match the
 *  expected shape OR points at a different bucket — the latter is the
 *  defense-in-depth check: a misconfigured row pointing at a foreign
 *  bucket fails closed instead of triggering an anonymous download. */
export function parseGcsSegmentUrl(
  url: string,
  expectedBucket: string,
): string | null {
  const m = /^https:\/\/storage\.googleapis\.com\/([^/]+)\/(.+\.mp4)$/i.exec(url);
  if (!m) return null;
  if (m[1] !== expectedBucket) return null;
  return m[2];
}

async function downloadSegment(
  storage: Storage,
  bucket: string,
  key: string,
  destination: string,
  storyId: string,
  kind: "intro" | "outro",
): Promise<void> {
  const file = storage.bucket(bucket).file(key);
  const [meta] = await file.getMetadata();
  const sizeRaw = meta.size;
  const sizeBytes =
    typeof sizeRaw === "string" ? parseInt(sizeRaw, 10) : sizeRaw ?? 0;
  if (sizeBytes > MAX_SEGMENT_BYTES) {
    throw new Error(
      `segment ${key} is ${sizeBytes} bytes, exceeds ${MAX_SEGMENT_BYTES} cap`,
    );
  }
  spliceLog("download", {
    story_id: storyId,
    kind,
    bucket,
    key,
    bytes: sizeBytes,
  });
  await file.download({ destination });
}

function runFfmpeg(argv: string[], storyId: string): Promise<void> {
  // Use spawn (not exec) with an explicit argv list so the input paths
  // can never be interpreted by a shell. Even with paths containing
  // spaces, semicolons, or quotes the binary sees them as standalone
  // tokens — covered by the ffmpeg.test.mjs argv shape test.
  return new Promise((resolve, reject) => {
    const proc = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrTail = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail += chunk.toString("utf8");
      // Keep the tail bounded — ffmpeg is chatty about progress and a
      // 30-minute render of a noisy input could otherwise accumulate
      // tens of MB of stderr in memory.
      if (stderrTail.length > 16384) {
        stderrTail = stderrTail.slice(-16384);
      }
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderrTail.split("\n").slice(-8).join("\n");
      spliceLog("failed", { story_id: storyId, rc: code, tail });
      reject(new Error(`ffmpeg exited with code ${code}: ${tail}`));
    });
  });
}

async function spliceWithSegments(opts: {
  storyId: string;
  bodyPath: string;
  segments: SpliceSegments;
  storage: Storage;
  gcsBucket: string;
}): Promise<void> {
  const { storyId, bodyPath, segments, storage, gcsBucket } = opts;
  const hasIntro = typeof segments.intro === "string" && segments.intro.length > 0;
  const hasOutro = typeof segments.outro === "string" && segments.outro.length > 0;

  if (!hasIntro && !hasOutro) {
    spliceLog("skipped", { story_id: storyId, reason: "no-segments" });
    return;
  }

  // Validate URLs early — fail closed with a clear log so an admin can
  // see WHICH URL the row pointed at, without trying to download it.
  const introKey = hasIntro
    ? parseGcsSegmentUrl(segments.intro as string, gcsBucket)
    : null;
  const outroKey = hasOutro
    ? parseGcsSegmentUrl(segments.outro as string, gcsBucket)
    : null;
  if (hasIntro && !introKey) {
    spliceLog("skipped", {
      story_id: storyId,
      reason: "invalid-intro-url",
      url: segments.intro,
    });
    return;
  }
  if (hasOutro && !outroKey) {
    spliceLog("skipped", {
      story_id: storyId,
      reason: "invalid-outro-url",
      url: segments.outro,
    });
    return;
  }

  // Hook-first reorder is only meaningful when an intro will sit in front
  // of the body; without an intro, [body][outro] already plays the hook at
  // t=0. The flag is also gated on a positive seconds value (the
  // dispatcher sends 0 / undefined when it can't compute a boundary —
  // e.g. alignment drift, missing hook string — in which case the splice
  // falls through to the legacy ordering).
  const hookEndSec =
    hasIntro && typeof segments.hookEndSec === "number"
      ? Math.max(0, segments.hookEndSec)
      : 0;
  const hookFirstActive = hookEndSec > 0 && hasIntro;

  spliceLog("start", {
    story_id: storyId,
    has_intro: hasIntro,
    has_outro: hasOutro,
    hook_first: hookFirstActive,
    hook_end_sec: hookEndSec,
  });
  const splicedStarted = Date.now();

  // /tmp paths are derived from storyId + Date.now() so a concurrent
  // retry on the same container can't clobber an in-flight splice.
  const stamp = Date.now();
  const sanitized = sanitizeForFs(storyId);
  const introPath = introKey
    ? path.join("/tmp", `${sanitized}-intro-${stamp}.mp4`)
    : null;
  const outroPath = outroKey
    ? path.join("/tmp", `${sanitized}-outro-${stamp}.mp4`)
    : null;
  const splicedPath = path.join("/tmp", `${sanitized}-spliced-${stamp}.mp4`);

  // Parallel downloads — both segments are small (~5 MB) and the GCS
  // client multiplexes well.
  await Promise.all([
    introKey && introPath
      ? downloadSegment(storage, gcsBucket, introKey, introPath, storyId, "intro")
      : Promise.resolve(),
    outroKey && outroPath
      ? downloadSegment(storage, gcsBucket, outroKey, outroPath, storyId, "outro")
      : Promise.resolve(),
  ]);

  // Inputs in playback order: intro → body → outro. Any missing end is
  // simply skipped, matching `pipeline/segments.py:splice`.
  const inputs: string[] = [];
  let bodyIndex = 0;
  if (introPath) {
    inputs.push(introPath);
    bodyIndex = 1;
  }
  inputs.push(bodyPath);
  if (outroPath) inputs.push(outroPath);

  // Pad only when an outro is going to play right after the body;
  // padding before nothing just lengthens the output for no reason.
  const padSec =
    outroPath !== null && typeof segments.outroLeadInSec === "number"
      ? Math.max(0, segments.outroLeadInSec)
      : 0;
  const argv = buildConcatArgv(inputs, splicedPath, {
    bodyIndex,
    bodyTailPadSec: padSec,
    hookEndSec,
  });
  spliceLog("ffmpeg", {
    story_id: storyId,
    argv,
    body_tail_pad_sec: padSec,
    hook_end_sec: hookEndSec,
  });
  await runFfmpeg(argv, storyId);

  // Replace the body file with the spliced one. fs.rename is atomic
  // inside /tmp (same filesystem), so the upload step never sees a
  // partial file.
  await fs.rename(splicedPath, bodyPath);

  // Best-effort cleanup of the downloaded segments. A leaked /tmp file
  // gets reclaimed when the container recycles (every ~15 min idle),
  // but logging it surfaces a leak pattern early.
  await Promise.allSettled(
    [introPath, outroPath]
      .filter((p): p is string => p !== null)
      .map((p) =>
        fs.unlink(p).catch((e) => {
          console.warn(
            "[cloud-run splice cleanup-fail]",
            JSON.stringify({
              path: p,
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }),
      ),
  );

  spliceLog("done", {
    story_id: storyId,
    in_ms: Date.now() - splicedStarted,
  });
}
