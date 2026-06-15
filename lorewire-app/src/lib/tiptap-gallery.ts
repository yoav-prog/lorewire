// Tiptap Gallery node. Holds 1..N images with the same alt + caption shape
// as ArticleImage. Renders as <figure data-article-gallery> with one inner
// <figure data-article-image> per image, so the public reader's CSS can
// style galleries (grid, slider, side-by-side) without forking the image
// styling. The editor-side NodeView lives in the article editor folder;
// this spec is React-free so the public renderer can register it.

import { Node, mergeAttributes } from "@tiptap/core";

export interface GalleryItem {
  src: string;
  alt: string;
  caption: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    articleGallery: {
      insertArticleGallery: (attrs: { items: GalleryItem[] }) => ReturnType;
    };
  }
}

function safeItems(raw: unknown): GalleryItem[] {
  if (!Array.isArray(raw)) return [];
  const out: GalleryItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const it = item as { src?: unknown; alt?: unknown; caption?: unknown };
    out.push({
      src: typeof it.src === "string" ? it.src : "",
      alt: typeof it.alt === "string" ? it.alt : "",
      caption: typeof it.caption === "string" ? it.caption : "",
    });
  }
  return out;
}

export const ArticleGallery = Node.create({
  name: "articleGallery",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      items: {
        default: [] as GalleryItem[],
        // Items live in the JSON attrs as an array. parseHTML reads the
        // nested <figure data-article-image> children we emit so a stored
        // gallery round-trips even if the editor's NodeView is unavailable.
        parseHTML: (el: HTMLElement) => {
          const inner = el.querySelectorAll(
            "figure[data-article-image] img",
          );
          const items: GalleryItem[] = [];
          inner.forEach((img) => {
            const figure = img.closest("figure");
            const caption =
              figure?.querySelector("figcaption")?.textContent ?? "";
            items.push({
              src: img.getAttribute("src") ?? "",
              alt: img.getAttribute("alt") ?? "",
              caption,
            });
          });
          return items;
        },
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "figure[data-article-gallery]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const items = safeItems(node.attrs.items);
    const figureAttrs = mergeAttributes(HTMLAttributes, {
      "data-article-gallery": "",
      "data-count": String(items.length),
    });
    // Render each item as an inner <figure data-article-image> so the
    // CSS the reader already ships for image blocks applies here too —
    // a gallery becomes a grid of styled image blocks.
    const children = items.map((item) => {
      const imgAttrs: Record<string, string> = { src: item.src, alt: item.alt };
      const inner: unknown[] = [
        "figure",
        { "data-article-image": "" },
        ["img", imgAttrs],
      ];
      if (item.caption) inner.push(["figcaption", {}, item.caption]);
      return inner;
    });
    return ["figure", figureAttrs, ...children];
  },

  addCommands() {
    return {
      insertArticleGallery:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { items: safeItems(attrs.items) },
          }),
    };
  },
});

// Used by the publish guard: count gallery images that are missing alt
// text so the same enforcement that covers ArticleImage covers galleries.
export function countGalleryImagesMissingAlt(document: unknown): number {
  if (!document || typeof document !== "object") return 0;
  let count = 0;
  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: unknown; attrs?: unknown; content?: unknown };
    if (n.type === "articleGallery") {
      const items = safeItems((n.attrs as { items?: unknown } | undefined)?.items);
      for (const it of items) {
        if (!it.alt.trim()) count++;
      }
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child);
    }
  }
  walk(document);
  return count;
}

// Slim view of a single gallery item, exposed for the asset-regen UI.
// `index` is the flat position across every gallery in document order so
// the regen UI's "gallery:N" slug targets the right item regardless of
// which gallery node it lives in.
export interface GalleryItemSummary {
  index: number;
  src: string;
  alt: string;
  caption: string;
}

export function listGalleryItems(
  document: unknown,
): GalleryItemSummary[] {
  if (!document || typeof document !== "object") return [];
  const out: GalleryItemSummary[] = [];
  let idx = 0;
  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: unknown; attrs?: unknown; content?: unknown };
    if (n.type === "articleGallery") {
      const items = safeItems((n.attrs as { items?: unknown } | undefined)?.items);
      for (const it of items) {
        out.push({
          index: idx,
          src: it.src,
          alt: it.alt,
          caption: it.caption,
        });
        idx++;
      }
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child);
    }
  }
  walk(document);
  return out;
}

// Append a new image to the document's gallery. If the document already has
// at least one `articleGallery` node, the item is appended to the LAST one
// so repeated "Add to gallery" clicks collect into a single block rather than
// scattering single-item galleries. Otherwise a fresh gallery node is
// appended to the top-level `content` array. Pure: returns a new document
// shape; never mutates the input. Returns the input unchanged when it is
// not a valid Tiptap doc (null, non-object, missing top-level array).
//
// Used by the article editor's "Add to gallery" action when promoting a
// short scene frame into the article body.
export function appendArticleGalleryItem(
  document: unknown,
  item: GalleryItem,
): unknown {
  if (!document || typeof document !== "object") return document;
  const doc = document as { type?: unknown; content?: unknown };
  if (!Array.isArray(doc.content)) return document;
  // Walk top-level content for the LAST articleGallery node — the editor
  // mounts gallery nodes at the top level (atomic block group=block), so a
  // shallow scan is sufficient. Deeper nested galleries would need a
  // recursive walk; we deliberately do not insert into nested contexts
  // because the schema does not allow it.
  let lastGalleryIdx = -1;
  for (let i = doc.content.length - 1; i >= 0; i--) {
    const child = doc.content[i] as { type?: unknown } | null;
    if (child && (child as { type?: unknown }).type === "articleGallery") {
      lastGalleryIdx = i;
      break;
    }
  }
  const sanitized: GalleryItem = {
    src: item.src,
    alt: item.alt ?? "",
    caption: item.caption ?? "",
  };
  const nextContent = [...doc.content];
  if (lastGalleryIdx >= 0) {
    const target = nextContent[lastGalleryIdx] as {
      type: string;
      attrs?: { items?: unknown };
    };
    const items = safeItems(target.attrs?.items);
    nextContent[lastGalleryIdx] = {
      ...target,
      attrs: { ...(target.attrs ?? {}), items: [...items, sanitized] },
    };
  } else {
    nextContent.push({
      type: "articleGallery",
      attrs: { items: [sanitized] },
    });
  }
  return { ...doc, content: nextContent };
}

// Like countGalleryImagesMissingAlt but counts ALL items across every
// gallery node. Used by the asset re-render UI to estimate the cost of
// regenerating every gallery image. Returns 0 when document is null or
// unparseable.
export function countGalleryImages(document: unknown): number {
  if (!document || typeof document !== "object") return 0;
  let count = 0;
  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: unknown; attrs?: unknown; content?: unknown };
    if (n.type === "articleGallery") {
      const items = safeItems((n.attrs as { items?: unknown } | undefined)?.items);
      count += items.length;
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child);
    }
  }
  walk(document);
  return count;
}
