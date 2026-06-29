// Tests for publish-to-instagram-story. Mirrors publish-to-instagram.test.ts
// (the Reel publisher) modulo the caption-free Story flow:
//   - happy path: create container (media_type=STORIES) → poll FINISHED →
//     publish → 'posted'
//   - container ERROR → 'failed', no further calls
//   - retry from pending row with container_id skips step 1
//   - dedup at story level for auto path
//   - manual trigger bypasses auto-toggle gate
//   - skipped when env config missing
//   - create-container 4xx → failed with normalized error
//   - ig_account_id mismatch refuses to publish
//   - delete-previous success + failure paths
//
// Plan: _plans/2026-06-25-instagram-facebook-stories-cross-publish.md.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { all, one, run } from "@/lib/db";
import { setSetting } from "@/lib/repo";
import {
  attemptInstagramStoryPublishForRow,
  deleteLatestPostedRowForStory,
  publishShortToInstagramStory,
  SETTING_AUTO_PUBLISH,
  type IgFetchLike,
  type IgFetchResponse,
  type InstagramStoryRow,
} from "@/lib/publish-to-instagram-story";

// --- Test helpers ----------------------------------------------------------

interface StubCall {
  url: string;
  method: string;
  body: string | undefined;
}

interface StubResponse {
  ok: boolean;
  status: number;
  body: unknown;
  bodyText?: string;
}

function makeFetchStub(responses: StubResponse[]): {
  fetch: IgFetchLike;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const queue = [...responses];
  const fetch: IgFetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error(`stub fetch exhausted at ${url}`);
    const text = next.bodyText ?? JSON.stringify(next.body);
    const resp: IgFetchResponse = {
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
  await run("DELETE FROM instagram_stories WHERE 1=1", []);
  await run(
    "DELETE FROM settings WHERE key LIKE 'publisher.instagram.%'",
    [],
  );
}

const ORIGINAL_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const ORIGINAL_IG = process.env.IG_BUSINESS_ACCOUNT_ID;

beforeEach(async () => {
  await reset();
  process.env.FB_PAGE_ACCESS_TOKEN = "test-token-secret";
  process.env.IG_BUSINESS_ACCOUNT_ID = "17841413922168686";
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.FB_PAGE_ACCESS_TOKEN;
  else process.env.FB_PAGE_ACCESS_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_IG === undefined) delete process.env.IG_BUSINESS_ACCOUNT_ID;
  else process.env.IG_BUSINESS_ACCOUNT_ID = ORIGINAL_IG;
});

const STORY = "story-ig-story-test-1";
const RENDER = "render-ig-story-test-1";
const VIDEO_URL = "https://storage.googleapis.com/lorewire-media/x/video.mp4";

// --- publishShortToInstagramStory auto path --------------------------------

describe("publishShortToInstagramStory auto path", () => {
  it("happy path: create STORIES container → poll FINISHED → publish → posted", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch, calls } = makeFetchStub([
      { ok: true, status: 200, body: { id: "ig_story_container_42" } },
      { ok: true, status: 200, body: { status_code: "FINISHED" } },
      { ok: true, status: 200, body: { id: "ig_story_post_99" } },
    ]);
    const result = await publishShortToInstagramStory(
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
    expect(result.row.external_post_id).toBe("ig_story_post_99");
    expect(result.row.container_id).toBe("ig_story_container_42");
    expect(result.row.ig_account_id).toBe("17841413922168686");
    expect(result.row.attempts).toBe(1);
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toContain("/17841413922168686/media");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toContain("media_type=STORIES");
    expect(calls[0].body).toContain("video_url=");
    expect(calls[0].body).not.toContain("caption=");
    expect(calls[1].url).toContain("ig_story_container_42");
    expect(calls[1].url).toContain("fields=status_code");
    expect(calls[1].method).toBe("GET");
    expect(calls[2].url).toContain("/17841413922168686/media_publish");
    expect(calls[2].method).toBe("POST");
    expect(calls[2].body).toContain("creation_id=ig_story_container_42");
  });

  it("polls multiple times before FINISHED, then publishes", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch, calls } = makeFetchStub([
      { ok: true, status: 200, body: { id: "c1" } },
      { ok: true, status: 200, body: { status_code: "IN_PROGRESS" } },
      { ok: true, status: 200, body: { status_code: "IN_PROGRESS" } },
      { ok: true, status: 200, body: { status_code: "FINISHED" } },
      { ok: true, status: 200, body: { id: "ig_story_post_x" } },
    ]);
    const result = await publishShortToInstagramStory(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
      },
      { fetch, sleepMs: noSleep },
    );
    expect(result.status).toBe("posted");
    expect(calls).toHaveLength(5);
  });

  it("container ERROR status -> failed row, no publish call", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch, calls } = makeFetchStub([
      { ok: true, status: 200, body: { id: "c1" } },
      { ok: true, status: 200, body: { status_code: "ERROR" } },
    ]);
    const result = await publishShortToInstagramStory(
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
    expect(result.row.container_id).toBe("c1");
    expect(calls).toHaveLength(2);
  });

  it("dedups at story level for auto path", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch: fetch1 } = makeFetchStub([
      { ok: true, status: 200, body: { id: "c1" } },
      { ok: true, status: 200, body: { status_code: "FINISHED" } },
      { ok: true, status: 200, body: { id: "ig_story_first" } },
    ]);
    await publishShortToInstagramStory(
      {
        storyId: STORY,
        renderId: RENDER,
        videoUrl: VIDEO_URL,
        trigger: "auto",
      },
      { fetch: fetch1, sleepMs: noSleep },
    );

    const { fetch: fetch2, calls: calls2 } = makeFetchStub([]);
    const result = await publishShortToInstagramStory(
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
      "SELECT COUNT(*) AS n FROM instagram_stories WHERE story_id = ?",
      [STORY],
    );
    expect(Number(count[0].n)).toBe(1);
  });

  it("toggle off skips auto, manual still works", async () => {
    const { fetch: fetchAuto, calls: callsAuto } = makeFetchStub([]);
    const autoResult = await publishShortToInstagramStory(
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

    const { fetch: fetchManual } = makeFetchStub([
      { ok: true, status: 200, body: { id: "c-m" } },
      { ok: true, status: 200, body: { status_code: "FINISHED" } },
      { ok: true, status: 200, body: { id: "ig_story_manual" } },
    ]);
    const manualResult = await publishShortToInstagramStory(
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

  it("skipped when IG_BUSINESS_ACCOUNT_ID missing", async () => {
    delete process.env.IG_BUSINESS_ACCOUNT_ID;
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch, calls } = makeFetchStub([]);
    const result = await publishShortToInstagramStory(
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

  it("create-container 4xx -> failed row with normalized error", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch } = makeFetchStub([
      {
        ok: false,
        status: 400,
        body: {
          error: {
            code: 36000,
            error_subcode: 2207042,
            message: "Media format unsupported",
          },
        },
      },
    ]);
    const result = await publishShortToInstagramStory(
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
    expect(result.row.ig_error_code).toBe(36000);
    expect(result.row.ig_error_subcode).toBe(2207042);
    expect(result.row.error_message).toContain("Media format");
    expect(result.row.container_id).toBeNull();
  });

  it("ig_account_id mismatch -> failed before any network call", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const id = "row-mismatch-1";
    await run(
      `INSERT INTO instagram_stories (id, story_id, render_id, ig_account_id, trigger, video_url, status, attempts, created_at)
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
    const result = await attemptInstagramStoryPublishForRow(id, {
      fetch,
      sleepMs: noSleep,
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.row.error_message).toContain("ig_account_id mismatch");
    expect(calls).toHaveLength(0);
  });
});

// --- attemptInstagramStoryPublishForRow retry path ------------------------

describe("attemptInstagramStoryPublishForRow", () => {
  it("resumes from existing container_id (skips create), polls + publishes", async () => {
    const id = "resume-1";
    await run(
      `INSERT INTO instagram_stories (id, story_id, render_id, ig_account_id, trigger, video_url, container_id, status, attempts, created_at)
       VALUES (?, ?, ?, ?, 'auto', ?, ?, 'pending', 1, ?)`,
      [
        id,
        STORY,
        RENDER,
        "17841413922168686",
        VIDEO_URL,
        "existing_container_abc",
        new Date().toISOString(),
      ],
    );
    const { fetch, calls } = makeFetchStub([
      { ok: true, status: 200, body: { status_code: "FINISHED" } },
      { ok: true, status: 200, body: { id: "ig_story_resumed" } },
    ]);
    const result = await attemptInstagramStoryPublishForRow(id, {
      fetch,
      sleepMs: noSleep,
    });
    expect(result.status).toBe("posted");
    if (result.status !== "posted") return;
    expect(result.row.external_post_id).toBe("ig_story_resumed");
    expect(result.row.container_id).toBe("existing_container_abc");
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("existing_container_abc");
  });

  it("starts from create when no container_id on the failed row", async () => {
    const id = "no-container-1";
    await run(
      `INSERT INTO instagram_stories (id, story_id, render_id, ig_account_id, trigger, video_url, status, attempts, created_at)
       VALUES (?, ?, ?, ?, 'auto', ?, 'failed', 1, ?)`,
      [
        id,
        STORY,
        RENDER,
        "17841413922168686",
        VIDEO_URL,
        new Date().toISOString(),
      ],
    );
    const { fetch, calls } = makeFetchStub([
      { ok: true, status: 200, body: { id: "fresh_c" } },
      { ok: true, status: 200, body: { status_code: "FINISHED" } },
      { ok: true, status: 200, body: { id: "ig_story_fresh" } },
    ]);
    const result = await attemptInstagramStoryPublishForRow(id, {
      fetch,
      sleepMs: noSleep,
    });
    expect(result.status).toBe("posted");
    expect(calls).toHaveLength(3);
  });

  it("skipped when row not eligible (already posted)", async () => {
    const id = "already-posted-1";
    await run(
      `INSERT INTO instagram_stories (id, story_id, render_id, ig_account_id, trigger, video_url, status, external_post_id, attempts, created_at)
       VALUES (?, ?, ?, ?, 'auto', ?, 'posted', 'existing_post', 1, ?)`,
      [
        id,
        STORY,
        RENDER,
        "17841413922168686",
        VIDEO_URL,
        new Date().toISOString(),
      ],
    );
    const { fetch, calls } = makeFetchStub([]);
    const result = await attemptInstagramStoryPublishForRow(id, {
      fetch,
      sleepMs: noSleep,
    });
    expect(result.status).toBe("skipped");
    expect(calls).toHaveLength(0);
  });
});

// --- deleteLatestPostedRowForStory ----------------------------------------

describe("deleteLatestPostedRowForStory (IG Story)", () => {
  it("DELETEs the latest posted Story and flips row to deleted", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch: postFetch } = makeFetchStub([
      { ok: true, status: 200, body: { id: "c-del" } },
      { ok: true, status: 200, body: { status_code: "FINISHED" } },
      { ok: true, status: 200, body: { id: "ig_story_to_delete" } },
    ]);
    await publishShortToInstagramStory(
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
    expect(result.externalPostId).toBe("ig_story_to_delete");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toContain("ig_story_to_delete");
    const fresh = await one<InstagramStoryRow>(
      "SELECT status FROM instagram_stories WHERE story_id = ?",
      [STORY],
    );
    expect(fresh?.status).toBe("deleted");
  });

  it("DELETE failure leaves the row alone", async () => {
    await setSetting(SETTING_AUTO_PUBLISH, "1");
    const { fetch: postFetch } = makeFetchStub([
      { ok: true, status: 200, body: { id: "c-keep" } },
      { ok: true, status: 200, body: { status_code: "FINISHED" } },
      { ok: true, status: 200, body: { id: "ig_story_stays_up" } },
    ]);
    await publishShortToInstagramStory(
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
    const fresh = await one<InstagramStoryRow>(
      "SELECT status FROM instagram_stories WHERE story_id = ?",
      [STORY],
    );
    expect(fresh?.status).toBe("posted");
  });
});
