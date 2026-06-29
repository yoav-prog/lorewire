// Tests for the Phase 3 ensureOgPoster helper. Per
// _plans/2026-06-29-phase-3-og-poster-cards.md.
//
// ensureOgPoster is parallel to ensureShortPoster (Phase 2): same
// LLM call, same guards, same Cloud Run /render-poster endpoint —
// but renders LANDSCAPE 1200×630, writes to its own short_config
// fields (og_poster_landscape_url, og_poster_disabled,
// og_poster_attempted_at), and returns a query-string-versioned URL
// (`?v={hash}`) for platform cache invalidation.
//
// Coverage:
//   * computeOgPosterHash determinism + aspect-keying (portrait + landscape
//     hashes differ for the same scene + text)
//   * shouldReattemptOgPoster window math
//   * setting kill switch (og.short_poster.enabled='0')
//   * per-story kill switch (short_config.og_poster_disabled=true)
//   * cache hit returns versioned URL + stamps short_config
//   * cache miss → POST aspect="landscape" → renders → stamps URL+attempted_at
//   * LLM generation persists poster_text + stamps og_poster_*
//   * guard rejections (glyph / RTL / profanity / too long)
//     still stamp og_poster_attempted_at so backfill skips them
//   * Cloud Run failure stamps attempted_at (so backfill respects window)
//   * payload shape: aspect="landscape", single `text` field
//   * URL includes ?v={hash}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { one, run } from "@/lib/db";
import {
  computeOgPosterHash,
  computePosterHash,
  ensureOgPoster,
  shouldReattemptOgPoster,
  type EnsureOgPosterDeps,
} from "@/lib/short-poster";
import type { ChatResult } from "@/lib/llm";

const STORY = "story-og-poster-test-1";

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
  fetch: NonNullable<EnsureOgPosterDeps["fetch"]>;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const queue = [...responses];
  const fetch: NonNullable<EnsureOgPosterDeps["fetch"]> = async (
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

function makeSettings(value: string | null): NonNullable<EnsureOgPosterDeps["settings"]> {
  return { getSetting: async () => value };
}

function makeChatStub(result: ChatResult): {
  chat: NonNullable<EnsureOgPosterDeps["chat"]>;
  calls: number;
} {
  let calls = 0;
  const chat: NonNullable<EnsureOgPosterDeps["chat"]> = async () => {
    calls += 1;
    return result;
  };
  return {
    chat,
    get calls() {
      return calls;
    },
  };
}

const pickModelStub: NonNullable<EnsureOgPosterDeps["pickModel"]> = async () =>
  "openai/gpt-5-test";

/** Capturing persist stub. Records every short_config write so a test
 *  can assert exactly what landed (URL, attempted_at, disabled flag). */
function makePersistStub(): {
  persistConfig: NonNullable<EnsureOgPosterDeps["persistConfig"]>;
  writes: Array<{ storyId: string; config: Record<string, unknown> }>;
} {
  const writes: Array<{ storyId: string; config: Record<string, unknown> }> = [];
  const persistConfig: NonNullable<EnsureOgPosterDeps["persistConfig"]> = async (
    storyId,
    configJson,
  ) => {
    writes.push({ storyId, config: JSON.parse(configJson) });
  };
  return { persistConfig, writes };
}

/** Seed stories + short_renders rows. Extends the Phase 2 fixture
 *  pattern with the three new OG-poster fields so each test starts
 *  from a known state. */
async function seedStory(
  storyId: string,
  opts: {
    props: Record<string, unknown>;
    posterTextOnConfig?: string;
    ogPosterDisabled?: boolean;
    ogPosterAttemptedAtIso?: string;
    storyBody?: string;
    storyTitle?: string;
  },
): Promise<void> {
  await run(`DELETE FROM short_renders WHERE story_id = ?`, [storyId]);
  await run(`DELETE FROM stories WHERE id = ?`, [storyId]);
  const config: Record<string, unknown> = {};
  if (opts.posterTextOnConfig) config.poster_text = opts.posterTextOnConfig;
  if (opts.ogPosterDisabled !== undefined) config.og_poster_disabled = opts.ogPosterDisabled;
  if (opts.ogPosterAttemptedAtIso) config.og_poster_attempted_at = opts.ogPosterAttemptedAtIso;
  const shortConfig = Object.keys(config).length > 0 ? JSON.stringify(config) : null;
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

/** Read the current short_config off the DB so a test can assert the
 *  helper persisted a particular field. */
async function readShortConfig(
  storyId: string,
): Promise<Record<string, unknown> | null> {
  const row = await one<{ short_config: string | null }>(
    `SELECT short_config FROM stories WHERE id = ?`,
    [storyId],
  );
  if (!row?.short_config) return null;
  try {
    return JSON.parse(row.short_config) as Record<string, unknown>;
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

describe("computeOgPosterHash", () => {
  it("returns 16 hex chars and is deterministic", () => {
    const a = computeOgPosterHash("https://x/s.png", "Hook.");
    const b = computeOgPosterHash("https://x/s.png", "Hook.");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
  });

  it("hashes DIFFERENT from portrait for the same inputs (aspect-keyed)", () => {
    // The Contrarian peer-review flagged: portrait and landscape must
    // invalidate independently so a portrait-only edit doesn't break
    // the landscape cache (and vice versa). The hash includes the
    // literal "landscape" string to enforce this.
    const portrait = computePosterHash("https://x/s.png", "Hook.");
    const landscape = computeOgPosterHash("https://x/s.png", "Hook.");
    expect(portrait).not.toBe(landscape);
  });

  it("changes when text changes", () => {
    const a = computeOgPosterHash("https://x/s.png", "Hook A.");
    const b = computeOgPosterHash("https://x/s.png", "Hook B.");
    expect(a).not.toBe(b);
  });
});

describe("shouldReattemptOgPoster", () => {
  // Anchored "now" so the math is deterministic.
  const NOW = Date.parse("2026-06-29T12:00:00Z");

  it("returns true when no attempt has ever been made", () => {
    expect(shouldReattemptOgPoster(undefined, NOW)).toBe(true);
  });

  it("returns true when the timestamp is malformed", () => {
    expect(shouldReattemptOgPoster("not-a-date", NOW)).toBe(true);
  });

  it("returns false within the 7-day re-attempt window", () => {
    const sixDaysAgo = new Date(NOW - 6 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldReattemptOgPoster(sixDaysAgo, NOW)).toBe(false);
  });

  it("returns true exactly at 7 days", () => {
    const sevenDaysAgo = new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldReattemptOgPoster(sevenDaysAgo, NOW)).toBe(true);
  });

  it("returns true past the window", () => {
    const longAgo = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldReattemptOgPoster(longAgo, NOW)).toBe(true);
  });
});

describe("ensureOgPoster — kill switches", () => {
  it("returns null when og.short_poster.enabled='0'", async () => {
    const stub = makeFetchStub([]);
    const chat = makeChatStub({ ok: true, content: "x", provider: "t", model: "t" });
    const persist = makePersistStub();
    const result = await ensureOgPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("0"),
      chat: chat.chat,
      pickModel: pickModelStub,
      persistConfig: persist.persistConfig,
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
    expect(chat.calls).toBe(0);
    expect(persist.writes).toHaveLength(0);
  });

  it("returns null when short_config.og_poster_disabled=true (per-story kill)", async () => {
    await seedStory(STORY, {
      props: {
        doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
        hook: "Hook.",
      },
      posterTextOnConfig: "Designed line.",
      ogPosterDisabled: true,
    });
    const stub = makeFetchStub([]);
    const chat = makeChatStub({ ok: true, content: "x", provider: "t", model: "t" });
    const persist = makePersistStub();
    const result = await ensureOgPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: chat.chat,
      pickModel: pickModelStub,
      persistConfig: persist.persistConfig,
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
    expect(chat.calls).toBe(0);
    expect(persist.writes).toHaveLength(0);
  });
});

describe("ensureOgPoster — happy paths", () => {
  it("HEAD hit returns versioned URL + stamps og_poster_landscape_url + attempted_at", async () => {
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
    const chat = makeChatStub({ ok: true, content: "SHOULD NOT BE CALLED", provider: "t", model: "t" });
    const persist = makePersistStub();
    const result = await ensureOgPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: chat.chat,
      pickModel: pickModelStub,
      persistConfig: persist.persistConfig,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.source).toBe("cached");
    expect(result.width).toBe(1200);
    expect(result.height).toBe(630);
    expect(result.alt).toContain("Lorewire short");
    // URL is versioned with ?v={hash}.
    expect(result.url).toMatch(/poster-landscape-[a-f0-9]{16}\.png\?v=[a-f0-9]{16}$/);
    expect(result.url.split("?v=")[1]).toBe(result.hash);
    // Cache hit means no LLM call.
    expect(chat.calls).toBe(0);
    // HEAD probes the BASE URL (no query string).
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("HEAD");
    expect(stub.calls[0].url).not.toContain("?v=");
    // Persist writes both the URL AND the attempted_at stamp.
    expect(persist.writes).toHaveLength(1);
    const written = persist.writes[0].config;
    expect(written.og_poster_landscape_url).toBe(result.url);
    expect(typeof written.og_poster_attempted_at).toBe("string");
    // Existing short_config fields (poster_text) survive the merge.
    expect(written.poster_text).toContain("wedding dress");
  });

  it("HEAD miss → POST /render-poster with aspect=landscape + single `text` field", async () => {
    await seedStory(STORY, {
      props: {
        doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
        hook: "Hook.",
      },
      posterTextOnConfig: "She refused. He emptied their joint account by morning.",
    });
    const stub = makeFetchStub([
      { ok: false, status: 404 }, // HEAD miss
      { ok: true, status: 200, body: {
        url: "https://media.lorewire.com/story-og-poster-test-1-short/poster-landscape-abc123.png",
        elapsed_ms: 700,
        hash: "abc123",
      } },
    ]);
    const chat = makeChatStub({ ok: true, content: "x", provider: "t", model: "t" });
    const persist = makePersistStub();
    const result = await ensureOgPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: chat.chat,
      pickModel: pickModelStub,
      persistConfig: persist.persistConfig,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.source).toBe("rendered");
    expect(result.url).toMatch(/\?v=[a-f0-9]{16}$/);
    // The POST body includes aspect=landscape AND single `text` field.
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1].method).toBe("POST");
    expect(stub.calls[1].url).toContain("/render-poster");
    expect(stub.calls[1].hasAuth).toBe(true);
    const sent = JSON.parse(stub.calls[1].body ?? "{}");
    expect(sent.aspect).toBe("landscape");
    expect(sent.inputProps.text).toContain("emptied their joint account");
    expect(sent.inputProps.brand_text).toBe("LORE WIRE");
    // No `hook` or `poster_text` in payload — the single `text` field
    // is the Phase 2 social-only refactor's locked contract.
    expect(sent.inputProps.hook).toBeUndefined();
    expect(sent.inputProps.poster_text).toBeUndefined();
  });

  it("missing poster_text → generates via LLM → persists → renders", async () => {
    await seedStory(STORY, {
      props: {
        doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
        hook: "Hook.",
      },
      storyBody: "A long story body about a kitchen and a note on a fridge.",
    });
    const generated = "She found the joint account drained to zero overnight.";
    const stub = makeFetchStub([
      { ok: false, status: 404 },
      { ok: true, status: 200, body: {
        url: "https://media.lorewire.com/s/poster-landscape-x.png",
        elapsed_ms: 700,
        hash: "x",
      } },
    ]);
    const chat = makeChatStub({ ok: true, content: generated, provider: "openai", model: "test" });
    const persist = makePersistStub();
    const result = await ensureOgPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: chat.chat,
      pickModel: pickModelStub,
      persistConfig: persist.persistConfig,
    });
    expect(result).not.toBeNull();
    expect(chat.calls).toBe(1);
    // The render POST contained the freshly-generated text.
    const sent = JSON.parse(stub.calls[1].body ?? "{}");
    expect(sent.inputProps.text).toBe(generated);
    // poster_text was persisted to the DB via generatePosterText's
    // own persistence (separate from persistConfig — see helper
    // implementation), so it's NOT in the persist.writes stub.
    // Verify it landed on the DB directly:
    const cfg = await readShortConfig(STORY);
    expect(cfg?.poster_text).toBe(generated);
  });
});

describe("ensureOgPoster — guard rejections stamp attempted_at", () => {
  const baseProps = {
    doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
  };

  it("guarded text (Hebrew → RTL) stamps attempted_at + returns null", async () => {
    await seedStory(STORY, {
      props: baseProps,
      posterTextOnConfig: "השמלה נהרסה.", // Hebrew → fails SUPPORTED_GLYPH_RE
    });
    const stub = makeFetchStub([]);
    const chat = makeChatStub({ ok: true, content: "x", provider: "t", model: "t" });
    const persist = makePersistStub();
    const result = await ensureOgPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: chat.chat,
      pickModel: pickModelStub,
      persistConfig: persist.persistConfig,
    });
    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(0);
    // The Contrarian's Failure Mode #1: guard-rejected stories MUST
    // stamp attempted_at so the backfill script's 7-day window skips
    // them next run. Otherwise the cron burns LLM + Cloud Run cycles
    // on the same broken stories every hour forever.
    expect(persist.writes).toHaveLength(1);
    expect(persist.writes[0].config.og_poster_attempted_at).toBeTypeOf("string");
    expect(persist.writes[0].config.og_poster_landscape_url).toBeUndefined();
  });

  it("guarded text (profanity) stamps attempted_at", async () => {
    await seedStory(STORY, {
      props: baseProps,
      posterTextOnConfig: "She found the damn envelope under the casserole.",
    });
    const stub = makeFetchStub([]);
    const chat = makeChatStub({ ok: true, content: "x", provider: "t", model: "t" });
    const persist = makePersistStub();
    const result = await ensureOgPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: chat.chat,
      pickModel: pickModelStub,
      persistConfig: persist.persistConfig,
    });
    expect(result).toBeNull();
    expect(persist.writes).toHaveLength(1);
    expect(persist.writes[0].config.og_poster_attempted_at).toBeTypeOf("string");
  });

  it("Cloud Run 500 stamps attempted_at (transient failures also skip-window)", async () => {
    await seedStory(STORY, {
      props: baseProps,
      posterTextOnConfig: "Her wedding dress was destroyed the morning of the ceremony.",
    });
    const stub = makeFetchStub([
      { ok: false, status: 404 }, // HEAD miss
      { ok: false, status: 500, bodyText: "internal" },
    ]);
    const chat = makeChatStub({ ok: true, content: "x", provider: "t", model: "t" });
    const persist = makePersistStub();
    const result = await ensureOgPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: chat.chat,
      pickModel: pickModelStub,
      persistConfig: persist.persistConfig,
    });
    expect(result).toBeNull();
    expect(persist.writes).toHaveLength(1);
    expect(persist.writes[0].config.og_poster_attempted_at).toBeTypeOf("string");
    expect(persist.writes[0].config.og_poster_landscape_url).toBeUndefined();
  });
});

describe("ensureOgPoster — missing data", () => {
  it("returns null when scene_1_url missing (no LLM cost, no persist)", async () => {
    await seedStory(STORY, {
      props: { doodle_frames: [] },
      posterTextOnConfig: "Designed line.",
    });
    const stub = makeFetchStub([]);
    const chat = makeChatStub({ ok: true, content: "x", provider: "t", model: "t" });
    const persist = makePersistStub();
    const result = await ensureOgPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: chat.chat,
      pickModel: pickModelStub,
      persistConfig: persist.persistConfig,
    });
    expect(result).toBeNull();
    expect(chat.calls).toBe(0);
    expect(persist.writes).toHaveLength(0);
  });

  it("falls back to spoken hook when LLM fails AND hook present", async () => {
    await seedStory(STORY, {
      props: {
        doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
        hook: "Eight hundred dollars. Gone.",
      },
    });
    const stub = makeFetchStub([
      { ok: false, status: 404 },
      { ok: true, status: 200, body: {
        url: "https://media.lorewire.com/s/poster-landscape-y.png",
        hash: "y",
      } },
    ]);
    const chat = makeChatStub({ ok: false, error: "openai 503" });
    const persist = makePersistStub();
    const result = await ensureOgPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: chat.chat,
      pickModel: pickModelStub,
      persistConfig: persist.persistConfig,
    });
    expect(result).not.toBeNull();
    // The render POST received the hook (fallback path).
    const sent = JSON.parse(stub.calls[1].body ?? "{}");
    expect(sent.inputProps.text).toBe("Eight hundred dollars. Gone.");
  });

  it("returns null when LLM fails AND no hook (exhausted text sources)", async () => {
    await seedStory(STORY, {
      props: {
        doodle_frames: [{ id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" }],
      },
    });
    const stub = makeFetchStub([]);
    const chat = makeChatStub({ ok: false, error: "openai 503" });
    const persist = makePersistStub();
    const result = await ensureOgPoster(STORY, {
      fetch: stub.fetch,
      settings: makeSettings("1"),
      chat: chat.chat,
      pickModel: pickModelStub,
      persistConfig: persist.persistConfig,
    });
    expect(result).toBeNull();
    // Still stamp attempted_at so the backfill window kicks in.
    expect(persist.writes).toHaveLength(1);
    expect(persist.writes[0].config.og_poster_attempted_at).toBeTypeOf("string");
  });
});
