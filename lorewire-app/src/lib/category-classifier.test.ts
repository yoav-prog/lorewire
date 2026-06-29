// Unit tests for the LLM category classifier
// (_plans/2026-06-21-category-classifier-and-pills.md). The chatCompletion
// helper is mocked so we exercise the closed-enum guard, the
// canonical-cased output, and the safe-fallback behavior without a real
// network call. Mirrors pipeline/tests/test_stages.py::ClassifyCategoryTests
// so both implementations are pinned to the same contract.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/models", () => ({
  selected: vi.fn().mockResolvedValue("openai/gpt-5-nano"),
}));

const chatCompletion = vi.fn();
vi.mock("@/lib/llm", () => ({
  chatCompletion: (...args: unknown[]) => chatCompletion(...args),
}));

import { classifyCategory } from "@/lib/category-classifier";

const TITLE = "THE $800 ENVELOPE";
const BODY =
  "A coworker collects cash for the boss's retirement gift, then the envelope quietly disappears.";

describe("classifyCategory", () => {
  beforeEach(() => {
    chatCompletion.mockReset();
  });

  it("returns the canonical-cased category for a clean match", async () => {
    chatCompletion.mockResolvedValueOnce({
      ok: true,
      content: "entitled",
      provider: "openai",
      model: "gpt-5-nano",
    });
    const r = await classifyCategory({
      title: TITLE,
      body: BODY,
      fallback: "Drama",
    });
    expect(r.category).toBe("Entitled");
    expect(r.source).toBe("llm");
    expect(r.llmOk).toBe(true);
  });

  it("strips surrounding punctuation around the answer", async () => {
    chatCompletion.mockResolvedValueOnce({
      ok: true,
      content: '"Humor".',
      provider: "openai",
      model: "gpt-5-nano",
    });
    const r = await classifyCategory({
      title: TITLE,
      body: BODY,
      fallback: "Drama",
    });
    expect(r.category).toBe("Humor");
  });

  it("takes the first word when the model explains its pick", async () => {
    chatCompletion.mockResolvedValueOnce({
      ok: true,
      content: "Humor - it reads like a sitcom beat",
      provider: "openai",
      model: "gpt-5-nano",
    });
    const r = await classifyCategory({
      title: TITLE,
      body: BODY,
      fallback: "Drama",
    });
    expect(r.category).toBe("Humor");
  });

  it("falls back when the response is outside the closed set", async () => {
    chatCompletion.mockResolvedValueOnce({
      ok: true,
      content: "Politics",
      provider: "openai",
      model: "gpt-5-nano",
    });
    const r = await classifyCategory({
      title: TITLE,
      body: BODY,
      fallback: "Wholesome",
    });
    expect(r.category).toBe("Wholesome");
    expect(r.source).toBe("fallback");
    expect(r.llmOk).toBe(true);
  });

  it("falls back when the LLM call errors", async () => {
    chatCompletion.mockResolvedValueOnce({
      ok: false,
      error: "openai 500: boom",
    });
    const r = await classifyCategory({
      title: TITLE,
      body: BODY,
      fallback: "Roommate",
    });
    expect(r.category).toBe("Roommate");
    expect(r.source).toBe("fallback");
    expect(r.llmOk).toBe(false);
    expect(r.reason).toContain("500");
  });

  it("skips the LLM call entirely when body is empty", async () => {
    const r = await classifyCategory({
      title: TITLE,
      body: "",
      fallback: "Dating",
    });
    expect(r.category).toBe("Dating");
    expect(r.source).toBe("fallback");
    expect(r.reason).toBe("empty-body");
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it("repairs an invalid fallback to a known category", async () => {
    chatCompletion.mockResolvedValueOnce({ ok: false, error: "boom" });
    const r = await classifyCategory({
      title: TITLE,
      body: BODY,
      fallback: "BogusValue",
    });
    expect(r.category).toBe("Entitled");
  });

  it("falls back to a Drama input when the LLM fails and Drama was the prior tag", async () => {
    // The backfill calls this with fallback = "Drama" specifically because
    // that's what we're trying to fix. If the LLM fails, the story stays
    // Drama — the action UI surfaces those rows so the admin can re-run
    // them later. The library doesn't second-guess the caller.
    chatCompletion.mockResolvedValueOnce({ ok: false, error: "boom" });
    const r = await classifyCategory({
      title: TITLE,
      body: BODY,
      fallback: "Drama",
    });
    expect(r.category).toBe("Drama");
    expect(r.source).toBe("fallback");
  });
});
