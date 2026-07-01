// Unit tests for the TS multi-tag classifier. chatCompletion is mocked so we
// exercise the JSON parse, the closed-set guard, ordering, the cap, clamping,
// dedupe, fence tolerance, and the empty-list fallbacks without a network
// call. Mirrors pipeline/tests/test_stages.py::ClassifyStoryTagsTests so both
// implementations stay pinned to the same contract.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/models", () => ({
  selected: vi.fn().mockResolvedValue("openai/gpt-5-nano"),
}));

const chatCompletion = vi.fn();
vi.mock("@/lib/llm", () => ({
  chatCompletion: (...args: unknown[]) => chatCompletion(...args),
}));

import { classifyStoryTags } from "@/lib/category-tags-classifier";

const CATEGORIES = [
  { slug: "entitled-people", label: "Entitled People", description: "entitled" },
  { slug: "cheating-betrayal", label: "Cheating & Betrayal", description: "betrayal" },
  { slug: "workplace", label: "Workplace Nightmares", description: "jobs" },
];
const BASE = { title: "T", body: "A real story body.", categories: CATEGORIES };

describe("classifyStoryTags", () => {
  beforeEach(() => chatCompletion.mockReset());

  it("returns [] with no categories, no LLM call", async () => {
    expect(await classifyStoryTags({ title: "T", body: "b", categories: [] })).toEqual([]);
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it("returns [] on empty body without calling the LLM", async () => {
    expect(await classifyStoryTags({ ...BASE, body: "" })).toEqual([]);
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it("orders by confidence, primary first", async () => {
    chatCompletion.mockResolvedValueOnce({
      ok: true,
      content: '[{"slug":"entitled-people","confidence":0.6},{"slug":"cheating-betrayal","confidence":0.9}]',
    });
    const out = await classifyStoryTags(BASE);
    expect(out.map((t) => t.slug)).toEqual(["cheating-betrayal", "entitled-people"]);
    expect(out[0].confidence).toBeCloseTo(0.9);
  });

  it("drops unknown slugs", async () => {
    chatCompletion.mockResolvedValueOnce({
      ok: true,
      content: '[{"slug":"politics","confidence":0.9},{"slug":"workplace","confidence":0.7}]',
    });
    expect((await classifyStoryTags(BASE)).map((t) => t.slug)).toEqual(["workplace"]);
  });

  it("caps at maxTags", async () => {
    chatCompletion.mockResolvedValueOnce({
      ok: true,
      content:
        '[{"slug":"entitled-people","confidence":0.9},{"slug":"cheating-betrayal","confidence":0.8},{"slug":"workplace","confidence":0.7}]',
    });
    const out = await classifyStoryTags({ ...BASE, maxTags: 2 });
    expect(out.map((t) => t.slug)).toEqual(["entitled-people", "cheating-betrayal"]);
  });

  it("clamps confidence to [0,1]", async () => {
    chatCompletion.mockResolvedValueOnce({ ok: true, content: '[{"slug":"workplace","confidence":1.7}]' });
    expect((await classifyStoryTags(BASE))[0].confidence).toBe(1);
  });

  it("tolerates code fences and prose", async () => {
    chatCompletion.mockResolvedValueOnce({
      ok: true,
      content: 'Sure:\n```json\n[{"slug":"workplace","confidence":0.5}]\n```',
    });
    expect((await classifyStoryTags(BASE)).map((t) => t.slug)).toEqual(["workplace"]);
  });

  it("dedupes keeping the highest confidence", async () => {
    chatCompletion.mockResolvedValueOnce({
      ok: true,
      content: '[{"slug":"workplace","confidence":0.4},{"slug":"workplace","confidence":0.8}]',
    });
    const out = await classifyStoryTags(BASE);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(0.8);
  });

  it("returns [] on unparseable output", async () => {
    chatCompletion.mockResolvedValueOnce({ ok: true, content: "not json at all" });
    expect(await classifyStoryTags(BASE)).toEqual([]);
  });

  it("returns [] when the LLM call fails", async () => {
    chatCompletion.mockResolvedValueOnce({ ok: false, error: "boom" });
    expect(await classifyStoryTags(BASE)).toEqual([]);
  });
});
