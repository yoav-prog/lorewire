// @vitest-environment happy-dom

// Contract coverage for the viewed-wires store. Tests the underlying
// mark-once primitive via __viewedWiresStoreForTests so we don't need
// a React renderer (no @testing-library set up — same workaround the
// rest of the codebase uses).

import { beforeEach, describe, expect, it } from "vitest";

import { __viewedWiresStoreForTests, useViewedWires } from "./use-viewed-wires";

describe("use-viewed-wires module surface", () => {
  it("exposes useViewedWires", () => {
    expect(typeof useViewedWires).toBe("function");
  });
});

describe("viewed-wires store — mark-once + clear semantics", () => {
  beforeEach(() => {
    // Order matters: clear the in-memory Set FIRST (which may persist
    // "[]" to storage when the previous test left ids populated), then
    // wipe storage so the next test starts with a truly empty key.
    document.cookie = "lw_consent=accepted; path=/";
    __viewedWiresStoreForTests.clear();
    window.localStorage.clear();
  });

  it("starts empty", () => {
    const unsub = __viewedWiresStoreForTests.subscribe(() => {});
    expect(__viewedWiresStoreForTests.getSnapshot()).toEqual([]);
    unsub();
  });

  it("mark adds an id and has() reflects it", () => {
    const unsub = __viewedWiresStoreForTests.subscribe(() => {});
    __viewedWiresStoreForTests.mark("wire-1");
    expect(__viewedWiresStoreForTests.has("wire-1")).toBe(true);
    expect(__viewedWiresStoreForTests.getSnapshot()).toContain("wire-1");
    unsub();
  });

  it("mark is idempotent (second mark of the same id is a no-op)", () => {
    const unsub = __viewedWiresStoreForTests.subscribe(() => {});
    __viewedWiresStoreForTests.mark("wire-1");
    __viewedWiresStoreForTests.mark("wire-1");
    __viewedWiresStoreForTests.mark("wire-1");
    const stored = JSON.parse(
      window.localStorage.getItem("lw.viewed_wires.v1") ?? "[]",
    );
    expect(stored).toEqual(["wire-1"]);
    expect(__viewedWiresStoreForTests.getSnapshot()).toEqual(["wire-1"]);
    unsub();
  });

  it("ignores empty string id (defensive)", () => {
    const unsub = __viewedWiresStoreForTests.subscribe(() => {});
    __viewedWiresStoreForTests.mark("");
    expect(__viewedWiresStoreForTests.getSnapshot()).toEqual([]);
    expect(window.localStorage.getItem("lw.viewed_wires.v1")).toBeNull();
    unsub();
  });

  it("clear empties the set and writes [] to storage", () => {
    const unsub = __viewedWiresStoreForTests.subscribe(() => {});
    __viewedWiresStoreForTests.mark("wire-1");
    __viewedWiresStoreForTests.mark("wire-2");
    __viewedWiresStoreForTests.clear();
    expect(__viewedWiresStoreForTests.getSnapshot()).toEqual([]);
    expect(window.localStorage.getItem("lw.viewed_wires.v1")).toBe("[]");
    unsub();
  });

  it("notifies subscribers on mark and clear", () => {
    let calls = 0;
    const unsub = __viewedWiresStoreForTests.subscribe(() => {
      calls += 1;
    });
    __viewedWiresStoreForTests.mark("wire-1"); // +1
    __viewedWiresStoreForTests.mark("wire-1"); // no-op
    __viewedWiresStoreForTests.mark("wire-2"); // +1
    __viewedWiresStoreForTests.clear(); // +1
    __viewedWiresStoreForTests.clear(); // no-op
    expect(calls).toBe(3);
    unsub();
  });

  it("consent rejected: mark updates in-memory state but does NOT persist", () => {
    document.cookie = "lw_consent=rejected; path=/";
    const unsub = __viewedWiresStoreForTests.subscribe(() => {});
    __viewedWiresStoreForTests.mark("wire-1");
    expect(__viewedWiresStoreForTests.has("wire-1")).toBe(true);
    expect(window.localStorage.getItem("lw.viewed_wires.v1")).toBeNull();
    unsub();
  });
});
