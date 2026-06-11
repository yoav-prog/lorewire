"use client";

// React NodeView for the articleImage Tiptap node. The Tiptap node itself
// (lib/tiptap-article-image.ts) is the JSON/HTML side; this is the editor-
// side UX. We render the image, an alt-text input (required for publish),
// a caption input (optional), and a small remove button. The atom-block
// node has no inner editable content — Tiptap routes selection through the
// NodeViewWrapper so the user can still click "delete" on a selected image.
//
// The alt-text warning band turns red when the input is empty so the writer
// sees the publish guard before they hit it. The server-side guard
// (countImagesMissingAlt -> publish action) is the load-bearing check; this
// is the friendly heads-up.

import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useState } from "react";

const ALT_INPUT =
  "w-full rounded-md border bg-bg px-2 py-1.5 text-[12px] text-ink outline-none transition-colors focus:border-accent";
const CAPTION_INPUT =
  "w-full rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] italic text-ink outline-none focus:border-accent";

export function ArticleImageView({
  node,
  updateAttributes,
  deleteNode,
  selected,
}: NodeViewProps) {
  // Mirror the node attrs into local state so the inputs feel snappy. We
  // commit to the editor on every change rather than on blur — this is the
  // simplest correct behaviour; Tiptap dedupes redundant updates internally.
  const [alt, setAlt] = useState<string>(String(node.attrs.alt ?? ""));
  const [caption, setCaption] = useState<string>(
    String(node.attrs.caption ?? ""),
  );
  const src = String(node.attrs.src ?? "");
  const altMissing = !alt.trim();

  function onAltChange(next: string): void {
    setAlt(next);
    updateAttributes({ alt: next });
  }

  function onCaptionChange(next: string): void {
    setCaption(next);
    updateAttributes({ caption: next });
  }

  return (
    <NodeViewWrapper
      as="figure"
      data-article-image=""
      className={`my-3 rounded-lg border bg-surface p-2 transition-colors ${
        selected ? "border-accent" : "border-line"
      }`}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          className="block max-h-[420px] w-full rounded-md object-contain"
        />
      ) : (
        <div className="grid h-32 place-items-center rounded-md bg-bg font-mono text-[11px] uppercase tracking-wider text-muted">
          missing src
        </div>
      )}
      <div className="mt-2 space-y-1.5">
        <label className="block">
          <span
            className={`mb-0.5 block font-mono text-[10px] uppercase tracking-wider ${
              altMissing ? "text-danger" : "text-muted"
            }`}
          >
            Alt text {altMissing ? "(required to publish)" : ""}
          </span>
          <input
            type="text"
            value={alt}
            onChange={(e) => onAltChange(e.target.value)}
            placeholder="Describe the image for screen readers"
            className={`${ALT_INPUT} ${
              altMissing
                ? "border-danger/40 focus:border-danger"
                : "border-line"
            }`}
          />
        </label>
        <label className="block">
          <span className="mb-0.5 block font-mono text-[10px] uppercase tracking-wider text-muted">
            Caption (optional)
          </span>
          <input
            type="text"
            value={caption}
            onChange={(e) => onCaptionChange(e.target.value)}
            placeholder="Shows under the image in the article"
            className={CAPTION_INPUT}
          />
        </label>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => deleteNode()}
            className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-danger"
          >
            Remove image
          </button>
        </div>
      </div>
    </NodeViewWrapper>
  );
}
