// Phase 1 of _plans/2026-06-15-curation-system.md. Mirrors the Python
// suite in shape — same CRUD + active-at + slot isolation invariants.

import { beforeEach, describe, expect, it } from "vitest";

import { all, one, run } from "@/lib/db";
import {
  CURATION_SLOT_KINDS,
  addToSlot,
  getActivePicks,
  isCurationSlotKind,
  listAllSlots,
  listSlots,
  listSlotsForStory,
  removeFromSlot,
  reorderSlot,
  setSlotStories,
} from "./curation";

async function clear() {
  await run("DELETE FROM curation_slots", []);
}

describe("CURATION_SLOT_KINDS registry", () => {
  it("includes every documented kind", () => {
    expect(CURATION_SLOT_KINDS).toContain("billboard.featured");
    expect(CURATION_SLOT_KINDS).toContain("rail.top10");
    expect(CURATION_SLOT_KINDS).toContain("rail.new");
    expect(CURATION_SLOT_KINDS).toContain("category.Drama");
    expect(CURATION_SLOT_KINDS).toContain("category.Roommate");
  });

  it("isCurationSlotKind validates known + rejects unknown", () => {
    expect(isCurationSlotKind("rail.top10")).toBe(true);
    expect(isCurationSlotKind("rail.toptenz")).toBe(false);
    expect(isCurationSlotKind("")).toBe(false);
  });
});

describe("setSlotStories + listSlots", () => {
  beforeEach(clear);

  it("empty slot returns []", async () => {
    expect(await listSlots("rail.top10")).toEqual([]);
  });

  it("preserves order", async () => {
    const n = await setSlotStories("rail.top10", ["a", "b", "c"]);
    expect(n).toBe(3);
    const rows = await listSlots("rail.top10");
    expect(rows.map((r) => r.story_id)).toEqual(["a", "b", "c"]);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  it("set replaces atomically (no orphans)", async () => {
    await setSlotStories("rail.top10", ["a", "b", "c"]);
    await setSlotStories("rail.top10", ["x", "y"]);
    const rows = await listSlots("rail.top10");
    expect(rows.map((r) => r.story_id)).toEqual(["x", "y"]);
  });

  it("set on one slot leaves other slots alone", async () => {
    await setSlotStories("rail.top10", ["a", "b"]);
    await setSlotStories("rail.new", ["q", "r"]);
    const top10 = await listSlots("rail.top10");
    const fresh = await listSlots("rail.new");
    expect(top10.map((r) => r.story_id)).toEqual(["a", "b"]);
    expect(fresh.map((r) => r.story_id)).toEqual(["q", "r"]);
  });

  it("set [] clears the slot", async () => {
    await setSlotStories("rail.top10", ["a", "b"]);
    await setSlotStories("rail.top10", []);
    expect(await listSlots("rail.top10")).toEqual([]);
  });
});

describe("addToSlot + removeFromSlot", () => {
  beforeEach(clear);

  it("appends to position = max + 1", async () => {
    await setSlotStories("rail.top10", ["a", "b"]);
    await addToSlot("rail.top10", "c");
    const rows = await listSlots("rail.top10");
    expect(rows.map((r) => r.story_id)).toEqual(["a", "b", "c"]);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  it("respects explicit position", async () => {
    await addToSlot("rail.top10", "a", { position: 7 });
    const rows = await listSlots("rail.top10");
    expect(rows[0].position).toBe(7);
  });

  it("UNIQUE (slot_kind, story_id) rejects re-add", async () => {
    await addToSlot("rail.top10", "a");
    await expect(addToSlot("rail.top10", "a")).rejects.toThrow();
  });

  it("removeFromSlot returns true on hit, false on miss", async () => {
    const id = await addToSlot("rail.top10", "a");
    expect(await removeFromSlot(id)).toBe(true);
    expect(await removeFromSlot(id)).toBe(false);
    expect(await removeFromSlot("nope")).toBe(false);
  });
});

describe("reorderSlot", () => {
  beforeEach(clear);

  it("rewrites positions in submitted order", async () => {
    await setSlotStories("rail.top10", ["a", "b", "c"]);
    const initial = await listSlots("rail.top10");
    const reversed = [
      initial[2].id,
      initial[1].id,
      initial[0].id,
    ];
    await reorderSlot("rail.top10", reversed);
    const after = await listSlots("rail.top10");
    expect(after.map((r) => r.story_id)).toEqual(["c", "b", "a"]);
  });

  it("ignores ids that belong to a different slot", async () => {
    await setSlotStories("rail.top10", ["a"]);
    await setSlotStories("rail.new", ["x"]);
    const newId = (await listSlots("rail.new"))[0].id;
    const top10Id = (await listSlots("rail.top10"))[0].id;
    await reorderSlot("rail.top10", [newId, top10Id]);
    const newAfter = await listSlots("rail.new");
    expect(newAfter[0].story_id).toBe("x");
  });
});

describe("activeAt filter", () => {
  beforeEach(clear);

  it("hides future-publish rows", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600_000).toISOString();
    const past = new Date(now.getTime() - 3600_000).toISOString();
    await addToSlot("rail.top10", "future", { publishAt: future });
    await addToSlot("rail.top10", "past", { publishAt: past });
    const rows = await listSlots("rail.top10", { activeAt: now });
    expect(rows.map((r) => r.story_id)).toEqual(["past"]);
  });

  it("hides already-expired rows", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600_000).toISOString();
    const past = new Date(now.getTime() - 3600_000).toISOString();
    await addToSlot("rail.top10", "live", { expiresAt: future });
    await addToSlot("rail.top10", "dead", { expiresAt: past });
    const rows = await listSlots("rail.top10", { activeAt: now });
    expect(rows.map((r) => r.story_id)).toEqual(["live"]);
  });

  it("getActivePicks returns story_ids in order", async () => {
    await setSlotStories("rail.top10", ["a", "b"]);
    expect(await getActivePicks("rail.top10")).toEqual(["a", "b"]);
  });
});

describe("listSlotsForStory", () => {
  beforeEach(clear);

  it("returns every slot the story appears in", async () => {
    await addToSlot("rail.top10", "envelope");
    await addToSlot("category.Entitled", "envelope");
    await addToSlot("billboard.featured", "other");
    const rows = await listSlotsForStory("envelope");
    expect(rows.map((r) => r.slot_kind).sort()).toEqual([
      "category.Entitled",
      "rail.top10",
    ]);
  });

  it("empty for unknown story", async () => {
    expect(await listSlotsForStory("nope")).toEqual([]);
  });
});

describe("listAllSlots", () => {
  beforeEach(clear);

  it("groups rows by slot_kind, ordered within", async () => {
    await setSlotStories("rail.top10", ["a", "b"]);
    await setSlotStories("rail.new", ["q"]);
    const grouped = await listAllSlots();
    expect(grouped["rail.top10"]?.map((r) => r.story_id)).toEqual(["a", "b"]);
    expect(grouped["rail.new"]?.map((r) => r.story_id)).toEqual(["q"]);
  });

  // Sanity: clear() actually empties the table so the suite starts clean.
  it("returns empty after clear", async () => {
    expect(Object.keys(await listAllSlots())).toEqual([]);
    expect(
      ((await all<{ n: number | string }>(
        "SELECT count(*) AS n FROM curation_slots",
        [],
      )) as { n: number | string }[])[0].n,
    ).toBe(0);
    expect(await one<{ n: number | string }>(
      "SELECT count(*) AS n FROM curation_slots",
      [],
    )).toEqual({ n: 0 });
  });
});
