// Tests for the TS-side world bible parser. Mirrors the Python
// `parse_world_bible` test coverage so a future change to either
// language has to keep both honest.

import { describe, expect, it } from "vitest";
import {
  leadCharacter,
  MAX_CHARACTERS,
  MAX_ITEMS,
  MAX_LOCATIONS,
  parseWorldBible,
  readWorldBible,
  WORLD_BIBLE_BUILT_WITH,
} from "./world-bible";

const SAMPLE = {
  built_with: WORLD_BIBLE_BUILT_WITH,
  characters: [
    {
      id: "char_aaaa1111",
      name: "Maya",
      role: "lead",
      visual_cues: "30s, dark curly hair, navy cardigan",
      reference_image_url: "https://example.test/maya.png",
    },
    {
      id: "char_bbbb2222",
      name: "Greg",
      role: "supporting",
      visual_cues: "40s, beard",
      reference_image_url: null,
    },
  ],
  sub_characters: [
    {
      id: "sub_cccc3333",
      name: "Security",
      role: "background",
      visual_cues: "uniform",
      reference_image_url: null,
    },
  ],
  locations: [
    {
      id: "loc_dddd4444",
      name: "office",
      visual_cues: "cubicles",
      reference_image_url: null,
    },
  ],
  items: [
    { id: "item_eeee5555", name: "envelope", visual_cues: "manila" },
  ],
};

describe("parseWorldBible", () => {
  it("round-trips a clean bible blob", () => {
    const bible = parseWorldBible(SAMPLE);
    expect(bible).not.toBeNull();
    expect(bible!.built_with).toBe(WORLD_BIBLE_BUILT_WITH);
    expect(bible!.characters).toHaveLength(2);
    expect(bible!.characters[0].name).toBe("Maya");
    expect(bible!.characters[0].reference_image_url).toBe("https://example.test/maya.png");
    expect(bible!.sub_characters).toHaveLength(1);
    expect(bible!.locations).toHaveLength(1);
    expect(bible!.items).toHaveLength(1);
  });

  it("returns null when the marker is wrong", () => {
    // Migration story: a stale narration_v1 cache must NOT render as
    // a bible, otherwise the inspector would show pre-Option-C data.
    const stale = { ...SAMPLE, built_with: "narration_v1" };
    expect(parseWorldBible(stale)).toBeNull();
  });

  it("returns null on non-object input", () => {
    for (const v of ["string", [1, 2], null, 42, undefined]) {
      expect(parseWorldBible(v)).toBeNull();
    }
  });

  it("drops malformed character entries silently", () => {
    const blob = {
      ...SAMPLE,
      characters: [
        SAMPLE.characters[0],
        { id: "x", name: "no cues" },         // missing visual_cues → drop
        { name: "no id", visual_cues: "y" },  // missing id → drop
        SAMPLE.characters[1],
      ],
    };
    const bible = parseWorldBible(blob);
    expect(bible!.characters).toHaveLength(2);
  });

  it("falls through to supporting role when invalid", () => {
    const blob = {
      ...SAMPLE,
      characters: [
        { id: "x", name: "X", role: "antagonist", visual_cues: "y" },
      ],
      sub_characters: [],
      locations: [],
      items: [],
    };
    const bible = parseWorldBible(blob);
    expect(bible!.characters[0].role).toBe("supporting");
  });

  it("enforces the per-bucket caps", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `x_${i}`,
        name: `n${i}`,
        visual_cues: "y",
      }));
    const bible = parseWorldBible({
      ...SAMPLE,
      characters: many(10).map((e) => ({ ...e, role: "supporting" })),
      sub_characters: [],
      locations: many(10),
      items: many(10),
    });
    expect(bible!.characters).toHaveLength(MAX_CHARACTERS);
    expect(bible!.locations).toHaveLength(MAX_LOCATIONS);
    expect(bible!.items).toHaveLength(MAX_ITEMS);
  });

  it("preserves null reference_image_url when ref-gen hasn't run", () => {
    const bible = parseWorldBible(SAMPLE);
    // Greg's ref hasn't been generated yet; the panel should know.
    expect(bible!.characters[1].reference_image_url).toBeNull();
  });
});

describe("readWorldBible", () => {
  // 2026-06-14: bible moved out of video_config into pipeline_cache.
  // The reader is shape-only, so the same JSON works from either
  // column — these tests exercise both the new shape (just a
  // pipeline_cache with world_bible) and the legacy shape (a
  // video_config with the bible alongside editor data) that a story
  // persisted before the migration would have.
  it("parses out of a pipeline_cache JSON string", () => {
    const cache = JSON.stringify({ world_bible: SAMPLE });
    const bible = readWorldBible(cache);
    expect(bible).not.toBeNull();
    expect(bible!.characters[0].name).toBe("Maya");
  });

  it("parses out of a legacy video_config JSON string (transition shape)", () => {
    const config = JSON.stringify({ world_bible: SAMPLE, scene_prompts: [] });
    const bible = readWorldBible(config);
    expect(bible).not.toBeNull();
    expect(bible!.characters[0].name).toBe("Maya");
  });

  it("returns null when the source JSON is missing or empty", () => {
    expect(readWorldBible(null)).toBeNull();
    expect(readWorldBible(undefined)).toBeNull();
    expect(readWorldBible("")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(readWorldBible("{not json")).toBeNull();
  });

  it("returns null when the bible key is missing", () => {
    expect(readWorldBible(JSON.stringify({ scene_prompts: [] }))).toBeNull();
  });
});

describe("leadCharacter", () => {
  it("returns the marked lead", () => {
    const bible = parseWorldBible(SAMPLE);
    expect(leadCharacter(bible)!.name).toBe("Maya");
  });

  it("falls back to the first character when no lead marked", () => {
    const blob = {
      ...SAMPLE,
      characters: [
        { ...SAMPLE.characters[0], role: "supporting" },
        SAMPLE.characters[1],
      ],
    };
    const bible = parseWorldBible(blob);
    expect(leadCharacter(bible)!.name).toBe("Maya");
  });

  it("returns null on an empty bible", () => {
    expect(leadCharacter(null)).toBeNull();
    const empty = parseWorldBible({
      built_with: WORLD_BIBLE_BUILT_WITH,
      characters: [],
      sub_characters: [],
      locations: [],
      items: [],
    });
    expect(leadCharacter(empty)).toBeNull();
  });
});
