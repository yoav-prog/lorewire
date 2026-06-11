// Tests for countImagesMissingAlt — the publish guard the action layer reads
// when transitioning an article to status='published'. Walks the Tiptap JSON
// document tree counting articleImage nodes whose alt attribute is missing
// or whitespace-only. Pure function, no DB.

import { describe, expect, it } from "vitest";
import { countImagesMissingAlt } from "@/lib/tiptap-article-image";

function img(alt: string | undefined, src = "https://cdn/example.png") {
  return {
    type: "articleImage",
    attrs: { src, alt: alt ?? "", caption: "" },
  };
}

function para(text: string) {
  return {
    type: "paragraph",
    content: [{ type: "text", text }],
  };
}

function doc(content: unknown[]) {
  return { type: "doc", content };
}

describe("countImagesMissingAlt", () => {
  it("returns 0 for an empty document", () => {
    expect(countImagesMissingAlt(doc([]))).toBe(0);
  });

  it("returns 0 when document is null or non-object", () => {
    expect(countImagesMissingAlt(null)).toBe(0);
    expect(countImagesMissingAlt(undefined)).toBe(0);
    expect(countImagesMissingAlt("not a doc")).toBe(0);
    expect(countImagesMissingAlt(42)).toBe(0);
  });

  it("returns 0 when every image has alt text", () => {
    expect(
      countImagesMissingAlt(
        doc([para("intro"), img("a cat"), para("middle"), img("a dog")]),
      ),
    ).toBe(0);
  });

  it("counts images with empty alt", () => {
    expect(
      countImagesMissingAlt(doc([img(""), img("ok"), img("")])),
    ).toBe(2);
  });

  it("treats whitespace-only alt as missing", () => {
    expect(
      countImagesMissingAlt(doc([img("   "), img("\t\n"), img("ok")])),
    ).toBe(2);
  });

  it("walks nested content (callouts, lists, blockquotes)", () => {
    const nested = doc([
      {
        type: "callout",
        attrs: { tone: "info" },
        content: [
          para("inside the callout"),
          img(""),
        ],
      },
      {
        type: "blockquote",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "quoted",
              },
            ],
          },
        ],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              para("item"),
              img("alt-present"),
              img(""),
            ],
          },
        ],
      },
    ]);
    expect(countImagesMissingAlt(nested)).toBe(2);
  });

  it("ignores missing alt on non-articleImage nodes", () => {
    const docWithStarterImage = doc([
      // The StarterKit's plain Image extension is a different node; the
      // guard does not apply to it. (We don't ship StarterKit Image in the
      // editor, but if a Sheets-imported article carries one we don't want
      // to block publish on it.)
      { type: "image", attrs: { src: "x", alt: "" } },
      img(""),
    ]);
    expect(countImagesMissingAlt(docWithStarterImage)).toBe(1);
  });
});
