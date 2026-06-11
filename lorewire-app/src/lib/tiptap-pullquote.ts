// Tiptap pull-quote. A content-bearing block that wraps inline text plus
// an optional attribution attribute (the "— Person, role" line shown
// underneath). We keep the text editable inline so the writer can format
// the quote like any other paragraph; attribution is a node attribute
// edited through the NodeView's small input.
//
// Why not a styled <blockquote>? Tiptap's StarterKit already ships
// Blockquote, which is for inline-document quotations inside the body.
// Pull-quote is a layout element pulled OUT of the body — bigger,
// centered, often with a horizontal rule. Keeping it a separate node
// lets the reader CSS style each variant distinctly.

import { Node, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pullQuote: {
      setPullQuote: () => ReturnType;
      unsetPullQuote: () => ReturnType;
      updatePullQuoteAttribution: (attribution: string) => ReturnType;
    };
  }
}

export const PullQuote = Node.create({
  name: "pullQuote",
  group: "block",
  // `inline+` lets the quote hold the inline text the writer types but
  // refuses block children (no nested lists or headings inside a pull-
  // quote, which keeps the layout clean).
  content: "inline+",
  defining: true,

  addAttributes() {
    return {
      attribution: {
        default: "",
        parseHTML: (el: HTMLElement) =>
          el.querySelector("cite")?.textContent ?? "",
      },
    };
  },

  parseHTML() {
    return [{ tag: "blockquote[data-pullquote]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const attribution = String(node.attrs.attribution ?? "").trim();
    const blockquoteAttrs = mergeAttributes(HTMLAttributes, {
      "data-pullquote": "",
    });
    if (attribution) {
      // ProseMirror's nesting model: the editable hole (0) goes in a
      // child <p> so generateHTML wraps the inline content correctly,
      // then a <cite> sibling carries the attribution.
      return [
        "blockquote",
        blockquoteAttrs,
        ["p", {}, 0],
        ["cite", {}, attribution],
      ];
    }
    return ["blockquote", blockquoteAttrs, ["p", {}, 0]];
  },

  addCommands() {
    return {
      setPullQuote:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
      unsetPullQuote:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
      updatePullQuoteAttribution:
        (attribution) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { attribution }),
    };
  },
});
