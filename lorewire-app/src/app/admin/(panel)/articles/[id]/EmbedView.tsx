"use client";

// React NodeView for the articleEmbed node. The writer pastes a URL; the
// view validates it against the toEmbedUrl allowlist (YouTube / X / TikTok)
// before storing on the node. If the URL doesn't match a known provider
// the view refuses the change and surfaces an error band — the public
// renderer's host check is the final guard, but failing early in the
// editor saves the writer from publishing a broken embed.

import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useState } from "react";
import { toEmbedUrl, type EmbedProvider } from "@/lib/tiptap-embed";

const BTN =
  "rounded-md border border-line bg-bg px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent";
const FIELD =
  "w-full rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent";

const PROVIDER_LABELS: Record<EmbedProvider, string> = {
  youtube: "YouTube",
  x: "X / Twitter",
  tiktok: "TikTok",
};

export function EmbedView({
  node,
  updateAttributes,
  deleteNode,
  selected,
}: NodeViewProps) {
  const provider = (node.attrs.provider ?? "") as EmbedProvider | "";
  const url = String(node.attrs.url ?? "");
  const originalUrl = String(node.attrs.originalUrl ?? "");
  const [input, setInput] = useState(originalUrl);
  const [error, setError] = useState("");

  function apply(): void {
    setError("");
    const parsed = toEmbedUrl(input.trim());
    if (!parsed) {
      setError(
        "Unsupported URL. Paste a YouTube watch link, an X / Twitter status URL, or a TikTok video URL.",
      );
      return;
    }
    updateAttributes({
      provider: parsed.provider,
      url: parsed.embedUrl,
      originalUrl: input.trim(),
    });
  }

  return (
    <NodeViewWrapper
      as="div"
      data-article-embed=""
      className={`my-3 rounded-lg border bg-surface p-3 transition-colors ${
        selected ? "border-accent" : "border-line"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Embed{provider ? ` · ${PROVIDER_LABELS[provider]}` : ""}
        </span>
        <button
          type="button"
          onClick={() => deleteNode()}
          className={`${BTN} hover:border-danger/40 hover:text-danger`}
        >
          Remove
        </button>
      </div>
      <div className="flex gap-2">
        <input
          type="url"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Paste a YouTube / X / TikTok URL"
          className={`${FIELD} flex-1 font-mono text-[11px]`}
          spellCheck={false}
        />
        <button type="button" onClick={apply} className={BTN}>
          Apply
        </button>
      </div>
      {error && (
        <p className="mt-1 text-[11px] text-danger">{error}</p>
      )}
      {url && (
        <div className="mt-3 overflow-hidden rounded-md border border-line bg-bg">
          <iframe
            src={url}
            title={provider ? `${PROVIDER_LABELS[provider]} embed` : "Embed"}
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            allowFullScreen
            className="aspect-video w-full"
          />
        </div>
      )}
    </NodeViewWrapper>
  );
}
