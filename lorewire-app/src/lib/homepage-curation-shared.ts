// Client-safe surface enum + capacity map shared by the admin editor
// (client component) and the storage helpers in
// lib/homepage-curation.ts (server-only). Keeping this file free of
// any "server-only" / db imports means the CurationClient bundle
// doesn't accidentally drag the postgres driver into the browser.
//
// Storage helpers re-export from here so callers can keep importing
// from lib/homepage-curation and the indirection stays invisible.
//
// Plan: _plans/2026-06-16-homepage-curation.md.

export const HOMEPAGE_SURFACES = [
  "hero",
  "top10",
  "continue",
  "new_row",
  "entitled_row",
  "humor_row",
  "wholesome_row",
  "dating_row",
  "roommate_row",
  "drama_row",
] as const;
export type HomepageSurface = (typeof HOMEPAGE_SURFACES)[number];

// Per-surface fixed capacity. Hero is a single pick. TOP 10 is exactly 10.
// All other rails are unbounded; the admin page caps the picker at a
// reasonable rail size so a rail can't grow past what fits.
export const SURFACE_CAPACITY: Record<HomepageSurface, number | null> = {
  hero: 1,
  top10: 10,
  continue: null,
  new_row: null,
  entitled_row: null,
  humor_row: null,
  wholesome_row: null,
  dating_row: null,
  roommate_row: null,
  drama_row: null,
};

export function isHomepageSurface(v: unknown): v is HomepageSurface {
  return (
    typeof v === "string" &&
    (HOMEPAGE_SURFACES as readonly string[]).includes(v)
  );
}
