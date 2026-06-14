// Phase 3 of _plans/2026-06-14-cloud-run-render.md.
//
// HTTP-layer tests for the Cloud Run render service. We exercise the
// auth + request-shape + render-orchestration paths against a stubbed
// renderAndUploadStory — the heavy Remotion render is tested
// end-to-end against the deployed Cloud Run instance, not here.
//
// Uses node:test (the runtime the project's other test surface uses,
// per test:motion in package.json) and starts the express app on a
// random port so we drive the real HTTP code, not a thin mock.
//
// Why the .mjs file is in TypeScript-source land: the existing pattern
// in video/src/motion/mouth-timing.test.mjs is the same — node:test
// runs ES modules natively without needing a separate build step.
// createApp gets imported from the compiled dist/ output (we tsc the
// server first, then run tests against the compiled JS) — see the
// test:server script we add to package.json alongside.

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { createApp } from "../dist/server/index.js";

const SECRET = "test-secret";

let server;
let baseUrl;

before(async () => {
  process.env.CRON_SECRET = SECRET;
  // Stubbed renderer: never touches Remotion or GCS. The HTTP layer
  // only needs to know the contract — Promise<{ url, elapsed_ms }> —
  // not the implementation.
  const render = async (storyId, inputProps) => {
    if (storyId === "boom") {
      throw new Error("renderMedia failed: bad composition");
    }
    return {
      url: `https://storage.googleapis.com/test-bucket/${storyId}/video.mp4`,
      elapsed_ms: 12345,
    };
  };
  const app = createApp(render);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function post(path, { body, auth } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth !== undefined) headers["Authorization"] = auth;
  const resp = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: resp.status, body: data };
}

describe("Cloud Run render service /healthz", () => {
  it("returns 200 ok without auth", async () => {
    const resp = await fetch(`${baseUrl}/healthz`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.ok, true);
  });
});

describe("Cloud Run render service /render auth", () => {
  it("returns 401 when Authorization header missing", async () => {
    const { status, body } = await post("/render", {
      body: { storyId: "envelope", configHash: "abc", inputProps: {} },
    });
    assert.equal(status, 401);
    assert.equal(body.error, "unauthorized");
  });

  it("returns 401 when token is wrong", async () => {
    const { status } = await post("/render", {
      auth: "Bearer wrong",
      body: { storyId: "envelope", configHash: "abc", inputProps: {} },
    });
    assert.equal(status, 401);
  });

  it("accepts a valid Bearer token", async () => {
    const { status } = await post("/render", {
      auth: `Bearer ${SECRET}`,
      body: { storyId: "envelope", configHash: "abc", inputProps: {} },
    });
    assert.equal(status, 200);
  });
});

describe("Cloud Run render service /render body validation", () => {
  it("returns 400 when body is missing", async () => {
    const { status, body } = await post("/render", {
      auth: `Bearer ${SECRET}`,
    });
    assert.equal(status, 400);
    assert.match(body.error, /storyId/);
  });

  it("returns 400 when storyId missing", async () => {
    const { status } = await post("/render", {
      auth: `Bearer ${SECRET}`,
      body: { configHash: "abc", inputProps: {} },
    });
    assert.equal(status, 400);
  });

  it("returns 400 when configHash missing", async () => {
    const { status } = await post("/render", {
      auth: `Bearer ${SECRET}`,
      body: { storyId: "envelope", inputProps: {} },
    });
    assert.equal(status, 400);
  });
});

describe("Cloud Run render service /render success path", () => {
  it("returns the URL + elapsed_ms from the renderer", async () => {
    const { status, body } = await post("/render", {
      auth: `Bearer ${SECRET}`,
      body: { storyId: "envelope", configHash: "abc", inputProps: {} },
    });
    assert.equal(status, 200);
    assert.equal(
      body.url,
      "https://storage.googleapis.com/test-bucket/envelope/video.mp4",
    );
    assert.equal(body.elapsed_ms, 12345);
  });
});

describe("Cloud Run render service /render error mapping", () => {
  it("returns 500 with the error message when renderer throws", async () => {
    const { status, body } = await post("/render", {
      auth: `Bearer ${SECRET}`,
      body: { storyId: "boom", configHash: "abc", inputProps: {} },
    });
    assert.equal(status, 500);
    assert.match(body.error, /renderMedia failed/);
  });
});
