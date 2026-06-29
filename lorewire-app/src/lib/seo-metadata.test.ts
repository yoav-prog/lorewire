// Tests for lib/seo-metadata.
//
// Coverage:
//   - pure: isStale (no generated_at → stale, story newer than gen → stale,
//           story older than gen → fresh)
//   - pure: SeoMetadataSchema rejects malformed shapes (missing platforms,
//           too-long youtube title, empty caption, too few tags)
//   - pure: systemPrompt + userPrompt include the expected pieces
//   - happy path: load → save → load round-trip persists exactly
//   - load of NULL column returns null (no parse errors thrown)
//   - load of malformed JSON returns null (no parse errors thrown)

import { beforeEach, describe, expect, it } from "vitest";
import { run } from "@/lib/db";
import {
  DEFAULT_MODEL,
  isStale,
  loadSeoMetadata,
  saveSeoMetadata,
  SeoMetadataSchema,
  systemPrompt,
  userPrompt,
  type SeoMetadata,
} from "@/lib/seo-metadata";

const FIXTURE: SeoMetadata = {
  youtube: {
    title: "He Found $5,000 In A Wallet",
    description:
      "Mike sat down on the bus and felt something hard. It was a wallet stuffed with $5,000 — and a photograph that changed everything. Watch the full story.\n\n#Shorts #InternetStories #TrueStory #DramaShorts #Reddit",
    tags: [
      "lost wallet",
      "moral dilemma",
      "honest stranger",
      "good samaritan",
      "found money",
      "reddit storytime",
    ],
  },
  tiktok: {
    caption:
      "wait til you hear what he did with the wallet 💀 #Shorts #LostWalletStory #MoralDilemma #RedditStorytime",
  },
  facebook: {
    caption:
      "Mike found $5,000 in a wallet on the bus seat. The photo inside changed his entire decision. Read the full story.",
  },
  instagram: {
    caption:
      "Mike found $5,000 in a wallet on the bus seat. The photo inside changed his entire decision. #Shorts #InternetStories #TrueStory",
  },
};

beforeEach(async () => {
  await run("DELETE FROM stories WHERE id LIKE 'seo-test-%'", []);
});

// --- Pure: isStale ---------------------------------------------------------

describe("isStale", () => {
  it("returns true when generated_at is null (never generated)", () => {
    expect(isStale(null, "2026-06-24T10:00:00Z")).toBe(true);
  });

  it("returns true when the story was updated after metadata generation", () => {
    expect(
      isStale("2026-06-24T10:00:00Z", "2026-06-24T11:00:00Z"),
    ).toBe(true);
  });

  it("returns false when metadata was generated after the last story update", () => {
    expect(
      isStale("2026-06-24T11:00:00Z", "2026-06-24T10:00:00Z"),
    ).toBe(false);
  });

  it("treats unparseable timestamps as stale (safer than skipping)", () => {
    expect(isStale("not-a-date", "2026-06-24T10:00:00Z")).toBe(true);
    expect(isStale("2026-06-24T10:00:00Z", "garbage")).toBe(true);
  });
});

// --- Pure: SeoMetadataSchema ----------------------------------------------

describe("SeoMetadataSchema", () => {
  it("accepts a well-formed fixture", () => {
    expect(SeoMetadataSchema.safeParse(FIXTURE).success).toBe(true);
  });

  it("rejects when youtube.title exceeds 100 chars", () => {
    const bad = {
      ...FIXTURE,
      youtube: { ...FIXTURE.youtube, title: "x".repeat(101) },
    };
    expect(SeoMetadataSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects when tiktok.caption is empty", () => {
    const bad = { ...FIXTURE, tiktok: { caption: "" } };
    expect(SeoMetadataSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects when youtube.tags has fewer than 3 entries", () => {
    const bad = {
      ...FIXTURE,
      youtube: { ...FIXTURE.youtube, tags: ["only", "two"] },
    };
    expect(SeoMetadataSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects when a platform key is missing", () => {
    const bad = { youtube: FIXTURE.youtube, tiktok: FIXTURE.tiktok };
    expect(SeoMetadataSchema.safeParse(bad).success).toBe(false);
  });
});

// --- Pure: prompt builders ------------------------------------------------

describe("prompt builders", () => {
  it("system prompt mentions every platform + the JSON-only rule", () => {
    const s = systemPrompt();
    expect(s).toContain("YouTube");
    expect(s).toContain("TikTok");
    expect(s).toContain("Facebook");
    expect(s).toContain("Instagram");
    expect(s).toContain("ONLY valid JSON");
  });

  it("user prompt includes title, category, article URL, and narration", () => {
    const u = userPrompt({
      title: "Bus Mystery",
      category: "Drama",
      teleprompter: "He sat down and felt a wallet.",
      articleUrl: "https://www.lorewire.com/stories/bus-mystery",
    });
    expect(u).toContain("Bus Mystery");
    expect(u).toContain("Drama");
    expect(u).toContain("He sat down and felt a wallet.");
    expect(u).toContain("https://www.lorewire.com/stories/bus-mystery");
  });
});

// --- DB I/O round-trip ----------------------------------------------------

describe("loadSeoMetadata + saveSeoMetadata", () => {
  it("saves then loads identical metadata for the same story", async () => {
    const storyId = "seo-test-roundtrip-1";
    await run(
      `INSERT INTO stories (id, title, status, created_at, updated_at)
       VALUES (?, ?, 'draft', ?, ?)`,
      [storyId, "Bus Mystery", new Date().toISOString(), new Date().toISOString()],
    );
    await saveSeoMetadata(storyId, FIXTURE);
    const loaded = await loadSeoMetadata(storyId);
    expect(loaded).toEqual(FIXTURE);
  });

  it("returns null when the story has no metadata yet", async () => {
    const storyId = "seo-test-empty-1";
    await run(
      `INSERT INTO stories (id, title, status, created_at, updated_at)
       VALUES (?, ?, 'draft', ?, ?)`,
      [storyId, "x", new Date().toISOString(), new Date().toISOString()],
    );
    expect(await loadSeoMetadata(storyId)).toBeNull();
  });

  it("returns null when the stored JSON is malformed (doesn't throw)", async () => {
    const storyId = "seo-test-malformed-1";
    await run(
      `INSERT INTO stories (id, title, status, created_at, updated_at, seo_metadata_json)
       VALUES (?, ?, 'draft', ?, ?, ?)`,
      [
        storyId,
        "x",
        new Date().toISOString(),
        new Date().toISOString(),
        "{not valid json",
      ],
    );
    expect(await loadSeoMetadata(storyId)).toBeNull();
  });

  it("returns null when stored JSON parses but fails schema validation", async () => {
    const storyId = "seo-test-schema-fail-1";
    await run(
      `INSERT INTO stories (id, title, status, created_at, updated_at, seo_metadata_json)
       VALUES (?, ?, 'draft', ?, ?, ?)`,
      [
        storyId,
        "x",
        new Date().toISOString(),
        new Date().toISOString(),
        JSON.stringify({ youtube: { title: "ok" } }), // missing required fields
      ],
    );
    expect(await loadSeoMetadata(storyId)).toBeNull();
  });
});

// --- Default model sanity check ------------------------------------------

describe("DEFAULT_MODEL", () => {
  it("points at a kie.ai model with an OpenAI-compatible chat completions endpoint", () => {
    // kie.ai's gemini-3-5-flash only exposes Google-native
    // streamGenerateContent, not chat completions, so the default
    // landed on gemini-3-pro instead. See seo-metadata.ts for the
    // full reasoning.
    expect(DEFAULT_MODEL).toBe("kie/gemini-3-pro");
  });
});
