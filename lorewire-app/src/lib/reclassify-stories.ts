// Service layer for the bulk reclassify action. The Next.js Server Action
// wrapper (`bulkReclassifyStoriesAction` in `app/admin/actions.ts`) is a
// thin auth + revalidate shim around this function; the actual SQL +
// classifier loop lives here so it's unit-testable without the
// "use server" gate getting in the way. See
// _plans/2026-06-21-category-classifier-and-pills.md.

import "server-only";

import { all } from "@/lib/db";
import { setStoryCategory } from "@/lib/repo";
import { classifyCategory } from "@/lib/category-classifier";

export interface ReclassifyChange {
  id: string;
  title: string;
  prev: string | null;
  next: string;
}

export interface ReclassifyFailure {
  id: string;
  title: string;
  reason: string;
}

export interface ReclassifyResult {
  scanned: number;
  reclassified: number;
  unchanged: number;
  failed: ReclassifyFailure[];
  changes: ReclassifyChange[];
}

export interface ReclassifyOpts {
  /** Hard cap on the number of stories scanned per call. Defaults to 200,
   *  matching MAX_BULK_ITEMS in the actions module. */
  limit?: number;
}

interface TargetRow {
  id: string;
  title: string | null;
  body: string | null;
  category: string | null;
}

/** Reclassify every story whose category is NULL or "Drama". Stories with
 *  any other category are left alone — those were either correctly
 *  auto-tagged from the subreddit map or hand-edited by an admin, and
 *  overwriting hand-edits silently is the worst kind of magic. */
export async function reclassifyDramaAndNullStories(
  opts: ReclassifyOpts = {},
): Promise<ReclassifyResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
  const targets = await all<TargetRow>(
    "SELECT id, title, body, category FROM stories " +
      "WHERE (category IS NULL OR category = 'Drama') " +
      "ORDER BY COALESCE(updated_at, created_at) DESC " +
      `LIMIT ${limit}`,
  );

  console.info("[reclassify start]", { scanned: targets.length });

  const changes: ReclassifyChange[] = [];
  const failed: ReclassifyFailure[] = [];
  let unchanged = 0;

  for (const r of targets) {
    const title = r.title ?? r.id.slice(0, 8);
    try {
      const result = await classifyCategory({
        title: r.title,
        body: r.body,
        // Fallback = current value so a network blip can't downgrade a
        // story to a worse category than it already has.
        fallback: r.category ?? "Drama",
      });
      if (!result.llmOk) {
        failed.push({ id: r.id, title, reason: result.reason ?? "llm-failed" });
        console.warn("[reclassify item]", {
          id: r.id,
          prev: r.category,
          next: result.category,
          llmOk: false,
          reason: result.reason,
        });
        continue;
      }
      if (result.category === r.category) {
        unchanged += 1;
        console.info("[reclassify item]", {
          id: r.id,
          prev: r.category,
          next: result.category,
          llmOk: true,
          changed: false,
        });
        continue;
      }
      await setStoryCategory(r.id, result.category);
      changes.push({
        id: r.id,
        title,
        prev: r.category,
        next: result.category,
      });
      console.info("[reclassify item]", {
        id: r.id,
        prev: r.category,
        next: result.category,
        llmOk: true,
        changed: true,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ id: r.id, title, reason });
      console.error("[reclassify item failed]", { id: r.id, error: reason });
    }
  }

  const out: ReclassifyResult = {
    scanned: targets.length,
    reclassified: changes.length,
    unchanged,
    failed,
    changes,
  };
  console.info("[reclassify done]", {
    scanned: out.scanned,
    reclassified: out.reclassified,
    unchanged: out.unchanged,
    failed: out.failed.length,
  });
  return out;
}
