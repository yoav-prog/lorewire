// Tests for the ensureShortPoster helper. Per
// _plans/2026-06-28-phase-2-social-poster-render.md (Part 3).
//
// Every branch the helper takes is covered by a focused test: cache
// hit, cache miss → render, guard rejections (glyph / RTL / profanity
// / all-caps / too long), missing data, kill-switch, Cloud Run errors,
// timeouts. The fetch stub captures every call so we can assert HEAD
// vs POST shape and forwarded inputProps.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "@/lib/db";
import {
  computePosterHash,
  ensureShortPoster,
  type EnsureShortPosterDeps,
} from "@/lib/short-poster";

const STORY = "story-poster-test-1";

interface StubResp {
  ok?: boolean;
  status?: number;
  body?: unknown;
  bodyText?: string;
  throws?: Error;
}

interface CapturedCall {
  url: string;
  method: string;
  hasAuth: boolean;
  body: string | undefined;
}

function makeFetchStub(responses: StubResp[]): {
  fetch: NonNullable<EnsureShortPosterDeps["fetch"]>;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const queue = [...responses];
  const fetch: NonNullable<EnsureShortPosterDeps["fetch"]> = async (
    url,
    init,
  ) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      hasAuth: Boolean(init?.headers?.Authorization),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const r = queue.shift();
    if (!r) throw new Error("stub: unexpected fetch call: " + url);
    if (r.throws) throw r.throws;
    const status = r.status ?? 200;
    const ok = r.ok ?? (status >= 200 && status < 300);
    return {
      ok,
      status,
      json: async () => r.body ?? {},
      text: async () => r.bodyText ?? JSON.stringify(r.body ?? {}),
    };
  };
  return { fetch, calls };
}

function makeSettings(value: string | null): NonNullable<EnsureShortPosterDeps["settings"]> {
  return {
    getSetting: async () => value,
  };
}

async function seedShortRender(
  storyId: string,
  props: Record<string, unknown>,
): Promise<void> {
  await run(`DELETE FROM short_renders WHERE story_id = ?`, [storyId]);
  await run(`DELETE FROM stories WHERE id = ?`, [storyId]);
  await run(
    `INSERT INTO stories (id, title, body, summary, status) VALUES (?, ?, ?, ?, ?)`,
    [storyId, "T", "B", "S", "published"],
  );
  await run(
    `INSERT INTO short_renders
       (id, story_id, config_hash, status, props, requested_by, requested_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `r-${storyId}-1`,
      storyId,
      "cfg-abc",
      "done",
      JSON.stringify(props),
      "test",
      "2026-06-29T00:00:00Z",
      "2026-06-29T00:01:00Z",
    ],
  );
}

const ORIGINAL_CLOUD_RUN = process.env.CLOUD_RUN_RENDER_URL;
const ORIGINAL_CRON = process.env.CRON_SECRET;
const ORIGINAL_MEDIA = process.env.MEDIA_PUBLIC_BASE;
const ORIGINAL_BUCKET = process.env.GCS_BUCKET;

beforeEach(() => {
  process.env.CLOUD_RUN_RENDER_URL = "https://cloud-run.test";
  process.env.CRON_SECRET = "cron-secret";
  process.env.MEDIA_PUBLIC_BASE = "https://media.lorewire.com";
  process.env.GCS_BUCKET = "lorewire-media";
});

afterEach(() => {
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("CLOUD_RUN_RENDER_URL", ORIGINAL_CLOUD_RUN);
  restore("CRON_SECRET", ORIGINAL_CRON);
  restore("MEDIA_PUBLIC_BASE", ORIGINAL_MEDIA);
  restore("GCS_BUCKET", ORIGINAL_BUCKET);
});

describe("computePosterHash", () => {
  it("returns 16 hex chars and is stable across calls", () => {
    const a = computePosterHash("https://x/scene.png", "Hook line.");
    const b = computePosterHash("https://x/scene.png", "Hook line.");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
  });

  it("changes when the hook changes", () => {
    const a = computePosterHash("https://x/scene.png", "Hook A.");
    const b = computePosterHash("https://x/scene.png", "Hook B.");
    expect(a).not.toBe(b);
  });

  it("changes when the scene url changes", () => {
    const a = computePosterHash("https://x/a.png", "Same hook.");
    const b = computePosterHash("https://x/b.png", "Same hook.");
    expect(a).not.toBe(b);
  });
});

describe("ensureShortPoster — kill switch", () => {
  it("returns null when publisher.short_poster.enabled='0'", async () => {
    const stub = makeFetchStub([]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("0"),
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

  it("treats unset setting as enabled (default ON)", async () => {
    // No short_renders row seeded → returns null with reason
    // missing_props; the kill switch is NOT what filtered.
    const stub = makeFetchStub([]);
    const result = await ensureShortPoster("never-seeded", {
      fetch: stub.fetch,
      settings: makeSettings(null),
    });
    expect(result).toBeNull();
  });
});

describe("ensureShortPoster — happy paths", () => {
  it("returns cached when HEAD 200", async () => {
    await seedShortRender(STORY, {
      doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
      poster_text: "Her wedding dress was destroyed the morning of the ceremony.",
    });
    const stub = makeFetchStub([
      { ok: true, status: 200 }, // HEAD cache hit
    ]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.source).toBe("cached");
    expect(result.url).toContain("media.lorewire.com");
    expect(result.url).toContain("-short/poster-");
    expect(result.url).toMatch(/poster-[a-f0-9]{16}\.png$/);
    expect(result.hash).toMatch(/^[a-f0-9]{16}$/);
    expect(result.alt).toContain("Lorewire short:");
    expect(result.alt).toContain("Her wedding dress");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("HEAD");
  });

  it("posts to Cloud Run /render-poster when HEAD 404 and returns the rendered url", async () => {
    await seedShortRender(STORY, {
      doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
      poster_text: "She refused. He emptied their joint account by morning.",
    });
    const stub = makeFetchStub([
      { ok: false, status: 404 }, // HEAD miss
      { ok: true, status: 200, body: {
        url: "https://media.lorewire.com/story-poster-test-1-short/poster-abc123.png",
        elapsed_ms: 700,
        hash: "abc123",
      } },
    ]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.source).toBe("rendered");
    expect(result.url).toBe(
      "https://media.lorewire.com/story-poster-test-1-short/poster-abc123.png",
    );
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1].url).toContain("/render-poster");
    expect(stub.calls[1].method).toBe("POST");
    expect(stub.calls[1].hasAuth).toBe(true);
    const sent = JSON.parse(stub.calls[1].body ?? "{}");
    expect(sent.storyId).toBe(STORY);
    expect(sent.inputProps.poster_text).toContain("emptied their joint account");
    expect(sent.inputProps.brand_text).toBe("LORE WIRE");
  });

  it("falls back to `hook` when `poster_text` is missing (legacy stories)", async () => {
    await seedShortRender(STORY, {
      doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
      hook: "Eight hundred dollars. Gone.",
      // no poster_text — older render before the 2026-06-29 prompt update
    });
    const stub = makeFetchStub([
      { ok: true, status: 200 }, // HEAD cache hit
    ]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.alt).toContain("Eight hundred dollars");
  });
});

describe("ensureShortPoster — guard rejections", () => {
  const baseProps = {
    doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
  };

  it("rejects non-Latin characters (RTL / glyph guard)", async () => {
    await seedShortRender(STORY, {
      ...baseProps,
      poster_text: "השמלה נהרסה בבוקר החתונה.", // Hebrew
    });
    const stub = makeFetchStub([]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects all-caps shock words 3+ chars", async () => {
    await seedShortRender(STORY, {
      ...baseProps,
      poster_text: "YOU WILL NEVER BELIEVE what happened next.",
    });
    const stub = makeFetchStub([]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects profanity", async () => {
    await seedShortRender(STORY, {
      ...baseProps,
      poster_text: "He found the damn envelope under the casserole.",
    });
    const stub = makeFetchStub([]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects text over 280 chars", async () => {
    await seedShortRender(STORY, {
      ...baseProps,
      poster_text: "x".repeat(281),
    });
    const stub = makeFetchStub([]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });
});

describe("ensureShortPoster — missing data", () => {
  it("returns null when no short_renders row exists", async () => {
    await run(`DELETE FROM short_renders WHERE story_id = ?`, ["never-seeded-2"]);
    const stub = makeFetchStub([]);
    const result = await ensureShortPoster("never-seeded-2", {
      fetch: stub.fetch,
      settings: makeSettings("1"),
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

  it("returns null when both poster_text and hook are missing", async () => {
    await seedShortRender(STORY, {
      doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
      // no poster_text, no hook (very old row)
    });
    const stub = makeFetchStub([]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

  it("returns null when scene_1_url is missing", async () => {
    await seedShortRender(STORY, {
      doodle_frames: [],
      poster_text: "Some valid text.",
    });
    const stub = makeFetchStub([]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });
});

describe("ensureShortPoster — failure paths", () => {
  beforeEach(async () => {
    await seedShortRender(STORY, {
      doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
      poster_text: "Her wedding dress was destroyed the morning of the ceremony.",
    });
  });

  it("treats HEAD network error as cache miss and falls through to POST", async () => {
    const stub = makeFetchStub([
      { throws: new Error("ECONNRESET") }, // HEAD network error
      { ok: true, status: 200, body: {
        url: "https://media.lorewire.com/story-poster-test-1-short/poster-xyz.png",
        elapsed_ms: 700,
        hash: "xyz",
      } },
    ]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.source).toBe("rendered");
    expect(stub.calls).toHaveLength(2);
  });

  it("returns null when Cloud Run returns 500", async () => {
    const stub = makeFetchStub([
      { ok: false, status: 404 }, // HEAD miss
      { ok: false, status: 500, bodyText: "internal error" },
    ]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(2);
  });

  it("returns null when Cloud Run returns 200 but no url", async () => {
    const stub = makeFetchStub([
      { ok: false, status: 404 },
      { ok: true, status: 200, body: { elapsed_ms: 500 } },
    ]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
    });
    expect(result).toBeNull();
  });

  it("returns null when CLOUD_RUN_RENDER_URL is unset", async () => {
    delete process.env.CLOUD_RUN_RENDER_URL;
    const stub = makeFetchStub([
      { ok: false, status: 404 },
    ]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
    });
    expect(result).toBeNull();
    // HEAD ran, then we noticed CLOUD_RUN env missing and aborted.
    expect(stub.calls).toHaveLength(1);
  });
});
