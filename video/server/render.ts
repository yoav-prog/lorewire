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
  selectComposition,
  type RenderMediaOptions,
} from "@remotion/renderer";
import { Storage } from "@google-cloud/storage";

import { buildConcatArgv } from "./ffmpeg.js";

const COMPOSITION_ID = "DoodleShort";

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

/** Resolved intro / outro public GCS URLs the dispatcher picked for this
 *  story. Either may be null — null means "no segment for that end" (the
 *  resolver chose to skip, or no global active is set). Phase 3 of
 *  _plans/2026-06-15-cloud-run-intro-outro-splice.md. */
export interface SpliceSegments {
  intro: string | null;
  outro: string | null;
}

/** Test-side seam so the HTTP layer can stub the heavy lifting
 *  without pulling in @remotion/bundler or the GCS client at import
 *  time. Production wires the real function in via `server/index.ts`. */
export type RenderFn = (
  storyId: string,
  inputProps: unknown,
  segments?: SpliceSegments,
) => Promise<RenderResult>;

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

  // Storage client used for both segment downloads (splice path) and
  // the final body upload. Auth flows through Application Default
  // Credentials — on Cloud Run that means the metadata server hands
  // out OAuth tokens for whichever service account is attached at
  // deploy time. See the docstring on makeStorageClient.
  const storage = makeStorageClient();

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
  await storage.bucket(gcsBucket).upload(tmpPath, {
    destination: key,
    contentType: "video/mp4",
    // Public read so the editor's <video> tag can play it without
    // signed URLs — matches how the rest of the GCS pipeline
    // (hero images, narration audio) already serves assets.
    predefinedAcl: "publicRead",
  });
  const publicUrl = `https://storage.googleapis.com/${gcsBucket}/${key}`;

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

function makeStorageClient(): Storage {
  // 2026-06-15: switched from inline GCS_CLIENT_EMAIL + GCS_PRIVATE_KEY
  // credentials to Application Default Credentials (ADC). On Cloud Run
  // the metadata server hands the SDK a fresh OAuth token for whichever
  // service account is attached to the Cloud Run service (passed via
  // `--service-account` at deploy). No PEM is ever parsed in this Node
  // process, so the OpenSSL 3 DECODER error that broke the inline path
  // (google-auth-library's JWT signing failed with
  // `error:1E08010C:DECODER routines::unsupported` on a freshly-rebuilt
  // node:22-slim image) goes away.
  //
  // The Cloud Run SA needs `objectAdmin` on the bucket — the
  // `videocreator@uplift-283910.iam.gserviceaccount.com` SA that the
  // rest of the pipeline already uses for GCS writes carries that role,
  // and is attached via the deploy command in video/package.json.
  //
  // Local dev path: outside Cloud Run, ADC falls back to whatever
  // `gcloud auth application-default login` set up. That's the same
  // dev-loop the Python pipeline uses, so no extra dev quirks.
  return new Storage();
}

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

  spliceLog("start", {
    story_id: storyId,
    has_intro: hasIntro,
    has_outro: hasOutro,
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
  if (introPath) inputs.push(introPath);
  inputs.push(bodyPath);
  if (outroPath) inputs.push(outroPath);

  const argv = buildConcatArgv(inputs, splicedPath);
  spliceLog("ffmpeg", { story_id: storyId, argv });
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
