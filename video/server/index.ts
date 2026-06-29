// LoreWire video render service entry point.
//
// Phase 3 of _plans/2026-06-14-cloud-run-render.md. The HTTP layer:
// auth, request-shape validation, error mapping. The heavy lifting
// (Remotion bundle + render + GCS upload) lives in `./render.ts`
// behind the `RenderFn` seam so this file stays testable without
// pulling in @remotion/bundler at import time.
//
// Run locally:
//   PORT=8080 CRON_SECRET=local-dev GCS_BUCKET=... npm run --workspace video dev:server
// (or via Docker after `docker build`).

import express, { type Request, type Response } from "express";

import {
  isProbeUrlAllowed,
  probeRemoteMp4DurationMs,
  renderAndUploadStory,
  renderPosterAndUploadStory,
  type PosterAspect,
  type PosterInputProps,
  type RenderFn,
  type RenderPosterFn,
  type SpliceSegments,
} from "./render.js";

/** Seam over the remote-probe helper so tests can inject a deterministic
 *  stub without spinning up ffprobe or hitting the network. Production
 *  wires the real implementation; tests pass a fake that resolves to a
 *  known value. Mirrors the existing `RenderFn` pattern. */
export type ProbeRemoteFn = (url: string) => Promise<number>;

const PORT = Number(process.env.PORT ?? 8080);

function log(event: string, fields: Record<string, unknown> = {}) {
  // One-line JSON-tagged log per CLAUDE.md rule 14. The
  // [cloud-run render <event>] namespace matches what the plan's
  // observability section names; the dispatcher uses a sibling
  // [dispatch_video_render] namespace.
  console.info(`[cloud-run render ${event}]`, JSON.stringify(fields));
}

function isAuthorized(req: Request): boolean {
  // Read CRON_SECRET at request time, not at module load, so tests
  // that set process.env.CRON_SECRET AFTER importing createApp still
  // get the right behavior. Cloud Run sets env vars before booting
  // the container, so the read-time cost is negligible there too.
  // Fail-closed: no secret in env → every request 401s.
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected) return false;
  const header = req.header("authorization") ?? req.header("Authorization");
  return header === `Bearer ${expected}`;
}

interface RenderRequestBody {
  storyId?: unknown;
  configHash?: unknown;
  // inputProps is the props bag the dispatcher pre-builds from the
  // story's video_config. Phase 3 validates the full shape against
  // the composition's prop schema.
  inputProps?: unknown;
  // Phase 3 of _plans/2026-06-15-cloud-run-intro-outro-splice.md.
  // Optional — a stale dispatcher that hasn't been updated yet just
  // omits the field, falls through to `{intro: null, outro: null}`,
  // and gets a body-only render (the legacy behavior).
  segments?: unknown;
}

function parseSegments(raw: unknown): SpliceSegments {
  // Default for missing / malformed shapes is "no segments" — a
  // body-only render is the safe fallback and matches today's behavior.
  if (!raw || typeof raw !== "object") return { intro: null, outro: null };
  const obj = raw as {
    intro?: unknown;
    outro?: unknown;
    outroLeadInSec?: unknown;
    hookEndSec?: unknown;
  };
  const intro =
    typeof obj.intro === "string" && obj.intro.length > 0 ? obj.intro : null;
  const outro =
    typeof obj.outro === "string" && obj.outro.length > 0 ? obj.outro : null;
  const out: SpliceSegments = { intro, outro };
  // Optional numeric splice tuning fields. A non-finite or negative value
  // is dropped silently so a stale / malformed dispatcher can't push the
  // render into an unsafe shape.
  if (
    typeof obj.outroLeadInSec === "number" &&
    Number.isFinite(obj.outroLeadInSec) &&
    obj.outroLeadInSec >= 0
  ) {
    out.outroLeadInSec = obj.outroLeadInSec;
  }
  if (
    typeof obj.hookEndSec === "number" &&
    Number.isFinite(obj.hookEndSec) &&
    obj.hookEndSec > 0
  ) {
    out.hookEndSec = obj.hookEndSec;
  }
  return out;
}

// ─── Phase 2 social poster body parser
// ─── _plans/2026-06-28-phase-2-social-poster-render.md

/** Hard caps so a malformed body can't blow up the request handler.
 *  Validated server-side as defense in depth — the helper that calls
 *  /render-poster also enforces these. */
const POSTER_HOOK_MAX_CHARS = 280;
const POSTER_URL_MAX_CHARS = 2000;
const POSTER_HASH_RE = /^[a-f0-9]{8,32}$/;

interface RenderPosterRequestBody {
  storyId?: unknown;
  hash?: unknown;
  aspect?: unknown;
  inputProps?: unknown;
}

function parseRenderPosterBody(body: RenderPosterRequestBody | undefined): {
  storyId: string;
  hash: string;
  aspect: PosterAspect;
  inputProps: PosterInputProps;
} | null {
  if (!body || typeof body !== "object") return null;
  const { storyId, hash, aspect: rawAspect, inputProps } = body;
  if (typeof storyId !== "string" || storyId.length === 0) return null;
  if (typeof hash !== "string" || !POSTER_HASH_RE.test(hash)) return null;
  // Aspect is optional for Phase 2 back-compat — a stale dispatcher that
  // doesn't yet send the field gets the portrait Phase 2 behavior. Any
  // value other than the two allowed enums fails closed with 400.
  let aspect: PosterAspect;
  if (rawAspect === undefined || rawAspect === "portrait") {
    aspect = "portrait";
  } else if (rawAspect === "landscape") {
    aspect = "landscape";
  } else {
    return null;
  }
  if (!inputProps || typeof inputProps !== "object" || Array.isArray(inputProps)) {
    return null;
  }
  const ip = inputProps as Record<string, unknown>;
  const scene_1_url = ip.scene_1_url;
  const text = ip.text;
  const brand_text = ip.brand_text;
  if (
    typeof scene_1_url !== "string" ||
    scene_1_url.length === 0 ||
    scene_1_url.length > POSTER_URL_MAX_CHARS
  ) return null;
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > POSTER_HOOK_MAX_CHARS
  ) return null;
  if (
    brand_text !== undefined &&
    (typeof brand_text !== "string" || brand_text.length > 64)
  ) return null;
  const validated: PosterInputProps = { scene_1_url, text };
  if (typeof brand_text === "string" && brand_text.length > 0) {
    validated.brand_text = brand_text;
  }
  return { storyId, hash, aspect, inputProps: validated };
}

function parseRenderBody(body: RenderRequestBody | undefined): {
  storyId: string;
  configHash: string;
  inputProps: unknown;
  segments: SpliceSegments;
} | null {
  if (!body || typeof body !== "object") return null;
  const { storyId, configHash, inputProps, segments } = body;
  if (typeof storyId !== "string" || storyId.length === 0) return null;
  if (typeof configHash !== "string" || configHash.length === 0) return null;
  // inputProps may be any JSON-serializable shape; deeper validation
  // is the renderer's job at Phase 3 prop-binding time.
  return {
    storyId,
    configHash,
    inputProps,
    segments: parseSegments(segments),
  };
}

// Factory so tests can inject a stubbed render function and exercise
// the HTTP layer without spinning up Remotion. Production wires the
// real `renderAndUploadStory` from ./render.ts; tests pass a fake
// that resolves instantly with a fake URL.
//
// Phase 2 adds a parallel `renderPoster` seam for the social-poster
// endpoint (_plans/2026-06-28-phase-2-social-poster-render.md). The
// `probeRemote` seam for the /probe-mp4 endpoint was added by
// _plans/2026-06-29-actual-mp4-duration.md. Three independent seams,
// one factory.
export function createApp(
  render: RenderFn = renderAndUploadStory,
  renderPoster: RenderPosterFn = renderPosterAndUploadStory,
  probeRemote: ProbeRemoteFn = probeRemoteMp4DurationMs,
) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    // Cloud Run uses this for the startup probe + ad-hoc curl checks.
    // No auth: the body is intentionally empty of anything sensitive.
    res.status(200).json({ ok: true });
  });

  app.post("/render", (req: Request, res: Response) => {
    void (async () => {
      if (!isAuthorized(req)) {
        log("auth_fail", {
          ip: req.header("x-forwarded-for") ?? "unknown",
        });
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      const parsed = parseRenderBody(req.body);
      if (!parsed) {
        log("bad_request", {
          body_keys: req.body ? Object.keys(req.body) : null,
        });
        res.status(400).json({
          error:
            "expected { storyId: string, configHash: string, inputProps }",
        });
        return;
      }

      log("received", {
        story_id: parsed.storyId,
        config_hash: parsed.configHash.slice(0, 12),
        has_intro: parsed.segments.intro !== null,
        has_outro: parsed.segments.outro !== null,
      });

      try {
        const result = await render(
          parsed.storyId,
          parsed.inputProps,
          parsed.segments,
        );
        log("done", {
          story_id: parsed.storyId,
          url_bytes: result.url.length,
          elapsed_ms: result.elapsed_ms,
          duration_ms: result.duration_ms,
        });
        res.status(200).json({
          url: result.url,
          elapsed_ms: result.elapsed_ms,
          duration_ms: result.duration_ms,
        });
      } catch (e) {
        // The dispatcher's failRender writes whatever's in `error`
        // verbatim to video_renders.error (capped at 2000 chars).
        // Keep the message specific enough to diagnose without
        // leaking stack traces (which can contain file paths).
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        log("render_fail", {
          story_id: parsed.storyId,
          error: msg,
        });
        res.status(500).json({ error: msg });
      }
    })();
  });

  // Phase 2 social poster endpoint. Per
  // _plans/2026-06-28-phase-2-social-poster-render.md. Mirrors /render's
  // auth + body-validation + error-mapping shape but invokes the
  // renderStill path (PNG, single-frame) instead of renderMedia (MP4).
  app.post("/render-poster", (req: Request, res: Response) => {
    void (async () => {
      if (!isAuthorized(req)) {
        log("poster_auth_fail", {
          ip: req.header("x-forwarded-for") ?? "unknown",
        });
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      const parsed = parseRenderPosterBody(req.body);
      if (!parsed) {
        log("poster_bad_request", {
          body_keys: req.body ? Object.keys(req.body) : null,
        });
        res.status(400).json({
          error:
            "expected { storyId: string, hash: string (hex 8-32), " +
            "aspect?: \"portrait\" | \"landscape\" (default portrait), " +
            "inputProps: { scene_1_url: string, text: string, brand_text?: string } }",
        });
        return;
      }

      log("poster_received", {
        story_id: parsed.storyId,
        hash: parsed.hash,
        aspect: parsed.aspect,
        text_len: parsed.inputProps.text.length,
      });

      try {
        const result = await renderPoster(
          parsed.storyId,
          parsed.hash,
          parsed.inputProps,
          parsed.aspect,
        );
        log("poster_done", {
          story_id: parsed.storyId,
          hash: result.hash,
          url_bytes: result.url.length,
          elapsed_ms: result.elapsed_ms,
        });
        res.status(200).json({
          url: result.url,
          elapsed_ms: result.elapsed_ms,
          hash: result.hash,
        });
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        log("poster_render_fail", {
          story_id: parsed.storyId,
          hash: parsed.hash,
          error: msg,
        });
        res.status(500).json({ error: msg });
      }
    })();
  });

  // _plans/2026-06-29-actual-mp4-duration.md.
  //
  // Probe a remote MP4 with ffprobe and return its actual duration in
  // milliseconds. Used by the admin backfill route in the Next app to
  // retroactively repair stories whose `stories.duration` was
  // body-only (the legacy writer wrote body + intro + outro math that
  // missed the splice's tail pad / re-encode rounding / hook-first
  // reorder).
  //
  // Security: CRON_SECRET bearer (same as /render). The URL must
  // resolve to one of the configured media hosts — GCS_BUCKET on
  // storage.googleapis.com, or MEDIA_PUBLIC_BASE when the R2 cutover
  // is active. Any other URL fails closed with 400, so this endpoint
  // can never be turned into a generic "download whatever and run
  // ffmpeg on it" SSRF lever. The download itself is capped at 200 MB
  // / 60 s in probeRemoteMp4DurationMs.
  app.post("/probe-mp4", (req: Request, res: Response) => {
    void (async () => {
      if (!isAuthorized(req)) {
        log("probe_mp4_auth_fail", {
          ip: req.header("x-forwarded-for") ?? "unknown",
        });
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const url = (req.body as { url?: unknown } | undefined)?.url;
      if (typeof url !== "string" || url.length === 0) {
        log("probe_mp4_bad_request", {});
        res.status(400).json({ error: "expected { url: string }" });
        return;
      }
      if (
        !isProbeUrlAllowed(url, {
          GCS_BUCKET: process.env.GCS_BUCKET,
          MEDIA_PUBLIC_BASE: process.env.MEDIA_PUBLIC_BASE,
        })
      ) {
        log("probe_mp4_url_rejected", { url });
        res.status(400).json({
          error: "url is not on the allow-list (GCS_BUCKET / MEDIA_PUBLIC_BASE)",
        });
        return;
      }
      try {
        const duration_ms = await probeRemote(url);
        res.status(200).json({ duration_ms });
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        log("probe_mp4_fail", { url, error: msg });
        res.status(500).json({ error: msg });
      }
    })();
  });

  // 404 last so legitimate handlers above always match first.
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "not_found", path: req.path });
  });

  return app;
}

// No auto-start in this module — production boot lives in
// `server/start.ts` (compiled to `dist/server/start.js`, which is the
// Dockerfile CMD). Keeping the listen-side out of the factory file is
// the standard Express + test pattern: tests import createApp without
// pulling in the network bind, so two test files importing the
// module can't race on the same port.
