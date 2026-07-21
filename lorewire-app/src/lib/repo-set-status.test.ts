// setStatus's publish-time media invariant: the flip to 'published'
// refuses a story with an empty video_url. This is the last line of
// defense behind evaluateAssetCompleteness — on 2026-07-02 two stories
// went live with finished renders in storage but a NULL video_url, so
// the public Watch tab had nothing to play. Submission-origin stories
// are exempt (the poll-only approval mode publishes text polls with no
// render by design — lib/submission-promote.ts); 'ready' stays exempt
// because a story can be reviewed-ready while its render is queued.
//
// Plan: _plans/2026-07-02-never-publish-without-video.md.

import { beforeEach, describe, expect, it } from "vitest";
import { one, run } from "@/lib/db";
import { setStatus } from "@/lib/repo";

const STORY_ID = "test-setstatus-story";

async function reset(): Promise<void> {
  await run("DELETE FROM stories WHERE id = ?", [STORY_ID]);
}

async function seedStory(video_url: string | null, submissionId: string | null = null): Promise<void> {
  const now = new Date().toISOString();
  await run(
    `INSERT INTO stories
       (id, reddit_id, submission_id, status, body, hero_image, video_url,
        created_at, updated_at)
     VALUES (?, 'realthread1', ?, 'review', 'A real body.', 'https://example.com/hero.png', ?, ?, ?)`,
    [STORY_ID, submissionId, video_url, now, now],
  );
}

beforeEach(reset);

describe("setStatus publish media invariant", () => {
  it("refuses the flip to 'published' when video_url is NULL", async () => {
    await seedStory(null);
    await expect(setStatus(STORY_ID, "published")).rejects.toThrow(
      /video_url is empty/,
    );
    const row = await one<{ status: string }>(
      "SELECT status FROM stories WHERE id = ?",
      [STORY_ID],
    );
    expect(row?.status).toBe("review");
  });

  it("refuses the flip to 'published' when video_url is an empty string", async () => {
    await seedStory("   ");
    await expect(setStatus(STORY_ID, "published")).rejects.toThrow(
      /video_url is empty/,
    );
  });

  it("exempts submission-origin stories (poll-only mode publishes without a render by design)", async () => {
    await seedStory(null, "sub-1");
    await setStatus(STORY_ID, "published");
    const row = await one<{ status: string }>(
      "SELECT status FROM stories WHERE id = ?",
      [STORY_ID],
    );
    expect(row?.status).toBe("published");
  });

  it("publishes when video_url is set", async () => {
    await seedStory("https://example.com/short.mp4");
    await setStatus(STORY_ID, "published");
    const row = await one<{ status: string; published_at: string | null }>(
      "SELECT status, published_at FROM stories WHERE id = ?",
      [STORY_ID],
    );
    expect(row?.status).toBe("published");
    expect(row?.published_at).toBeTruthy();
  });

  it("still allows 'ready' without a video (render may be queued)", async () => {
    await seedStory(null);
    await setStatus(STORY_ID, "ready");
    const row = await one<{ status: string }>(
      "SELECT status FROM stories WHERE id = ?",
      [STORY_ID],
    );
    expect(row?.status).toBe("ready");
  });

  it("still allows non-public statuses without a video", async () => {
    await seedStory(null);
    await setStatus(STORY_ID, "archived");
    const row = await one<{ status: string }>(
      "SELECT status FROM stories WHERE id = ?",
      [STORY_ID],
    );
    expect(row?.status).toBe("archived");
  });
});
