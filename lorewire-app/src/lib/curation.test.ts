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

describe("listPublishedStoriesForCuration", () => {
  beforeEach(clear);

  async function seedStory(
    id: string,
    status: string,
    title: string,
    category: string,
  ) {
    await run(
      "INSERT INTO stories (id, status, title, category, created_at, updated_at, published_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, status, title, category, "2026-06-15T00:00:00+00:00",
       "2026-06-15T00:00:00+00:00", "2026-06-15T00:00:00+00:00"],
    );
  }

  it("returns only published stories", async () => {
    await run("DELETE FROM stories", []);
    await seedStory("a", "published", "A", "Drama");
    await seedStory("b", "review", "B", "Drama");
    await seedStory("c", "archived", "C", "Drama");
    const { listPublishedStoriesForCuration } = await import("./curation");
    const rows = await listPublishedStoriesForCuration();
    expect(rows.map((r) => r.id).sort()).toEqual(["a"]);
  });

  it("returns empty array when no stories at all", async () => {
    await run("DELETE FROM stories", []);
    const { listPublishedStoriesForCuration } = await import("./curation");
    expect(await listPublishedStoriesForCuration()).toEqual([]);
  });
});

describe("resolveCategoryPage", () => {
  async function seedStory(
    id: string,
    status: string,
    title: string,
    category: string,
    publishedAt: string,
  ) {
    await run(
      "INSERT INTO stories (id, status, title, category, hero_image, summary, " +
        "created_at, updated_at, published_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        status,
        title,
        category,
        `https://example/${id}.png`,
        `summary for ${id}`,
        publishedAt,
        publishedAt,
        publishedAt,
      ],
    );
  }

  beforeEach(async () => {
    await clear();
    await run("DELETE FROM stories", []);
  });

  it("returns empty when no published stories", async () => {
    const { resolveCategoryPage } = await import("./curation");
    expect(await resolveCategoryPage("Drama")).toEqual([]);
  });

  it("auto-fills with published stories of the category, newest-first", async () => {
    const { resolveCategoryPage } = await import("./curation");
    await seedStory("a", "published", "A", "Drama", "2026-06-01T00:00:00+00:00");
    await seedStory("b", "published", "B", "Drama", "2026-06-10T00:00:00+00:00");
    await seedStory("c", "published", "C", "Drama", "2026-06-05T00:00:00+00:00");
    const rows = await resolveCategoryPage("Drama");
    expect(rows.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(rows.every((r) => r.pinned === false)).toBe(true);
  });

  it("filters out other categories", async () => {
    const { resolveCategoryPage } = await import("./curation");
    await seedStory("a", "published", "A", "Drama", "2026-06-10T00:00:00+00:00");
    await seedStory("b", "published", "B", "Humor", "2026-06-10T00:00:00+00:00");
    const rows = await resolveCategoryPage("Drama");
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("filters out unpublished stories", async () => {
    const { resolveCategoryPage } = await import("./curation");
    await seedStory("a", "published", "A", "Drama", "2026-06-10T00:00:00+00:00");
    await seedStory("b", "review", "B", "Drama", "2026-06-10T00:00:00+00:00");
    await seedStory("c", "archived", "C", "Drama", "2026-06-10T00:00:00+00:00");
    const rows = await resolveCategoryPage("Drama");
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("puts pinned stories first in admin order, then auto-fills", async () => {
    const { resolveCategoryPage, setSlotStories } = await import("./curation");
    // Three Drama stories, newest is 'c'.
    await seedStory("a", "published", "A", "Drama", "2026-06-01T00:00:00+00:00");
    await seedStory("b", "published", "B", "Drama", "2026-06-05T00:00:00+00:00");
    await seedStory("c", "published", "C", "Drama", "2026-06-10T00:00:00+00:00");
    // Admin pins a first, then c.
    await setSlotStories("category.Drama", ["a", "c"]);

    const rows = await resolveCategoryPage("Drama");
    expect(rows.map((r) => r.id)).toEqual(["a", "c", "b"]);
    expect(rows[0].pinned).toBe(true);
    expect(rows[1].pinned).toBe(true);
    expect(rows[2].pinned).toBe(false);
  });

  it("ignores pinned ids whose story is unpublished or missing", async () => {
    const { resolveCategoryPage, setSlotStories } = await import("./curation");
    await seedStory("a", "published", "A", "Drama", "2026-06-10T00:00:00+00:00");
    await seedStory("b", "review", "B", "Drama", "2026-06-10T00:00:00+00:00");
    await setSlotStories("category.Drama", ["a", "b", "ghost"]);
    const rows = await resolveCategoryPage("Drama");
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("respects the limit", async () => {
    const { resolveCategoryPage } = await import("./curation");
    for (let i = 0; i < 5; i++) {
      await seedStory(
        `s${i}`,
        "published",
        `S${i}`,
        "Drama",
        `2026-06-0${i + 1}T00:00:00+00:00`,
      );
    }
    const rows = await resolveCategoryPage("Drama", { limit: 2 });
    expect(rows.map((r) => r.id)).toEqual(["s4", "s3"]);
  });
});

describe("getHomePagePicks", () => {
  // These tests focus on the picks the admin actually pinned. Phase 6
  // adds auto-fill on by default; disable it here so the assertions
  // only see what setSlotStories/addToSlot wrote. Auto-fill behaviour
  // has its own describe block below.
  beforeEach(async () => {
    await clear();
    await run(
      "INSERT INTO settings (key, value) VALUES (?, ?), (?, ?), (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [
        "curation.autofill.rail.top10", "0",
        "curation.autofill.rail.new", "0",
        "curation.autofill.rail.entitled", "0",
      ],
    );
  });

  it("returns null billboard and empty rails when no slots set", async () => {
    const { getHomePagePicks } = await import("./curation");
    const picks = await getHomePagePicks();
    expect(picks).toEqual({
      billboard: null,
      continueRow: [],
      top10: [],
      entitled: [],
      newRow: [],
    });
  });

  it("returns first billboard.featured row as billboard pick", async () => {
    const { getHomePagePicks, setSlotStories } = await import("./curation");
    await setSlotStories("billboard.featured", ["hero"]);
    const picks = await getHomePagePicks();
    expect(picks.billboard).toBe("hero");
  });

  it("returns each rail in admin order", async () => {
    const { getHomePagePicks, setSlotStories } = await import("./curation");
    await setSlotStories("rail.continue", ["c1", "c2"]);
    await setSlotStories("rail.top10", ["t1", "t2", "t3"]);
    await setSlotStories("rail.entitled", ["e1"]);
    await setSlotStories("rail.new", ["n1", "n2"]);
    const picks = await getHomePagePicks();
    expect(picks.continueRow).toEqual(["c1", "c2"]);
    expect(picks.top10).toEqual(["t1", "t2", "t3"]);
    expect(picks.entitled).toEqual(["e1"]);
    expect(picks.newRow).toEqual(["n1", "n2"]);
  });

  it("partitions independently — pinning one rail doesn't leak into another", async () => {
    const { getHomePagePicks, setSlotStories } = await import("./curation");
    await setSlotStories("rail.top10", ["a"]);
    const picks = await getHomePagePicks();
    expect(picks.top10).toEqual(["a"]);
    expect(picks.continueRow).toEqual([]);
    expect(picks.entitled).toEqual([]);
    expect(picks.newRow).toEqual([]);
    expect(picks.billboard).toBeNull();
  });

  it("respects activeAt — hides future-publish rows", async () => {
    const { addToSlot, getHomePagePicks } = await import("./curation");
    const now = new Date();
    const future = new Date(now.getTime() + 3600_000).toISOString();
    await addToSlot("rail.top10", "soon", { publishAt: future });
    await addToSlot("rail.top10", "now");
    const picks = await getHomePagePicks(now);
    expect(picks.top10).toEqual(["now"]);
  });

  it("respects activeAt — hides expired rows", async () => {
    const { addToSlot, getHomePagePicks } = await import("./curation");
    const now = new Date();
    const past = new Date(now.getTime() - 3600_000).toISOString();
    await addToSlot("rail.top10", "dead", { expiresAt: past });
    await addToSlot("rail.top10", "live");
    const picks = await getHomePagePicks(now);
    expect(picks.top10).toEqual(["live"]);
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

// ─── Phase 6: scheduling + auto-fill + cleanup ──────────────────────────────

describe("setSlotPicks", () => {
  beforeEach(clear);

  it("round-trips publish_at and expires_at", async () => {
    const { setSlotPicks, listSlots } = await import("./curation");
    const pub = "2026-06-20T12:00:00.000Z";
    const exp = "2026-07-01T00:00:00.000Z";
    await setSlotPicks("rail.top10", [
      { story_id: "a", publish_at: pub, expires_at: exp },
      { story_id: "b", publish_at: null, expires_at: null },
    ]);
    const rows = await listSlots("rail.top10");
    expect(rows.map((r) => r.story_id)).toEqual(["a", "b"]);
    expect(rows[0].publish_at).toBe(pub);
    expect(rows[0].expires_at).toBe(exp);
    expect(rows[1].publish_at).toBeNull();
    expect(rows[1].expires_at).toBeNull();
  });

  it("accepts datetime-local format and normalizes to ISO UTC", async () => {
    const { setSlotPicks, listSlots } = await import("./curation");
    // datetime-local widget output: no seconds, no zone.
    await setSlotPicks("rail.top10", [
      { story_id: "a", publish_at: "2026-06-20T12:00", expires_at: "" },
    ]);
    const rows = await listSlots("rail.top10");
    expect(rows[0].publish_at).toBe("2026-06-20T12:00:00.000Z");
    expect(rows[0].expires_at).toBeNull();
  });

  it("atomic replace clears prior rows including their schedules", async () => {
    const { setSlotPicks, listSlots } = await import("./curation");
    await setSlotPicks("rail.top10", [
      { story_id: "a", publish_at: "2026-06-20T12:00:00.000Z" },
    ]);
    await setSlotPicks("rail.top10", [{ story_id: "b" }]);
    const rows = await listSlots("rail.top10");
    expect(rows.map((r) => r.story_id)).toEqual(["b"]);
    expect(rows[0].publish_at).toBeNull();
  });

  it("scheduled rows hide from getHomePagePicks before publish_at", async () => {
    const { setSlotPicks, getHomePagePicks } = await import("./curation");
    const now = new Date("2026-06-20T00:00:00.000Z");
    await setSlotPicks("rail.top10", [
      { story_id: "future", publish_at: "2026-06-21T00:00:00.000Z" },
      { story_id: "now", publish_at: "2026-06-19T00:00:00.000Z" },
    ]);
    // Disable auto-fill so the test only inspects the activeAt filter.
    await run(
      "INSERT INTO settings (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ["curation.autofill.rail.top10", "0"],
    );
    const picks = await getHomePagePicks(now);
    expect(picks.top10).toEqual(["now"]);
  });
});

describe("appendAutofill", () => {
  it("pads pinned to target with newest, skipping duplicates", async () => {
    const { appendAutofill } = await import("./curation");
    expect(appendAutofill(["a", "b"], ["c", "a", "d", "e"], 4)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("respects pinned that's already at target", async () => {
    const { appendAutofill } = await import("./curation");
    expect(appendAutofill(["a", "b", "c"], ["d"], 3)).toEqual(["a", "b", "c"]);
  });

  it("does not exceed target even when newest has more", async () => {
    const { appendAutofill } = await import("./curation");
    expect(appendAutofill([], ["a", "b", "c", "d"], 2)).toEqual(["a", "b"]);
  });
});

describe("auto-fill in getHomePagePicks", () => {
  beforeEach(async () => {
    await clear();
    await run("DELETE FROM stories", []);
    await run(
      "DELETE FROM settings WHERE key LIKE 'curation.autofill.%'",
      [],
    );
  });

  async function seedStory(id: string, publishedAt: string) {
    await run(
      "INSERT INTO stories (id, status, title, category, created_at, " +
        "updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, "published", id, "Drama", publishedAt, publishedAt, publishedAt],
    );
  }

  it("pads empty rail.top10 with 10 newest published when autofill on", async () => {
    const { getHomePagePicks } = await import("./curation");
    for (let i = 0; i < 12; i++) {
      const d = `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00+00:00`;
      await seedStory(`s${i}`, d);
    }
    const picks = await getHomePagePicks();
    expect(picks.top10.length).toBe(10);
    // Newest-first: s11 then s10 then s9 ...
    expect(picks.top10[0]).toBe("s11");
    expect(picks.top10[9]).toBe("s2");
  });

  it("does not pad when autofill disabled", async () => {
    const { getHomePagePicks } = await import("./curation");
    for (let i = 0; i < 12; i++) {
      const d = `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00+00:00`;
      await seedStory(`s${i}`, d);
    }
    await run(
      "INSERT INTO settings (key, value) VALUES (?, ?), (?, ?), (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [
        "curation.autofill.rail.top10", "0",
        "curation.autofill.rail.new", "0",
        "curation.autofill.rail.entitled", "0",
      ],
    );
    const picks = await getHomePagePicks();
    expect(picks.top10).toEqual([]);
    expect(picks.newRow).toEqual([]);
    expect(picks.entitled).toEqual([]);
  });

  it("preserves pinned order and appends autofill after", async () => {
    const { getHomePagePicks, setSlotStories } = await import("./curation");
    for (let i = 0; i < 12; i++) {
      const d = `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00+00:00`;
      await seedStory(`s${i}`, d);
    }
    await setSlotStories("rail.top10", ["s0", "s1"]);
    const picks = await getHomePagePicks();
    expect(picks.top10.length).toBe(10);
    expect(picks.top10.slice(0, 2)).toEqual(["s0", "s1"]);
    // Auto-fill is newest-first AND skips already-pinned, so s11, s10, ...
    expect(picks.top10[2]).toBe("s11");
    // Pinned ids appear exactly once even though they sit in both the
    // pinned set and the newest-published query result.
    expect(picks.top10.filter((id) => id === "s0").length).toBe(1);
    expect(picks.top10.filter((id) => id === "s1").length).toBe(1);
  });

  it("excludes rail.continue from auto-fill", async () => {
    const { getHomePagePicks } = await import("./curation");
    for (let i = 0; i < 12; i++) {
      const d = `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00+00:00`;
      await seedStory(`s${i}`, d);
    }
    const picks = await getHomePagePicks();
    expect(picks.continueRow).toEqual([]);
  });
});

describe("normalizeIso", () => {
  it("accepts datetime-local without seconds", async () => {
    const { normalizeIso } = await import("./curation");
    expect(normalizeIso("2026-06-20T12:00")).toBe("2026-06-20T12:00:00.000Z");
  });

  it("accepts datetime-local with seconds (Firefox step<60)", async () => {
    const { normalizeIso } = await import("./curation");
    expect(normalizeIso("2026-06-20T12:00:45")).toBe(
      "2026-06-20T12:00:45.000Z",
    );
  });

  it("accepts full ISO with Z", async () => {
    const { normalizeIso } = await import("./curation");
    expect(normalizeIso("2026-06-20T12:00:00.000Z")).toBe(
      "2026-06-20T12:00:00.000Z",
    );
  });

  it("accepts ISO with explicit offset", async () => {
    const { normalizeIso } = await import("./curation");
    // +02:00 -> shifts back to UTC.
    expect(normalizeIso("2026-06-20T14:00:00+02:00")).toBe(
      "2026-06-20T12:00:00.000Z",
    );
  });

  it("rejects bare date (ambiguous instant)", async () => {
    const { normalizeIso } = await import("./curation");
    expect(normalizeIso("2026-06-20")).toBeNull();
  });

  it("rejects zoneless full ISO that isn't datetime-local shape", async () => {
    const { normalizeIso } = await import("./curation");
    // No Z and no offset — would silently shift by the server's tz.
    expect(normalizeIso("garbage")).toBeNull();
  });

  it("returns null for empty / null / undefined", async () => {
    const { normalizeIso } = await import("./curation");
    expect(normalizeIso("")).toBeNull();
    expect(normalizeIso(null)).toBeNull();
    expect(normalizeIso(undefined)).toBeNull();
  });
});

describe("setSlotPicks transactional behaviour", () => {
  beforeEach(clear);

  it("rolls back when the INSERT fails (no half-applied DELETE)", async () => {
    const { setSlotPicks, listSlots } = await import("./curation");
    // Seed an initial pick.
    await setSlotPicks("rail.top10", [{ story_id: "keep" }]);
    // Now attempt a write whose INSERT will explode (UNIQUE collision on
    // the SAME slot_kind + story_id within the new batch). The
    // post-DELETE state inside the failed transaction must not survive.
    await expect(
      setSlotPicks("rail.top10", [
        { story_id: "dup" },
        { story_id: "dup" }, // same story twice — UNIQUE violation
      ]),
    ).rejects.toThrow();
    const rows = await listSlots("rail.top10");
    expect(rows.map((r) => r.story_id)).toEqual(["keep"]);
  });
});

describe("deleteExpiredSlotRows", () => {
  beforeEach(clear);

  it("treats a row at exactly the cutoff as still-fresh (boundary is exclusive)", async () => {
    const { addToSlot, deleteExpiredSlotRows, listSlots } = await import(
      "./curation"
    );
    const now = new Date("2026-06-20T00:00:00.000Z");
    // Exactly cutoff = now - 7 days.
    const atCutoff = new Date(
      now.getTime() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await addToSlot("rail.top10", "edge", { expiresAt: atCutoff });
    expect(await deleteExpiredSlotRows(now, 7)).toBe(0);
    expect((await listSlots("rail.top10")).length).toBe(1);
  });

  it("hard-deletes rows whose expires_at is older than the grace window", async () => {
    const { addToSlot, deleteExpiredSlotRows, listSlots } = await import(
      "./curation"
    );
    const now = new Date("2026-06-20T00:00:00.000Z");
    const longGone = "2026-06-01T00:00:00.000Z"; // 19 days before now
    const recent = "2026-06-18T00:00:00.000Z"; // 2 days before now
    await addToSlot("rail.top10", "old", { expiresAt: longGone });
    await addToSlot("rail.top10", "recent", { expiresAt: recent });
    await addToSlot("rail.top10", "live", { expiresAt: null });
    const removed = await deleteExpiredSlotRows(now, 7);
    expect(removed).toBe(1);
    const remaining = await listSlots("rail.top10");
    expect(remaining.map((r) => r.story_id).sort()).toEqual(["live", "recent"]);
  });

  it("leaves never-expiring rows alone", async () => {
    const { addToSlot, deleteExpiredSlotRows } = await import("./curation");
    await addToSlot("rail.top10", "a", { expiresAt: null });
    await addToSlot("rail.top10", "b", { expiresAt: null });
    expect(await deleteExpiredSlotRows(new Date(), 7)).toBe(0);
  });

  it("rejects negative grace days", async () => {
    const { deleteExpiredSlotRows } = await import("./curation");
    await expect(deleteExpiredSlotRows(new Date(), -1)).rejects.toThrow();
  });
});

describe("readAutofillSettings", () => {
  beforeEach(async () => {
    await run(
      "DELETE FROM settings WHERE key LIKE 'curation.autofill.%'",
      [],
    );
  });

  it("defaults every autofillable rail to enabled when no setting set", async () => {
    const { readAutofillSettings } = await import("./curation");
    const enabled = await readAutofillSettings();
    expect(enabled.has("rail.top10")).toBe(true);
    expect(enabled.has("rail.new")).toBe(true);
    expect(enabled.has("rail.entitled")).toBe(true);
  });

  it("respects explicit 0/off/false as disabled", async () => {
    const { readAutofillSettings } = await import("./curation");
    await run(
      "INSERT INTO settings (key, value) VALUES (?, ?), (?, ?), (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [
        "curation.autofill.rail.top10", "0",
        "curation.autofill.rail.new", "off",
        "curation.autofill.rail.entitled", "false",
      ],
    );
    const enabled = await readAutofillSettings();
    expect(enabled.size).toBe(0);
  });
});
