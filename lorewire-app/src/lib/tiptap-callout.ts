// Tiptap Callout node. A wrapped block that holds other blocks (paragraphs,
// lists, more callouts if you really want) with a `tone` attribute that
// drives the visual treatment. Three tones at launch — info, warning,
// success — matching the plan. Renders as
//   <aside data-callout data-tone="info"> … </aside>
// so the reader and the server-side generateHTML produce the same markup.
//
// The node itself does not own any UI — the editor toolbar toggles it via
// the `setCallout` / `unsetCallout` / `updateCalloutTone` commands. Keeping
// the node React-free means it slots cleanly into the server-side block
// renderer the public reader will use in Phase 4a.

import { Node, mergeAttributes } from "@tiptap/core";

export type CalloutTone = "info" | "warning" | "success";

const CALLOUT_TONES: CalloutTone[] = ["info", "warning", "success"];

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (attrs?: { tone?: CalloutTone }) => ReturnType;
      unsetCallout: () => ReturnType;
      updateCalloutTone: (tone: CalloutTone) => ReturnType;
    };
  }
}

function isTone(value: unknown): value is CalloutTone {
  return CALLOUT_TONES.includes(value as CalloutTone);
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  // `block+` lets the callout host any block-level content the editor
  // schema knows about — paragraphs, headings, lists. `defining: true` keeps
  // it intact when the user backspaces from inside (matches blockquote).
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      tone: {
        default: "info" as CalloutTone,
        parseHTML: (element: HTMLElement) => {
          const raw = element.getAttribute("data-tone");
          return isTone(raw) ? raw : "info";
        },
        renderHTML: (attrs: { tone?: CalloutTone }) => ({
          "data-tone": attrs.tone ?? "info",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "aside[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "aside",
      mergeAttributes(HTMLAttributes, { "data-callout": "" }),
      0,
    ];
  },

  addCommands() {
    return {
      setCallout:
        (attrs) =>
        ({ commands }) =>
          commands.wrapIn(this.name, { tone: attrs?.tone ?? "info" }),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
      updateCalloutTone:
        (tone) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { tone }),
    };
  },
});
