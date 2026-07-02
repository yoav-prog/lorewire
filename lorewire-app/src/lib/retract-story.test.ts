// Tests for the retract path: queued rows cancelled, story archived,
// per-platform delete outcomes mapped (including TikTok's no-delete-API
// caveat), and platform failures reported without aborting the rest.
// The four platform delete helpers are mocked; the store is real.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { all, run } from "@/lib/db";

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));
vi.mock("@/lib/publish-to-youtube", () => ({
  deleteLatestPostedRowForStory: vi.fn(),
}));
vi.mock("@/lib/publish-to-facebook", () => ({
  deleteLatestPostedRowForStory: vi.fn(),
}));
vi.mock("@/lib/publish-to-instagram", () => ({
  deleteLatestPostedRowForStory: vi.fn(),
}));
vi.mock("@/lib/publish-to-tiktok", () => ({
  deleteLatestPostedRowForStory: vi.fn(),
}));

import { deleteLatestPostedRowForStory as deleteYouTubePost } from "@/lib/publish-to-youtube";
import { deleteLatestPostedRowForStory as deleteFacebookPostRow } from "@/lib/publish-to-facebook";
import { deleteLatestPostedRowForStory as deleteInstagramPostRow } from "@/lib/publish-to-instagram";
import { deleteLatestPostedRowForStory as deleteTikTokPostRow } from "@/lib/publish-to-tiktok";
import { retractStory } from "./retract-story";

const NONE = { ok: false as const, error: "no posted row found for story" };

async function clear() {
  await run("DELETE FROM stories", []);
  await run("DELETE FROM scheduled_publishes", []);
  vi.mocked(deleteYouTubePost).mockResolvedValue(NONE);
  vi.mocked(deleteFacebookPostRow).mockResolvedValue(NONE);
  vi.mocked(deleteInstagramPostRow).mockResolvedValue(NONE);
  vi.mocked(deleteTikTokPostRow).mockResolvedValue(NONE);
}

async function insertPublishedStory(id: string) {
  await run(
    "INSERT INTO stories (id, title, status, created_at, updated_at) " +
      "VALUES (?, 'T', 'published', '2026-07-01', '2026-07-01')",
    [id],
  );
}

async function insertQueuedRow(id: string, storyId: string, platform: string, state = "scheduled") {
  await run(
    "INSERT INTO scheduled_publishes (id, story_id, platform, scheduled_for, state, attempts, created_at) " +
      "VALUES (?, ?, ?, '2026-07-09T09:00:00.000Z', ?, 0, '2026-07-01')",
    [id, storyId, platform, state],
  );
}

describe("retractStory", () => {
  beforeEach(clear);

  it("refuses an unknown story", async () => {
    const r = await retractStory("nope");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("story_not_found");
  });

  it("cancels queued posts, archives the story, reports untouched platforms", async () => {
    await insertPublishedStory("s1");
    await insertQueuedRow("q1", "s1", "youtube");
    await insertQueuedRow("q2", "s1", "tiktok");
    await insertQueuedRow("q3", "s1", "facebook", "published"); // already out: not cancellable

    const r = await retractStory("s1");
    expect(r.ok).toBe(true);
    expect(r.cancelledQueued).toBe(2);
    expect(r.archived).toBe(true);

    const story = await all<{ status: string }>(
      "SELECT status FROM stories WHERE id = 's1'",
      [],
    );
    expect(story[0].status).toBe("archived");

    const states = await all<{ id: string; state: string }>(
      "SELECT id, state FROM scheduled_publishes ORDER BY id",
      [],
    );
    expect(states).toEqual([
      { id: "q1", state: "cancelled" },
      { id: "q2", state: "cancelled" },
      { id: "q3", state: "published" },
    ]);
  });

  it("maps platform outcomes: deleted, manual (tiktok), nothing_posted, failed", async () => {
    await insertPublishedStory("s1");
    vi.mocked(deleteYouTubePost).mockResolvedValue({
      ok: true,
      rowId: "r",
      externalVideoId: "v",
    });
    vi.mocked(deleteFacebookPostRow).mockResolvedValue({
      ok: false,
      error: "graph api 500",
    } as Awaited<ReturnType<typeof deleteFacebookPostRow>>);
    vi.mocked(deleteTikTokPostRow).mockResolvedValue({
      ok: true,
      rowId: "r",
      externalPostId: "p",
    });

    const r = await retractStory("s1");
    const byPlatform = Object.fromEntries(r.platforms.map((p) => [p.platform, p.status]));
    expect(byPlatform).toEqual({
      youtube: "deleted",
      facebook: "failed",
      instagram: "nothing_posted",
      tiktok: "manual_delete_needed",
    });
    // A platform failure never blocks the others or the site takedown.
    expect(r.ok).toBe(true);
    expect(r.archived).toBe(true);
  });

  it("is safe to retry: a second retract is a no-op that still reports ok", async () => {
    await insertPublishedStory("s1");
    const first = await retractStory("s1");
    expect(first.archived).toBe(true);
    const second = await retractStory("s1");
    expect(second.ok).toBe(true);
    expect(second.archived).toBe(false); // it was no longer published
    expect(second.cancelledQueued).toBe(0);
  });
});
