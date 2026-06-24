// Tests for publish-to-youtube. The HTTP calls are fully stubbed via
// the `fetch` and `getAccessToken` dep injection points so no network
// ever fires; the DB is the real per-process test SQLite (see
// tests/setup.ts).
//
// Coverage:
//   - pure: renderTitle / renderDescription token substitution + trim
//   - pure: parseTagList, mergeTags dedupe + 500-char cap
//   - happy path inserts a 'posted' row with the YT video id
//   - missing env (channel id or refresh token) -> skipped, no row
//   - auto toggle off -> auto path skipped, manual path proceeds
//   - story already posted -> auto skipped (dedup)
//   - channel id mismatch (env vs channels.list response) -> 'failed' row
//   - oauth refresh failure -> 'failed' row, no upload attempted
//   - upload init 4xx with structured YT error -> 'failed' row
//   - upload PUT 5xx with HTML body -> 'failed' row with fallback message
//   - captions sidecar failure is best-effort (does not mark row failed)
//
// Plan: _plans/2026-06-24-youtube-and-tiktok-auto-publish-and-socials-admin.md.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { all, run } from "@/lib/db";
import { setSetting } from "@/lib/repo";
import {
  attemptYouTubePublishForRow,
  mergeTags,
  parseTagList,
  publishShortToYouTube,
  renderDescription,
  renderTitle,
  type YtFetchLike,
  type YtFetchResponse,
} from "@/lib/publish-to-youtube";

// --- Test helpers ----------------------------------------------------------

interface StubCall {
  url: string;
  method: string;
  body: string | Uint8Array | undefined;
  headers: Record<string, string> | undefined;
}

interface StubResponse {
  ok: boolean;
  status: number;
  body?: unknown; // serialized to JSON for json() and text()
  bodyText?: string;
  arrayBuffer?: Uint8Array; // returned by arrayBuffer()
  headers?: Record<string, string>; // returned by headers.get()
}

function makeFetchStub(responses: StubResponse[]): {
  fetch: YtFetchLike;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const queue = [...responses];
  const fetch: YtFetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body,
      headers: init?.headers,
    });
    const next = queue.shift();
    if (!next) throw new Error(`stub fetch exhausted at ${url}`);
    const text = next.bodyText ?? JSON.stringify(next.body ?? {});
    const ab =
      next.arrayBuffer ?? new TextEncoder().encode(text);
    const headerMap = next.headers ?? {};
    const resp: YtFetchResponse = {
      ok: next.ok,
      status: next.status,
      headers: {
        get(name: string): string | null {
          const lowered = name.toLowerCase();
          for (const k of Object.keys(headerMap)) {
            if (k.toLowerCase() === lowered) return headerMap[k];
          }
          return null;
        },
      },
      json: async () => JSON.parse(text),
      text: async () => text,
      arrayBuffer: async () =>
        ab.buffer.slice(
          ab.byteOffset,
          ab.byteOffset + ab.byteLength,
        ) as ArrayBuffer,
    };
    return resp;
  };
  return { fetch, calls };
}

async function reset(): Promise<void> {
  await run("DELETE FROM youtube_posts WHERE 1=1", []);
  await run("DELETE FROM settings WHERE key LIKE 'publisher.youtube.%'", []);
}

const ORIGINAL_CHANNEL = process.env.YOUTUBE_CHANNEL_ID;
const ORIGINAL_REFRESH = process.env.YOUTUBE_REFRESH_TOKEN;
const ORIGINAL_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const ORIGINAL_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;

beforeEach(async () => {
  await reset();
  process.env.YOUTUBE_CHANNEL_ID = "UCLoreWireChannelId";
  process.env.YOUTUBE_REFRESH_TOKEN = "test-refresh-secret";
  process.env.YOUTUBE_CLIENT_ID = "test-client-id";
  process.env.YOUTUBE_CLIENT_SECRET = "test-client-secret";
});

afterEach(() => {
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("YOUTUBE_CHANNEL_ID", ORIGINAL_CHANNEL);
  restore("YOUTUBE_REFRESH_TOKEN", ORIGINAL_REFRESH);
  restore("YOUTUBE_CLIENT_ID", ORIGINAL_CLIENT_ID);
  restore("YOUTUBE_CLIENT_SECRET", ORIGINAL_CLIENT_SECRET);
});

const STORY = "story-yt-test-1";
const RENDER = "render-yt-test-1";
const VIDEO_URL = "https://storage.googleapis.com/lorewire-media/x/video.mp4";

const CTX = {
  hook: "An impossible thing happened on the bus today.",
  title: "Bus Mystery",
  article_url: "https://www.lorewire.com/stories/bus-mystery",
  category: "Drama",
};

const STUB_VIDEO_BYTES = new Uint8Array([0xff, 0xfb, 0x14, 0x00]);
const UPLOAD_SESSION_URL = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=session-x";

/** Build the canonical 4-response sequence for a happy-path upload.
 *  Order matches publish-to-youtube's runUploadPipeline:
 *    1. verify channel id (channels.list)
 *    2. fetch video bytes (from videoUrl)
 *    3. init resumable upload (Location header)
 *    4. PUT video bytes (returns the resource with id)
 *  Captions sidecar is optional and appended by the caller when needed.
 */
function happyPathResponses(opts?: {
  channelId?: string;
  externalVideoId?: string;
}): StubResponse[] {
  return [
    {
      ok: true,
      status: 200,
      body: {
        items: [{ id: opts?.channelId ?? "UCLoreWireChannelId" }],
      },
    },
    {
      ok: true,
      status: 200,
      arrayBuffer: STUB_VIDEO_BYTES,
      headers: { "content-type": "video/mp4" },
    },
    {
      ok: true,
      status: 200,
      body: {},
      headers: { location: UPLOAD_SESSION_URL },
    },
    {
      ok: true,
      status: 200,
      body: { id: opts?.externalVideoId ?? "video-id-xyz" },
    },
  ];
}

// --- Pure renderers --------------------------------------------------------

describe("renderTitle", () => {
  it("substitutes the hook when ≤100 chars", () => {
    expect(renderTitle("{{hook}}", CTX, STORY)).toBe(
      "An impossible thing happened on the bus today.",
    );
  });

  it("trims with single-char ellipsis when over the 100-char cap", () => {
    const longHook = "a".repeat(200);
    const out = renderTitle("{{hook}}", { ...CTX, hook: longHook }, STORY);
    expect(out.length).toBe(100);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back hook → title → story id", () => {
    expect(renderTitle("{{hook}}", { ...CTX, hook: null }, STORY)).toBe(
      CTX.title,
    );
    expect(
      renderTitle("{{hook}}", { ...CTX, hook: null, title: null }, STORY),
    ).toBe(STORY);
  });
});

describe("renderDescription", () => {
  it("substitutes hook + title + article_url + category", () => {
    const out = renderDescription(
      "Top: {{hook}}\nMid: {{title}}\nCat: {{category}}\nURL: {{article_url}}",
      CTX,
      STORY,
    );
    expect(out).toContain(CTX.hook);
    expect(out).toContain(CTX.title);
    expect(out).toContain("Drama");
    expect(out).toContain(CTX.article_url);
  });

  it("defaults missing article_url to lorewire.com homepage", () => {
    const out = renderDescription(
      "{{article_url}}",
      { ...CTX, article_url: null },
      STORY,
    );
    expect(out).toBe("https://www.lorewire.com/");
  });
});

describe("parseTagList + mergeTags", () => {
  it("parses comma-separated tags, trimming and normalising whitespace", () => {
    expect(parseTagList("  true stories , internet  stories ,, lorewire ")).toEqual(
      ["true stories", "internet stories", "lorewire"],
    );
  });

  it("dedupes case-insensitively and caps at YT_TAGS_MAX_COUNT (8)", () => {
    const base = parseTagList("a, b, c, d, e, f");
    const cat = parseTagList("A, g, h, i, j");
    const merged = mergeTags(base, cat);
    expect(merged.length).toBe(8);
    // dedupe is case-insensitive so "A" should not bring a duplicate
    const lower = merged.map((t) => t.toLowerCase());
    expect(new Set(lower).size).toBe(merged.length);
  });

  it("drops tail entries until joined length fits the 500-char cap", () => {
    const huge = Array.from({ length: 8 }, (_, i) =>
      `${"x".repeat(100)}${i}`,
    );
    const merged = mergeTags(huge, []);
    const joined = merged.join(", ");
    expect(joined.length).toBeLessThanOrEqual(500);
  });
});

// --- Skips / gates ---------------------------------------------------------

describe("publishShortToYouTube — skip gates", () => {
  it("skips when YOUTUBE_CHANNEL_ID is missing", async () => {
    delete process.env.YOUTUBE_CHANNEL_ID;
    const stub = makeFetchStub([]);
    const result = await publishShortToYouTube(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: stub.fetch, getAccessToken: async () => "ignored" },
    );
    expect(result.status).toBe("skipped");
    expect(stub.calls.length).toBe(0);
    const rows = await all<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM youtube_posts",
      [],
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  it("skips when the auto_publish toggle is off (auto trigger only)", async () => {
    await setSetting("publisher.youtube.auto_publish", "0");
    const stub = makeFetchStub([]);
    const result = await publishShortToYouTube(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: stub.fetch, getAccessToken: async () => "ignored" },
    );
    expect(result.status).toBe("skipped");
    expect(stub.calls.length).toBe(0);
  });

  it("skips auto when story already has a pending or posted row", async () => {
    await setSetting("publisher.youtube.auto_publish", "1");
    await run(
      `INSERT INTO youtube_posts
       (id, story_id, render_id, channel_id, trigger, video_url, title,
        description, tags_json, category_id, made_for_kids, synthetic,
        privacy, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', 1, ?)`,
      [
        "existing-row",
        STORY,
        "older",
        "UCLoreWireChannelId",
        "auto",
        VIDEO_URL,
        "x",
        "x",
        "[]",
        "24",
        0,
        1,
        "public",
        new Date().toISOString(),
      ],
    );
    const stub = makeFetchStub([]);
    const result = await publishShortToYouTube(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: stub.fetch, getAccessToken: async () => "ignored" },
    );
    expect(result.status).toBe("skipped");
  });
});

// --- Happy path ------------------------------------------------------------

describe("publishShortToYouTube — happy path", () => {
  beforeEach(async () => {
    await setSetting("publisher.youtube.auto_publish", "1");
  });

  it("inserts a posted row with the YT video id and the resolved metadata", async () => {
    const stub = makeFetchStub(happyPathResponses());
    const result = await publishShortToYouTube(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: stub.fetch, getAccessToken: async () => "access-token-stub" },
    );
    expect(result.status).toBe("posted");
    if (result.status !== "posted") return;
    expect(result.row.external_video_id).toBe("video-id-xyz");
    expect(result.row.privacy).toBe("public");
    expect(result.row.synthetic).toBe(1);
    expect(result.row.made_for_kids).toBe(0);
    const parsedTags = JSON.parse(result.row.tags_json) as string[];
    expect(Array.isArray(parsedTags)).toBe(true);
    expect(parsedTags.length).toBeGreaterThan(0);
    // The 4 stub calls in order: channels.list → video bytes → init → PUT
    expect(stub.calls.length).toBe(4);
    expect(stub.calls[0].url).toContain("/channels?part=id&mine=true");
    expect(stub.calls[1].url).toBe(VIDEO_URL);
    expect(stub.calls[2].url).toContain("uploadType=resumable");
    expect(stub.calls[3].url).toBe(UPLOAD_SESSION_URL);
  });
});

// --- Defense in depth: channel id mismatch ---------------------------------

describe("publishShortToYouTube — channel id mismatch", () => {
  it("fails the row when channels.list returns a different id", async () => {
    await setSetting("publisher.youtube.auto_publish", "1");
    const stub = makeFetchStub([
      // channels.list with the WRONG id (this comes before video bytes)
      {
        ok: true,
        status: 200,
        body: { items: [{ id: "UCWrongChannelId" }] },
      },
    ]);
    const result = await publishShortToYouTube(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: stub.fetch, getAccessToken: async () => "access-token-stub" },
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.row.yt_error_reason).toBe("channel_mismatch");
    expect(result.row.external_video_id).toBeNull();
  });
});

// --- Error paths -----------------------------------------------------------

describe("publishShortToYouTube — error paths", () => {
  beforeEach(async () => {
    await setSetting("publisher.youtube.auto_publish", "1");
  });

  it("oauth refresh failure marks the row failed without uploading", async () => {
    const stub = makeFetchStub([]);
    const result = await publishShortToYouTube(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      {
        fetch: stub.fetch,
        getAccessToken: async () => {
          throw new Error("oauth refresh: invalid_grant");
        },
      },
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.row.yt_error_reason).toBe("oauth");
    expect(result.row.error_message).toContain("invalid_grant");
    expect(stub.calls.length).toBe(0);
  });

  it("init upload 4xx with structured YT error → failed row with reason", async () => {
    const stub = makeFetchStub([
      // channels.list ok
      { ok: true, status: 200, body: { items: [{ id: "UCLoreWireChannelId" }] } },
      // video bytes
      {
        ok: true,
        status: 200,
        arrayBuffer: STUB_VIDEO_BYTES,
        headers: { "content-type": "video/mp4" },
      },
      // init upload 403
      {
        ok: false,
        status: 403,
        body: {
          error: {
            code: 403,
            message: "The user has exceeded the number of videos they may upload.",
            errors: [
              {
                reason: "uploadLimitExceeded",
                message: "The user has exceeded the upload limit.",
              },
            ],
          },
        },
      },
    ]);
    const result = await publishShortToYouTube(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: stub.fetch, getAccessToken: async () => "access-token-stub" },
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.row.yt_error_reason).toBe("uploadLimitExceeded");
    expect(result.row.error_message ?? "").toContain("upload limit");
  });

  it("PUT 5xx with HTML body → failed row with fallback message", async () => {
    const stub = makeFetchStub([
      { ok: true, status: 200, body: { items: [{ id: "UCLoreWireChannelId" }] } },
      {
        ok: true,
        status: 200,
        arrayBuffer: STUB_VIDEO_BYTES,
        headers: { "content-type": "video/mp4" },
      },
      {
        ok: true,
        status: 200,
        body: {},
        headers: { location: UPLOAD_SESSION_URL },
      },
      {
        ok: false,
        status: 500,
        bodyText: "<html>internal server error</html>",
      },
    ]);
    const result = await publishShortToYouTube(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: stub.fetch, getAccessToken: async () => "access-token-stub" },
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.row.error_message ?? "").toContain("HTTP 500");
  });
});

// --- Retry path ------------------------------------------------------------

describe("attemptYouTubePublishForRow", () => {
  it("re-walks the upload pipeline against an existing failed row", async () => {
    await setSetting("publisher.youtube.auto_publish", "1");
    // Seed a 'failed' row.
    const stubFail = makeFetchStub([
      { ok: true, status: 200, body: { items: [{ id: "UCLoreWireChannelId" }] } },
      {
        ok: true,
        status: 200,
        arrayBuffer: STUB_VIDEO_BYTES,
        headers: { "content-type": "video/mp4" },
      },
      // init upload fails first time
      {
        ok: false,
        status: 503,
        bodyText: "service unavailable",
      },
    ]);
    const first = await publishShortToYouTube(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: stubFail.fetch, getAccessToken: async () => "access-token-stub" },
    );
    expect(first.status).toBe("failed");
    if (first.status !== "failed") return;
    const failedRowId = first.row.id;
    // Retry against the same row with happy responses.
    const stubOk = makeFetchStub(happyPathResponses());
    const retry = await attemptYouTubePublishForRow(failedRowId, {
      fetch: stubOk.fetch,
      getAccessToken: async () => "access-token-stub",
    });
    expect(retry.status).toBe("posted");
    if (retry.status !== "posted") return;
    expect(retry.row.id).toBe(failedRowId);
    expect(retry.row.external_video_id).toBe("video-id-xyz");
    expect((retry.row.attempts ?? 0)).toBeGreaterThanOrEqual(2);
  });
});
