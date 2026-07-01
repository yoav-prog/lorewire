// Tests for the homepage_curation storage helpers. Exercises the
// position math (append, remove + densify, swap-with-neighbour) +
// the surface enum guard against the real SQLite test seam.
//
// Plan: _plans/2026-06-16-homepage-curation.md (phase 1).

import { beforeEach, describe, expect, it } from "vitest";
import { run } from "@/lib/db";
import {
  addToSurface,
  HOMEPAGE_SURFACES,
  listAllCuration,
  listSurface,
  moveInSurface,
  removeFromSurface,
  SURFACE_CAPACITY,
} from "@/lib/homepage-curation";

async function reset(): Promise<void> {
  await run("DELETE FROM homepage_curation WHERE 1=1", []);
}

beforeEach(async () => {
  await reset();
});

describe("addToSurface", () => {
  it("appends at the next position", async () => {
    const a = await addToSurface("top10", "story-a");
    const b = await addToSurface("top10", "story-b");
    const c = await addToSurface("top10", "story-c");
    expect(a.ok && a.row.position).toBe(0);
    expect(b.ok && b.row.position).toBe(1);
    expect(c.ok && c.row.position).toBe(2);
  });

  it("rejects unknown surfaces", async () => {
    const r = await addToSurface("not_a_rail", "story-a");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/unknown surface/);
    }
  });

  it("rejects an empty story_id", async () => {
    const r = await addToSurface("top10", "");
    expect(r.ok).toBe(false);
  });

  it("refuses to add the same story twice to one surface", async () => {
    await addToSurface("top10", "story-a");
    const dupe = await addToSurface("top10", "story-a");
    expect(dupe.ok).toBe(false);
    if (!dupe.ok) {
      expect(dupe.error).toMatch(/already in top10/);
    }
  });

  it("allows the same story across DIFFERENT surfaces", async () => {
    const a = await addToSurface("top10", "story-a");
    const b = await addToSurface("entitled-people", "story-a");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("refuses to overflow a fixed-capacity surface", async () => {
    // Hero capacity is 8 (rotation pool for the carousel). Filling all 8
    // is allowed; the 9th add must fail.
    for (let i = 0; i < 8; i++) {
      const r = await addToSurface("hero", `story-hero-${i}`);
      expect(r.ok).toBe(true);
    }
    const overflow = await addToSurface("hero", "story-hero-9");
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.error).toMatch(/full/);
    }
  });

  it("fills TOP 10 to capacity then refuses the 11th", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await addToSurface("top10", `story-${i}`);
      expect(r.ok).toBe(true);
    }
    const overflow = await addToSurface("top10", "story-11");
    expect(overflow.ok).toBe(false);
  });

  it("allows uncapped surfaces past 10 entries", async () => {
    for (let i = 0; i < 14; i++) {
      const r = await addToSurface("entitled-people", `story-${i}`);
      expect(r.ok).toBe(true);
    }
    const list = await listSurface("entitled-people");
    expect(list).toHaveLength(14);
  });
});

describe("removeFromSurface", () => {
  async function seedTop10(ids: string[]): Promise<void> {
    for (const id of ids) {
      const r = await addToSurface("top10", id);
      if (!r.ok) throw new Error(`seed: ${r.error}`);
    }
  }

  it("densifies positions so survivors are contiguous from 0", async () => {
    await seedTop10(["a", "b", "c", "d", "e"]);
    const r = await removeFromSurface("top10", "c");
    expect(r.ok).toBe(true);
    const after = await listSurface("top10");
    expect(after.map((x) => x.story_id)).toEqual(["a", "b", "d", "e"]);
    expect(after.map((x) => x.position)).toEqual([0, 1, 2, 3]);
  });

  it("removes the head cleanly", async () => {
    await seedTop10(["a", "b", "c"]);
    await removeFromSurface("top10", "a");
    const after = await listSurface("top10");
    expect(after.map((x) => x.story_id)).toEqual(["b", "c"]);
    expect(after.map((x) => x.position)).toEqual([0, 1]);
  });

  it("removes the tail cleanly", async () => {
    await seedTop10(["a", "b", "c"]);
    await removeFromSurface("top10", "c");
    const after = await listSurface("top10");
    expect(after.map((x) => x.story_id)).toEqual(["a", "b"]);
  });

  it("frees up a slot in a fixed-capacity surface", async () => {
    for (let i = 0; i < 10; i++) {
      await addToSurface("top10", `story-${i}`);
    }
    await removeFromSurface("top10", "story-5");
    const refill = await addToSurface("top10", "story-new");
    expect(refill.ok).toBe(true);
    if (refill.ok) {
      expect(refill.row.position).toBe(9);
    }
  });

  it("errors when the story isn't in the surface", async () => {
    await seedTop10(["a"]);
    const r = await removeFromSurface("top10", "ghost");
    expect(r.ok).toBe(false);
  });

  it("rejects unknown surfaces", async () => {
    const r = await removeFromSurface("not_a_rail", "story-a");
    expect(r.ok).toBe(false);
  });
});

describe("moveInSurface", () => {
  async function seed(ids: string[]): Promise<void> {
    for (const id of ids) {
      const r = await addToSurface("entitled-people", id);
      if (!r.ok) throw new Error(`seed: ${r.error}`);
    }
  }

  it("swaps a story up by one slot", async () => {
    await seed(["a", "b", "c", "d"]);
    const r = await moveInSurface("entitled-people", "c", "up");
    expect(r.ok).toBe(true);
    const after = await listSurface("entitled-people");
    expect(after.map((x) => x.story_id)).toEqual(["a", "c", "b", "d"]);
    expect(after.map((x) => x.position)).toEqual([0, 1, 2, 3]);
  });

  it("swaps a story down by one slot", async () => {
    await seed(["a", "b", "c", "d"]);
    const r = await moveInSurface("entitled-people", "b", "down");
    expect(r.ok).toBe(true);
    const after = await listSurface("entitled-people");
    expect(after.map((x) => x.story_id)).toEqual(["a", "c", "b", "d"]);
  });

  it("is a silent no-op when moving up at the head", async () => {
    await seed(["a", "b", "c"]);
    const r = await moveInSurface("entitled-people", "a", "up");
    expect(r.ok).toBe(true);
    const after = await listSurface("entitled-people");
    expect(after.map((x) => x.story_id)).toEqual(["a", "b", "c"]);
  });

  it("is a silent no-op when moving down at the tail", async () => {
    await seed(["a", "b", "c"]);
    const r = await moveInSurface("entitled-people", "c", "down");
    expect(r.ok).toBe(true);
    const after = await listSurface("entitled-people");
    expect(after.map((x) => x.story_id)).toEqual(["a", "b", "c"]);
  });

  it("errors on an unknown story", async () => {
    await seed(["a"]);
    const r = await moveInSurface("entitled-people", "ghost", "up");
    expect(r.ok).toBe(false);
  });

  it("rejects invalid directions", async () => {
    await seed(["a", "b"]);
    const r = await moveInSurface(
      "entitled-people",
      "a",
      "sideways" as "up" | "down",
    );
    expect(r.ok).toBe(false);
  });

  it("preserves uniqueness across the swap via the parking-position trick", async () => {
    // The (surface, position) unique index would reject a direct
    // position swap; the helper parks one row at -1 first. Chain three
    // swaps to make sure the parking position is always released.
    await seed(["a", "b", "c", "d"]);
    await moveInSurface("entitled-people", "d", "up"); // a, b, d, c
    await moveInSurface("entitled-people", "d", "up"); // a, d, b, c
    await moveInSurface("entitled-people", "d", "up"); // d, a, b, c
    const after = await listSurface("entitled-people");
    expect(after.map((x) => x.story_id)).toEqual(["d", "a", "b", "c"]);
    expect(after.map((x) => x.position)).toEqual([0, 1, 2, 3]);
  });
});

describe("listAllCuration", () => {
  it("groups rows by surface in position order", async () => {
    await addToSurface("top10", "t1");
    await addToSurface("top10", "t2");
    await addToSurface("entitled-people", "e1");
    await addToSurface("hero", "h1");
    const all = await listAllCuration();
    expect(all.top10.map((x) => x.story_id)).toEqual(["t1", "t2"]);
    expect(all["entitled-people"].map((x) => x.story_id)).toEqual(["e1"]);
    expect(all.hero.map((x) => x.story_id)).toEqual(["h1"]);
    expect(all["family-feuds"]).toEqual([]);
  });

  it("returns an empty object for each known surface when the table is empty", async () => {
    const all = await listAllCuration();
    for (const surface of HOMEPAGE_SURFACES) {
      expect(all[surface]).toEqual([]);
    }
  });
});

describe("SURFACE_CAPACITY contract", () => {
  it("hero is capped at 8 (rotation pool for the carousel)", () => {
    expect(SURFACE_CAPACITY.hero).toBe(8);
  });
  it("top10 is capped at 10", () => {
    expect(SURFACE_CAPACITY.top10).toBe(10);
  });
  it("category rows + new_row + continue are uncapped", () => {
    expect(SURFACE_CAPACITY.continue).toBeNull();
    expect(SURFACE_CAPACITY.new_row).toBeNull();
    expect(SURFACE_CAPACITY["entitled-people"]).toBeNull();
    expect(SURFACE_CAPACITY["family-feuds"]).toBeNull();
    expect(SURFACE_CAPACITY["wholesome-wins"]).toBeNull();
    expect(SURFACE_CAPACITY["dating-disasters"]).toBeNull();
    expect(SURFACE_CAPACITY["workplace"]).toBeNull();
    expect(SURFACE_CAPACITY["revenge-karma"]).toBeNull();
  });
});
