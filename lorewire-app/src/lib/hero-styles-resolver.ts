// Step 5 of _plans/2026-06-17-hero-style-registry.md.
//
// TS mirror of the Python resolver in `pipeline/stages.py:resolve_hero_style`.
// The pipeline owns the canonical implementation; this is the admin UI's
// equivalent so the per-story picker can render an accurate caption
// ("Auto-picked from the Drama short-list ...") WITHOUT round-tripping
// to Python at request time.
//
// Both sides MUST agree on:
//   - The resolution chain order (per-story → category default → global
//     default → deterministic auto-pick).
//   - The hash → pick mapping for the auto layer (sha1(storyId) mod len).
//
// Tested for parity in `lorewire-app/src/lib/hero-styles-resolver.test.ts`
// (TS) and `pipeline/tests/test_hero_styles.py` (Python) — both sides
// assert the same hash → style id mapping on a shared fixture set.

import { createHash } from "node:crypto";

import {
  CATEGORY_STYLE_WHITELIST,
  HERO_STYLES,
  HERO_STYLES_BY_ID,
  type HeroStyle,
  type HeroStyleSource,
} from "@/lib/hero-styles";

export interface ResolvedHeroStyle {
  style: HeroStyle;
  source: HeroStyleSource;
  /** Whitelist hashed against when `source === "auto_hash"`; empty
   *  array for the other layers. Surfaced into the caption so the
   *  admin can see exactly which short-list produced the pick. */
  whitelist: readonly string[];
}

/** Snapshot of every settings layer the resolver needs. Matches the
 *  shape `loadHeroStyleSettings` returns in `@/app/admin/actions` so the
 *  story edit page can drop the snapshot straight in without
 *  re-querying per-story. */
export interface HeroStyleResolutionContext {
  pinnedId: string | null;
  category: string;
  storyId: string;
  globalStyleId: string;
  categoryDefaults: Record<string, string>;
}

/** Pick one of `allowed` deterministically from the story id.
 *
 *  MUST stay byte-identical to
 *  `pipeline/stages.py:deterministic_style_pick`:
 *    - sha1 of the UTF-8 bytes of storyId.
 *    - First 4 bytes interpreted as a big-endian uint32.
 *    - That uint32 mod `allowed.length`.
 *  Any drift here would mean the admin caption shows a different style
 *  from what the pipeline actually renders. Parity test pins the
 *  mapping on a fixed input set.
 *
 *  Throws on an empty `allowed` so a misconfigured whitelist fails
 *  loudly. */
export function deterministicStylePick(
  storyId: string,
  allowed: readonly string[],
): string {
  if (allowed.length === 0) {
    throw new Error("deterministicStylePick: allowed list is empty");
  }
  const digest = createHash("sha1").update(storyId, "utf-8").digest();
  const num = digest.readUInt32BE(0);
  return allowed[num % allowed.length];
}

function safeLookup(styleId: string | null | undefined): HeroStyle | null {
  if (!styleId) return null;
  return HERO_STYLES_BY_ID[styleId] ?? null;
}

/** Walk the four-layer resolution chain.
 *
 *  Each layer falls through on `null`/empty/unknown id, so a stale row
 *  in any layer doesn't take the render offline — it just punts to the
 *  next layer down. Unknown category falls back to Drama's whitelist
 *  (mirrors the Python side). */
export function resolveHeroStyleFromContext(
  ctx: HeroStyleResolutionContext,
): ResolvedHeroStyle {
  // Layer 1: explicit per-story pin
  const fromStory = safeLookup(ctx.pinnedId);
  if (fromStory) {
    return { style: fromStory, source: "per_story", whitelist: [] };
  }

  const catKey = (ctx.category || "Drama").trim();
  const lowerKey = catKey.toLowerCase();

  // Layer 2: per-category default
  const catDefaultId = ctx.categoryDefaults[lowerKey] ?? "";
  const fromCategory = safeLookup(catDefaultId);
  if (fromCategory) {
    return { style: fromCategory, source: "category_default", whitelist: [] };
  }

  // Layer 3: global default
  const fromGlobal = safeLookup(ctx.globalStyleId);
  if (fromGlobal) {
    return { style: fromGlobal, source: "global_default", whitelist: [] };
  }

  // Layer 4: deterministic auto-pick
  const whitelist =
    CATEGORY_STYLE_WHITELIST[catKey] ?? CATEGORY_STYLE_WHITELIST["Drama"];
  const pickedId = deterministicStylePick(ctx.storyId, whitelist);
  const picked = HERO_STYLES_BY_ID[pickedId];
  if (!picked) {
    // Whitelist references a missing style id — caught by
    // pipeline/tests/test_hero_styles.py::WhitelistIntegrityTests as
    // well, but defend in case a sync race lands us with stale data.
    // Fall back to the first known style so the caption + picker stay
    // renderable.
    const fallback = HERO_STYLES[0];
    return {
      style: fallback,
      source: "auto_hash",
      whitelist: [...whitelist],
    };
  }
  return { style: picked, source: "auto_hash", whitelist: [...whitelist] };
}
