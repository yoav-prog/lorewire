// Tests for the server-side Tiptap renderer. We assert the load-bearing
// shape — opening tag, attrs, presence of custom block markup — rather
// than the full string, so a Tiptap version bump that changes attribute
// ordering doesn't churn the suite.

import { describe, expect, it } from "vitest";
import { renderArticleHtml } from "@/lib/article-html";

function doc(content: unknown[]) {
  return JSON.stringify({ type: "doc", content });
}

describe("renderArticleHtml / fallbacks", () => {
  it("returns the empty-doc HTML for null / undefined / empty input", () => {
    const empty = renderArticleHtml(null);
    expect(empty).toContain("<p>");
    expect(empty).toBe(renderArticleHtml(undefined));
    expect(empty).toBe(renderArticleHtml(""));
  });

  it("returns the empty-doc HTML for unparseable JSON", () => {
    const a = renderArticleHtml("not-json");
    const b = renderArticleHtml(null);
    expect(a).toBe(b);
  });

  it("returns the empty-doc HTML for non-object JSON", () => {
    const a = renderArticleHtml("42");
    const b = renderArticleHtml(null);
    expect(a).toBe(b);
  });
});

describe("renderArticleHtml / StarterKit nodes", () => {
  it("renders paragraphs and inline text", () => {
    const html = renderArticleHtml(
      doc([
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello, reader." }],
        },
      ]),
    );
    expect(html).toContain("<p>Hello, reader.</p>");
  });

  it("renders headings at the right level", () => {
    const html = renderArticleHtml(
      doc([
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Section" }],
        },
      ]),
    );
    expect(html).toMatch(/<h2[^>]*>Section<\/h2>/);
  });

  it("renders bullet lists with list items", () => {
    const html = renderArticleHtml(
      doc([
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "one" }],
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>");
    expect(html).toContain("one");
  });
});

describe("renderArticleHtml / Callout custom block", () => {
  it("renders aside with data-callout and the right tone", () => {
    const html = renderArticleHtml(
      doc([
        {
          type: "callout",
          attrs: { tone: "warning" },
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "watch out" }],
            },
          ],
        },
      ]),
    );
    expect(html).toContain("<aside");
    expect(html).toContain('data-callout=""');
    expect(html).toContain('data-tone="warning"');
    expect(html).toContain("watch out");
  });

  it("defaults to info when tone is missing", () => {
    const html = renderArticleHtml(
      doc([
        {
          type: "callout",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "hi" }],
            },
          ],
        },
      ]),
    );
    expect(html).toContain('data-tone="info"');
  });
});

describe("renderArticleHtml / ArticleImage custom block", () => {
  it("renders figure with img attrs and figcaption when caption is set", () => {
    const html = renderArticleHtml(
      doc([
        {
          type: "articleImage",
          attrs: {
            src: "https://cdn/example.png",
            alt: "An example",
            caption: "Photo by author",
          },
        },
      ]),
    );
    expect(html).toContain("<figure");
    expect(html).toContain('data-article-image=""');
    expect(html).toContain('src="https://cdn/example.png"');
    expect(html).toContain('alt="An example"');
    expect(html).toContain("<figcaption>Photo by author</figcaption>");
  });

  it("omits figcaption when caption is empty", () => {
    const html = renderArticleHtml(
      doc([
        {
          type: "articleImage",
          attrs: {
            src: "https://cdn/example.png",
            alt: "Alt",
            caption: "",
          },
        },
      ]),
    );
    expect(html).not.toContain("<figcaption");
  });
});

describe("renderArticleHtml / Hebrew RTL passthrough", () => {
  it("preserves Hebrew text in the output", () => {
    const html = renderArticleHtml(
      doc([
        {
          type: "paragraph",
          content: [{ type: "text", text: "שלום עולם" }],
        },
      ]),
    );
    expect(html).toContain("שלום עולם");
  });
});
