// Tests for autoCurateOnPublish. The helper is "best-effort + never
// throw" by design, so the test surface here is:
//   - on the happy path, the freshly-published story lands in new_row
//     AND its category rail
//   - unknown categories silently skip the category rail but still
//     hit new_row
//   - duplicate / full-rail situations are tolerated without raising
//   - missing storyId is a no-op
//
// Plan: _plans/2026-06-17-publish-auto-curates.md.

import { beforeEach, describe, expect, it } from "vitest";
import { all, run } from "@/lib/db";
import { addToSurface, listSurface } from "@/lib/homepage-curation";
import { autoCurateOnPublish } from "@/lib/publish-auto-curate";

async function reset(): Promise<void> {
  await run("DELETE FROM homepage_curation WHERE 1=1", []);
}

beforeEach(async () => {
  await reset();
});

describe("autoCurateOnPublish", () => {
  it("adds the story to new_row and its category rail", async () => {
    await autoCurateOnPublish("story-1", "Entitled");
    const newRow = await listSurface("new_row");
    const entitled = await listSurface("entitled_row");
    expect(newRow.map((r) => r.story_id)).toEqual(["story-1"]);
    expect(entitled.map((r) => r.story_id)).toEqual(["story-1"]);
  });

  it("normalises category casing before resolving the rail", async () => {
    // "ENTITLED" or " Entitled  " should still land in entitled_row.
    await autoCurateOnPublish("story-1", "ENTITLED");
    await autoCurateOnPublish("story-2", " Drama  ");
    expect((await listSurface("entitled_row")).map((r) => r.story_id)).toEqual([
      "story-1",
    ]);
    expect((await listSurface("drama_row")).map((r) => r.story_id)).toEqual([
      "story-2",
    ]);
  });

  it("adds to new_row even when the category rail name is unknown", async () => {
    // 'Crime' has no Crime_row on the homepage — the new_row add still
    // happens so the admin sees the story show up under New.
    await autoCurateOnPublish("story-1", "Crime");
    expect((await listSurface("new_row")).map((r) => r.story_id)).toEqual([
      "story-1",
    ]);
    // Sanity: nothing landed in a Crime-shaped surface (which doesn't
    // exist as a homepage rail anyway).
  });

  it("adds to new_row when category is null or empty", async () => {
    await autoCurateOnPublish("story-1", null);
    await autoCurateOnPublish("story-2", "");
    expect((await listSurface("new_row")).map((r) => r.story_id)).toEqual([
      "story-1",
      "story-2",
    ]);
  });

  it("tolerates a story already in new_row (publish-then-republish)", async () => {
    await addToSurface("new_row", "story-1");
    // Should NOT throw even though new_row already has story-1.
    await autoCurateOnPublish("story-1", "Drama");
    const newRow = await listSurface("new_row");
    expect(newRow.map((r) => r.story_id)).toEqual(["story-1"]);
    // Drama rail still gets the row though, since it's empty.
    const drama = await listSurface("drama_row");
    expect(drama.map((r) => r.story_id)).toEqual(["story-1"]);
  });

  it("tolerates a story already in both rails", async () => {
    await addToSurface("new_row", "story-1");
    await addToSurface("humor_row", "story-1");
    // Should not throw and should not duplicate.
    await autoCurateOnPublish("story-1", "Humor");
    expect((await listSurface("new_row")).length).toBe(1);
    expect((await listSurface("humor_row")).length).toBe(1);
  });

  it("is a no-op on empty storyId", async () => {
    await autoCurateOnPublish("", "Drama");
    const newRow = await all<{ n: number }>(
      "SELECT count(*) AS n FROM homepage_curation",
      [],
    );
    expect(newRow[0].n).toBe(0);
  });
});
