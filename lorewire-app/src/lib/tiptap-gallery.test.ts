// Tests for the pure helpers on tiptap-gallery (no DB, no React). The Tiptap
// Node spec itself is exercised by the editor + public reader integration
// tests in a wider suite; here we lock down the document-shape mutators that
// the article-media bridge depends on (appendArticleGalleryItem) plus the
// existing scanners (countGalleryImagesMissingAlt, listGalleryItems,
// countGalleryImages) so a future schema tweak to the gallery node can't
// silently break the bridge.

import { describe, expect, it } from "vitest";
import {
  appendArticleGalleryItem,
  countGalleryImages,
  countGalleryImagesMissingAlt,
  listGalleryItems,
} from "@/lib/tiptap-gallery";

function emptyDoc(): unknown {
  return { type: "doc", content: [] };
}

function docWithParagraph(text: string): unknown {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text }] },
    ],
  };
}

function docWithGallery(
  items: Array<{ src: string; alt: string; caption: string }>,
): unknown {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Lead" }] },
      { type: "articleGallery", attrs: { items } },
    ],
  };
}

describe("appendArticleGalleryItem", () => {
  it("appends to the last existing articleGallery node", () => {
    const doc = docWithGallery([
      { src: "/a.png", alt: "A", caption: "" },
    ]);
    const next = appendArticleGalleryItem(doc, {
      src: "/b.png",
      alt: "B",
      caption: "",
    }) as { content: Array<{ type: string; attrs?: { items: unknown[] } }> };
    const gallery = next.content[1];
    expect(gallery.type).toBe("articleGallery");
    expect(gallery.attrs?.items).toEqual([
      { src: "/a.png", alt: "A", caption: "" },
      { src: "/b.png", alt: "B", caption: "" },
    ]);
  });

  it("creates a new gallery at the end when the doc has none", () => {
    const doc = docWithParagraph("hello");
    const next = appendArticleGalleryItem(doc, {
      src: "/x.png",
      alt: "X",
      caption: "",
    }) as { content: Array<{ type: string; attrs?: { items: unknown[] } }> };
    expect(next.content).toHaveLength(2);
    expect(next.content[1].type).toBe("articleGallery");
    expect(next.content[1].attrs?.items).toEqual([
      { src: "/x.png", alt: "X", caption: "" },
    ]);
    // Existing content is preserved unchanged.
    expect(next.content[0].type).toBe("paragraph");
  });

  it("appends to the LAST gallery when several are present", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "articleGallery", attrs: { items: [{ src: "/a.png", alt: "A", caption: "" }] } },
        { type: "paragraph", content: [{ type: "text", text: "x" }] },
        { type: "articleGallery", attrs: { items: [{ src: "/b.png", alt: "B", caption: "" }] } },
      ],
    };
    const next = appendArticleGalleryItem(doc, {
      src: "/c.png",
      alt: "C",
      caption: "",
    }) as { content: Array<{ type: string; attrs?: { items: unknown[] } }> };
    // First gallery is untouched.
    expect(next.content[0].attrs?.items).toEqual([
      { src: "/a.png", alt: "A", caption: "" },
    ]);
    // Second gallery got the new item appended.
    expect(next.content[2].attrs?.items).toEqual([
      { src: "/b.png", alt: "B", caption: "" },
      { src: "/c.png", alt: "C", caption: "" },
    ]);
  });

  it("does not mutate the input document", () => {
    const doc = docWithGallery([
      { src: "/a.png", alt: "A", caption: "" },
    ]) as { content: Array<{ type: string; attrs?: { items: unknown[] } }> };
    const before = JSON.stringify(doc);
    appendArticleGalleryItem(doc, {
      src: "/b.png",
      alt: "B",
      caption: "",
    });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("coerces missing alt and caption to empty strings", () => {
    const doc = emptyDoc();
    const next = appendArticleGalleryItem(doc, {
      src: "/only-src.png",
      // @ts-expect-error — testing the runtime coercion of missing fields
      alt: undefined,
      // @ts-expect-error — same
      caption: undefined,
    }) as { content: Array<{ type: string; attrs?: { items: unknown[] } }> };
    expect(next.content[0].attrs?.items).toEqual([
      { src: "/only-src.png", alt: "", caption: "" },
    ]);
  });

  it("returns the input unchanged when given a non-document value", () => {
    expect(appendArticleGalleryItem(null, { src: "/x.png", alt: "", caption: "" })).toBeNull();
    expect(
      appendArticleGalleryItem("not a doc", { src: "/x.png", alt: "", caption: "" }),
    ).toBe("not a doc");
    expect(
      appendArticleGalleryItem({ type: "doc" }, { src: "/x.png", alt: "", caption: "" }),
    ).toEqual({ type: "doc" });
  });
});

// Smoke regressions on the existing scanners. These shipped earlier and have
// no test coverage in this file — adding light coverage here means a future
// refactor of the gallery node attrs shape (a likely place for someone to
// reach into) breaks loudly instead of silently corrupting the publish guard
// (countGalleryImagesMissingAlt) or the asset regen panel (countGalleryImages,
// listGalleryItems).

describe("countGalleryImagesMissingAlt", () => {
  it("counts items with empty alt across all gallery nodes", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "articleGallery",
          attrs: {
            items: [
              { src: "/a.png", alt: "A", caption: "" },
              { src: "/b.png", alt: "", caption: "" },
            ],
          },
        },
        {
          type: "articleGallery",
          attrs: {
            items: [
              { src: "/c.png", alt: "   ", caption: "" },
            ],
          },
        },
      ],
    };
    expect(countGalleryImagesMissingAlt(doc)).toBe(2);
  });

  it("returns 0 when the document has no galleries", () => {
    expect(countGalleryImagesMissingAlt(docWithParagraph("hi"))).toBe(0);
    expect(countGalleryImagesMissingAlt(null)).toBe(0);
  });
});

describe("listGalleryItems / countGalleryImages", () => {
  it("flattens items across galleries in document order", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "articleGallery",
          attrs: { items: [{ src: "/a.png", alt: "A", caption: "" }] },
        },
        { type: "paragraph", content: [{ type: "text", text: "x" }] },
        {
          type: "articleGallery",
          attrs: {
            items: [
              { src: "/b.png", alt: "B", caption: "Bee" },
              { src: "/c.png", alt: "C", caption: "" },
            ],
          },
        },
      ],
    };
    expect(countGalleryImages(doc)).toBe(3);
    const items = listGalleryItems(doc);
    expect(items.map((i) => i.index)).toEqual([0, 1, 2]);
    expect(items.map((i) => i.src)).toEqual(["/a.png", "/b.png", "/c.png"]);
    expect(items[1].caption).toBe("Bee");
  });
});
