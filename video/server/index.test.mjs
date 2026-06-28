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
/** Captures the (storyId, inputProps, segments) tuple the stub last
 *  received so the segments-parsing tests can assert what the HTTP
 *  layer handed downstream. Reset before each segments-parsing case. */
let lastRenderCall = null;
/** Captures the (storyId, hash, inputProps) tuple for /render-poster.
 *  Reset before each poster-parsing case. */
let lastPosterRenderCall = null;

before(async () => {
  process.env.CRON_SECRET = SECRET;
  // Stubbed renderer: never touches Remotion or GCS. The HTTP layer
  // only needs to know the contract — Promise<{ url, elapsed_ms }> —
  // not the implementation.
  const render = async (storyId, inputProps, segments) => {
    lastRenderCall = { storyId, inputProps, segments };
    if (storyId === "boom") {
      throw new Error("renderMedia failed: bad composition");
    }
    return {
      url: `https://storage.googleapis.com/test-bucket/${storyId}/video.mp4`,
      elapsed_ms: 12345,
    };
  };
  // Phase 2 stub for /render-poster. Same shape as the video stub.
  const renderPoster = async (storyId, hash, inputProps) => {
    lastPosterRenderCall = { storyId, hash, inputProps };
    if (storyId === "poster-boom") {
      throw new Error("renderStill failed: bad composition");
    }
    return {
      url: `https://storage.googleapis.com/test-bucket/${storyId}-short/poster-${hash}.png`,
      elapsed_ms: 678,
      hash,
    };
  };
  const app = createApp(render, renderPoster);
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

// Phase 3 of _plans/2026-06-15-cloud-run-intro-outro-splice.md. The HTTP
// layer parses the optional `segments` field, normalizes malformed shapes
// to {intro: null, outro: null}, and passes the resolved tuple as the
// third argument to the render fn.
describe("Cloud Run render service /render segments parsing", () => {
  it("passes intro + outro URLs through when both are provided", async () => {
    lastRenderCall = null;
    const intro = "https://storage.googleapis.com/test-bucket/segments/i1.mp4";
    const outro = "https://storage.googleapis.com/test-bucket/segments/o1.mp4";
    const { status } = await post("/render", {
      auth: `Bearer ${SECRET}`,
      body: {
        storyId: "envelope",
        configHash: "abc",
        inputProps: {},
        segments: { intro, outro },
      },
    });
    assert.equal(status, 200);
    assert.deepEqual(lastRenderCall.segments, { intro, outro });
  });

  it("defaults segments to {intro: null, outro: null} when omitted", async () => {
    lastRenderCall = null;
    const { status } = await post("/render", {
      auth: `Bearer ${SECRET}`,
      body: { storyId: "envelope", configHash: "abc", inputProps: {} },
    });
    assert.equal(status, 200);
    assert.deepEqual(lastRenderCall.segments, { intro: null, outro: null });
  });

  it("normalizes malformed segments (non-object) to {intro: null, outro: null}", async () => {
    lastRenderCall = null;
    const { status } = await post("/render", {
      auth: `Bearer ${SECRET}`,
      body: {
        storyId: "envelope",
        configHash: "abc",
        inputProps: {},
        segments: "intro-please",
      },
    });
    assert.equal(status, 200);
    assert.deepEqual(lastRenderCall.segments, { intro: null, outro: null });
  });

  it("normalizes individual missing / empty / non-string fields to null", async () => {
    lastRenderCall = null;
    const intro = "https://storage.googleapis.com/test-bucket/segments/i1.mp4";
    const { status } = await post("/render", {
      auth: `Bearer ${SECRET}`,
      body: {
        storyId: "envelope",
        configHash: "abc",
        inputProps: {},
        segments: { intro, outro: "" },
      },
    });
    assert.equal(status, 200);
    assert.deepEqual(lastRenderCall.segments, { intro, outro: null });
  });

  it("passes hookEndSec through when the dispatcher sends a positive number", async () => {
    // _plans/2026-06-28-hook-before-brand-intro.md. The dispatcher
    // computes hook_end_ms from the alignment data and POSTs the
    // seconds-form here so the server stays content-free.
    lastRenderCall = null;
    const intro = "https://storage.googleapis.com/test-bucket/segments/i1.mp4";
    const { status } = await post("/render", {
      auth: `Bearer ${SECRET}`,
      body: {
        storyId: "envelope",
        configHash: "abc",
        inputProps: {},
        segments: { intro, outro: null, hookEndSec: 2.5 },
      },
    });
    assert.equal(status, 200);
    assert.deepEqual(lastRenderCall.segments, {
      intro,
      outro: null,
      hookEndSec: 2.5,
    });
  });

  it("drops hookEndSec when it's <= 0, non-finite, or wrong type", async () => {
    // Defense in depth: a stale / malformed dispatcher can't push the
    // splice into an unsafe shape. Falls through to the legacy ordering.
    const intro = "https://storage.googleapis.com/test-bucket/segments/i1.mp4";
    for (const bad of [0, -1, Infinity, NaN, "2.5", null]) {
      lastRenderCall = null;
      const { status } = await post("/render", {
        auth: `Bearer ${SECRET}`,
        body: {
          storyId: "envelope",
          configHash: "abc",
          inputProps: {},
          segments: { intro, outro: null, hookEndSec: bad },
        },
      });
      assert.equal(status, 200);
      assert.equal(
        lastRenderCall.segments.hookEndSec,
        undefined,
        `hookEndSec=${JSON.stringify(bad)} must be dropped`,
      );
    }
  });

  it("passes outroLeadInSec through when the dispatcher sends one", async () => {
    // Pre-existing latent bug: SpliceSegments declared outroLeadInSec
    // and the renderer used it, but parseSegments dropped it before
    // 2026-06-28. The hook-first refactor that added hookEndSec parsing
    // also fixed this gap. Lock the fix in with a regression test.
    lastRenderCall = null;
    const intro = "https://storage.googleapis.com/test-bucket/segments/i1.mp4";
    const outro = "https://storage.googleapis.com/test-bucket/segments/o1.mp4";
    const { status } = await post("/render", {
      auth: `Bearer ${SECRET}`,
      body: {
        storyId: "envelope",
        configHash: "abc",
        inputProps: {},
        segments: { intro, outro, outroLeadInSec: 1.5 },
      },
    });
    assert.equal(status, 200);
    assert.deepEqual(lastRenderCall.segments, {
      intro,
      outro,
      outroLeadInSec: 1.5,
    });
  });
});

// _plans/2026-06-28-phase-2-social-poster-render.md.
// The /render-poster endpoint mirrors /render's HTTP layer (auth + body
// validation + error mapping) but invokes the renderStill seam instead
// of renderMedia. These tests stub the renderer so we're testing the
// HTTP layer end-to-end without spinning up Remotion.

const STORY = "envelope";
const VALID_HASH = "a1b2c3d4e5f60718";
const VALID_POSTER_BODY = {
  storyId: STORY,
  hash: VALID_HASH,
  inputProps: {
    scene_1_url: "https://media.lorewire.com/envelope-short/frame-00.png",
    text: "Her wedding dress was destroyed the morning of the ceremony.",
    brand_text: "LORE WIRE",
  },
};

describe("Cloud Run render service /render-poster auth", () => {
  it("returns 401 when Authorization header missing", async () => {
    const { status, body } = await post("/render-poster", {
      body: VALID_POSTER_BODY,
    });
    assert.equal(status, 401);
    assert.equal(body.error, "unauthorized");
  });

  it("returns 401 when token is wrong", async () => {
    const { status } = await post("/render-poster", {
      auth: "Bearer wrong",
      body: VALID_POSTER_BODY,
    });
    assert.equal(status, 401);
  });
});

describe("Cloud Run render service /render-poster body validation", () => {
  it("returns 400 when body is missing", async () => {
    const { status, body } = await post("/render-poster", {
      auth: `Bearer ${SECRET}`,
    });
    assert.equal(status, 400);
    assert.match(body.error, /storyId/);
  });

  it("returns 400 when storyId is missing", async () => {
    const { status } = await post("/render-poster", {
      auth: `Bearer ${SECRET}`,
      body: { ...VALID_POSTER_BODY, storyId: undefined },
    });
    assert.equal(status, 400);
  });

  it("returns 400 when hash doesn't match the required hex format", async () => {
    for (const badHash of ["", "../escape", "Z" + VALID_HASH.slice(1), "abc", "a".repeat(33)]) {
      const { status } = await post("/render-poster", {
        auth: `Bearer ${SECRET}`,
        body: { ...VALID_POSTER_BODY, hash: badHash },
      });
      assert.equal(status, 400, `hash=${JSON.stringify(badHash)} should be rejected`);
    }
  });

  it("returns 400 when inputProps is missing or non-object", async () => {
    for (const bad of [null, "props", 42, []]) {
      const { status } = await post("/render-poster", {
        auth: `Bearer ${SECRET}`,
        body: { ...VALID_POSTER_BODY, inputProps: bad },
      });
      assert.equal(status, 400, `inputProps=${JSON.stringify(bad)} should be rejected`);
    }
  });

  it("returns 400 when scene_1_url is missing or too long", async () => {
    for (const badUrl of ["", "x".repeat(2001), null, 42]) {
      const { status } = await post("/render-poster", {
        auth: `Bearer ${SECRET}`,
        body: {
          ...VALID_POSTER_BODY,
          inputProps: { ...VALID_POSTER_BODY.inputProps, scene_1_url: badUrl },
        },
      });
      assert.equal(status, 400, `scene_1_url=${JSON.stringify(badUrl)?.slice(0, 30)} should be rejected`);
    }
  });

  it("returns 400 when text is missing or empty", async () => {
    for (const badText of [undefined, "", null, 42]) {
      const { status } = await post("/render-poster", {
        auth: `Bearer ${SECRET}`,
        body: {
          ...VALID_POSTER_BODY,
          inputProps: { ...VALID_POSTER_BODY.inputProps, text: badText },
        },
      });
      assert.equal(status, 400, `text=${JSON.stringify(badText)} should be rejected`);
    }
  });

  it("returns 400 when text is too long", async () => {
    const { status } = await post("/render-poster", {
      auth: `Bearer ${SECRET}`,
      body: {
        ...VALID_POSTER_BODY,
        inputProps: { ...VALID_POSTER_BODY.inputProps, text: "x".repeat(281) },
      },
    });
    assert.equal(status, 400);
  });
});

describe("Cloud Run render service /render-poster success path", () => {
  it("returns the URL + elapsed_ms + hash from the renderer", async () => {
    lastPosterRenderCall = null;
    const { status, body } = await post("/render-poster", {
      auth: `Bearer ${SECRET}`,
      body: VALID_POSTER_BODY,
    });
    assert.equal(status, 200);
    assert.equal(
      body.url,
      `https://storage.googleapis.com/test-bucket/${STORY}-short/poster-${VALID_HASH}.png`,
    );
    assert.equal(body.elapsed_ms, 678);
    assert.equal(body.hash, VALID_HASH);
    // The renderer saw the (storyId, hash, inputProps) tuple intact.
    assert.equal(lastPosterRenderCall.storyId, STORY);
    assert.equal(lastPosterRenderCall.hash, VALID_HASH);
    assert.equal(
      lastPosterRenderCall.inputProps.text,
      "Her wedding dress was destroyed the morning of the ceremony.",
    );
  });

  it("normalizes a missing optional brand_text to undefined", async () => {
    lastPosterRenderCall = null;
    const { status } = await post("/render-poster", {
      auth: `Bearer ${SECRET}`,
      body: {
        ...VALID_POSTER_BODY,
        inputProps: {
          scene_1_url: VALID_POSTER_BODY.inputProps.scene_1_url,
          text: VALID_POSTER_BODY.inputProps.text,
        },
      },
    });
    assert.equal(status, 200);
    assert.equal(lastPosterRenderCall.inputProps.brand_text, undefined);
  });
});

describe("Cloud Run render service /render-poster error mapping", () => {
  it("returns 500 with the error message when the renderer throws", async () => {
    const { status, body } = await post("/render-poster", {
      auth: `Bearer ${SECRET}`,
      body: { ...VALID_POSTER_BODY, storyId: "poster-boom" },
    });
    assert.equal(status, 500);
    assert.match(body.error, /renderStill failed/);
  });
});
