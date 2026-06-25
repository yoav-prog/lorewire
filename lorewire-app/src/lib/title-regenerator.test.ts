// Tests for lib/title-regenerator (plan:
// _plans/2026-06-25-title-length-gate.md, Layer 3).
//
// Coverage:
//   - pure: TitleSchema accepts brand-voice titles, rejects empty,
//           over-length, and over-word-count input
//   - pure: prompt builders include the body + category and the JSON-only rule
//   - flow: regenerateTitleForStory returns story-not-found for an unknown id
//   - flow: regenerateTitleForStory returns story-missing-body for a body-less story
//   - flow: regenerateTitleForStory writes a new title to stories.title on
//           a happy-path mocked LLM call

import { beforeEach, describe, expect, it, vi } from "vitest";
import { one, run } from "@/lib/db";
import {
  TITLE_MAX_CHARS,
  TITLE_MAX_WORDS,
  TitleSchema,
  regenerateTitleForStory,
  systemPrompt,
  userPrompt,
} from "@/lib/title-regenerator";

// Mock the LLM client. Individual tests override the implementation per
// case via `mockChatCompletion.mockResolvedValueOnce(...)`. Default is a
// success so the tests that don't care about the LLM path don't trip.
const mockChatCompletion = vi.fn();
vi.mock("@/lib/llm", () => ({
  chatCompletion: (opts: unknown) => mockChatCompletion(opts),
}));

beforeEach(async () => {
  await run("DELETE FROM stories WHERE id LIKE 'title-regen-test-%'", []);
  mockChatCompletion.mockReset();
});

// --- Pure: TitleSchema ----------------------------------------------------

describe("TitleSchema", () => {
  it("accepts brand-voice titles", () => {
    for (const example of [
      "THE $800 ENVELOPE",
      "SHE REPLIED ALL",
      "WRONG NUMBER, RIGHT GUY",
      "MY ROOMMATE'S 3AM RULES",
    ]) {
      expect(TitleSchema.safeParse(example).success).toBe(true);
    }
  });

  it("rejects empty / whitespace-only strings", () => {
    expect(TitleSchema.safeParse("").success).toBe(false);
    expect(TitleSchema.safeParse("   ").success).toBe(false);
  });

  it("rejects the 99-char cinnamon-roll title (the bug we're fixing)", () => {
    const bad =
      "MY SON ATE THE MIDDLES OUT OF EVERY CINNAMON ROLL BEFORE " +
      "I GOT TO THE TABLE THIS MORNING.";
    expect(TitleSchema.safeParse(bad).success).toBe(false);
  });

  it(`rejects titles past ${TITLE_MAX_CHARS} chars`, () => {
    expect(TitleSchema.safeParse("X".repeat(TITLE_MAX_CHARS + 1)).success).toBe(
      false,
    );
  });

  it(`rejects titles past ${TITLE_MAX_WORDS} words even when char-count fits`, () => {
    // 9 short words is comfortably under the char cap but past the word cap.
    expect(
      TitleSchema.safeParse("ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE")
        .success,
    ).toBe(false);
  });
});

// --- Pure: prompt builders ------------------------------------------------

describe("prompt builders", () => {
  it("system prompt names the brand voice rules + the JSON-only contract", () => {
    const s = systemPrompt();
    expect(s).toContain("LoreWire");
    expect(s).toContain("ALL CAPS");
    expect(s).toContain("2 to 6 words");
    expect(s).toContain(`${TITLE_MAX_CHARS} characters`);
    expect(s).toContain("THE $800 ENVELOPE");
    expect(s).toContain("ONLY the JSON object");
  });

  it("user prompt includes the body + category", () => {
    const u = userPrompt({
      body: "She mailed the envelope.",
      category: "Drama",
    });
    expect(u).toContain("Drama");
    expect(u).toContain("She mailed the envelope.");
  });
});

// --- Flow: regenerateTitleForStory ----------------------------------------

describe("regenerateTitleForStory", () => {
  it("returns story-not-found when the story id doesn't exist", async () => {
    const out = await regenerateTitleForStory("title-regen-test-missing");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("story-not-found");
    }
  });

  it("refuses stories with no body text (can't ground the prompt)", async () => {
    const storyId = "title-regen-test-no-body";
    const now = new Date().toISOString();
    await run(
      `INSERT INTO stories (id, title, body, status, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?)`,
      [storyId, "OLD TITLE", "", now, now],
    );
    const out = await regenerateTitleForStory(storyId);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("story-missing-body");
    }
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it("writes the new title to stories.title on a happy-path LLM call", async () => {
    const storyId = "title-regen-test-happy";
    const now = new Date().toISOString();
    await run(
      `INSERT INTO stories (id, title, body, category, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Entitled', 'draft', ?, ?)`,
      [
        storyId,
        "MY SON ATE THE MIDDLES OUT OF EVERY CINNAMON ROLL BEFORE I GOT TO THE TABLE THIS MORNING.",
        "She walked into the kitchen and the cinnamon rolls had craters where the middles used to be.",
        now,
        now,
      ],
    );
    mockChatCompletion.mockResolvedValueOnce({
      ok: true,
      content: JSON.stringify({ title: "the cinnamon roll heist" }),
      provider: "openai",
      model: "gpt-5-nano",
    });
    const out = await regenerateTitleForStory(storyId);
    expect(out.ok).toBe(true);
    if (out.ok) {
      // ALL CAPS is enforced in the regenerator regardless of LLM casing.
      expect(out.title).toBe("THE CINNAMON ROLL HEIST");
      expect(out.previousTitle).toMatch(/^MY SON ATE/);
    }
    const row = await one<{ title: string | null }>(
      "SELECT title FROM stories WHERE id = ?",
      [storyId],
    );
    expect(row?.title).toBe("THE CINNAMON ROLL HEIST");
  });

  it("does NOT write on a schema-violating LLM response", async () => {
    const storyId = "title-regen-test-bad-llm";
    const now = new Date().toISOString();
    await run(
      `INSERT INTO stories (id, title, body, category, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Humor', 'draft', ?, ?)`,
      [storyId, "ORIGINAL TITLE", "Some body text to satisfy the body gate.", now, now],
    );
    // LLM returns a title that fits the JSON shape but blows the length cap.
    mockChatCompletion.mockResolvedValueOnce({
      ok: true,
      content: JSON.stringify({
        title: "AN EXTREMELY LONG TITLE PAST THE FIFTY CHARACTER CAP",
      }),
      provider: "openai",
      model: "gpt-5-nano",
    });
    const out = await regenerateTitleForStory(storyId);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("schema");
    }
    const row = await one<{ title: string | null }>(
      "SELECT title FROM stories WHERE id = ?",
      [storyId],
    );
    // Original title untouched.
    expect(row?.title).toBe("ORIGINAL TITLE");
  });

  it("does NOT write on an LLM-call failure", async () => {
    const storyId = "title-regen-test-llm-fail";
    const now = new Date().toISOString();
    await run(
      `INSERT INTO stories (id, title, body, category, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Drama', 'draft', ?, ?)`,
      [storyId, "ORIGINAL", "Body text long enough to clear the body gate.", now, now],
    );
    mockChatCompletion.mockResolvedValueOnce({
      ok: false,
      error: "openai 503: temporarily unavailable",
    });
    const out = await regenerateTitleForStory(storyId);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("llm");
    }
    const row = await one<{ title: string | null }>(
      "SELECT title FROM stories WHERE id = ?",
      [storyId],
    );
    expect(row?.title).toBe("ORIGINAL");
  });
});
