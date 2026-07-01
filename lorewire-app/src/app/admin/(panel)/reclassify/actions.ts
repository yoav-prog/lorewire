"use server";

// Admin-gated server action that runs the multi-tag reclassification DRY-RUN
// and returns the coverage report. Runs in Vercel (which already has the DB +
// LLM key), so there's no local setup and no cross-runtime job. Writes
// nothing — applying the tags is the Python pipeline's gated job. Plan:
// _plans/2026-07-01-category-taxonomy-multitag.md.

import { requireCapability } from "@/lib/dal";
import { runDryRunReport, type TagReport } from "@/lib/reclassify-tags";

export async function dryRunReclassifyTagsAction(): Promise<TagReport> {
  await requireCapability("content.manage");
  return runDryRunReport();
}

export interface ApplyTagItem {
  id: string;
  tags: { slug: string; confidence?: number | null }[];
}

export interface ApplyResult {
  applied: number;
  skipped: number;
}

/** Writes the reviewed tags to story_tags. Takes the auto-tagged proposals
 *  from a dry-run (the caller filters out the review queue). Every slug is
 *  re-validated server-side against the current active categories, so a
 *  tampered payload can only ever write real category slugs. Never writes an
 *  empty tag set (that would strip a story of all tags). Reversible: it only
 *  touches story_tags; stories.category is untouched. */
export async function applyReclassifyTagsAction(
  items: ApplyTagItem[],
): Promise<ApplyResult> {
  await requireCapability("content.manage");
  const { listCategories, setStoryTags } = await import("@/lib/categories/repo");
  const activeSlugs = new Set((await listCategories()).map((c) => c.slug));

  let applied = 0;
  let skipped = 0;
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !item.id || !Array.isArray(item.tags)) {
      skipped += 1;
      continue;
    }
    const tags = item.tags.filter(
      (t) => t && typeof t.slug === "string" && activeSlugs.has(t.slug),
    );
    if (tags.length === 0) {
      skipped += 1;
      continue;
    }
    await setStoryTags(item.id, tags, "llm");
    applied += 1;
  }
  console.info("[reclassify-tags apply]", { applied, skipped });
  return { applied, skipped };
}
