// Tests for publish-to-facebook-story. The 4-step FB video_stories flow
// (start → rupload → poll → finish) is fully stubbed via the fetch +
// sleepMs deps. DB is the real per-process test SQLite.
//
// Coverage:
//   - happy path: start → rupload → poll ready → finish → 'posted'
//   - start 4xx → 'failed', no rupload call
//   - rupload error → 'failed', no poll/finish
//   - status ERROR → 'failed', no finish call
//   - retry from pending row with upload_session_id skips start + rupload
//   - dedup at story level for auto path
//   - manual trigger bypasses auto-toggle gate
//   - skipped when FB_PAGE_ID missing
//   - page_id mismatch refuses to publish
//   - delete-previous success + failure paths
//
// Plan: _plans/2026-06-25-instagram-facebook-stories-cross-publish.md.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { all, one, run } from "@/lib/db";
import { setSetting } from "@/lib/repo";
import {
  attemptFacebookStoryPublishForRow,
  deleteLatestPostedRowForStory,
  publishShortToFacebookStory,
  SETTING_AUTO_PUBLISH,
  type FacebookStoryRow,
  type FbFetchLike,
  type FbFetchResponse,
} from "@/lib/publish-to-facebook-story";

// --- Test helpers ----------------------------------------------------------

interface StubCall {
  url: string;
  method: string;
  body: string | undefined;
  headers: Record<string, string> | undefined;
}

interface StubResponse {
  ok: boolean;
  status: number;
  body: unknown;
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
      headers: init?.headers,
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

const noSleep = async (_ms: number): Promise<void> => undefined;

async function reset(): Promise<void> {
  await run("DELETE FROM facebook_stories WHERE 1=1", []);
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

const STORY = "story-fb-story-test-1";
const RENDER = "render-fb-story-test-1";
const VIDEO_URL = "https://storage.googleapis.com/lorewire-media/x/video.mp4";

const RUPLOAD_URL =
  "https://rupload.facebook.com/video-upload/v22.0/1234567890";

function successResponses(videoId: string, postId: string): StubResponse[] {
  return [
    {
      ok: true,
      status: 200,
      body: { video_id: videoId, upload_url: RUPLOAD_URL },
    },
    { ok: true, status: 200, body: { success: true } },
    {
      ok: true,
      status: 200,
      body: { status: { video_status: "ready" } },
    },
    { ok: true, status: 200, body: { success: true, post_id: postId } },
  ];
}

// --- publishShortToFacebookStory auto path ---------------------------------

describe("publishShortToFacebookStory auto path", () => {
  it("happy path: start → rupload → poll ready → finish → posted", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch, calls } = makeFetchStub(
      successResponses("vid_42", "post_99"),
    );
    const result = await publishShortToFacebookStory(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
      },
      { fetch, sleepMs: noSleep },
    );
    expect(result.status).toBe("posted");
    if (result.status !== "posted") return;
    expect(result.row.external_post_id).toBe("post_99");
    expect(result.row.upload_session_id).toBe("vid_42");
    expect(result.row.page_id).toBe("911708085365160");
    expect(result.row.attempts).toBe(1);
    expect(calls).toHaveLength(4);
    expect(calls[0].url).toContain("/911708085365160/video_stories");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toContain("upload_phase=start");
    expect(calls[1].url).toBe(RUPLOAD_URL);
    expect(calls[1].method).toBe("POST");
    expect(calls[1].headers?.file_url).toBe(VIDEO_URL);
    expect(calls[1].headers?.Authorization).toContain("OAuth ");
    expect(calls[2].url).toContain("vid_42");
    expect(calls[2].url).toContain("fields=status");
    expect(calls[2].method).toBe("GET");
    expect(calls[3].url).toContain("/911708085365160/video_stories");
    expect(calls[3].method).toBe("POST");
    expect(calls[3].body).toContain("upload_phase=finish");
    expect(calls[3].body).toContain("video_id=vid_42");
  });

  it("polls multiple times before ready, then finishes", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch, calls } = makeFetchStub([
      { ok: true, status: 200, body: { video_id: "v1", upload_url: RUPLOAD_URL } },
      { ok: true, status: 200, body: { success: true } },
      { ok: true, status: 200, body: { status: { video_status: "processing" } } },
      { ok: true, status: 200, body: { status: { video_status: "processing" } } },
      { ok: true, status: 200, body: { status: { video_status: "ready" } } },
      { ok: true, status: 200, body: { success: true, post_id: "p1" } },
    ]);
    const result = await publishShortToFacebookStory(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
      },
      { fetch, sleepMs: noSleep },
    );
    expect(result.status).toBe("posted");
    expect(calls).toHaveLength(6);
  });

  it("start 4xx -> failed row, no rupload call", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch, calls } = makeFetchStub([
      {
        ok: false,
        status: 400,
        body: {
          error: {
            code: 100,
            error_subcode: 1234,
            message: "Invalid parameter",
          },
        },
      },
    ]);
    const result = await publishShortToFacebookStory(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
      },
      { fetch, sleepMs: noSleep },
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.row.fb_error_code).toBe(100);
    expect(result.row.fb_error_subcode).toBe(1234);
    expect(result.row.error_message).toContain("Invalid");
    expect(result.row.upload_session_id).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("rupload error -> failed, no poll/finish", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch, calls } = makeFetchStub([
      { ok: true, status: 200, body: { video_id: "v1", upload_url: RUPLOAD_URL } },
      {
        ok: false,
        status: 400,
        body: { error: { code: 7, message: "File hosted on Meta CDN" } },
      },
    ]);
    const result = await publishShortToFacebookStory(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
      },
      { fetch, sleepMs: noSleep },
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.row.error_message).toContain("Meta CDN");
    expect(result.row.upload_session_id).toBe("v1");
    expect(calls).toHaveLength(2);
  });

  it("status error -> failed, no finish call", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch, calls } = makeFetchStub([
      { ok: true, status: 200, body: { video_id: "v1", upload_url: RUPLOAD_URL } },
      { ok: true, status: 200, body: { success: true } },
      { ok: true, status: 200, body: { status: { video_status: "error" } } },
    ]);
    const result = await publishShortToFacebookStory(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
      },
      { fetch, sleepMs: noSleep },
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.row.error_message).toContain("error");
    expect(result.row.upload_session_id).toBe("v1");
    expect(calls).toHaveLength(3);
  });

  it("dedups at story level for auto path", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch: fetch1 } = makeFetchStub(
      successResponses("vid_first", "post_first"),
    );
    await publishShortToFacebookStory(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
      },
      { fetch: fetch1, sleepMs: noSleep },
    );

    const { fetch: fetch2, calls: calls2 } = makeFetchStub([]);
    const result = await publishShortToFacebookStory(
      {
        storyId: STORY,
        renderId: "render-different",
        videoUrl: VIDEO_URL,
        trigger: "auto",
      },
      { fetch: fetch2, sleepMs: noSleep },
    );
    expect(result.status).toBe("skipped");
    expect(calls2).toHaveLength(0);
    const count = await all<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM facebook_stories WHERE story_id = ?",
      [STORY],
    );
    expect(Number(count[0].n)).toBe(1);
  });

  it("toggle off skips auto, manual still works", async () => {
    const { fetch: fetchAuto, calls: callsAuto } = makeFetchStub([]);
    const autoResult = await publishShortToFacebookStory(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
      },
      { fetch: fetchAuto, sleepMs: noSleep },
    );
    expect(autoResult.status).toBe("skipped");
    expect(callsAuto).toHaveLength(0);

    const { fetch: fetchManual } = makeFetchStub(
      successResponses("vid_m", "post_manual"),
    );
    const manualResult = await publishShortToFacebookStory(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "manual",
      },
      { fetch: fetchManual, sleepMs: noSleep },
    );
    expect(manualResult.status).toBe("posted");
  });

  it("skipped when FB_PAGE_ID missing", async () => {
    delete process.env.FB_PAGE_ID;
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch, calls } = makeFetchStub([]);
    const result = await publishShortToFacebookStory(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
      },
      { fetch, sleepMs: noSleep },
    );
    expect(result.status).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("page_id mismatch -> failed before any network call", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const id = "row-mismatch-1";
    await run(
      `INSERT INTO facebook_stories (id, story_id, render_id, page_id, trigger, video_url, status, attempts, created_at)
       VALUES (?, ?, ?, ?, 'manual', ?, 'pending', 0, ?)`,
      [
        id,
        STORY,
        RENDER,
        "9999999999999999",
        VIDEO_URL,
        new Date().toISOString(),
      ],
    );
    const { fetch, calls } = makeFetchStub([]);
    const result = await attemptFacebookStoryPublishForRow(id, {
      fetch,
      sleepMs: noSleep,
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.row.error_message).toContain("page_id mismatch");
    expect(calls).toHaveLength(0);
  });
});

// --- attemptFacebookStoryPublishForRow retry path ------------------------

describe("attemptFacebookStoryPublishForRow", () => {
  it("resumes from existing upload_session_id (skips start+rupload)", async () => {
    const id = "resume-1";
    await run(
      `INSERT INTO facebook_stories (id, story_id, render_id, page_id, trigger, video_url, upload_session_id, status, attempts, created_at)
       VALUES (?, ?, ?, ?, 'auto', ?, ?, 'pending', 1, ?)`,
      [
        id,
        STORY,
        RENDER,
        "911708085365160",
        VIDEO_URL,
        "existing_video_abc",
        new Date().toISOString(),
      ],
    );
    const { fetch, calls } = makeFetchStub([
      { ok: true, status: 200, body: { status: { video_status: "ready" } } },
      { ok: true, status: 200, body: { success: true, post_id: "post_resumed" } },
    ]);
    const result = await attemptFacebookStoryPublishForRow(id, {
      fetch,
      sleepMs: noSleep,
    });
    expect(result.status).toBe("posted");
    if (result.status !== "posted") return;
    expect(result.row.external_post_id).toBe("post_resumed");
    expect(result.row.upload_session_id).toBe("existing_video_abc");
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("existing_video_abc");
    expect(calls[0].method).toBe("GET");
    expect(calls[1].body).toContain("video_id=existing_video_abc");
  });

  it("starts from start when no upload_session_id on the failed row", async () => {
    const id = "no-session-1";
    await run(
      `INSERT INTO facebook_stories (id, story_id, render_id, page_id, trigger, video_url, status, attempts, created_at)
       VALUES (?, ?, ?, ?, 'auto', ?, 'failed', 1, ?)`,
      [
        id,
        STORY,
        RENDER,
        "911708085365160",
        VIDEO_URL,
        new Date().toISOString(),
      ],
    );
    const { fetch, calls } = makeFetchStub(
      successResponses("fresh_v", "post_fresh"),
    );
    const result = await attemptFacebookStoryPublishForRow(id, {
      fetch,
      sleepMs: noSleep,
    });
    expect(result.status).toBe("posted");
    expect(calls).toHaveLength(4);
  });

  it("skipped when row not eligible (already posted)", async () => {
    const id = "already-posted-1";
    await run(
      `INSERT INTO facebook_stories (id, story_id, render_id, page_id, trigger, video_url, status, external_post_id, attempts, created_at)
       VALUES (?, ?, ?, ?, 'auto', ?, 'posted', 'existing_post', 1, ?)`,
      [
        id,
        STORY,
        RENDER,
        "911708085365160",
        VIDEO_URL,
        new Date().toISOString(),
      ],
    );
    const { fetch, calls } = makeFetchStub([]);
    const result = await attemptFacebookStoryPublishForRow(id, {
      fetch,
      sleepMs: noSleep,
    });
    expect(result.status).toBe("skipped");
    expect(calls).toHaveLength(0);
  });
});

// --- deleteLatestPostedRowForStory ----------------------------------------

describe("deleteLatestPostedRowForStory (FB Story)", () => {
  it("DELETEs the latest posted Story and flips row to deleted", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch: postFetch } = makeFetchStub(
      successResponses("vid_del", "post_to_delete"),
    );
    await publishShortToFacebookStory(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
      },
      { fetch: postFetch, sleepMs: noSleep },
    );

    const { fetch: delFetch, calls } = makeFetchStub([
      { ok: true, status: 200, body: { success: true } },
    ]);
    const result = await deleteLatestPostedRowForStory(STORY, {
      fetch: delFetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.externalPostId).toBe("post_to_delete");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toContain("post_to_delete");
    const fresh = await one<FacebookStoryRow>(
      "SELECT status FROM facebook_stories WHERE story_id = ?",
      [STORY],
    );
    expect(fresh?.status).toBe("deleted");
  });

  it("DELETE failure leaves the row alone", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch: postFetch } = makeFetchStub(
      successResponses("vid_keep", "post_stays_up"),
    );
    await publishShortToFacebookStory(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
      },
      { fetch: postFetch, sleepMs: noSleep },
    );

    const { fetch: delFetch } = makeFetchStub([
      {
        ok: false,
        status: 400,
        body: { error: { code: 100, message: "Cannot delete this object" } },
      },
    ]);
    const result = await deleteLatestPostedRowForStory(STORY, {
      fetch: delFetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Cannot delete");
    const fresh = await one<FacebookStoryRow>(
      "SELECT status FROM facebook_stories WHERE story_id = ?",
      [STORY],
    );
    expect(fresh?.status).toBe("posted");
  });
});
