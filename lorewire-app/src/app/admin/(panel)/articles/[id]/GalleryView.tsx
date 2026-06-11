"use client";

// React NodeView for the articleGallery node. The node attr `items` is the
// canonical store; this view reads/writes through updateAttributes so
// autosave catches every change. Each image gets the same alt + caption
// affordances as the standalone ArticleImage block (alt-missing warning,
// caption optional) plus add / remove / reorder controls.

import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useRef, useState } from "react";
import type { GalleryItem } from "@/lib/tiptap-gallery";

const BTN =
  "rounded-md border border-line bg-bg px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40";

interface UploadResponse {
  imageId: string;
  url: string;
  width: number | null;
  height: number | null;
}

interface ErrorResponse {
  error?: string;
}

function safeItems(raw: unknown): GalleryItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((it) => {
    const obj = (it ?? {}) as Partial<GalleryItem>;
    return {
      src: typeof obj.src === "string" ? obj.src : "",
      alt: typeof obj.alt === "string" ? obj.alt : "",
      caption: typeof obj.caption === "string" ? obj.caption : "",
    };
  });
}

export function GalleryView({
  node,
  updateAttributes,
  deleteNode,
  selected,
  editor,
}: NodeViewProps) {
  // Pull the article id off the editor's storage. ArticleEditor stamps the
  // id during mount so every NodeView that needs an upload target can read
  // it without prop drilling. We narrow through `unknown` because Tiptap's
  // Storage type only knows extensions registered at compile time and our
  // LorewireStorage is registered at runtime in the editor.
  const articleId =
    ((editor.storage as unknown as Record<string, unknown>).lorewire as
      | { articleId?: string }
      | undefined)?.articleId ?? "";
  const items = safeItems(node.attrs.items);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  function setItems(next: GalleryItem[]): void {
    updateAttributes({ items: next });
  }

  function update(idx: number, patch: Partial<GalleryItem>): void {
    setItems(items.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }

  function remove(idx: number): void {
    setItems(items.filter((_, i) => i !== idx));
  }

  function move(idx: number, dir: -1 | 1): void {
    const j = idx + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[idx], next[j]] = [next[j], next[idx]];
    setItems(next);
  }

  async function onPickFile(file: File): Promise<void> {
    if (!articleId) {
      setError("Cannot upload before the article id is available.");
      return;
    }
    setError("");
    if (file.size > 4 * 1024 * 1024) {
      setError("Image is larger than 4 MB.");
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("articleId", articleId);
      form.append("file", file);
      const resp = await fetch("/api/admin/articles/images", {
        method: "POST",
        body: form,
      });
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as ErrorResponse;
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as UploadResponse;
      setItems([...items, { src: data.url, alt: "", caption: "" }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <NodeViewWrapper
      as="figure"
      data-article-gallery=""
      className={`my-3 rounded-lg border bg-surface p-2 transition-colors ${
        selected ? "border-accent" : "border-line"
      }`}
    >
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Gallery · {items.length} image{items.length === 1 ? "" : "s"}
        </span>
        <span className="flex gap-1">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className={BTN}
          >
            {uploading ? "Uploading…" : "+ Image"}
          </button>
          <button
            type="button"
            onClick={() => deleteNode()}
            className={`${BTN} hover:border-danger/40 hover:text-danger`}
          >
            Remove block
          </button>
        </span>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPickFile(file);
        }}
      />
      {error && (
        <p className="mb-2 px-1 text-[11px] text-danger">{error}</p>
      )}
      {items.length === 0 ? (
        <p className="grid h-24 place-items-center rounded-md bg-bg font-mono text-[11px] uppercase tracking-wider text-muted">
          No images yet
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item, idx) => {
            const altMissing = !item.alt.trim();
            return (
              <div
                key={idx}
                className="grid grid-cols-[120px_1fr_auto] gap-2 rounded-md border border-line bg-bg p-2"
              >
                {item.src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.src}
                    alt={item.alt}
                    className="h-20 w-30 rounded-md object-cover"
                  />
                ) : (
                  <div className="grid h-20 w-30 place-items-center rounded-md bg-surface text-[10px] text-muted">
                    no src
                  </div>
                )}
                <div className="space-y-1">
                  <input
                    type="text"
                    value={item.alt}
                    onChange={(e) => update(idx, { alt: e.target.value })}
                    placeholder="Alt text (required to publish)"
                    className={`w-full rounded-md border bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent ${
                      altMissing
                        ? "border-danger/40"
                        : "border-line"
                    }`}
                  />
                  <input
                    type="text"
                    value={item.caption}
                    onChange={(e) =>
                      update(idx, { caption: e.target.value })
                    }
                    placeholder="Caption (optional)"
                    className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[12px] italic text-ink outline-none focus:border-accent"
                  />
                </div>
                <span className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => move(idx, -1)}
                    disabled={idx === 0}
                    className={BTN}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(idx, 1)}
                    disabled={idx === items.length - 1}
                    className={BTN}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(idx)}
                    className={`${BTN} hover:border-danger/40 hover:text-danger`}
                  >
                    ×
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </NodeViewWrapper>
  );
}
