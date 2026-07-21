// Admin dry-run reclassification into the multi-tag taxonomy (PR: admin
// trigger for _plans/2026-07-01-category-taxonomy-multitag.md). Mirrors the
// Python `pipeline/reclassify_tags.py`: `buildTagReport` classifies every
// story and aggregates a coverage report WITHOUT writing, so the admin can
// see what the run would do — and whether the 17 categories cover the corpus
// — before anything is applied. `runDryRunReport` is the thin IO wrapper the
// server action calls; it runs in Vercel, which already has the DB + LLM key.
//
// This intentionally stops at the report. Applying the tags is the Python
// pipeline's job (pipeline/reclassify_tags.run) and stays gated on this
// review.

import "server-only";

import { all } from "@/lib/db";
import { listCategories } from "@/lib/categories/repo";
import {
  classifyStoryTags,
  type StoryTag,
  type TagCategory,
} from "@/lib/category-tags-classifier";

export interface StoryRow {
  id: string;
  title: string | null;
  body: string | null;
  category: string | null;
}

export interface TagProposal {
  id: string;
  title: string | null;
  oldCategory: string | null;
  tags: StoryTag[];
  primary: string | null;
  primaryConfidence: number;
  needsReview: boolean;
}

export interface TagReport {
  total: number;
  autoTagged: number;
  reviewQueue: number;
  primaryCounts: Record<string, number>;
  tagCounts: Record<string, number>;
  confidenceBuckets: { high: number; mid: number; low: number };
  confidenceFloor: number;
  proposals: TagProposal[];
}

// A story whose best tag is below this lands in the review queue instead of
// being auto-assigned. Surfaced in the report so the admin sees how many.
export const DEFAULT_CONFIDENCE_FLOOR = 0.6;

function bucketOf(confidence: number): "high" | "mid" | "low" {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.6) return "mid";
  return "low";
}

/** Classify each story and aggregate a report without writing. `classifyFn`
 *  is injected so this is testable with a stub (no LLM). Mirrors the Python
 *  `build_reclassification_report`. */
export async function buildTagReport(
  stories: StoryRow[],
  categories: TagCategory[],
  classifyFn: (story: StoryRow, categories: TagCategory[]) => Promise<StoryTag[]>,
  confidenceFloor: number = DEFAULT_CONFIDENCE_FLOOR,
): Promise<TagReport> {
  const primaryCounts: Record<string, number> = {};
  const tagCounts: Record<string, number> = {};
  const confidenceBuckets = { high: 0, mid: 0, low: 0 };
  const proposals: TagProposal[] = [];
  let reviewQueue = 0;

  for (const s of stories) {
    const tags = await classifyFn(s, categories);
    const primary = tags[0] ?? null;
    const primaryConfidence = primary ? primary.confidence : 0;
    const needsReview = !primary || primaryConfidence < confidenceFloor;

    proposals.push({
      id: s.id,
      title: s.title,
      oldCategory: s.category,
      tags,
      primary: primary?.slug ?? null,
      primaryConfidence,
      needsReview,
    });

    if (needsReview) {
      reviewQueue += 1;
      continue;
    }
    confidenceBuckets[bucketOf(primaryConfidence)] += 1;
    for (const t of tags) tagCounts[t.slug] = (tagCounts[t.slug] ?? 0) + 1;
    primaryCounts[primary.slug] = (primaryCounts[primary.slug] ?? 0) + 1;
  }

  return {
    total: stories.length,
    autoTagged: stories.length - reviewQueue,
    reviewQueue,
    primaryCounts,
    tagCounts,
    confidenceBuckets,
    confidenceFloor,
    proposals,
  };
}

export interface DryRunOptions {
  limit?: number;
  confidenceFloor?: number;
}

/** Read the active categories + stories, classify each via the LLM, and
 *  return the coverage report. Writes nothing. */
export async function runDryRunReport(
  opts: DryRunOptions = {},
): Promise<TagReport> {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 1000));
  const activeCategories = await listCategories();
  const categories: TagCategory[] = activeCategories.map((c) => ({
    slug: c.slug,
    label: c.label,
    description: c.description,
  }));
  const stories = await all<StoryRow>(
    "SELECT id, title, body, category FROM stories " +
      "ORDER BY COALESCE(updated_at, created_at) DESC " +
      `LIMIT ${limit}`,
  );
  console.info("[reclassify-tags dry-run start]", {
    stories: stories.length,
    categories: categories.length,
  });
  const report = await buildTagReport(
    stories,
    categories,
    (story, cats) =>
      classifyStoryTags({ title: story.title, body: story.body, categories: cats }),
    opts.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR,
  );
  console.info("[reclassify-tags dry-run done]", {
    total: report.total,
    autoTagged: report.autoTagged,
    reviewQueue: report.reviewQueue,
  });
  return report;
}
