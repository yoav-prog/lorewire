// @vitest-environment node

// Orchestration tests for the publish route. The DB query layers, the engine,
// and auth are stubbed (their own integration tests cover them); here we pin
// the route's control flow: input validation, the readiness + connection
// guards, idempotency, the audio gate, the happy path, and the failure paths
// that flip the ledger row.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";
import * as dal from "@/lib/dal";
import * as shortQueue from "@/lib/short-render-queue";
import * as repo from "@/lib/repo";
import * as accounts from "@/lib/social-accounts";
import * as ledger from "@/lib/youtube-publishes";
import * as upload from "@/lib/youtube-upload";
import * as socialPublish from "@/lib/social-publish";

function req(body: unknown): Request {
  return new Request("http://localhost/api/social/youtube/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const DONE_RENDER = {
  id: "render-1",
  story_id: "story-1",
  status: "done",
  output_url: "https://storage.googleapis.com/bucket/short.mp4",
} as unknown as shortQueue.ShortRenderRow;

const ACCOUNT = {
  id: "account-1",
  platform: "youtube",
  status: "active",
} as unknown as accounts.SocialAccountRow;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(dal, "requireAdmin").mockResolvedValue({
    userId: "admin-1",
  } as unknown as Awaited<ReturnType<typeof dal.requireAdmin>>);
  vi.spyOn(repo, "getStory").mockResolvedValue({
    title: "A story",
    summary: "The summary.",
    category: "Drama",
  } as unknown as repo.StoryRow);
  // Sensible defaults for the happy path; individual tests override.
  vi.spyOn(shortQueue, "latestDoneShortRenderForStory").mockResolvedValue(DONE_RENDER);
  vi.spyOn(accounts, "getActiveSocialAccount").mockResolvedValue(ACCOUNT);
  vi.spyOn(ledger, "getActiveYoutubePublishForShort").mockResolvedValue(null);
  vi.spyOn(ledger, "insertInFlightYoutubePublish").mockResolvedValue("publish-1");
  vi.spyOn(ledger, "markYoutubePublished").mockResolvedValue(undefined);
  vi.spyOn(ledger, "markYoutubePublishFailed").mockResolvedValue(undefined);
  vi.spyOn(upload, "getValidYoutubeAccessToken").mockResolvedValue("access-token");
  vi.spyOn(upload, "uploadShortToYoutube").mockResolvedValue({ videoId: "vid-1" });
});

describe("POST /api/social/youtube/publish", () => {
  it("400 when storyId is missing", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("missing-storyId");
  });

  it("409 short-not-ready when there is no finished render", async () => {
    vi.spyOn(shortQueue, "latestDoneShortRenderForStory").mockResolvedValue(null);
    const res = await POST(req({ storyId: "story-1" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("short-not-ready");
  });

  it("409 not-connected when no YouTube account is active", async () => {
    vi.spyOn(accounts, "getActiveSocialAccount").mockResolvedValue(null);
    const res = await POST(req({ storyId: "story-1" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not-connected");
  });

  it("returns the existing URL when already published, without re-uploading", async () => {
    vi.spyOn(ledger, "getActiveYoutubePublishForShort").mockResolvedValue({
      status: "published",
      public_url: "https://www.youtube.com/shorts/old",
    } as unknown as ledger.YoutubePublishRow);
    const uploadSpy = vi.spyOn(upload, "uploadShortToYoutube");
    const res = await POST(req({ storyId: "story-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyPublished).toBe(true);
    expect(body.publicUrl).toBe("https://www.youtube.com/shorts/old");
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it("409 in-progress when a publish is already in flight", async () => {
    vi.spyOn(ledger, "getActiveYoutubePublishForShort").mockResolvedValue({
      status: "in_flight",
    } as unknown as ledger.YoutubePublishRow);
    const res = await POST(req({ storyId: "story-1" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("in-progress");
  });

  it("422 when the audio gate blocks", async () => {
    vi.spyOn(socialPublish, "audioClearanceGate").mockReturnValue({
      allowed: false,
      verdict: "blocked",
      reason: "unknown audio provenance",
    });
    const res = await POST(req({ storyId: "story-1" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("audio-blocked");
  });

  it("happy path: uploads, marks published, returns the shorts URL", async () => {
    const res = await POST(req({ storyId: "story-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("published");
    expect(body.videoId).toBe("vid-1");
    expect(body.publicUrl).toBe("https://www.youtube.com/shorts/vid-1");
    expect(ledger.markYoutubePublished).toHaveBeenCalledWith(
      "publish-1",
      "vid-1",
      "https://www.youtube.com/shorts/vid-1",
    );
  });

  it("409 needs-reauth and marks failed when the token cannot be resolved", async () => {
    vi.spyOn(upload, "getValidYoutubeAccessToken").mockResolvedValue(null);
    const res = await POST(req({ storyId: "story-1" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("needs-reauth");
    expect(ledger.markYoutubePublishFailed).toHaveBeenCalled();
  });

  it("502 upload-failed and marks failed when the upload throws", async () => {
    vi.spyOn(upload, "uploadShortToYoutube").mockRejectedValue(
      new Error("videos.insert upload returned 403"),
    );
    const res = await POST(req({ storyId: "story-1" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("upload-failed");
    expect(body.detail).toContain("403");
    expect(ledger.markYoutubePublishFailed).toHaveBeenCalled();
  });
});
