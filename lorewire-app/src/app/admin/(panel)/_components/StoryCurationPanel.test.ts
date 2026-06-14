// Phase 5 of _plans/2026-06-15-curation-system.md. The panel itself is
// a server component (DB read + form actions); these tests pin down the
// pure `labelForSlot` helper so a typo in the human label can't ship
// silently. The action flow is covered by the action-level tests next
// to actions.ts.

import { describe, it, expect } from "vitest";
import { labelForSlot } from "./StoryCurationPanel";

describe("labelForSlot", () => {
  it("labels the billboard slot", () => {
    expect(labelForSlot("billboard.featured")).toBe("Billboard — featured");
  });

  it("labels every rail slot", () => {
    expect(labelForSlot("rail.continue")).toBe("Rail — Continue Watching");
    expect(labelForSlot("rail.top10")).toBe("Rail — Top 10 Today");
    expect(labelForSlot("rail.new")).toBe("Rail — New on LoreWire");
    expect(labelForSlot("rail.entitled")).toBe("Rail — Entitled");
  });

  it("expands category slots with the category name", () => {
    expect(labelForSlot("category.Drama")).toBe("Category — Drama");
    expect(labelForSlot("category.Roommate")).toBe("Category — Roommate");
  });

  it("falls through to the raw key for unknown slots", () => {
    expect(labelForSlot("rail.future")).toBe("rail.future");
    expect(labelForSlot("weird.slot")).toBe("weird.slot");
  });
});
