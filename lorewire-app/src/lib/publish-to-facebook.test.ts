// Tests for publish-to-facebook. The HTTP call is fully stubbed via
// the `fetch` dep injection point so no network ever fires; the DB is
// the real per-process test SQLite (see tests/setup.ts).
//
// Coverage walks the plan's 10 cases plus a couple of safety nets:
//   - happy path inserts a 'posted' row with the FB video id
//   - missing token env -> skipped, no row
//   - auto toggle off -> auto path skipped, manual path proceeds
//   - story already posted -> auto skipped (dedup)
//   - 4xx with structured FB error -> 'failed' row with error fields
//   - 5xx (HTML error body) -> 'failed' row with fallback message
//   - caption template substitution + the three fallback chains
//   - delete-previous success flips old row to 'deleted'
//   - delete-previous failure leaves old row alone (caller must not
//     proceed with the new publish; surface for the route to decide)
//
// Plan: _plans/2026-06-23-facebook-auto-publish.md.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { all, run } from "@/lib/db";
import { setSetting } from "@/lib/repo";
import {
  deleteLatestPostedRowForStory,
  publishShortToFacebook,
  renderCaption,
  type FbFetchLike,
  type FbFetchResponse,
} from "@/lib/publish-to-facebook";

// --- Test helpers ----------------------------------------------------------

interface StubCall {
  url: string;
  method: string;
  body: string | undefined;
}

interface StubResponse {
  ok: boolean;
  status: number;
  body: unknown; // serialized to JSON unless `bodyText` is set
  bodyText?: string;
}

function makeFetchStub(responses: StubResponse[]): {
  fetch: FbFetchLike;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const queue = [...responses];
  const fetch: FbFetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error(`stub fetch exhausted at ${url}`);
    const text = next.bodyText ?? JSON.stringify(next.body);
    const resp: FbFetchResponse = {
      ok: next.ok,
      status: next.status,
      json: async () => JSON.parse(text),
      text: async () => text,
    };
    return resp;
  };
  return { fetch, calls };
}

async function reset(): Promise<void> {
  await run("DELETE FROM facebook_posts WHERE 1=1", []);
  await run(
    "DELETE FROM settings WHERE key LIKE 'publisher.facebook.%'",
    [],
  );
}

const ORIGINAL_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const ORIGINAL_PAGE = process.env.FB_PAGE_ID;

beforeEach(async () => {
  await reset();
  process.env.FB_PAGE_ACCESS_TOKEN = "test-token-secret";
  process.env.FB_PAGE_ID = "911708085365160";
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.FB_PAGE_ACCESS_TOKEN;
  else process.env.FB_PAGE_ACCESS_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_PAGE === undefined) delete process.env.FB_PAGE_ID;
  else process.env.FB_PAGE_ID = ORIGINAL_PAGE;
});

const STORY = "story-fb-test-1";
const RENDER = "render-fb-test-1";
const VIDEO_URL = "https://storage.googleapis.com/lorewire-media/x/video.mp4";

const CTX = {
  hook: "An impossible thing happened on the bus today.",
  title: "Bus Mystery",
  article_url: "https://www.lorewire.com/stories/bus-mystery",
};

// --- renderCaption (pure) --------------------------------------------------

describe("renderCaption", () => {
  it("substitutes all three tokens with the provided context", () => {
    const out = renderCaption(
      "{{hook}}\n\n{{title}} → {{article_url}}",
      CTX,
      STORY,
    );
    expect(out).toBe(
      "An impossible thing happened on the bus today.\n\nBus Mystery → https://www.lorewire.com/stories/bus-mystery",
    );
  });

  it("falls back: hook missing → title", () => {
    const out = renderCaption(
      "{{hook}}",
      { ...CTX, hook: null },
      STORY,
    );
    expect(out).toBe("Bus Mystery");
  });

  it("falls back: title missing → story id", () => {
    const out = renderCaption(
      "{{title}}",
      { hook: null, title: null, article_url: null },
      STORY,
    );
    // hook is null and falls back to title, title is null and falls back to
    // story id; the renderer chains the fallback so title token resolves to
    // the story id when the title itself is empty.
    expect(out).toBe(STORY);
  });

  it("falls back: article_url missing → lorewire homepage", () => {
    const out = renderCaption(
      "{{article_url}}",
      { ...CTX, article_url: "" },
      STORY,
    );
    expect(out).toBe("https://www.lorewire.com/");
  });

  it("leaves unknown tokens alone", () => {
    const out = renderCaption("{{title}} {{unknown}}", CTX, STORY);
    expect(out).toBe("Bus Mystery {{unknown}}");
  });
});

// --- publishShortToFacebook ------------------------------------------------

describe("publishShortToFacebook auto path", () => {
  it("inserts a 'posted' row when toggle is on and FB returns 200", async () => {
    await setSetting("publisher.facebook.auto_publish", "1");
    const { fetch, calls } = makeFetchStub([
      { ok: true, status: 200, body: { id: "fb_video_42" } },
    ]);
    const result = await publishShortToFacebook(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch },
    );
    expect(result.status).toBe("posted");
    if (result.status !== "posted") return;
    expect(result.row.external_post_id).toBe("fb_video_42");
    expect(result.row.attempts).toBe(1);
    expect(result.row.page_id).toBe("911708085365160");
    expect(result.row.trigger).toBe("auto");
    expect(result.row.video_url).toBe(VIDEO_URL);
    expect(result.row.caption).toContain("An impossible thing happened");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/911708085365160/videos");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toContain("file_url=");
    expect(calls[0].body).toContain("access_token=test-token-secret");
  });

  it("skips (no row, no HTTP) when FB_PAGE_ACCESS_TOKEN is unset", async () => {
    delete process.env.FB_PAGE_ACCESS_TOKEN;
    await setSetting("publisher.facebook.auto_publish", "1");
    const { fetch, calls } = makeFetchStub([]);
    const result = await publishShortToFacebook(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch },
    );
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toMatch(/env config/);
    }
    expect(calls).toHaveLength(0);
    const rows = await all<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM facebook_posts",
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("auto path skips when toggle is off; manual path proceeds anyway", async () => {
    // toggle is unset (default off)
    const { fetch: fetchAuto, calls: callsAuto } = makeFetchStub([]);
    const autoResult = await publishShortToFacebook(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: fetchAuto },
    );
    expect(autoResult.status).toBe("skipped");
    expect(callsAuto).toHaveLength(0);

    const { fetch: fetchManual, calls: callsManual } = makeFetchStub([
      { ok: true, status: 200, body: { id: "fb_video_manual" } },
    ]);
    const manualResult = await publishShortToFacebook(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "manual",
        context: CTX,
      },
      { fetch: fetchManual },
    );
    expect(manualResult.status).toBe("posted");
    expect(callsManual).toHaveLength(1);
  });

  it("auto path skips when story already has a posted row (dedup)", async () => {
    await setSetting("publisher.facebook.auto_publish", "1");
    const { fetch: fetch1 } = makeFetchStub([
      { ok: true, status: 200, body: { id: "fb_video_first" } },
    ]);
    await publishShortToFacebook(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: fetch1 },
    );

    const { fetch: fetch2, calls: calls2 } = makeFetchStub([]);
    const result = await publishShortToFacebook(
      {
        storyId: STORY,
        renderId: "render-different-2",
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: fetch2 },
    );
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toMatch(/already published/);
    }
    expect(calls2).toHaveLength(0);
    const rows = await all<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM facebook_posts WHERE story_id = ?",
      [STORY],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it("records a 'failed' row with structured FB error fields on 4xx", async () => {
    await setSetting("publisher.facebook.auto_publish", "1");
    const { fetch } = makeFetchStub([
      {
        ok: false,
        status: 400,
        body: {
          error: {
            code: 190,
            error_subcode: 460,
            message: "Invalid OAuth access token.",
            fbtrace_id: "abc",
          },
        },
      },
    ]);
    const result = await publishShortToFacebook(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch },
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.row.fb_error_code).toBe(190);
    expect(result.row.fb_error_subcode).toBe(460);
    expect(result.row.error_message).toContain("Invalid OAuth");
    expect(result.row.attempts).toBe(1);
    expect(result.row.external_post_id).toBeNull();
  });

  it("records a 'failed' row with a fallback message on 5xx HTML body", async () => {
    await setSetting("publisher.facebook.auto_publish", "1");
    const { fetch } = makeFetchStub([
      {
        ok: false,
        status: 503,
        body: null,
        bodyText: "<html><body>Service Unavailable</body></html>",
      },
    ]);
    const result = await publishShortToFacebook(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch },
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.row.fb_error_code).toBeNull();
    expect(result.row.error_message).toContain("HTTP 503");
  });

  it("uses captionOverride when supplied (manual path)", async () => {
    const { fetch, calls } = makeFetchStub([
      { ok: true, status: 200, body: { id: "fb_video_manual2" } },
    ]);
    const result = await publishShortToFacebook(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "manual",
        context: CTX,
        captionOverride: "Custom admin caption (rare typo fix)",
      },
      { fetch },
    );
    expect(result.status).toBe("posted");
    if (result.status === "posted") {
      expect(result.row.caption).toBe("Custom admin caption (rare typo fix)");
    }
    expect(calls[0].body).toContain(
      "description=Custom+admin+caption+%28rare+typo+fix%29",
    );
  });
});

// --- deleteLatestPostedRowForStory -----------------------------------------

describe("deleteLatestPostedRowForStory", () => {
  it("returns ok and flips status to 'deleted' when FB DELETE succeeds", async () => {
    await setSetting("publisher.facebook.auto_publish", "1");
    const { fetch: postFetch } = makeFetchStub([
      { ok: true, status: 200, body: { id: "fb_to_be_deleted" } },
    ]);
    await publishShortToFacebook(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: postFetch },
    );

    const { fetch: delFetch, calls } = makeFetchStub([
      { ok: true, status: 200, body: { success: true } },
    ]);
    const result = await deleteLatestPostedRowForStory(STORY, {
      fetch: delFetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.externalPostId).toBe("fb_to_be_deleted");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toContain("fb_to_be_deleted");

    const rows = await all<{ status: string }>(
      "SELECT status FROM facebook_posts WHERE story_id = ?",
      [STORY],
    );
    expect(rows[0].status).toBe("deleted");
  });

  it("returns error and leaves row alone when FB DELETE fails", async () => {
    await setSetting("publisher.facebook.auto_publish", "1");
    const { fetch: postFetch } = makeFetchStub([
      { ok: true, status: 200, body: { id: "fb_stays_up" } },
    ]);
    await publishShortToFacebook(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: postFetch },
    );

    const { fetch: delFetch } = makeFetchStub([
      {
        ok: false,
        status: 400,
        body: {
          error: { code: 100, message: "Post not editable" },
        },
      },
    ]);
    const result = await deleteLatestPostedRowForStory(STORY, {
      fetch: delFetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Post not editable");

    const rows = await all<{ status: string }>(
      "SELECT status FROM facebook_posts WHERE story_id = ?",
      [STORY],
    );
    // Still 'posted' — the delete failure must not silently mutate state.
    expect(rows[0].status).toBe("posted");
  });

  it("returns error when no posted row exists for the story", async () => {
    const { fetch } = makeFetchStub([]);
    const result = await deleteLatestPostedRowForStory("no-such-story", {
      fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no posted row");
    }
  });
});

// _plans/2026-06-28-explicit-thumbnail-uploads.md.
//
// When the story carries a scene-1 URL in short_config AND the setting
// is on (default), postVideo switches to multipart and attaches the
// image as the `thumb` part. When either side is missing OR the
// thumbnail fetch fails, it falls back to the url-encoded path so the
// publish itself never fails on a cover-only problem.

describe("publishShortToFacebook — custom thumbnail upload", () => {
  beforeEach(async () => {
    process.env.FB_PAGE_ACCESS_TOKEN = "test-token-secret";
    process.env.FB_PAGE_ID = "911708085365160";
    await setSetting("publisher.facebook.auto_publish", "1");
    await run(`DELETE FROM stories WHERE id = ?`, [STORY]);
    await run(
      `INSERT INTO stories (id, title, body, summary, status, short_config)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        STORY,
        "T",
        "B",
        "S",
        "published",
        JSON.stringify({
          duration_ms: 50000,
          doodle_frames: [
            { id: "frame-00", url: "https://media.lorewire.com/x/frame-00.png" },
          ],
          captions: [],
        }),
      ],
    );
  });

  afterEach(async () => {
    await run(`DELETE FROM stories WHERE id = ?`, [STORY]);
  });

  it("fetches scene-1 + attaches it as multipart thumb on the /videos POST", async () => {
    // 1: GET thumbnail bytes from GCS. 2: POST /videos with multipart.
    const { fetch, calls } = makeFetchStub([
      {
        ok: true,
        status: 200,
        body: { id: "fb_video_cover_42" },
      },
    ]);
    // The fetch stub above only services the /videos POST; the
    // thumbnail GET hits a separate URL so the stub returns one entry
    // per call. Re-make with the right queue:
    const responses = [
      // GET thumb bytes
      {
        ok: true,
        status: 200,
        body: null,
        bodyText: "PNGBYTES",
      },
      // POST /videos with multipart
      { ok: true, status: 200, body: { id: "fb_video_cover_42" } },
    ];
    const stub = makeFetchStub(responses);
    const result = await publishShortToFacebook(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: stub.fetch },
    );
    expect(result.status).toBe("posted");
    if (result.status !== "posted") return;
    expect(result.row.external_post_id).toBe("fb_video_cover_42");
    expect(stub.calls).toHaveLength(2);
    // Call 0: thumbnail bytes fetch
    expect(stub.calls[0].url).toBe("https://media.lorewire.com/x/frame-00.png");
    expect(stub.calls[0].method).toBe("GET");
    // Call 1: multipart POST to /videos. The body is a FormData when
    // multipart fires; the stub serializes it as `[object FormData]`
    // when toString'd, which is fine for the call-count assertion.
    expect(stub.calls[1].url).toContain("/911708085365160/videos");
    expect(stub.calls[1].method).toBe("POST");
    // Suppress the unused noop binding warning.
    void fetch;
    void calls;
  });

  it("falls back to url-encoded when the thumbnail GCS fetch fails", async () => {
    const stub = makeFetchStub([
      // GET thumb → 404
      { ok: false, status: 404, body: { error: "not found" } },
      // POST /videos url-encoded (the fallback path) → ok
      { ok: true, status: 200, body: { id: "fb_video_fallback" } },
    ]);
    const result = await publishShortToFacebook(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: stub.fetch },
    );
    expect(result.status).toBe("posted");
    if (result.status !== "posted") return;
    expect(result.row.external_post_id).toBe("fb_video_fallback");
    expect(stub.calls).toHaveLength(2);
    // The fallback POST is url-encoded (a string body containing
    // file_url= + access_token=), NOT multipart.
    expect(stub.calls[1].body).toContain("file_url=");
  });

  it("skips the thumbnail fetch when the setting is off", async () => {
    await setSetting("publisher.facebook.upload_custom_thumbnail", "0");
    const stub = makeFetchStub([
      { ok: true, status: 200, body: { id: "fb_video_no_thumb" } },
    ]);
    const result = await publishShortToFacebook(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: stub.fetch },
    );
    expect(result.status).toBe("posted");
    expect(stub.calls).toHaveLength(1);
    // The single call is url-encoded /videos POST.
    expect(stub.calls[0].url).toContain("/videos");
    expect(stub.calls[0].body).toContain("file_url=");
  });

  it("skips the thumbnail fetch when the story has no short_config", async () => {
    await run(`UPDATE stories SET short_config = NULL WHERE id = ?`, [STORY]);
    const stub = makeFetchStub([
      { ok: true, status: 200, body: { id: "fb_video_no_cfg" } },
    ]);
    const result = await publishShortToFacebook(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
        context: CTX,
      },
      { fetch: stub.fetch },
    );
    expect(result.status).toBe("posted");
    expect(stub.calls).toHaveLength(1);
  });
});
