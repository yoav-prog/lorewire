// Pure resolvers for the IG-style Stories rail's playlist. Kept here
// (next to the rail / viewer) instead of in lib/homepage-rails.ts so
// every Stories-related concept lives in one folder. The shared rails
// resolver only knows about the existing surfaces (hero, top10,
// continue, new_row, category rails) and Stories doesn't introduce a
// new surface in the curation schema — we piggyback on `new_row`'s
// curated ids when present.
//
// The "unseen" filter does NOT run here — that's a client-side
// personalization step applied after useViewedWires hydrates from
// localStorage. Keeping it out of the SSR-shareable resolver means
// the homepage payload stays identical for every visitor (cache-
// friendly) and the per-user filter happens in the hydrated tree.
//
// Plan: _plans/2026-06-25-stories-rail-and-viewer.md.

import { isPublishedStory, type Story } from "@/lib/stories";
import type { HomepageCuration, MergedCatalog } from "@/lib/homepage-rails";

export const STORIES_PLAYLIST_CAP = 10;

/** Build the Stories rail playlist. Curated `new_row` ids pin at the
 *  front (matches the discovery-rail augmenting semantics from PR #68);
 *  the remainder fills with the catalog's most-recent published stories
 *  (year DESC, dedup against curated ids). Caps at STORIES_PLAYLIST_CAP.
 *
 *  Returns [] when no published candidate exists — the rail uses that
 *  as the signal to render nothing.
 */
export function resolveStoriesPlaylist(
  curation: HomepageCuration | null,
  catalog: MergedCatalog,
  resolveStory: (id: string) => Story | null,
): Story[] {
  // Curation reuses `new_row` instead of introducing a separate Stories
  // surface in the schema — the rail's promise ("what's new") is
  // identical to new_row's, and an admin curating one expects the
  // other to follow. If the two promises diverge later, the right
  // move is a dedicated `stories` surface, not a parallel resolver.
  const curatedIds = curation?.new_row ?? [];
  const out: Story[] = [];
  const seen = new Set<string>();
  for (const id of curatedIds) {
    if (out.length >= STORIES_PLAYLIST_CAP) break;
    const candidate = resolveStory(id);
    if (candidate && isPublishedStory(candidate) && !seen.has(candidate.id)) {
      out.push(candidate);
      seen.add(candidate.id);
    }
  }
  if (out.length >= STORIES_PLAYLIST_CAP) return out;
  const fallback = [...catalog.array.filter(isPublishedStory)].sort(
    (a, b) => (b.year ?? 0) - (a.year ?? 0),
  );
  for (const candidate of fallback) {
    if (out.length >= STORIES_PLAYLIST_CAP) break;
    if (seen.has(candidate.id)) continue;
    out.push(candidate);
    seen.add(candidate.id);
  }
  return out;
}

/** Drop already-viewed wires from a Stories playlist. Pure helper so
 *  the rail can apply the visibility filter (used to render unseen-only)
 *  and the viewer can leave the full playlist intact (so a deep-link
 *  to a viewed wire still works). Accepts either an Array or a Set so
 *  callers don't pay the Array→Set rebuild on every render. */
export function filterStoriesPlaylistByUnseen(
  playlist: Story[],
  viewedIds: ReadonlySet<string> | string[],
): Story[] {
  const set = viewedIds instanceof Set ? viewedIds : new Set(viewedIds);
  return playlist.filter((s) => !set.has(s.id));
}
