// Pure-math coverage for the Skip Intro window (lib/intro-window):
//   1. Generation classification off the props fields.
//   2. Timeline derivation per generation, mirroring the splice constants.
//   3. The assembled-duration sanity clamp fails closed.
//   4. Defensive props-JSON readers (missing / malformed / wrong types).
//   5. The player-side guards (usability vs the real element duration,
//      in-window predicate with the end slack).
// Plan: _plans/2026-07-04-skip-intro.md.

import { describe, expect, it } from "vitest";
import {
  classifySpliceGeneration,
  deriveIntroWindow,
  hookEndMsFromPropsJson,
  hookTailHoldMsFromPropsJson,
  INTRO_FADE_MS,
  INTRO_HOOK_GAP_MS,
  INTRO_INTRO_GAP_MS,
  INTRO_TAIL_HOLD_MIN_MS,
  INTRO_TAIL_HOLD_FALLBACK_MS,
  INTRO_WINDOW_END_SLACK_MS,
  introWindowFromPropsJson,
  introWindowUsable,
  isInIntroWindow,
} from "./intro-window";

describe("classifySpliceGeneration", () => {
  it("maps the three field combinations to their generations", () => {
    expect(classifySpliceGeneration(null, null)).toBe("intro-first");
    expect(classifySpliceGeneration(2500, null)).toBe("unpaced-hook-first");
    expect(classifySpliceGeneration(2500, 120)).toBe("paced-hook-first");
  });

  it("treats a tail hold without a hook boundary as intro-first", () => {
    // Shouldn't occur in real props, but the boundary is what gates the
    // reorder — no boundary means the splice ran legacy ordering.
    expect(classifySpliceGeneration(null, 120)).toBe("intro-first");
  });
});

describe("deriveIntroWindow — paced hook-first", () => {
  it("starts at the hook boundary + tail hold and spans fade + gaps + intro", () => {
    const w = deriveIntroWindow({
      generation: "paced-hook-first",
      hookEndMs: 3000,
      hookTailHoldMs: 200,
      introDurationMs: 4000,
    });
    expect(w).toEqual({
      start_ms: 3200,
      end_ms:
        3200 + INTRO_FADE_MS + INTRO_HOOK_GAP_MS + 4000 + INTRO_INTRO_GAP_MS,
    });
  });

  it("floors the tail hold the same way Cloud Run does", () => {
    const w = deriveIntroWindow({
      generation: "paced-hook-first",
      hookEndMs: 3000,
      hookTailHoldMs: 0, // valid "no gap before the next word" value
      introDurationMs: 4000,
    });
    expect(w?.start_ms).toBe(3000 + INTRO_TAIL_HOLD_MIN_MS);
  });

  it("falls back to the constant hold when the field is absent", () => {
    const w = deriveIntroWindow({
      generation: "paced-hook-first",
      hookEndMs: 3000,
      hookTailHoldMs: null,
      introDurationMs: 4000,
    });
    expect(w?.start_ms).toBe(3000 + INTRO_TAIL_HOLD_FALLBACK_MS);
  });

  it("requires a positive hook boundary", () => {
    for (const bad of [null, undefined, 0, -1, Number.NaN]) {
      expect(
        deriveIntroWindow({
          generation: "paced-hook-first",
          hookEndMs: bad as number | null,
          hookTailHoldMs: 200,
          introDurationMs: 4000,
        }),
      ).toBeNull();
    }
  });
});

describe("deriveIntroWindow — unpaced hook-first", () => {
  it("hard-cuts: the window is exactly the intro after the hook", () => {
    const w = deriveIntroWindow({
      generation: "unpaced-hook-first",
      hookEndMs: 2500,
      introDurationMs: 4000,
    });
    expect(w).toEqual({ start_ms: 2500, end_ms: 6500 });
  });
});

describe("deriveIntroWindow — intro-first", () => {
  it("spans [0, intro duration] and ignores hook fields", () => {
    const w = deriveIntroWindow({
      generation: "intro-first",
      hookEndMs: 9999, // ignored
      introDurationMs: 4000,
    });
    expect(w).toEqual({ start_ms: 0, end_ms: 4000 });
  });
});

describe("deriveIntroWindow — guards", () => {
  it("returns null without a positive intro duration", () => {
    for (const bad of [null, 0, -5, Number.NaN]) {
      expect(
        deriveIntroWindow({ generation: "intro-first", introDurationMs: bad }),
      ).toBeNull();
    }
  });

  it("fails closed when the window butts against the assembled duration", () => {
    // end 4000 + the 1s story margin > 4500 → derivation can't be right.
    expect(
      deriveIntroWindow({
        generation: "intro-first",
        introDurationMs: 4000,
        assembledDurationMs: 4500,
      }),
    ).toBeNull();
    // With a full second of story after the target it passes.
    expect(
      deriveIntroWindow({
        generation: "intro-first",
        introDurationMs: 4000,
        assembledDurationMs: 5000,
      }),
    ).toEqual({ start_ms: 0, end_ms: 4000 });
  });

  it("rounds fractional inputs to integer milliseconds", () => {
    const w = deriveIntroWindow({
      generation: "unpaced-hook-first",
      hookEndMs: 2500.4,
      introDurationMs: 4000.4,
    });
    expect(w).toEqual({ start_ms: 2500, end_ms: 6501 });
  });
});

describe("props-JSON readers", () => {
  it("reads hook_end_ms only when finite and positive", () => {
    expect(hookEndMsFromPropsJson(JSON.stringify({ hook_end_ms: 2500 }))).toBe(
      2500,
    );
    for (const bad of [0, -1, "2500", null]) {
      expect(
        hookEndMsFromPropsJson(JSON.stringify({ hook_end_ms: bad })),
      ).toBeNull();
    }
    expect(hookEndMsFromPropsJson(null)).toBeNull();
    expect(hookEndMsFromPropsJson("not json")).toBeNull();
    expect(hookEndMsFromPropsJson("[1,2]")).toBeNull();
  });

  it("reads hook_tail_hold_ms accepting 0 as valid", () => {
    expect(
      hookTailHoldMsFromPropsJson(JSON.stringify({ hook_tail_hold_ms: 0 })),
    ).toBe(0);
    expect(
      hookTailHoldMsFromPropsJson(JSON.stringify({ hook_tail_hold_ms: 250 })),
    ).toBe(250);
    for (const bad of [-1, "250", null]) {
      expect(
        hookTailHoldMsFromPropsJson(JSON.stringify({ hook_tail_hold_ms: bad })),
      ).toBeNull();
    }
    expect(hookTailHoldMsFromPropsJson(JSON.stringify({}))).toBeNull();
  });

  it("reads the explicit persisted window, requiring end > start >= 0", () => {
    expect(
      introWindowFromPropsJson(
        JSON.stringify({ intro_start_ms: 0, intro_end_ms: 4000 }),
      ),
    ).toEqual({ start_ms: 0, end_ms: 4000 });
    expect(
      introWindowFromPropsJson(
        JSON.stringify({ intro_start_ms: 3200, intro_end_ms: 9650 }),
      ),
    ).toEqual({ start_ms: 3200, end_ms: 9650 });
    for (const bad of [
      { intro_start_ms: -1, intro_end_ms: 4000 },
      { intro_start_ms: 4000, intro_end_ms: 4000 },
      { intro_start_ms: 5000, intro_end_ms: 4000 },
      { intro_start_ms: 0 },
      { intro_end_ms: 4000 },
      { intro_start_ms: "0", intro_end_ms: 4000 },
    ]) {
      expect(introWindowFromPropsJson(JSON.stringify(bad))).toBeNull();
    }
  });
});

describe("player-side guards", () => {
  const w = { start_ms: 3200, end_ms: 9650 };

  it("introWindowUsable trusts the window until the element duration says otherwise", () => {
    expect(introWindowUsable(w, null)).toBe(true);
    expect(introWindowUsable(w, 60_000)).toBe(true);
    // Seek target too close to (or past) the end of the real file.
    expect(introWindowUsable(w, 10_000)).toBe(false);
    expect(introWindowUsable(w, 9_000)).toBe(false);
    expect(introWindowUsable(null, 60_000)).toBe(false);
    expect(introWindowUsable({ start_ms: -1, end_ms: 4000 }, null)).toBe(false);
    expect(introWindowUsable({ start_ms: 4000, end_ms: 4000 }, null)).toBe(
      false,
    );
  });

  it("isInIntroWindow is inclusive at start and slacked at the end", () => {
    expect(isInIntroWindow(3199, w)).toBe(false);
    expect(isInIntroWindow(3200, w)).toBe(true);
    expect(isInIntroWindow(9650 - INTRO_WINDOW_END_SLACK_MS - 1, w)).toBe(true);
    expect(isInIntroWindow(9650 - INTRO_WINDOW_END_SLACK_MS, w)).toBe(false);
    expect(isInIntroWindow(9650, w)).toBe(false);
  });
});
