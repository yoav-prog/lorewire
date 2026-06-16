"use server";

// Server actions for /admin/curation. Each one gates on requireAdmin,
// revalidates / so the public homepage re-fetches on the next request
// AND the curation page itself so the card lists update without a hard
// reload, and logs `[admin curation ...]` namespaced per rule 14.
//
// Plan: _plans/2026-06-16-homepage-curation.md (phase 3).

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/dal";
import {
  addToSurface,
  HOMEPAGE_SURFACES,
  listAllCuration,
  moveInSurface,
  removeFromSurface,
  type HomepageSurface,
} from "@/lib/homepage-curation";
import { all } from "@/lib/db";

export interface CurationActionResult {
  ok: boolean;
  error?: string;
}

function revalidate(): void {
  revalidatePath("/");
  revalidatePath("/admin/curation");
}

export async function addCurationAction(
  surface: string,
  storyId: string,
): Promise<CurationActionResult> {
  const session = await requireAdmin();
  const r = await addToSurface(surface, storyId);
  // eslint-disable-next-line no-console -- rule 14
  console.info("[admin curation add]", {
    surface,
    story_id: storyId,
    user_id: session.userId,
    ok: r.ok,
    error: r.ok ? null : r.error,
  });
  if (!r.ok) return { ok: false, error: r.error };
  revalidate();
  return { ok: true };
}

export async function removeCurationAction(
  surface: string,
  storyId: string,
): Promise<CurationActionResult> {
  const session = await requireAdmin();
  const r = await removeFromSurface(surface, storyId);
  // eslint-disable-next-line no-console -- rule 14
  console.info("[admin curation remove]", {
    surface,
    story_id: storyId,
    user_id: session.userId,
    ok: r.ok,
    error: r.ok ? null : r.error,
  });
  if (!r.ok) return { ok: false, error: r.error };
  revalidate();
  return { ok: true };
}

export async function moveCurationAction(
  surface: string,
  storyId: string,
  direction: "up" | "down",
): Promise<CurationActionResult> {
  const session = await requireAdmin();
  const r = await moveInSurface(surface, storyId, direction);
  // eslint-disable-next-line no-console -- rule 14
  console.info("[admin curation move]", {
    surface,
    story_id: storyId,
    direction,
    user_id: session.userId,
    ok: r.ok,
    error: r.ok ? null : r.error,
  });
  if (!r.ok) return { ok: false, error: r.error };
  revalidate();
  return { ok: true };
}

// Story rows the admin picker can choose from. Returns every published,
// non-noindex story — the picker filters client-side by category /
// search. Slim projection so the JSON the page bundles down isn't
// bloated by body/alignment columns.
export interface CurationPickerStory {
  id: string;
  title: string | null;
  category: string | null;
  hero_image: string | null;
  video_url: string | null;
  duration: string | null;
  published_at: string | null;
}

export async function listCurationPickerStoriesAction(): Promise<
  CurationPickerStory[]
> {
  await requireAdmin();
  const rows = await all<CurationPickerStory>(
    "SELECT id, title, category, hero_image, video_url, duration, published_at " +
      "FROM stories " +
      "WHERE status = 'published' AND published_at IS NOT NULL " +
      "AND (noindex IS NULL OR noindex = 0) " +
      "ORDER BY published_at DESC",
  );
  return rows;
}

// Combined server-render payload for the curation page. Returns every
// surface keyed by name + the full picker story list so the page can
// render in a single round trip. Surfaces with no rows still appear
// (empty arrays) so the admin can add to them.
export interface CurationServerRenderRow {
  id: string;
  story_id: string;
  position: number;
  is_published: boolean;
  /** Joined from stories so the card can render a thumbnail + title
   *  without a second N round-trips. NULL fields when the story id no
   *  longer matches any row (truly gone, not just unpublished). */
  title: string | null;
  category: string | null;
  hero_image: string | null;
}

export interface CurationServerRender {
  surfaces: Record<HomepageSurface, CurationServerRenderRow[]>;
  picker: CurationPickerStory[];
}

export async function loadCurationServerRenderAction(): Promise<CurationServerRender> {
  await requireAdmin();
  const grouped = await listAllCuration();
  // Bulk-fetch every curated story id (across all surfaces) so the page
  // can render titles + thumbs + publish state without N round-trips.
  const idSet = new Set<string>();
  for (const s of HOMEPAGE_SURFACES) {
    for (const r of grouped[s]) idSet.add(r.story_id);
  }
  const ids = Array.from(idSet);
  let infoMap = new Map<
    string,
    {
      title: string | null;
      category: string | null;
      hero_image: string | null;
      is_published: boolean;
    }
  >();
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await all<{
      id: string;
      title: string | null;
      category: string | null;
      hero_image: string | null;
      status: string | null;
      published_at: string | null;
      noindex: number | null;
    }>(
      `SELECT id, title, category, hero_image, status, published_at, noindex ` +
        `FROM stories WHERE id IN (${placeholders})`,
      ids,
    );
    infoMap = new Map(
      rows.map((r) => [
        r.id,
        {
          title: r.title,
          category: r.category,
          hero_image: r.hero_image,
          is_published:
            r.status === "published" &&
            !!r.published_at &&
            (r.noindex === null || r.noindex === 0),
        },
      ]),
    );
  }
  const surfaces: Record<HomepageSurface, CurationServerRenderRow[]> = {
    hero: [],
    top10: [],
    continue: [],
    new_row: [],
    entitled_row: [],
    humor_row: [],
    wholesome_row: [],
    dating_row: [],
    roommate_row: [],
    drama_row: [],
  };
  for (const surface of HOMEPAGE_SURFACES) {
    for (const r of grouped[surface]) {
      const info = infoMap.get(r.story_id);
      surfaces[surface].push({
        id: r.id,
        story_id: r.story_id,
        position: r.position,
        is_published: info?.is_published ?? false,
        title: info?.title ?? null,
        category: info?.category ?? null,
        hero_image: info?.hero_image ?? null,
      });
    }
  }
  const picker = await listCurationPickerStoriesAction();
  return { surfaces, picker };
}
