// Unit tests for the dry-run report aggregation. buildTagReport takes an
// injected classifyFn, so no DB and no LLM are involved — the server-only
// imports it pulls in are mocked out. Mirrors
// pipeline/tests/test_reclassify_tags.py::BuildReclassificationReportTests.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ all: vi.fn() }));
vi.mock("@/lib/categories/repo", () => ({ listCategories: vi.fn() }));
vi.mock("@/lib/category-tags-classifier", () => ({ classifyStoryTags: vi.fn() }));

import { buildTagReport, type StoryRow } from "@/lib/reclassify-tags";
import type { StoryTag, TagCategory } from "@/lib/category-tags-classifier";

const CATS: TagCategory[] = [
  { slug: "a", label: "A" },
  { slug: "b", label: "B" },
];

function stories(n: number): StoryRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: String(i),
    title: "t",
    body: "b",
    category: "Drama",
  }));
}

const fixed =
  (tags: StoryTag[]) =>
  async (): Promise<StoryTag[]> =>
    tags;

describe("buildTagReport", () => {
  it("aggregates counts and confidence buckets", async () => {
    const rep = await buildTagReport(stories(2), CATS, fixed([{ slug: "a", confidence: 0.9 }]));
    expect(rep.total).toBe(2);
    expect(rep.autoTagged).toBe(2);
    expect(rep.reviewQueue).toBe(0);
    expect(rep.primaryCounts.a).toBe(2);
    expect(rep.confidenceBuckets.high).toBe(2);
  });

  it("routes empty tags to the review queue", async () => {
    const rep = await buildTagReport(stories(1), CATS, fixed([]));
    expect(rep.reviewQueue).toBe(1);
    expect(rep.autoTagged).toBe(0);
    expect(rep.proposals[0].needsReview).toBe(true);
    expect(rep.proposals[0].primary).toBeNull();
  });

  it("routes a low-confidence primary to the review queue", async () => {
    const rep = await buildTagReport(stories(1), CATS, fixed([{ slug: "a", confidence: 0.4 }]), 0.6);
    expect(rep.reviewQueue).toBe(1);
    expect(rep.primaryCounts).toEqual({});
  });

  it("counts all tags but the primary once", async () => {
    const rep = await buildTagReport(
      stories(1),
      CATS,
      fixed([
        { slug: "a", confidence: 0.9 },
        { slug: "b", confidence: 0.7 },
      ]),
    );
    expect(rep.primaryCounts).toEqual({ a: 1 });
    expect(rep.tagCounts).toEqual({ a: 1, b: 1 });
  });

  it("treats the floor as inclusive", async () => {
    const rep = await buildTagReport(stories(1), CATS, fixed([{ slug: "a", confidence: 0.6 }]), 0.6);
    expect(rep.reviewQueue).toBe(0);
    expect(rep.confidenceBuckets.mid).toBe(1);
  });
});
