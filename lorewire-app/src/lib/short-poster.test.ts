// Tests for the ensureShortPoster helper. Per
// _plans/2026-06-28-phase-2-social-poster-render.md (Part 3).
//
// The helper now generates `poster_text` via a DEDICATED LLM call
// inside `ensureShortPoster` and caches it on `stories.short_config`
// — separate from the script LLM in pipeline/shorts_narration.py so
// the video script + MP4 + hero stay byte-identical to a pre-Phase-2
// run (the social-only invariant).
//
// Coverage:
//   * computePosterHash determinism
//   * kill switch
//   * cached short_config.poster_text → HEAD hit / HEAD miss → POST render
//   * missing cache → LLM call → persist → render
//   * LLM failure → spoken hook fallback
//   * LLM failure + no hook → null
//   * guard rejections (glyph / RTL / profanity / all-caps / too long)
//   * missing data paths
//   * HEAD network error → POST fallback
//   * Cloud Run failure modes (5xx, 200-but-empty, env-missing)
//   * payload shape (single `text` field, no `hook`/`poster_text`
//     duals — PosterStill takes a single resolved text)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "@/lib/db";
import {
  computePosterHash,
  ensureShortPoster,
  type EnsureShortPosterDeps,
} from "@/lib/short-poster";
import type { ChatResult } from "@/lib/llm";

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

/** Capturing chat stub. Records every call so a test can assert "the
 *  helper called the LLM exactly N times" and inspect the prompt the
 *  helper assembled. */
function makeChatStub(result: ChatResult): {
  chat: NonNullable<EnsureShortPosterDeps["chat"]>;
  calls: Array<{ modelId: string; systemContent: string; userContent: string }>;
} {
  const calls: Array<{ modelId: string; systemContent: string; userContent: string }> = [];
  const chat: NonNullable<EnsureShortPosterDeps["chat"]> = async (opts) => {
    const system = opts.messages.find((m) => m.role === "system");
    const user = opts.messages.find((m) => m.role === "user");
    calls.push({
      modelId: opts.modelId,
      systemContent: system?.content ?? "",
      userContent: user?.content ?? "",
    });
    return result;
  };
  return { chat, calls };
}

const pickModelStub: NonNullable<EnsureShortPosterDeps["pickModel"]> = async () =>
  "openai/gpt-5-test";

/** Seed a stories row + the freshest `done` short_renders row that
 *  the helper reads scene_1_url + hook from. `posterTextOnConfig`
 *  optionally writes a cached `poster_text` to `stories.short_config`
 *  so the helper hits the cache path instead of the LLM path. */
async function seedStory(
  storyId: string,
  opts: {
    props: Record<string, unknown>;
    posterTextOnConfig?: string;
    storyBody?: string;
    storyTitle?: string;
  },
): Promise<void> {
  await run(`DELETE FROM short_renders WHERE story_id = ?`, [storyId]);
  await run(`DELETE FROM stories WHERE id = ?`, [storyId]);
  const shortConfig = opts.posterTextOnConfig
    ? JSON.stringify({ poster_text: opts.posterTextOnConfig })
    : null;
  await run(
    `INSERT INTO stories (id, title, body, summary, status, short_config) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      storyId,
      opts.storyTitle ?? "T",
      opts.storyBody ?? "Body of the story.",
      "S",
      "published",
      shortConfig,
    ],
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
      JSON.stringify(opts.props),
      "test",
      "2026-06-29T00:00:00Z",
      "2026-06-29T00:01:00Z",
    ],
  );
}

/** Read `stories.short_config.poster_text` so a test can assert the
 *  helper persisted a freshly-generated line back to the cache. */
async function readPersistedPosterText(storyId: string): Promise<string | null> {
  // Use a direct sqlite read via the same db helper to avoid pulling
  // in the full repo module (which is server-only).
  const { one } = await import("@/lib/db");
  const row = await one<{ short_config: string | null }>(
    `SELECT short_config FROM stories WHERE id = ?`,
    [storyId],
  );
  if (!row?.short_config) return null;
  try {
    const parsed = JSON.parse(row.short_config) as { poster_text?: unknown };
    return typeof parsed.poster_text === "string" ? parsed.poster_text : null;
  } catch {
    return null;
  }
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

  it("changes when the text changes", () => {
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
    const chat = makeChatStub({ ok: true, content: "ignored", provider: "test", model: "test" });
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("0"),
      chat: chat.chat,
      pickModel: pickModelStub,
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
    // Kill switch fires before LLM dial.
    expect(chat.calls).toHaveLength(0);
  });

  it("treats unset setting as enabled (default ON)", async () => {
    // No short_renders row seeded → returns null with reason
    // missing_render_props; the kill switch is NOT what filtered.
    const stub = makeFetchStub([]);
    const chat = makeChatStub({ ok: true, content: "ignored", provider: "test", model: "test" });
    const result = await ensureShortPoster("never-seeded", {
      fetch: stub.fetch,
      settings: makeSettings(null),
      chat: chat.chat,
      pickModel: pickModelStub,
    });
    expect(result).toBeNull();
  });
});

describe("ensureShortPoster — happy paths", () => {
  it("uses cached short_config.poster_text on HEAD hit (no LLM call)", async () => {
    await seedStory(STORY, {
      props: {
        doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
        hook: "Eight hundred dollars. Gone.",
      },
      posterTextOnConfig: "Her wedding dress was destroyed the morning of the ceremony.",
    });
    const stub = makeFetchStub([
      { ok: true, status: 200 }, // HEAD cache hit
    ]);
    const chat = makeChatStub({ ok: true, content: "SHOULD NOT BE CALLED", provider: "test", model: "test" });
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: chat.chat,
      pickModel: pickModelStub,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.source).toBe("cached");
    expect(result.url).toContain("media.lorewire.com");
    expect(result.url).toContain("-short/poster-");
    // The returned URL carries `?v=<hash>` so each unique URL is a
    // fresh CDN cache key — important for the publisher fetch on a
    // first-publish HEAD-miss path, and matches the OG poster URL
    // shape for cross-platform crawler cache-busting.
    expect(result.url).toMatch(/poster-[a-f0-9]{16}\.png\?v=[a-f0-9]{16}$/);
    expect(result.url.endsWith(`?v=${result.hash}`)).toBe(true);
    expect(result.hash).toMatch(/^[a-f0-9]{16}$/);
    expect(result.alt).toContain("Lorewire short:");
    expect(result.alt).toContain("Her wedding dress");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("HEAD");
    // Cache hit means NO LLM dial.
    expect(chat.calls).toHaveLength(0);
  });

  it("posts to Cloud Run /render-poster with a single `text` prop on HEAD miss", async () => {
    await seedStory(STORY, {
      props: {
        doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
        hook: "Eight hundred dollars. Gone.",
      },
      posterTextOnConfig: "She refused. He emptied their joint account by morning.",
    });
    const stub = makeFetchStub([
      { ok: false, status: 404 }, // HEAD miss (cache check)
      { ok: true, status: 200, body: {
        url: "https://media.lorewire.com/story-poster-test-1-short/poster-abc123.png",
        elapsed_ms: 700,
        hash: "abc123",
      } },
      { ok: true, status: 200 }, // verify HEAD: object is readable
    ]);
    const chat = makeChatStub({ ok: true, content: "SHOULD NOT BE CALLED", provider: "test", model: "test" });
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: chat.chat,
      pickModel: pickModelStub,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.source).toBe("rendered");
    // Returned URL is the deterministic poster URL + `?v=<hash>` cache
    // buster, not the raw `data.url` Cloud Run echoed back.
    expect(result.url).toMatch(
      /^https:\/\/media\.lorewire\.com\/story-poster-test-1-short\/poster-[a-f0-9]{16}\.png\?v=[a-f0-9]{16}$/,
    );
    expect(result.url.endsWith(`?v=${result.hash}`)).toBe(true);
    expect(stub.calls).toHaveLength(3);
    expect(stub.calls[1].url).toContain("/render-poster");
    expect(stub.calls[1].method).toBe("POST");
    expect(stub.calls[1].hasAuth).toBe(true);
    expect(stub.calls[2].method).toBe("HEAD"); // post-render verify
    expect(stub.calls[2].url).toBe(result.url);
    const sent = JSON.parse(stub.calls[1].body ?? "{}");
    expect(sent.storyId).toBe(STORY);
    // Single resolved `text` field — no dual hook/poster_text leak.
    expect(sent.inputProps.text).toContain("emptied their joint account");
    expect(sent.inputProps.hook).toBeUndefined();
    expect(sent.inputProps.poster_text).toBeUndefined();
    expect(sent.inputProps.brand_text).toBe("LORE WIRE");
  });

  it("rewrites a legacy GCS scene_1_url onto the R2 media base before rendering", async () => {
    const prev = process.env.MEDIA_PUBLIC_BASE;
    process.env.MEDIA_PUBLIC_BASE = "https://media.lorewire.com";
    try {
      await seedStory(STORY, {
        props: {
          doodle_frames: [
            {
              id: "frame-00",
              url: "https://storage.googleapis.com/aporia-unleash/story-poster-test-1-short/frame-00.webp?v=abc123",
            },
          ],
          hook: "A hook.",
        },
        posterTextOnConfig:
          "She refused. He emptied their joint account by morning.",
      });
      const stub = makeFetchStub([
        { ok: false, status: 404 }, // HEAD miss
        {
          ok: true,
          status: 200,
          body: {
            url: "https://media.lorewire.com/story-poster-test-1-short/poster-r2.png",
            elapsed_ms: 700,
            hash: "r2scene",
          },
        },
        { ok: true, status: 200 }, // verify HEAD: object readable
      ]);
      const result = await ensureShortPoster(STORY, {
        fetch: stub.fetch,
        settings: makeSettings("1"),
        chat: makeChatStub({ ok: true, content: "x", provider: "t", model: "t" })
          .chat,
        pickModel: pickModelStub,
      });
      expect(result).not.toBeNull();
      const postCall = stub.calls.find((c) => c.method === "POST");
      expect(postCall).toBeDefined();
      const sent = JSON.parse(postCall?.body ?? "{}");
      // The stored GCS URL is rewritten onto media.lorewire.com (query preserved)
      // so Cloud Run loads the migrated R2 object instead of the dead GCS one.
      expect(sent.inputProps.scene_1_url).toBe(
        "https://media.lorewire.com/story-poster-test-1-short/frame-00.webp?v=abc123",
      );
    } finally {
      if (prev === undefined) delete process.env.MEDIA_PUBLIC_BASE;
      else process.env.MEDIA_PUBLIC_BASE = prev;
    }
  });
});

describe("ensureShortPoster — lazy LLM generation", () => {
  it("calls LLM, persists to short_config, then renders when poster_text is unset", async () => {
    await seedStory(STORY, {
      props: {
        doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
        hook: "Eight hundred dollars. Gone.",
      },
      // posterTextOnConfig deliberately omitted — forces the LLM path.
      storyBody:
        "After ten years of marriage, she walked into the kitchen and " +
        "found the joint account drained to zero. The note on the fridge " +
        "said only: 'I needed it more than us.'",
      storyTitle: "The empty kitchen",
    });
    const generated = "She found the joint account drained to zero overnight.";
    const stub = makeFetchStub([
      { ok: false, status: 404 }, // HEAD miss
      { ok: true, status: 200, body: {
        url: "https://media.lorewire.com/story-poster-test-1-short/poster-gen.png",
        elapsed_ms: 700,
        hash: "gen",
      } },
      { ok: true, status: 200 }, // verify HEAD
    ]);
    const chat = makeChatStub({ ok: true, content: generated, provider: "openai", model: "gpt-5-test" });

    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: chat.chat,
      pickModel: pickModelStub,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.source).toBe("rendered");
    // LLM was called exactly once with the right model + the right
    // prompt shape (system prompt mentions the social-cover voice).
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0].modelId).toBe("openai/gpt-5-test");
    expect(chat.calls[0].systemContent).toContain("social-media cover tile");
    // The spoken hook was passed as tone-alignment context.
    expect(chat.calls[0].userContent).toContain("Eight hundred dollars. Gone.");
    expect(chat.calls[0].userContent).toContain("kitchen");
    // The generated line was persisted to short_config so the next
    // publish hits cache.
    const persisted = await readPersistedPosterText(STORY);
    expect(persisted).toBe(generated);
    // The render POST sent the freshly-generated text.
    const sent = JSON.parse(stub.calls[1].body ?? "{}");
    expect(sent.inputProps.text).toBe(generated);
  });

  it("strips wrapping quotes the LLM occasionally returns", async () => {
    await seedStory(STORY, {
      props: {
        doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
      },
    });
    const stub = makeFetchStub([
      { ok: false, status: 404 },
      { ok: true, status: 200, body: { url: "https://media.lorewire.com/x.png", hash: "h" } },
      { ok: true, status: 200 }, // verify HEAD
    ]);
    const chat = makeChatStub({
      ok: true,
      content: '"She refused. He emptied their joint account by morning."',
      provider: "openai",
      model: "gpt-5-test",
    });
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: chat.chat,
      pickModel: pickModelStub,
    });
    expect(result).not.toBeNull();
    const persisted = await readPersistedPosterText(STORY);
    expect(persisted).toBe("She refused. He emptied their joint account by morning.");
  });

  it("falls back to the spoken hook when the LLM call returns an error", async () => {
    await seedStory(STORY, {
      props: {
        doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
        hook: "Eight hundred dollars. Gone.",
      },
    });
    const stub = makeFetchStub([
      { ok: false, status: 404 },
      { ok: true, status: 200, body: {
        url: "https://media.lorewire.com/x.png",
        hash: "h",
      } },
      { ok: true, status: 200 }, // verify HEAD
    ]);
    const chat = makeChatStub({ ok: false, error: "openai 503 backend timeout" });
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: chat.chat,
      pickModel: pickModelStub,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.alt).toContain("Eight hundred dollars");
    // We did NOT persist anything when the LLM failed — next publish
    // should retry the LLM, not freeze the hook on the cache forever.
    const persisted = await readPersistedPosterText(STORY);
    expect(persisted).toBeNull();
    // Render POST received the hook (fallback path).
    const sent = JSON.parse(stub.calls[1].body ?? "{}");
    expect(sent.inputProps.text).toBe("Eight hundred dollars. Gone.");
  });

  it("returns null when the LLM fails AND there's no hook to fall back to", async () => {
    await seedStory(STORY, {
      props: {
        doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
        // no hook, no poster_text — exhausts every text source.
      },
    });
    const stub = makeFetchStub([]);
    const chat = makeChatStub({ ok: false, error: "openai 503" });
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: chat.chat,
      pickModel: pickModelStub,
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });
});

describe("ensureShortPoster — guard rejections", () => {
  const baseProps = {
    doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
  };
  const noopChat = makeChatStub({ ok: true, content: "unused", provider: "t", model: "t" });

  it("rejects non-Latin characters (RTL / glyph guard)", async () => {
    await seedStory(STORY, {
      props: baseProps,
      posterTextOnConfig: "השמלה נהרסה בבוקר החתונה.", // Hebrew
    });
    const stub = makeFetchStub([]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: noopChat.chat,
      pickModel: pickModelStub,
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

  it("allows all-caps text (the composition uppercases it anyway)", async () => {
    await seedStory(STORY, {
      props: {
        doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
        hook: "Eight hundred dollars. Gone.",
      },
      posterTextOnConfig: "YOU WILL NEVER BELIEVE WHAT HAPPENED NEXT.",
    });
    const stub = makeFetchStub([
      { ok: false, status: 404 }, // HEAD miss
      { ok: true, status: 200, body: {
        url: "https://media.lorewire.com/story-poster-test-1-short/poster-caps1.png",
        elapsed_ms: 700,
        hash: "caps1",
      } },
      { ok: true, status: 200 }, // verify HEAD
    ]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: noopChat.chat,
      pickModel: pickModelStub,
    });
    // All-caps now passes the guard -> renders, verifies, returns URL.
    expect(result).not.toBeNull();
    expect(stub.calls).toHaveLength(3);
    const sent = JSON.parse(stub.calls[1].body ?? "{}");
    expect(sent.inputProps.text).toBe("YOU WILL NEVER BELIEVE WHAT HAPPENED NEXT.");
  });

  it("rejects profanity", async () => {
    await seedStory(STORY, {
      props: baseProps,
      posterTextOnConfig: "He found the damn envelope under the casserole.",
    });
    const stub = makeFetchStub([]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: noopChat.chat,
      pickModel: pickModelStub,
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects text over 280 chars", async () => {
    await seedStory(STORY, {
      props: baseProps,
      posterTextOnConfig: "x".repeat(281),
    });
    const stub = makeFetchStub([]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: noopChat.chat,
      pickModel: pickModelStub,
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });
});

describe("ensureShortPoster — missing data", () => {
  const noopChat = makeChatStub({ ok: true, content: "unused", provider: "t", model: "t" });

  it("returns null when no short_renders row exists", async () => {
    await run(`DELETE FROM short_renders WHERE story_id = ?`, ["never-seeded-2"]);
    const stub = makeFetchStub([]);
    const result = await ensureShortPoster("never-seeded-2", {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: noopChat.chat,
      pickModel: pickModelStub,
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

  it("returns null when scene_1_url is missing", async () => {
    await seedStory(STORY, {
      props: { doodle_frames: [] },
      posterTextOnConfig: "Some valid text.",
    });
    const stub = makeFetchStub([]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: noopChat.chat,
      pickModel: pickModelStub,
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });
});

describe("ensureShortPoster — failure paths", () => {
  beforeEach(async () => {
    await seedStory(STORY, {
      props: {
        doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
      },
      posterTextOnConfig: "Her wedding dress was destroyed the morning of the ceremony.",
    });
  });
  const noopChat = makeChatStub({ ok: true, content: "unused", provider: "t", model: "t" });

  it("treats HEAD network error as cache miss and falls through to POST", async () => {
    const stub = makeFetchStub([
      { throws: new Error("ECONNRESET") }, // HEAD network error
      { ok: true, status: 200, body: {
        url: "https://media.lorewire.com/story-poster-test-1-short/poster-xyz.png",
        elapsed_ms: 700,
        hash: "xyz",
      } },
      { ok: true, status: 200 }, // verify HEAD
    ]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: noopChat.chat,
      pickModel: pickModelStub,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.source).toBe("rendered");
    expect(stub.calls).toHaveLength(3);
  });

  it("returns null when Cloud Run returns 500", async () => {
    const stub = makeFetchStub([
      { ok: false, status: 404 }, // HEAD miss
      { ok: false, status: 500, bodyText: "internal error" },
    ]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: noopChat.chat,
      pickModel: pickModelStub,
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
      chat: noopChat.chat,
      pickModel: pickModelStub,
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
      chat: noopChat.chat,
      pickModel: pickModelStub,
    });
    expect(result).toBeNull();
    // HEAD ran, then we noticed CLOUD_RUN env missing and aborted.
    expect(stub.calls).toHaveLength(1);
  });
});

// The readiness verify is the fix for the
// "first publish has no thumbnail, second publish does" bug. The race:
// Cloud Run confirms the PUT to R2, but the publishers fetch the URL
// through MEDIA_PUBLIC_BASE (Cloudflare custom domain), where a
// brand-new object isn't always immediately visible. Without the
// verify, FB / IG / YT all silently fall back to no-cover on the
// first publish; by the time the second publish runs, the object has
// propagated and HEAD-cache hits short-circuit the race entirely —
// hence the symptom.
describe("ensureShortPoster — readiness verify (propagation race fix)", () => {
  beforeEach(async () => {
    await seedStory(STORY, {
      props: {
        doodle_frames: [
          { id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" },
        ],
      },
      posterTextOnConfig:
        "Her wedding dress was destroyed the morning of the ceremony.",
    });
  });
  const noopChat = makeChatStub({
    ok: true,
    content: "unused",
    provider: "t",
    model: "t",
  });

  it("returns the rendered URL when the verify HEAD succeeds on the first attempt", async () => {
    const stub = makeFetchStub([
      { ok: false, status: 404 }, // cache HEAD miss
      {
        ok: true,
        status: 200,
        body: {
          url: "https://media.lorewire.com/story-poster-test-1-short/poster-fresh.png",
          hash: "fresh",
        },
      },
      { ok: true, status: 200 }, // verify HEAD: ready on first probe
    ]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: noopChat.chat,
      pickModel: pickModelStub,
      verifyBackoffsMs: [0, 0, 0, 0],
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.source).toBe("rendered");
    expect(result.url.endsWith(`?v=${result.hash}`)).toBe(true);
    expect(stub.calls).toHaveLength(3);
    expect(stub.calls[2].method).toBe("HEAD");
    expect(stub.calls[2].url).toBe(result.url);
  });

  it("retries the verify HEAD when the object is briefly invisible at the edge", async () => {
    const stub = makeFetchStub([
      { ok: false, status: 404 }, // cache HEAD miss
      {
        ok: true,
        status: 200,
        body: {
          url: "https://media.lorewire.com/story-poster-test-1-short/poster-late.png",
          hash: "late",
        },
      },
      { ok: false, status: 404 }, // verify HEAD #1: not yet propagated
      { ok: false, status: 404 }, // verify HEAD #2: still propagating
      { ok: true, status: 200 }, // verify HEAD #3: now readable
    ]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: noopChat.chat,
      pickModel: pickModelStub,
      // Zero backoffs keep the test fast while still exercising the
      // retry loop — production sleeps between attempts.
      verifyBackoffsMs: [0, 0, 0, 0],
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.source).toBe("rendered");
    expect(result.url).toContain("?v=");
    expect(stub.calls).toHaveLength(5);
    // The verify probes the SAME URL the publisher will fetch — so a
    // 200 here guarantees the publisher's subsequent GET also hits a
    // warm cache entry on the same key.
    expect(stub.calls[2].url).toBe(result.url);
    expect(stub.calls[3].url).toBe(result.url);
    expect(stub.calls[4].url).toBe(result.url);
  });

  it("returns null when the verify never sees the object (propagation timeout)", async () => {
    const stub = makeFetchStub([
      { ok: false, status: 404 }, // cache HEAD miss
      {
        ok: true,
        status: 200,
        body: {
          url: "https://media.lorewire.com/story-poster-test-1-short/poster-stuck.png",
          hash: "stuck",
        },
      },
      { ok: false, status: 404 }, // verify HEAD #1
      { ok: false, status: 404 }, // verify HEAD #2
      { ok: false, status: 404 }, // verify HEAD #3
      { ok: false, status: 404 }, // verify HEAD #4 (final budget)
    ]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: noopChat.chat,
      pickModel: pickModelStub,
      verifyBackoffsMs: [0, 0, 0, 0],
    });
    // Null → publisher falls back to scene-1 instead of a 404-thumbnail
    // URL the platform would silently drop.
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(6);
  });

  it("treats verify network errors as a miss and keeps retrying", async () => {
    const stub = makeFetchStub([
      { ok: false, status: 404 }, // cache HEAD miss
      {
        ok: true,
        status: 200,
        body: {
          url: "https://media.lorewire.com/story-poster-test-1-short/poster-net.png",
          hash: "net",
        },
      },
      { throws: new Error("ETIMEDOUT") }, // verify HEAD #1: network blip
      { ok: true, status: 200 }, // verify HEAD #2: ok
    ]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: noopChat.chat,
      pickModel: pickModelStub,
      verifyBackoffsMs: [0, 0, 0, 0],
    });
    expect(result).not.toBeNull();
    expect(stub.calls).toHaveLength(4);
  });

  it("skips the verify entirely when the cache HEAD hits (no race possible)", async () => {
    const stub = makeFetchStub([
      { ok: true, status: 200 }, // cache HEAD hit
    ]);
    const result = await ensureShortPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: noopChat.chat,
      pickModel: pickModelStub,
      verifyBackoffsMs: [0, 0, 0, 0],
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.source).toBe("cached");
    expect(result.url).toMatch(/\?v=[a-f0-9]{16}$/);
    // Just the one HEAD — no render, no verify.
    expect(stub.calls).toHaveLength(1);
  });
});
