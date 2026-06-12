// Tests for the per-story caption style resolver. The inheritance chain
// (story → category → global → defaults) is the load-bearing contract
// here — a regression that swaps tier priority means the public reader
// and the live preview both lie about effective values.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { run } from "@/lib/db";
import { setSetting } from "@/lib/repo";
import {
  CAPTION_DEFAULTS,
  CAPTION_STYLE_FIELDS,
  resolveCaptionStyle,
  toPreview,
} from "@/lib/caption-style";

async function clearCaptionSettings(): Promise<void> {
  await run("DELETE FROM settings WHERE key LIKE 'caption.%'", []);
}

beforeAll(async () => {
  // Warm the schema.
  await resolveCaptionStyle({ storyId: "warm", category: null });
});

beforeEach(async () => {
  await clearCaptionSettings();
});

describe("resolveCaptionStyle: defaults", () => {
  it("returns the built-in defaults when nothing is persisted", async () => {
    const r = await resolveCaptionStyle({ storyId: "s1", category: "Drama" });
    for (const bare of CAPTION_STYLE_FIELDS) {
      expect(r.fields[bare].effective).toBe(CAPTION_DEFAULTS[bare]);
      expect(r.fields[bare].source).toBe("default");
      expect(r.fields[bare].storyOverride).toBeNull();
    }
  });
});

describe("resolveCaptionStyle: inheritance chain", () => {
  it("global setting wins over default", async () => {
    await setSetting("caption.color", "#abcdef");
    const r = await resolveCaptionStyle({ storyId: "s1", category: "Drama" });
    expect(r.fields.color.effective).toBe("#abcdef");
    expect(r.fields.color.source).toBe("global");
    expect(r.fields.color.storyOverride).toBeNull();
  });

  it("category setting wins over global", async () => {
    await setSetting("caption.color", "#aaaaaa");
    await setSetting("caption.cat.Drama.color", "#bbbbbb");
    const r = await resolveCaptionStyle({ storyId: "s1", category: "Drama" });
    expect(r.fields.color.effective).toBe("#bbbbbb");
    expect(r.fields.color.source).toBe("category");
  });

  it("category setting is ignored when story has no category", async () => {
    await setSetting("caption.color", "#aaaaaa");
    await setSetting("caption.cat.Drama.color", "#bbbbbb");
    const r = await resolveCaptionStyle({ storyId: "s1", category: null });
    expect(r.fields.color.effective).toBe("#aaaaaa");
    expect(r.fields.color.source).toBe("global");
  });

  it("per-story override wins over everything", async () => {
    await setSetting("caption.color", "#aaaaaa");
    await setSetting("caption.cat.Drama.color", "#bbbbbb");
    await setSetting("caption.story.s1.color", "#cccccc");
    const r = await resolveCaptionStyle({ storyId: "s1", category: "Drama" });
    expect(r.fields.color.effective).toBe("#cccccc");
    expect(r.fields.color.source).toBe("story");
    expect(r.fields.color.storyOverride).toBe("#cccccc");
  });

  it("a different story's override does NOT leak across", async () => {
    await setSetting("caption.story.other-story.color", "#other");
    const r = await resolveCaptionStyle({ storyId: "s1", category: "Drama" });
    expect(r.fields.color.source).toBe("default");
  });

  it("inheritedFromParent ignores the per-story override", async () => {
    // Story override is set; inheritedFromParent should report what the
    // field WOULD become if cleared — i.e., the category or global value.
    await setSetting("caption.color", "#global");
    await setSetting("caption.cat.Drama.color", "#cat");
    await setSetting("caption.story.s1.color", "#story");
    const r = await resolveCaptionStyle({ storyId: "s1", category: "Drama" });
    expect(r.fields.color.inheritedFromParent).toBe("#cat");
  });

  it("whitespace-only persisted values fall through", async () => {
    await setSetting("caption.story.s1.color", "   ");
    await setSetting("caption.cat.Drama.color", "#cat");
    const r = await resolveCaptionStyle({ storyId: "s1", category: "Drama" });
    expect(r.fields.color.source).toBe("category");
    expect(r.fields.color.effective).toBe("#cat");
  });
});

describe("toPreview", () => {
  it("coerces numeric fields and validates enums", async () => {
    const r = await resolveCaptionStyle({ storyId: "s1", category: null });
    const p = toPreview(r);
    expect(typeof p.position_y).toBe("number");
    expect(typeof p.size_scale).toBe("number");
    expect(typeof p.padding_x).toBe("number");
    expect(typeof p.font_weight).toBe("number");
    expect(["uppercase", "none", "lowercase"]).toContain(p.text_transform);
    expect(["none", "fade", "pop", "slide-up"]).toContain(p.entry_effect);
    expect(["none", "karaoke", "color", "scale", "background"]).toContain(
      p.word_highlight,
    );
  });

  it("falls back to safe defaults when persisted values are garbage", async () => {
    await setSetting("caption.story.s1.position_y", "not-a-number");
    await setSetting("caption.story.s1.text_transform", "italic"); // not in the allowed set
    const r = await resolveCaptionStyle({ storyId: "s1", category: null });
    const p = toPreview(r);
    expect(p.position_y).toBe(0.55);
    expect(p.text_transform).toBe("uppercase");
  });

  it("respects valid story overrides", async () => {
    await setSetting("caption.story.s1.position_y", "0.8");
    await setSetting("caption.story.s1.size_scale", "1.5");
    await setSetting("caption.story.s1.text_transform", "lowercase");
    const r = await resolveCaptionStyle({ storyId: "s1", category: null });
    const p = toPreview(r);
    expect(p.position_y).toBe(0.8);
    expect(p.size_scale).toBe(1.5);
    expect(p.text_transform).toBe("lowercase");
  });
});
