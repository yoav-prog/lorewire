// Post-publish enrichment: when an admin publishes a story, drop it into
// the natural homepage rails so it's actually visible on / without an
// explicit /admin/curation step. PR #41 deleted the hardcoded rail
// constants; every surface now reads exclusively from the
// homepage_curation table, so publishing on its own ships the story
// invisibly. This helper plugs that gap.
//
// Best-effort + swallow. Publishing has already succeeded by the time
// this fires — a curation failure (full rail, dupe, unknown category, DB
// hiccup) must NOT bounce the admin back to a failed-publish banner for
// a story that IS actually published. The admin can always finish the
// job via /admin/curation later.
//
// Plan: _plans/2026-06-17-publish-auto-curates.md.

import "server-only";
import { addToSurface } from "@/lib/homepage-curation";
import { isHomepageSurface } from "@/lib/homepage-curation-shared";
import { GRANULAR_CATEGORIES } from "@/lib/categories/granular";

export async function autoCurateOnPublish(
  storyId: string,
  category: string | null | undefined,
): Promise<void> {
  if (!storyId) return;
  try {
    const newRowResult = await addToSurface("new_row", storyId);
    if (!newRowResult.ok) {
      // eslint-disable-next-line no-console -- rule 14
      console.info("[publish auto-curate new_row skipped]", {
        story_id: storyId,
        reason: newRowResult.error,
      });
    } else {
      // eslint-disable-next-line no-console -- rule 14
      console.info("[publish auto-curate]", {
        story_id: storyId,
        surface: "new_row",
        position: newRowResult.row.position,
      });
    }
    const catLabel = (category ?? "").trim().toLowerCase();
    if (catLabel) {
      // Match the story's category label to a rail-flagged category and drop
      // it into that rail's slug surface. Non-rail or unknown categories land
      // in new_row only (above). Data-driven off the 18-set.
      const rail = GRANULAR_CATEGORIES.find(
        (c) => c.isRail && c.label.toLowerCase() === catLabel,
      );
      if (rail && isHomepageSurface(rail.slug)) {
        const catResult = await addToSurface(rail.slug, storyId);
        if (!catResult.ok) {
          // eslint-disable-next-line no-console -- rule 14
          console.info(`[publish auto-curate ${rail.slug} skipped]`, {
            story_id: storyId,
            reason: catResult.error,
          });
        } else {
          // eslint-disable-next-line no-console -- rule 14
          console.info("[publish auto-curate]", {
            story_id: storyId,
            surface: rail.slug,
            position: catResult.row.position,
          });
        }
      } else {
        // eslint-disable-next-line no-console -- rule 14
        console.info("[publish auto-curate skipped]", {
          story_id: storyId,
          category: catLabel,
          reason: "no rail for category",
        });
      }
    }
  } catch (e) {
    // Never propagate. The publish has already landed; a logging-or-DB
    // failure here must not surface as a failed-publish error to the
    // admin.
    // eslint-disable-next-line no-console -- rule 14
    console.warn("[publish auto-curate error]", {
      story_id: storyId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
