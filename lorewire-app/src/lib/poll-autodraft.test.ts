// Tests for the shared autodraft service. Covers the four-state
// matrix the service has to handle:
//
//   1. No existing poll + LLM OK         → insert enabled=1
//   2. No existing poll + LLM fails      → insert enabled=0 (preset)
//   3. Existing enabled=1                → skip (admin's choice wins)
//   4. Existing enabled=0 + LLM OK       → upgrade to enabled=1
//
// 2026-06-18 polls plan extension — "every article must have a poll."

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "@/lib/db";
import {
  autoDraftPollForSubject,
  tiptapToPlainText,
} from "@/lib/poll-autodraft";
import { getPollByArticleId, getPollByStoryId } from "@/lib/polls";
import * as llm from "@/lib/llm";

async function reset(): Promise<void> {
  await run("DELETE FROM poll_votes WHERE 1=1");
  await run("DELETE FROM poll_aggregates WHERE 1=1");
  await run("DELETE FROM polls WHERE 1=1");
  await run("DELETE FROM stories WHERE id LIKE 'test-ad-%'");
  await run("DELETE FROM articles WHERE id LIKE 'test-ad-%'");
}

async function seedStory(id: string, body: string = "Body text."): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "INSERT INTO stories (id, category, title, status, body, created_at, updated_at) " +
      "VALUES (?, 'Drama', 'T', 'published', ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET body = excluded.body",
    [id, body, now, now],
  );
}

async function seedArticle(id: string): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "INSERT INTO articles (id, type, language, slug, title, status, payload, created_at, updated_at) " +
      "VALUES (?, 'feature', 'en', ?, 'T', 'published', '{}', ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
    [id, `slug-${id}`, now, now],
  );
}

beforeEach(async () => {
  await reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("autoDraftPollForSubject — no existing poll", () => {
  it("inserts enabled=1 when the LLM returns valid output", async () => {
    vi.spyOn(llm, "chatCompletion").mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        question: "Who's wrong?",
        optionA: "Wife",
        optionB: "Husband",
      }),
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    await seedStory("test-ad-story-1", "Body text long enough");
    const r = await autoDraftPollForSubject({
      kind: "story",
      storyId: "test-ad-story-1",
      title: "T",
      body: "Body text long enough for the model to read",
      category: "Drama",
    });
    expect(r.ok).toBe(true);
    expect(r.ai).toBe(true);
    const poll = await getPollByStoryId("test-ad-story-1");
    expect(poll?.enabled).toBe(1);
    expect(poll?.question).toBe("Who's wrong?");
  });

  it("inserts enabled=0 preset draft when the LLM call fails", async () => {
    vi.spyOn(llm, "chatCompletion").mockResolvedValue({
      ok: false,
      error: "upstream 500",
    });
    await seedStory("test-ad-story-2", "Body text long enough");
    const r = await autoDraftPollForSubject({
      kind: "story",
      storyId: "test-ad-story-2",
      title: "T",
      body: "Body text long enough for the model to read",
      category: "Drama",
    });
    expect(r.ok).toBe(true);
    expect(r.ai).toBe(false);
    expect(r.fallbackReason).toBe("llm_failed");
    const poll = await getPollByStoryId("test-ad-story-2");
    expect(poll?.enabled).toBe(0);
    // Drama preset is "Who's wrong?" — invariant: a row exists,
    // even if it's the placeholder.
    expect(poll?.question).toBe("Who's wrong?");
  });

  it("inserts enabled=0 preset draft when the LLM returns non-JSON", async () => {
    vi.spyOn(llm, "chatCompletion").mockResolvedValue({
      ok: true,
      content: "not json at all",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    await seedStory("test-ad-story-3", "Body text long enough");
    const r = await autoDraftPollForSubject({
      kind: "story",
      storyId: "test-ad-story-3",
      title: "T",
      body: "Body text long enough for the model to read",
      category: "Drama",
    });
    expect(r.ai).toBe(false);
    expect(r.fallbackReason).toBe("non_json");
  });

  it("inserts enabled=0 preset draft when LLM output fails validation", async () => {
    // Identical labels → validatePollInputs rejects.
    vi.spyOn(llm, "chatCompletion").mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        question: "Q?",
        optionA: "same",
        optionB: "same",
      }),
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    await seedStory("test-ad-story-4", "Body text long enough");
    const r = await autoDraftPollForSubject({
      kind: "story",
      storyId: "test-ad-story-4",
      title: "T",
      body: "Body text long enough for the model to read",
      category: "Drama",
    });
    expect(r.ai).toBe(false);
    expect(r.fallbackReason).toBe("validation_failed");
  });

  it("skips the LLM entirely when body is empty — inserts preset draft directly", async () => {
    const spy = vi.spyOn(llm, "chatCompletion");
    await seedArticle("test-ad-article-empty");
    const r = await autoDraftPollForSubject({
      kind: "article",
      articleId: "test-ad-article-empty",
      title: "T",
      bodyText: "",
      type: "feature",
    });
    expect(r.ok).toBe(true);
    expect(r.ai).toBe(false);
    expect(r.fallbackReason).toBe("validation_failed");
    expect(spy).not.toHaveBeenCalled();
    const poll = await getPollByArticleId("test-ad-article-empty");
    expect(poll?.enabled).toBe(0);
  });
});

describe("autoDraftPollForSubject — existing poll idempotency", () => {
  it("never overwrites an enabled poll (admin's choice wins)", async () => {
    await seedStory("test-ad-story-5", "Body text long enough");
    // Pre-seed the poll as if the admin had saved it manually.
    await run(
      `INSERT INTO polls (id, story_id, article_id, question, option_a_text, option_b_text, enabled, category, created_at, updated_at)
       VALUES ('admin-poll', 'test-ad-story-5', NULL, 'Admin question?', 'A', 'B', 1, 'Drama', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()],
    );
    const spy = vi.spyOn(llm, "chatCompletion");
    const r = await autoDraftPollForSubject({
      kind: "story",
      storyId: "test-ad-story-5",
      title: "T",
      body: "Body text long enough",
      category: "Drama",
    });
    expect(r.ok).toBe(true);
    expect(r.ai).toBe(true);
    expect(r.pollId).toBe("admin-poll");
    // LLM was never called — admin's poll is the source of truth.
    expect(spy).not.toHaveBeenCalled();
    const poll = await getPollByStoryId("test-ad-story-5");
    expect(poll?.question).toBe("Admin question?");
  });

  it("upgrades a disabled draft to enabled=1 when LLM produces good output", async () => {
    await seedStory("test-ad-story-6", "Body text long enough");
    // Pre-seed a draft (as our own earlier autodraft would have).
    await run(
      `INSERT INTO polls (id, story_id, article_id, question, option_a_text, option_b_text, enabled, category, created_at, updated_at)
       VALUES ('draft-poll', 'test-ad-story-6', NULL, 'Who''s wrong?', 'Person A', 'Person B', 0, 'Drama', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()],
    );
    vi.spyOn(llm, "chatCompletion").mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        question: "Was the response fair?",
        optionA: "Yes",
        optionB: "No",
      }),
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    const r = await autoDraftPollForSubject({
      kind: "story",
      storyId: "test-ad-story-6",
      title: "T",
      body: "Body text long enough for the model to read",
      category: "Drama",
    });
    expect(r.ai).toBe(true);
    const poll = await getPollByStoryId("test-ad-story-6");
    expect(poll?.enabled).toBe(1);
    expect(poll?.question).toBe("Was the response fair?");
  });

  it("leaves a disabled draft as-is when LLM still fails on upgrade", async () => {
    await seedStory("test-ad-story-7", "Body text long enough");
    await run(
      `INSERT INTO polls (id, story_id, article_id, question, option_a_text, option_b_text, enabled, category, created_at, updated_at)
       VALUES ('stuck-draft', 'test-ad-story-7', NULL, 'Who''s wrong?', 'Person A', 'Person B', 0, 'Drama', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()],
    );
    vi.spyOn(llm, "chatCompletion").mockResolvedValue({
      ok: false,
      error: "still failing",
    });
    const r = await autoDraftPollForSubject({
      kind: "story",
      storyId: "test-ad-story-7",
      title: "T",
      body: "Body text long enough",
      category: "Drama",
    });
    expect(r.ai).toBe(false);
    const poll = await getPollByStoryId("test-ad-story-7");
    expect(poll?.enabled).toBe(0);
    // Original draft text retained.
    expect(poll?.question).toBe("Who's wrong?");
  });
});

describe("tiptapToPlainText", () => {
  it("flattens a doc to plain text", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "world" }],
        },
      ],
    });
    expect(tiptapToPlainText(doc)).toBe("Hello world");
  });

  it("returns empty string on null / malformed input", () => {
    expect(tiptapToPlainText(null)).toBe("");
    expect(tiptapToPlainText("not json")).toBe("");
    expect(tiptapToPlainText("{}")).toBe("");
  });

  it("recurses through nested content arrays", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "nested" },
                { type: "text", text: "text" },
              ],
            },
          ],
        },
      ],
    });
    expect(tiptapToPlainText(doc)).toBe("nested text");
  });
});
