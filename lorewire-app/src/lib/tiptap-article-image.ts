// Tiptap node for an article image with alt text and an optional caption.
// Atomic block — Tiptap doesn't editor-render inside it; the React NodeView
// (see ArticleImageView.tsx) handles the on-screen UI (img + alt input +
// caption input + delete). When the editor serializes to JSON the attrs
// round-trip cleanly, and when the reader generates HTML the renderHTML
// below produces a semantic <figure> the public CSS can style.
//
// Why not the StarterKit's plain Image extension? It's inline, alt-only, and
// has no caption. Editorial content needs both alt (accessibility) and
// caption (visual) plus a guard that prevents publishing with missing alt.
// The guard lives in the article publish action; this node just exposes the
// attribute so the guard can read it from the document JSON.

import { Node, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    articleImage: {
      insertArticleImage: (attrs: {
        src: string;
        alt?: string;
        caption?: string;
        width?: number | null;
        height?: number | null;
      }) => ReturnType;
    };
  }
}

export interface ArticleImageAttrs {
  src: string;
  alt: string;
  caption: string;
  width: number | null;
  height: number | null;
}

export const ArticleImage = Node.create({
  name: "articleImage",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: {
        default: "",
        parseHTML: (el: HTMLElement) =>
          el.querySelector("img")?.getAttribute("src") ?? "",
      },
      alt: {
        default: "",
        parseHTML: (el: HTMLElement) =>
          el.querySelector("img")?.getAttribute("alt") ?? "",
      },
      caption: {
        default: "",
        parseHTML: (el: HTMLElement) =>
          el.querySelector("figcaption")?.textContent ?? "",
      },
      width: {
        default: null as number | null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.querySelector("img")?.getAttribute("width");
          if (!raw) return null;
          const n = Number(raw);
          return Number.isFinite(n) ? n : null;
        },
      },
      height: {
        default: null as number | null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.querySelector("img")?.getAttribute("height");
          if (!raw) return null;
          const n = Number(raw);
          return Number.isFinite(n) ? n : null;
        },
      },
    };
  },

  parseHTML() {
    // Parse our own emitted shape (figure[data-article-image]) and the bare
    // <img> shape that copy-paste or a sloppy Sheets import might produce.
    // The bare-img branch picks up the src/alt attrs via the per-attribute
    // parseHTMLs above; caption stays empty.
    return [
      { tag: "figure[data-article-image]" },
      { tag: "img[src]:not([data-article-image] img)" },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    const src = node.attrs.src as string;
    const alt = (node.attrs.alt as string) ?? "";
    const caption = (node.attrs.caption as string) ?? "";
    const width = node.attrs.width as number | null;
    const height = node.attrs.height as number | null;
    const imgAttrs: Record<string, string | number> = { src, alt };
    if (width) imgAttrs.width = width;
    if (height) imgAttrs.height = height;
    const figureAttrs = mergeAttributes(HTMLAttributes, {
      "data-article-image": "",
    });
    if (caption) {
      return [
        "figure",
        figureAttrs,
        ["img", imgAttrs],
        ["figcaption", {}, caption],
      ];
    }
    return ["figure", figureAttrs, ["img", imgAttrs]];
  },

  addCommands() {
    return {
      insertArticleImage:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              src: attrs.src,
              alt: attrs.alt ?? "",
              caption: attrs.caption ?? "",
              width: attrs.width ?? null,
              height: attrs.height ?? null,
            },
          }),
    };
  },
});

// Walks a Tiptap JSON document and returns the count of articleImage nodes
// that are missing alt text. Used by the article publish action to refuse a
// publish when any image is inaccessible — the editor surfaces the count so
// the writer knows what to fix. Returns 0 when document is null / unparseable.
export function countImagesMissingAlt(document: unknown): number {
  if (!document || typeof document !== "object") return 0;
  let count = 0;
  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: unknown; attrs?: unknown; content?: unknown };
    if (n.type === "articleImage") {
      const attrs = (n.attrs ?? {}) as { alt?: unknown };
      const alt = typeof attrs.alt === "string" ? attrs.alt.trim() : "";
      if (!alt) count++;
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child);
    }
  }
  walk(document);
  return count;
}

// Like countImagesMissingAlt but counts ALL articleImage nodes. Used by
// the asset re-render UI to estimate the cost of regenerating every body
// image at once. Returns 0 when document is null / unparseable.
export function countArticleImages(document: unknown): number {
  if (!document || typeof document !== "object") return 0;
  let count = 0;
  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: unknown; content?: unknown };
    if (n.type === "articleImage") count++;
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child);
    }
  }
  walk(document);
  return count;
}
