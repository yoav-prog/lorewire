// Tiptap Comparison node — a two-column "this vs that" block. Atomic so
// the side bodies are simple string attributes (not nested editable
// content), which keeps the JSON shape compact and makes diff / render /
// publish guards trivial to reason about. If a writer needs rich content
// per side later, we can upgrade to a content-bearing node with two
// labeled slots — but Phase 5's editorial demand is "left vs right with
// titles + short bodies," which strings cover cleanly.

import { Node, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    articleComparison: {
      insertArticleComparison: (attrs?: {
        leftLabel?: string;
        leftBody?: string;
        rightLabel?: string;
        rightBody?: string;
      }) => ReturnType;
    };
  }
}

function attrString(el: HTMLElement, name: string): string {
  const v = el.getAttribute(name);
  return v ?? "";
}

export const ArticleComparison = Node.create({
  name: "articleComparison",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      leftLabel: {
        default: "",
        parseHTML: (el: HTMLElement) => attrString(el, "data-left-label"),
      },
      leftBody: {
        default: "",
        parseHTML: (el: HTMLElement) => attrString(el, "data-left-body"),
      },
      rightLabel: {
        default: "",
        parseHTML: (el: HTMLElement) => attrString(el, "data-right-label"),
      },
      rightBody: {
        default: "",
        parseHTML: (el: HTMLElement) => attrString(el, "data-right-body"),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-article-comparison]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const left = {
      label: String(node.attrs.leftLabel ?? "").trim(),
      body: String(node.attrs.leftBody ?? "").trim(),
    };
    const right = {
      label: String(node.attrs.rightLabel ?? "").trim(),
      body: String(node.attrs.rightBody ?? "").trim(),
    };
    const wrap = mergeAttributes(HTMLAttributes, {
      "data-article-comparison": "",
      "data-left-label": left.label,
      "data-left-body": left.body,
      "data-right-label": right.label,
      "data-right-body": right.body,
    });
    return [
      "div",
      wrap,
      [
        "div",
        { "data-side": "left" },
        ["h4", { "data-comparison-label": "" }, left.label || "Left"],
        ["p", { "data-comparison-body": "" }, left.body],
      ],
      [
        "div",
        { "data-side": "right" },
        ["h4", { "data-comparison-label": "" }, right.label || "Right"],
        ["p", { "data-comparison-body": "" }, right.body],
      ],
    ];
  },

  addCommands() {
    return {
      insertArticleComparison:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              leftLabel: attrs?.leftLabel ?? "",
              leftBody: attrs?.leftBody ?? "",
              rightLabel: attrs?.rightLabel ?? "",
              rightBody: attrs?.rightBody ?? "",
            },
          }),
    };
  },
});
