// @vitest-environment happy-dom

// Tests for the localStorage-backed recents wrapper behind the global
// admin search bar (plan:
// _plans/2026-06-19-global-admin-search.md).
//
// Needs `window.localStorage` — flips the per-file environment to
// happy-dom per the convention documented in vitest.config.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addRecent,
  clearRecent,
  readRecent,
  removeRecent,
} from "@/lib/admin-search-recent";

const KEY = "lorewire.admin.search.recent";

describe("admin-search-recent", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  describe("readRecent", () => {
    it("returns [] when nothing is stored", () => {
      expect(readRecent()).toEqual([]);
    });

    it("returns [] when stored value is malformed JSON", () => {
      window.localStorage.setItem(KEY, "{not json");
      expect(readRecent()).toEqual([]);
    });

    it("returns [] when stored value is not an array", () => {
      window.localStorage.setItem(KEY, JSON.stringify({ wrong: "shape" }));
      expect(readRecent()).toEqual([]);
    });

    it("filters out entries with wrong shape", () => {
      window.localStorage.setItem(
        KEY,
        JSON.stringify([
          { kind: "reddit", id: "a1", label: "Real", ts: 1 },
          { kind: "garbage", id: "b1", label: "Bad", ts: 2 },
          { kind: "story", id: 123, label: "Bad id", ts: 3 },
          { kind: "story", id: "c1", label: null, ts: 4 },
          { kind: "story", id: "d1", label: "Good", ts: 5 },
        ]),
      );
      const out = readRecent();
      expect(out.map((p) => p.id)).toEqual(["d1", "a1"]);
    });

    it("sorts newest-first by ts", () => {
      window.localStorage.setItem(
        KEY,
        JSON.stringify([
          { kind: "reddit", id: "old", label: "Old", ts: 100 },
          { kind: "story", id: "new", label: "New", ts: 200 },
          { kind: "reddit", id: "mid", label: "Mid", ts: 150 },
        ]),
      );
      const out = readRecent();
      expect(out.map((p) => p.id)).toEqual(["new", "mid", "old"]);
    });

    it("respects the max parameter", () => {
      const many = Array.from({ length: 10 }, (_, i) => ({
        kind: "reddit", id: `r${i}`, label: `R${i}`, ts: i,
      }));
      window.localStorage.setItem(KEY, JSON.stringify(many));
      expect(readRecent(3)).toHaveLength(3);
    });
  });

  describe("addRecent", () => {
    it("inserts a new pick at the top", () => {
      addRecent({ kind: "reddit", id: "a1", label: "First" });
      const out = readRecent();
      expect(out).toHaveLength(1);
      expect(out[0].id).toBe("a1");
      expect(typeof out[0].ts).toBe("number");
    });

    it("dedupes by (kind, id) — a re-pick floats to the top", () => {
      addRecent({ kind: "reddit", id: "a1", label: "First" });
      addRecent({ kind: "story", id: "s1", label: "Story" });
      addRecent({ kind: "reddit", id: "a1", label: "First (refreshed)" });
      const out = readRecent();
      expect(out).toHaveLength(2);
      // a1 floated to the top with the refreshed label.
      expect(out[0].id).toBe("a1");
      expect(out[0].label).toBe("First (refreshed)");
      expect(out[1].id).toBe("s1");
    });

    it("caps the stored list at max", () => {
      for (let i = 0; i < 10; i++) {
        addRecent({ kind: "reddit", id: `r${i}`, label: `R${i}` }, 3);
      }
      expect(readRecent(Number.POSITIVE_INFINITY)).toHaveLength(3);
    });

    it("treats (reddit, abc) and (story, abc) as distinct", () => {
      addRecent({ kind: "reddit", id: "abc", label: "Reddit ABC" });
      addRecent({ kind: "story", id: "abc", label: "Story ABC" });
      const out = readRecent();
      expect(out).toHaveLength(2);
    });
  });

  describe("removeRecent", () => {
    it("removes a single pick", () => {
      addRecent({ kind: "reddit", id: "a1", label: "Keep" });
      addRecent({ kind: "story", id: "s1", label: "Drop" });
      removeRecent("story", "s1");
      const out = readRecent();
      expect(out.map((p) => p.id)).toEqual(["a1"]);
    });

    it("is idempotent (removing a non-existent pick is a no-op)", () => {
      addRecent({ kind: "reddit", id: "a1", label: "Keep" });
      removeRecent("reddit", "never-existed");
      expect(readRecent()).toHaveLength(1);
    });
  });

  describe("clearRecent", () => {
    it("removes the entire storage key", () => {
      addRecent({ kind: "reddit", id: "a1", label: "One" });
      addRecent({ kind: "story", id: "s1", label: "Two" });
      clearRecent();
      expect(readRecent()).toEqual([]);
      expect(window.localStorage.getItem(KEY)).toBeNull();
    });
  });
});
