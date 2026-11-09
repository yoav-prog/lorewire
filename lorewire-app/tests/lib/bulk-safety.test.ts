// Unit tests for the shared bulk-action safety model (@/lib/bulk-safety): the
// per-story cost estimate the regenerate confirm shows and the danger caps the
// server + client both enforce. Pure functions, no DB — the module is a neutral
// shared constant table.
//
// Plan: _plans/2026-07-15-content-pagination-and-bulk-safety.md (Phase 0).

import { describe, expect, it } from "vitest";
import {
  estimateRegenCostUsd,
  MAX_BULK_DESTRUCTIVE_ITEMS,
  MAX_BULK_PAID_ITEMS,
  REGEN_TARGET_COST_USD,
} from "@/lib/bulk-safety";

describe("estimateRegenCostUsd", () => {
  it("multiplies the per-story cost and rounds to cents", () => {
    expect(estimateRegenCostUsd("short", 40)).toBe(45.2);
    expect(estimateRegenCostUsd("pipeline", 10)).toBe(5);
    expect(estimateRegenCostUsd("voice", 3)).toBe(1.14);
  });

  it("returns null for daily-budget-gated targets", () => {
    expect(estimateRegenCostUsd("hero", 100)).toBeNull();
    expect(estimateRegenCostUsd("hero_thumbnail", 100)).toBeNull();
    expect(estimateRegenCostUsd("scenes", 100)).toBeNull();
  });

  it("is zero-safe for an empty selection", () => {
    expect(estimateRegenCostUsd("short", 0)).toBe(0);
  });
});

describe("danger caps + cost table", () => {
  it("keeps destructive + paid caps well below the cheap-op limit", () => {
    expect(MAX_BULK_DESTRUCTIVE_ITEMS).toBeLessThanOrEqual(50);
    expect(MAX_BULK_PAID_ITEMS).toBeLessThanOrEqual(50);
  });

  it("prices every regen target so no undefined leaks into the modal", () => {
    for (const cost of Object.values(REGEN_TARGET_COST_USD)) {
      expect(cost === null || typeof cost === "number").toBe(true);
    }
  });
});
