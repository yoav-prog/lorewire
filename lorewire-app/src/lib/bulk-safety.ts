// Bulk-action safety limits + paid-op cost model. Shared by the server action
// handlers (@/app/admin/actions.ts) and the admin Content client island
// (ContentList) so the cap the UI shows is exactly the cap the server
// enforces — no drift between the two. Deliberately NOT a "use server" file
// and NOT "server-only": it is a neutral module both halves import. The
// BulkRegenTarget import below is type-only (erased at build), so this module
// never pulls the server actions bundle into the client.
//
// Plan: _plans/2026-07-15-content-pagination-and-bulk-safety.md (Phase 0).

import type { BulkRegenTarget } from "@/app/admin/actions";

// Cheap, reversible ops (status / category / publish-toggle). This is the
// existing "select all 200" guard; the dataset-wide select-all work (Phase 1)
// will revisit it. Destructive and paid ops do NOT use this — see below.
export const MAX_BULK_ITEMS = 200;

// Danger-split caps (2026-07-15). Destructive and paid bulk ops act only on
// the rows the operator explicitly ticked, and are capped far below the cheap
// limit so a single click can never wipe hundreds of rows or spend four
// figures. Enforced server-side (defense in depth); the client blocks earlier
// with a friendlier message.
export const MAX_BULK_DESTRUCTIVE_ITEMS = 50;
export const MAX_BULK_PAID_ITEMS = 50;

// Select-all-matching (cheap, reversible status / category ops applied to a
// whole filter, resolved server-side) is bounded well above the tick caps but
// still capped so one click can't rewrite the entire library — and so the
// synchronous chunked apply stays inside the serverless time budget. Past this,
// the action asks the operator to narrow the filter.
export const MAX_BULK_BY_FILTER_ITEMS = 1000;

// Above this estimated spend, the regenerate confirm demands a typed count
// (echoing the resolved number) instead of a single click.
export const SPEND_CONFIRM_THRESHOLD_USD = 20;

// Representative per-story USD cost for a paid regenerate target. `null` means
// daily-budget-gated (hero / scenes): spend is bounded by the image budget, so
// a fixed multiplied total would mislead — the UI shows a budget note instead.
// Figures track the hints in REGEN_TARGET_META (ContentList); keep the two in
// step. voice uses the worst case (ElevenLabs Multilingual) so the estimate
// never under-promises.
export const REGEN_TARGET_COST_USD: Record<BulkRegenTarget, number | null> = {
  hero: null,
  hero_thumbnail: null,
  scenes: null,
  voice: 0.38,
  pipeline: 0.5,
  short: 1.13,
};

// Total estimated USD for regenerating `count` stories, rounded to cents.
// Returns null when the target is budget-gated (no meaningful fixed total).
export function estimateRegenCostUsd(
  target: BulkRegenTarget,
  count: number,
): number | null {
  const per = REGEN_TARGET_COST_USD[target];
  if (per == null) return null;
  return Math.round(per * count * 100) / 100;
}
