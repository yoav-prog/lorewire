"use client";

// React NodeView for the articleComparison node. Four plain text fields:
// two labels, two bodies. Atomic block — the bodies are strings, not
// editable inline content, because the editorial demand at v1 is simple
// "this vs that" comparisons, not rich content per side. A future
// upgrade to NodeViewContent per side is straightforward if needed.

import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";

const BTN =
  "rounded-md border border-line bg-bg px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent";
const LABEL =
  "mb-0.5 block font-mono text-[10px] uppercase tracking-wider text-muted";
const FIELD =
  "w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink outline-none focus:border-accent";

export function ComparisonView({
  node,
  updateAttributes,
  deleteNode,
  selected,
}: NodeViewProps) {
  const leftLabel = String(node.attrs.leftLabel ?? "");
  const leftBody = String(node.attrs.leftBody ?? "");
  const rightLabel = String(node.attrs.rightLabel ?? "");
  const rightBody = String(node.attrs.rightBody ?? "");

  return (
    <NodeViewWrapper
      as="div"
      data-article-comparison=""
      className={`my-3 rounded-lg border bg-surface p-3 transition-colors ${
        selected ? "border-accent" : "border-line"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Comparison
        </span>
        <button
          type="button"
          onClick={() => deleteNode()}
          className={`${BTN} hover:border-danger/40 hover:text-danger`}
        >
          Remove
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 rounded-md border border-line bg-bg p-2">
          <label className="block">
            <span className={LABEL}>Left label</span>
            <input
              value={leftLabel}
              onChange={(e) =>
                updateAttributes({ leftLabel: e.target.value })
              }
              placeholder="e.g. Before"
              className={FIELD}
            />
          </label>
          <label className="block">
            <span className={LABEL}>Left body</span>
            <textarea
              value={leftBody}
              onChange={(e) =>
                updateAttributes({ leftBody: e.target.value })
              }
              placeholder="What was true on the left side"
              rows={3}
              className={FIELD}
            />
          </label>
        </div>
        <div className="space-y-1.5 rounded-md border border-line bg-bg p-2">
          <label className="block">
            <span className={LABEL}>Right label</span>
            <input
              value={rightLabel}
              onChange={(e) =>
                updateAttributes({ rightLabel: e.target.value })
              }
              placeholder="e.g. After"
              className={FIELD}
            />
          </label>
          <label className="block">
            <span className={LABEL}>Right body</span>
            <textarea
              value={rightBody}
              onChange={(e) =>
                updateAttributes({ rightBody: e.target.value })
              }
              placeholder="What was true on the right side"
              rows={3}
              className={FIELD}
            />
          </label>
        </div>
      </div>
    </NodeViewWrapper>
  );
}
