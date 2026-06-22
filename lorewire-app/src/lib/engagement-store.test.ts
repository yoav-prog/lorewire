// @vitest-environment happy-dom

// Smoke + contract coverage for engagement-store. The store's toggle
// runs inside React's useSyncExternalStore via a closure, so a real
// end-to-end test of the consent gate needs a React renderer — out of
// scope for Phase 1 (no @testing-library set up). The actual gate
// behavior — "consent missing → no localStorage write" — rides on the
// cookie-parsing helper covered in consent-client.test.ts plus a single
// one-line branch in engagement-store. Manual QA in the Phase 6 pass
// walks the full flow.

import { describe, expect, it } from "vitest";

import {
  useContinueReading,
  useFavoriteCategories,
  useLikedReels,
  useRecentlyViewed,
  useSavedStories,
  useStoryRatings,
} from "./engagement-store";

describe("engagement-store module surface", () => {
  it("exposes the six documented hooks", () => {
    // The hooks themselves aren't called here (no React renderer) — we
    // just verify the exports exist and are callable. A typo or rename
    // in any of them would crash every consumer in the shells.
    expect(typeof useSavedStories).toBe("function");
    expect(typeof useLikedReels).toBe("function");
    expect(typeof useFavoriteCategories).toBe("function");
    expect(typeof useRecentlyViewed).toBe("function");
    expect(typeof useContinueReading).toBe("function");
    expect(typeof useStoryRatings).toBe("function");
  });
});
