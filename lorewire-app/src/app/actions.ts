"use server";

// Public-facing server actions for the main app shell. Keep this surface
// tightly scoped — anything callable from the homepage's client component
// runs unauthenticated, so it MUST only read data that's already public
// (status='published' + non-null published_at + non-null slug).
//
// getLiveStoryVideoUrl exists so the main-page DetailModal can show the
// CURRENT story video instead of the one baked into src/data/published.ts
// at the last export. Apply Short to Story updates stories.video_url in
// the DB; without this fetch, the homepage modal kept showing the old
// long-form URL until the catalog was re-exported and the app redeployed.

import { getPublishedStoryBySlug } from "@/lib/stories-public";
import { one } from "@/lib/db";

export interface LiveStoryVideoUrlResult {
  ok: boolean;
  video_url: string | null;
  /** True when the story exists in the DB and is publicly readable.
   *  False when the id doesn't match any published row (e.g. the
   *  catalog still has a legacy sample story that isn't in the DB).
   *  Callers should fall back to the baked URL on `ok=false`. */
  found: boolean;
}

// idOrSlug accepts either the stories.id (UUIDs from the pipeline, slug-like
// for legacy seeds) or stories.slug. Static catalog entries usually carry
// `id` matching the DB id, but legacy samples may pre-date the slug
// migration — we try id first, then slug, and return ok=false if neither
// matches a published row.
export async function getLiveStoryVideoUrl(
  idOrSlug: string,
): Promise<LiveStoryVideoUrlResult> {
  if (!idOrSlug || typeof idOrSlug !== "string") {
    return { ok: true, video_url: null, found: false };
  }
  // Try by id first — handles new pipeline UUIDs and legacy ids ("envelope").
  const byId = await one<{ video_url: string | null; status: string | null }>(
    "SELECT video_url, status FROM stories " +
      "WHERE id = ? AND status = 'published' AND published_at IS NOT NULL",
    [idOrSlug],
  );
  if (byId) {
    return { ok: true, video_url: byId.video_url, found: true };
  }
  // Fall back to slug lookup so the action works regardless of which
  // identifier the homepage card has on hand.
  const bySlug = await getPublishedStoryBySlug(idOrSlug);
  if (bySlug) {
    return { ok: true, video_url: bySlug.video_url, found: true };
  }
  return { ok: true, video_url: null, found: false };
}
