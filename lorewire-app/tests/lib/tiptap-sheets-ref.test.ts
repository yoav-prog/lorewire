// Tests for the sheetsRef strip behaviour. The block is editor-only — the
// public reader must never see it — and the strip helper has to handle
// nested cases (sheetsRef inside a callout, inside a list item) because
// Tiptap doc trees can nest blocks arbitrarily.

import { describe, expect, it } from "vitest";
import { stripSheetsRefs } from "@/lib/tiptap-sheets-ref";

interface DocNode {
  type: string;
  content?: DocNode[];
}

function doc(content: DocNode[]): DocNode {
  return { type: "doc", content };
}

function para(text: string): DocNode {
  return {
    type: "paragraph",
    content: [{ type: "text", text } as DocNode & { text: string }],
  };
}

function sheetsRef(): DocNode {
  return { type: "sheetsRef" };
}

describe("stripSheetsRefs", () => {
  it("returns the doc unchanged when there are no refs", () => {
    const d = doc([para("hello")]);
    const out = stripSheetsRefs(d);
    expect(out).toEqual(d);
  });

  it("removes a top-level sheetsRef block", () => {
    const d = doc([para("before"), sheetsRef(), para("after")]);
    const out = stripSheetsRefs(d);
    expect(out.content).toHaveLength(2);
    expect(out.content?.[0]).toEqual(para("before"));
    expect(out.content?.[1]).toEqual(para("after"));
  });

  it("removes a sheetsRef nested inside a callout", () => {
    const d = doc([
      {
        type: "callout",
        content: [para("intro"), sheetsRef()],
      },
    ]);
    const out = stripSheetsRefs(d);
    const callout = out.content?.[0];
    expect(callout?.type).toBe("callout");
    expect(callout?.content).toHaveLength(1);
    expect(callout?.content?.[0]).toEqual(para("intro"));
  });

  it("removes a sheetsRef nested inside a list item", () => {
    const d = doc([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [para("item"), sheetsRef()],
          },
        ],
      },
    ]);
    const out = stripSheetsRefs(d);
    const li = out.content?.[0]?.content?.[0];
    expect(li?.content).toHaveLength(1);
  });

  it("does not mutate the input document", () => {
    const d = doc([para("a"), sheetsRef(), para("b")]);
    const snapshot = JSON.stringify(d);
    stripSheetsRefs(d);
    expect(JSON.stringify(d)).toBe(snapshot);
  });

  it("tolerates a non-object input by returning it unchanged", () => {
    expect(stripSheetsRefs(null as never)).toBeNull();
    expect(stripSheetsRefs(undefined as never)).toBeUndefined();
  });
});
