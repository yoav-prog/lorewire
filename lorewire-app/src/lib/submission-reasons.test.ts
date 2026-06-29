// Coverage for the rejection-reason taxonomy + the free-text "Other" path. The
// invariant that matters: a reviewer's custom note must reach the author verbatim,
// which only works if the dashboard branches on the `custom` sentinel BEFORE the
// taxonomy lookup — because categoryToReasonKey folds any unknown category
// (including "custom") into "borderline" and would otherwise bury the note. Pure
// functions, no DB, no network.

import { describe, expect, it } from "vitest";

import {
  CUSTOM_REASON_CATEGORY,
  categoryToReasonKey,
  customReason,
  resolveReason,
} from "@/lib/submission-reasons";

describe("customReason (free-text Other path)", () => {
  it("shows the reviewer's note verbatim", () => {
    const note = "Trim the intro and lead with the actual choice.";
    expect(customReason(note, "en").message).toBe(note);
  });

  it("frames it with canned title + call to action, in the author's language", () => {
    const en = customReason("x", "en");
    expect(en.title).toBe("A note from our reviewer");
    expect(en.fix).toBe("Make that change and send it back in.");

    const he = customReason("x", "he");
    expect(he.title).not.toBe(en.title);
    expect(he.fix).not.toBe(en.fix);
  });

  it("is why the dashboard must branch ahead of the taxonomy: the sentinel folds to borderline", () => {
    // resolveReason can't carry the per-submission note, so the `custom` category
    // degrades to the generic borderline message — proving the branch is load-bearing.
    expect(categoryToReasonKey(CUSTOM_REASON_CATEGORY)).toBe("borderline");
    expect(resolveReason(CUSTOM_REASON_CATEGORY, "en").message).toBe(
      resolveReason("borderline", "en").message,
    );
  });
});
