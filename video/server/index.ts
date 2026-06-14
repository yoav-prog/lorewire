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
  renderAndUploadStory,
  type RenderFn,
  type SpliceSegments,
} from "./render.js";

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
  const obj = raw as { intro?: unknown; outro?: unknown };
  const intro =
    typeof obj.intro === "string" && obj.intro.length > 0 ? obj.intro : null;
  const outro =
    typeof obj.outro === "string" && obj.outro.length > 0 ? obj.outro : null;
  return { intro, outro };
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
export function createApp(render: RenderFn = renderAndUploadStory) {
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
        });
        res.status(200).json({
          url: result.url,
          elapsed_ms: result.elapsed_ms,
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
