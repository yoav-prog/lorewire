// @vitest-environment node

// Integration tests for the youtube_publishes ledger against the real (temp
// SQLite) DB. Validates the schema + SQL and the Phase 1 idempotency guard:
// an in_flight or published row owns the short; a failed row never blocks a
// retry.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "@/lib/db";
import {
  getActiveYoutubePublishForShort,
  insertInFlightYoutubePublish,
  latestYoutubePublishForShort,
  markYoutubePublishFailed,
  markYoutubePublished,
} from "./youtube-publishes";

async function clean() {
  await run("DELETE FROM youtube_publishes WHERE 1=1", []);
}
beforeEach(clean);
afterEach(clean);

const SHORT = "render-1";
const ACCOUNT = "account-1";

describe("youtube_publishes ledger", () => {
  it("a fresh in_flight row owns the short", async () => {
    const id = await insertInFlightYoutubePublish({
      shortId: SHORT,
      accountId: ACCOUNT,
      audioClearance: "tts",
    });
    const active = await getActiveYoutubePublishForShort(SHORT);
    expect(active?.id).toBe(id);
    expect(active?.status).toBe("in_flight");
    expect(active?.audio_clearance).toBe("tts");
  });

  it("marking published carries the video id + URL and still counts as active", async () => {
    const id = await insertInFlightYoutubePublish({
      shortId: SHORT,
      accountId: ACCOUNT,
      audioClearance: "tts",
    });
    await markYoutubePublished(id, "yt-vid-1", "https://www.youtube.com/shorts/yt-vid-1");
    const active = await getActiveYoutubePublishForShort(SHORT);
    expect(active?.status).toBe("published");
    expect(active?.external_post_id).toBe("yt-vid-1");
    expect(active?.public_url).toBe("https://www.youtube.com/shorts/yt-vid-1");
  });

  it("a failed publish does not block a retry", async () => {
    const failed = await insertInFlightYoutubePublish({
      shortId: SHORT,
      accountId: ACCOUNT,
      audioClearance: "tts",
    });
    await markYoutubePublishFailed(failed, "boom");
    // Failed rows are excluded from the active guard.
    expect(await getActiveYoutubePublishForShort(SHORT)).toBeNull();

    const retry = await insertInFlightYoutubePublish({
      shortId: SHORT,
      accountId: ACCOUNT,
      audioClearance: "tts",
    });
    const active = await getActiveYoutubePublishForShort(SHORT);
    expect(active?.id).toBe(retry);
  });

  it("records the error message on failure", async () => {
    const id = await insertInFlightYoutubePublish({
      shortId: SHORT,
      accountId: ACCOUNT,
      audioClearance: "tts",
    });
    await markYoutubePublishFailed(id, "quotaExceeded");
    const latest = await latestYoutubePublishForShort(SHORT);
    expect(latest?.status).toBe("failed");
    expect(latest?.last_error).toBe("quotaExceeded");
  });
});
