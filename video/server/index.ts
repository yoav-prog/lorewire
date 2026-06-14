// LoreWire video render service entry point.
//
// Phase 1 of _plans/2026-06-14-cloud-run-render.md. This is the scaffold:
// the HTTP surface + auth + request-shape validation are real, but the
// /render handler is a placeholder that just logs and returns 202. The
// actual claim + render + GCS upload + DB writeback land in Phase 3
// alongside the integration tests.
//
// Keeping the scaffold standalone lets us:
//   - Build + push the image now and verify cold-start + Chromium load
//     against the runtime stage of the Dockerfile.
//   - Wire the Vercel dispatcher (Phase 4) against a known-deployed URL
//     before the render itself is implemented.
//   - Surface auth failures and bad-request shapes in Cloud Run logs
//     from day one rather than alongside Phase 3 noise.
//
// Run locally:
//   PORT=8080 CRON_SECRET=local-dev npm run --workspace video dev:server
// (or via Docker after `docker build`).

import express, { type Request, type Response } from "express";

const PORT = Number(process.env.PORT ?? 8080);

// Same secret the existing Vercel cron drains use. Fail-closed: no
// secret in env → every request 401s, which is exactly the contract
// we want from a service that costs money to invoke.
const CRON_SECRET = process.env.CRON_SECRET ?? "";

function log(event: string, fields: Record<string, unknown> = {}) {
  // One-line JSON-tagged log per CLAUDE.md rule 14. The
  // [cloud-run render <event>] namespace matches what the plan's
  // observability section names; the dispatcher uses a sibling
  // [dispatch_video_render] namespace.
  console.info(`[cloud-run render ${event}]`, JSON.stringify(fields));
}

function isAuthorized(req: Request): boolean {
  if (!CRON_SECRET) return false;
  const header = req.header("authorization") ?? req.header("Authorization");
  return header === `Bearer ${CRON_SECRET}`;
}

interface RenderRequestBody {
  storyId?: unknown;
  configHash?: unknown;
  // inputProps is the props bag the dispatcher pre-builds from the
  // story's video_config. Phase 3 validates the full shape against
  // the composition's prop schema.
  inputProps?: unknown;
}

function parseRenderBody(
  body: RenderRequestBody | undefined,
): { storyId: string; configHash: string; inputProps: unknown } | null {
  if (!body || typeof body !== "object") return null;
  const { storyId, configHash, inputProps } = body;
  if (typeof storyId !== "string" || storyId.length === 0) return null;
  if (typeof configHash !== "string" || configHash.length === 0) return null;
  // inputProps may be any JSON-serializable shape; deeper validation
  // is the renderer's job at Phase 3 prop-binding time.
  return { storyId, configHash, inputProps };
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req: Request, res: Response) => {
  // Cloud Run uses this for the startup probe + ad-hoc curl checks.
  // No auth: the body is intentionally empty of anything sensitive.
  res.status(200).json({ ok: true });
});

app.post("/render", (req: Request, res: Response) => {
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
    res
      .status(400)
      .json({ error: "expected { storyId: string, configHash: string, inputProps }" });
    return;
  }

  log("scaffold_received", {
    story_id: parsed.storyId,
    config_hash: parsed.configHash.slice(0, 12),
  });

  // Phase 3 replaces this with: try_claim_render → renderMedia → GCS
  // upload → video_renders + stories writeback. Until then the response
  // shape is the same one the dispatcher will see post-Phase-3 so the
  // wiring can be developed independently.
  res
    .status(202)
    .json({ accepted: true, scaffold: true, story_id: parsed.storyId });
});

// 404 last so legitimate handlers above always match first.
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: "not_found", path: req.path });
});

app.listen(PORT, () => {
  log("started", {
    port: PORT,
    cron_secret_set: Boolean(CRON_SECRET),
  });
});
