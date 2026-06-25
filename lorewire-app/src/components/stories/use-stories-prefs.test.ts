// @vitest-environment happy-dom

// Contract coverage for the Stories prefs stores. Same workaround as
// engagement-store / use-viewed-wires: exercise the underlying store
// primitives via __storiesPrefsStoresForTests so we don't need a React
// renderer (no @testing-library is set up).

import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_STORIES_AUTOADVANCE,
  DEFAULT_STORIES_IMAGE_DWELL_MS,
  STORIES_IMAGE_DWELL_CHOICES,
  __storiesPrefsStoresForTests,
  clampDwell,
  useStoriesAutoAdvance,
  useStoriesImageDwellMs,
} from "./use-stories-prefs";

describe("use-stories-prefs module surface", () => {
  it("exposes the documented hooks + helpers", () => {
    expect(typeof useStoriesAutoAdvance).toBe("function");
    expect(typeof useStoriesImageDwellMs).toBe("function");
    expect(typeof clampDwell).toBe("function");
    expect(DEFAULT_STORIES_AUTOADVANCE).toBe(true);
    expect(DEFAULT_STORIES_IMAGE_DWELL_MS).toBe(6000);
    expect(STORIES_IMAGE_DWELL_CHOICES).toEqual([4000, 6000, 8000, 10000]);
  });
});

describe("clampDwell — coerce to legal choice or default", () => {
  it("returns the value when it's a legal choice", () => {
    expect(clampDwell(4000)).toBe(4000);
    expect(clampDwell(6000)).toBe(6000);
    expect(clampDwell(8000)).toBe(8000);
    expect(clampDwell(10000)).toBe(10000);
  });

  it("returns the default for values outside the legal set", () => {
    expect(clampDwell(0)).toBe(DEFAULT_STORIES_IMAGE_DWELL_MS);
    expect(clampDwell(3000)).toBe(DEFAULT_STORIES_IMAGE_DWELL_MS);
    expect(clampDwell(5000)).toBe(DEFAULT_STORIES_IMAGE_DWELL_MS);
    expect(clampDwell(7000)).toBe(DEFAULT_STORIES_IMAGE_DWELL_MS);
    expect(clampDwell(12000)).toBe(DEFAULT_STORIES_IMAGE_DWELL_MS);
    expect(clampDwell(-1)).toBe(DEFAULT_STORIES_IMAGE_DWELL_MS);
  });

  it("returns the default for non-number values (defensive)", () => {
    expect(clampDwell("6000")).toBe(DEFAULT_STORIES_IMAGE_DWELL_MS);
    expect(clampDwell(null)).toBe(DEFAULT_STORIES_IMAGE_DWELL_MS);
    expect(clampDwell(undefined)).toBe(DEFAULT_STORIES_IMAGE_DWELL_MS);
    expect(clampDwell(Number.NaN)).toBe(DEFAULT_STORIES_IMAGE_DWELL_MS);
    expect(clampDwell(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_STORIES_IMAGE_DWELL_MS,
    );
  });
});

describe("stories auto-advance store", () => {
  beforeEach(() => {
    // Reset state: explicit set to default + wipe storage, in that
    // order so the persist call inside set() can't leave a "true"
    // string behind in localStorage after the wipe.
    document.cookie = "lw_consent=accepted; path=/";
    __storiesPrefsStoresForTests.autoAdvance.set(DEFAULT_STORIES_AUTOADVANCE);
    window.localStorage.clear();
  });

  it("starts at the default (true)", () => {
    const unsub = __storiesPrefsStoresForTests.autoAdvance.subscribe(() => {});
    expect(__storiesPrefsStoresForTests.autoAdvance.getSnapshot()).toBe(true);
    unsub();
  });

  it("set(false) flips + persists '0'", () => {
    const unsub = __storiesPrefsStoresForTests.autoAdvance.subscribe(() => {});
    __storiesPrefsStoresForTests.autoAdvance.set(false);
    expect(__storiesPrefsStoresForTests.autoAdvance.getSnapshot()).toBe(false);
    expect(window.localStorage.getItem("lw.stories.autoadvance.v1")).toBe("0");
    unsub();
  });

  it("set(true) persists '1'", () => {
    const unsub = __storiesPrefsStoresForTests.autoAdvance.subscribe(() => {});
    __storiesPrefsStoresForTests.autoAdvance.set(false);
    __storiesPrefsStoresForTests.autoAdvance.set(true);
    expect(window.localStorage.getItem("lw.stories.autoadvance.v1")).toBe("1");
    unsub();
  });

  it("consent rejected: set flips in-memory but does NOT persist", () => {
    document.cookie = "lw_consent=rejected; path=/";
    const unsub = __storiesPrefsStoresForTests.autoAdvance.subscribe(() => {});
    __storiesPrefsStoresForTests.autoAdvance.set(false);
    expect(__storiesPrefsStoresForTests.autoAdvance.getSnapshot()).toBe(false);
    expect(window.localStorage.getItem("lw.stories.autoadvance.v1")).toBeNull();
    unsub();
  });

  it("notifies subscribers on every set", () => {
    let calls = 0;
    const unsub = __storiesPrefsStoresForTests.autoAdvance.subscribe(() => {
      calls += 1;
    });
    __storiesPrefsStoresForTests.autoAdvance.set(false);
    __storiesPrefsStoresForTests.autoAdvance.set(true);
    __storiesPrefsStoresForTests.autoAdvance.set(false);
    expect(calls).toBe(3);
    unsub();
  });
});

describe("stories image-dwell store", () => {
  beforeEach(() => {
    document.cookie = "lw_consent=accepted; path=/";
    __storiesPrefsStoresForTests.imageDwell.set(
      DEFAULT_STORIES_IMAGE_DWELL_MS,
    );
    window.localStorage.clear();
  });

  it("starts at the default (6000)", () => {
    const unsub = __storiesPrefsStoresForTests.imageDwell.subscribe(() => {});
    expect(__storiesPrefsStoresForTests.imageDwell.getSnapshot()).toBe(6000);
    unsub();
  });

  it("set(legal-choice) flips + persists the value", () => {
    const unsub = __storiesPrefsStoresForTests.imageDwell.subscribe(() => {});
    __storiesPrefsStoresForTests.imageDwell.set(8000);
    expect(__storiesPrefsStoresForTests.imageDwell.getSnapshot()).toBe(8000);
    expect(window.localStorage.getItem("lw.stories.image_dwell_ms.v1")).toBe(
      "8000",
    );
    unsub();
  });

  it("set(illegal-value) clamps to default in-memory + persists default", () => {
    const unsub = __storiesPrefsStoresForTests.imageDwell.subscribe(() => {});
    __storiesPrefsStoresForTests.imageDwell.set(7500);
    expect(__storiesPrefsStoresForTests.imageDwell.getSnapshot()).toBe(6000);
    expect(window.localStorage.getItem("lw.stories.image_dwell_ms.v1")).toBe(
      "6000",
    );
    unsub();
  });

  it("read path coerces a stale stored value to the default on next read", () => {
    // Simulate a previous session that wrote a since-removed value.
    window.localStorage.setItem("lw.stories.image_dwell_ms.v1", "9001");
    // Fire a storage event so the started store re-hydrates.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "lw.stories.image_dwell_ms.v1",
        newValue: "9001",
      }),
    );
    const unsub = __storiesPrefsStoresForTests.imageDwell.subscribe(() => {});
    expect(__storiesPrefsStoresForTests.imageDwell.getSnapshot()).toBe(6000);
    unsub();
  });

  it("consent rejected: set flips in-memory but does NOT persist", () => {
    document.cookie = "lw_consent=rejected; path=/";
    const unsub = __storiesPrefsStoresForTests.imageDwell.subscribe(() => {});
    __storiesPrefsStoresForTests.imageDwell.set(4000);
    expect(__storiesPrefsStoresForTests.imageDwell.getSnapshot()).toBe(4000);
    expect(
      window.localStorage.getItem("lw.stories.image_dwell_ms.v1"),
    ).toBeNull();
    unsub();
  });
});
