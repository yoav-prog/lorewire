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

import { promises as fs } from "node:fs";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import {
  renderMedia,
  selectComposition,
  type RenderMediaOptions,
} from "@remotion/renderer";
import { Storage } from "@google-cloud/storage";

const COMPOSITION_ID = "DoodleShort";

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

/** Test-side seam so the HTTP layer can stub the heavy lifting
 *  without pulling in @remotion/bundler or the GCS client at import
 *  time. Production wires the real function in via `server/index.ts`. */
export type RenderFn = (
  storyId: string,
  inputProps: unknown,
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
): Promise<RenderResult> {
  const started = Date.now();
  const gcsBucket = process.env.GCS_BUCKET;
  if (!gcsBucket) {
    throw new Error("GCS_BUCKET not configured");
  }

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

  // GCS upload reusing the SAME credentials the rest of the
  // LoreWire stack uses — Vercel functions, pipeline/gcs.py, and
  // lib/gcs.ts all read GCS_CLIENT_EMAIL + GCS_PRIVATE_KEY from
  // env. Passing them explicitly to the Storage client (instead of
  // letting it fall through to Cloud Run's metadata server) means:
  //   - No separate IAM role to maintain on the Cloud Run side.
  //   - One source of truth for credential rotation (rotate them
  //     in Vercel + redeploy Cloud Run with the same values).
  //   - Local `npm run dev:server` works against real GCS the moment
  //     the developer has the env loaded — no `gcloud auth` quirks.
  // The .env shape stores the key with literal `\n` sequences;
  // normalize to real newlines like lib/gcs.ts does so the PEM
  // parser accepts it.
  const clientEmail = process.env.GCS_CLIENT_EMAIL;
  const rawKey = process.env.GCS_PRIVATE_KEY;
  if (!clientEmail || !rawKey) {
    throw new Error(
      "GCS_CLIENT_EMAIL and GCS_PRIVATE_KEY must be set (use the same values Vercel does)",
    );
  }
  const privateKey = rawKey.includes("\\n")
    ? rawKey.replace(/\\n/g, "\n")
    : rawKey;
  const storage = new Storage({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey,
    },
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
