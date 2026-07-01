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
