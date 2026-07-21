// @vitest-environment happy-dom

// Contract coverage for the Wires category-filter store. In-memory only (a
// session browsing filter, not a persisted pref), so there's no localStorage or
// consent gate to exercise — clear() resets it between tests. Tested via the
// raw store escape hatch, the pattern the other wires stores use.

import { beforeEach, describe, expect, it } from "vitest";

import {
  __wireCategoryFilterStoreForTests as store,
  useWireCategoryFilter,
} from "./wire-category-filter";

describe("wire-category-filter module surface", () => {
  it("exposes useWireCategoryFilter", () => {
    expect(typeof useWireCategoryFilter).toBe("function");
  });

  it("getServerSnapshot returns a stable empty array (SSR-safe)", () => {
    expect(store.getServerSnapshot()).toEqual([]);
    expect(store.getServerSnapshot()).toBe(store.getServerSnapshot());
  });
});

describe("wire-category-filter store", () => {
  beforeEach(() => {
    store.clear();
  });

  it("starts empty", () => {
    const unsub = store.subscribe(() => {});
    expect(store.getSnapshot()).toEqual([]);
    unsub();
  });

  it("toggle adds then removes a slug; has() reflects it", () => {
    const unsub = store.subscribe(() => {});
    store.toggle("workplace");
    expect(store.has("workplace")).toBe(true);
    expect(store.getSnapshot()).toContain("workplace");
    store.toggle("workplace");
    expect(store.has("workplace")).toBe(false);
    expect(store.getSnapshot()).not.toContain("workplace");
    unsub();
  });

  it("keeps the snapshot sorted so {a,b} and {b,a} produce the same dep", () => {
    const unsub = store.subscribe(() => {});
    store.toggle("workplace");
    store.toggle("breakups");
    // Sorted alphabetically regardless of insertion order.
    expect(store.getSnapshot()).toEqual(["breakups", "workplace"]);
    unsub();
  });

  it("returns a stable snapshot reference between edits", () => {
    const unsub = store.subscribe(() => {});
    store.toggle("creepy");
    const a = store.getSnapshot();
    const b = store.getSnapshot();
    expect(a).toBe(b);
    store.toggle("in-laws");
    expect(store.getSnapshot()).not.toBe(a);
    unsub();
  });

  it("clear empties the selection", () => {
    const unsub = store.subscribe(() => {});
    store.toggle("revenge-karma");
    store.toggle("wholesome-wins");
    store.clear();
    expect(store.getSnapshot()).toEqual([]);
    unsub();
  });

  it("ignores empty-string slugs and no-op clears (defensive)", () => {
    let calls = 0;
    const unsub = store.subscribe(() => {
      calls += 1;
    });
    store.toggle(""); // ignored
    store.clear(); // already empty → no notify
    expect(calls).toBe(0);
    expect(store.getSnapshot()).toEqual([]);
    unsub();
  });
});
