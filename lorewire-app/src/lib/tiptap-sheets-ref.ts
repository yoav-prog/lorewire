// Tiptap Sheets Reference — an editor-only research block. The writer
// pastes a sheet URL + range, the NodeView fetches rows from the existing
// Sheets API helper, and the block surfaces them inline so the writer can
// read while composing without juggling tabs. The cached rows live on the
// node's attributes so closing and reopening the article doesn't require
// a refetch, and the writer can hit "Refresh" to pick up changes.
//
// Public render. This block is RESEARCH ONLY — it never appears on the
// public reader. renderArticleHtml strips nodes of this type before
// passing the doc to generateHTML, so even if the renderer registers the
// node spec the output is empty. We keep the spec registered (and the
// renderHTML safe / minimal) so a stored block round-trips cleanly
// through the editor's autosave cycle.

import { Node, mergeAttributes } from "@tiptap/core";

export interface SheetsRefRow {
  // Each row is a header->value mapping so the writer sees labeled data
  // in the editor regardless of column order. Saved as a sparse object.
  [header: string]: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    sheetsRef: {
      insertSheetsRef: (attrs: {
        spreadsheetId: string;
        tab: string;
        range?: string;
      }) => ReturnType;
    };
  }
}

function safeRows(raw: unknown): SheetsRefRow[] {
  if (!Array.isArray(raw)) return [];
  const out: SheetsRefRow[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const obj: SheetsRefRow = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      obj[k] = v == null ? "" : String(v);
    }
    out.push(obj);
  }
  return out;
}

export const SheetsRef = Node.create({
  name: "sheetsRef",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      spreadsheetId: { default: "" },
      tab: { default: "" },
      range: { default: "" },
      // headers and rows are denormalized for cheap rendering. Headers
      // come first because the NodeView renders them in their original
      // sheet order even when individual rows are sparse.
      headers: { default: [] as string[] },
      rows: { default: [] as SheetsRefRow[] },
      // Last successful fetch — surfaced in the NodeView so the writer
      // sees how stale the data is.
      fetchedAt: { default: null as string | null },
      note: {
        // Writer-supplied annotation ("Q3 numbers, ignore footer row").
        default: "",
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-sheets-ref]" }];
  },

  renderHTML({ HTMLAttributes }) {
    // Even though renderArticleHtml strips this node before public
    // render, the editor's autosave path runs renderHTML during JSON
    // round-trips. We emit a minimal placeholder div so the persistence
    // path can never throw on this node.
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-sheets-ref": "",
        "data-research-only": "",
        hidden: "",
      }),
    ];
  },

  addCommands() {
    return {
      insertSheetsRef:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              spreadsheetId: attrs.spreadsheetId,
              tab: attrs.tab,
              range: attrs.range ?? "",
              headers: [],
              rows: [],
              fetchedAt: null,
              note: "",
            },
          }),
    };
  },
});

// Strip all sheetsRef nodes from a Tiptap document tree so the public
// renderer never sees them. Returns a new top-level doc; the input is not
// mutated. Used by renderArticleHtml on the public read path.
export function stripSheetsRefs<T extends { type?: unknown; content?: unknown }>(
  doc: T,
): T {
  if (!doc || typeof doc !== "object") return doc;
  if (!Array.isArray(doc.content)) return doc;
  const filtered: unknown[] = [];
  for (const child of doc.content) {
    if (!child || typeof child !== "object") continue;
    const c = child as { type?: unknown; content?: unknown };
    if (c.type === "sheetsRef") continue;
    // Recurse so a sheetsRef nested inside a callout or a list still gets
    // removed. We rebuild the node shallowly to keep the tree immutable.
    filtered.push(stripSheetsRefs(c as T));
  }
  return { ...doc, content: filtered } as T;
}

export { safeRows };
