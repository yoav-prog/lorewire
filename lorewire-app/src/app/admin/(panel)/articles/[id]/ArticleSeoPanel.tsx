"use client";

// SEO panel for the article editor. Lives below the type-specific metadata
// sidebar and above the status card. Four fields: slug (with shape + length
// state), meta_title (with optimal/tight/long state), meta_description
// (same states with different thresholds), og_image (URL with preview).
// Plus a read-only JSON-LD preview of what the reader will emit per the
// current article state.
//
// The panel is client-side because the length-state indicators and the
// JSON-LD preview need to update live as the writer types. A small custom
// "Save SEO" button posts to updateArticleSeoAction; we don't autosave SEO
// because slug changes are a moving target (a typo mid-edit shouldn't
// allocate a slug the writer didn't mean).

import { useMemo, useRef, useState } from "react";
import { updateArticleSeoAction } from "@/app/admin/actions";
import { MAX_IMAGE_BYTES, uploadErrorText } from "@/lib/admin-image-upload";
import {
  META_TITLE_OPTIMAL,
  META_TITLE_MAX,
  META_DESC_OPTIMAL,
  META_DESC_MAX,
  metaTitleState,
  metaDescState,
  isValidSlugShape,
  type LengthBudgetState,
} from "@/lib/article-seo";

const SECTION_WRAP = "rounded-xl border border-line bg-surface p-4";
const SECTION_LABEL =
  "mb-2 block font-mono text-[11px] uppercase tracking-wider text-muted";
const SMALL_LABEL =
  "mb-0.5 block font-mono text-[10px] uppercase tracking-wider text-muted";
const FIELD =
  "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent";
const PRIMARY_BTN =
  "w-full rounded-md bg-accent px-3 py-1.5 font-semibold text-bg transition-opacity hover:opacity-90";

function stateClass(state: LengthBudgetState): string {
  switch (state) {
    case "empty":
      return "text-muted";
    case "ok":
      return "text-cat-wholesome";
    case "tight":
      return "text-cat-entitled";
    case "long":
      return "text-danger";
  }
}

function stateBorder(state: LengthBudgetState): string {
  if (state === "long") return "border-danger/50";
  if (state === "tight") return "border-cat-entitled/40";
  return "border-line";
}

interface Props {
  articleId: string;
  language: string;
  direction: "ltr" | "rtl";
  slug: string;
  metaTitle: string;
  metaDescription: string;
  ogImage: string;
  // Server-rendered preview JSON. We render it as text and don't re-derive
  // here because the panel doesn't have the parsed payload — the article
  // page does, and the preview lives on the same page render.
  jsonLdPreview: string;
}

export function ArticleSeoPanel({
  articleId,
  language,
  direction,
  slug: initialSlug,
  metaTitle: initialMetaTitle,
  metaDescription: initialMetaDesc,
  ogImage: initialOg,
  jsonLdPreview,
}: Props) {
  const [slug, setSlug] = useState(initialSlug);
  const [metaTitle, setMetaTitle] = useState(initialMetaTitle);
  const [metaDesc, setMetaDesc] = useState(initialMetaDesc);
  const [ogImage, setOgImage] = useState(initialOg);
  const [ogUploading, setOgUploading] = useState(false);
  const [ogUploadNote, setOgUploadNote] = useState<
    { kind: "ok" | "error"; text: string } | null
  >(null);
  const ogFileRef = useRef<HTMLInputElement>(null);

  const slugValid = useMemo(() => isValidSlugShape(slug), [slug]);
  const titleState = useMemo(() => metaTitleState(metaTitle), [metaTitle]);
  const descState = useMemo(() => metaDescState(metaDesc), [metaDesc]);

  // Upload an OG image to /api/admin/uploads/image (stored in R2 via the
  // media uploader) and fill the field with the returned URL. Deliberately
  // does NOT auto-submit — this form has no autosave because a submit can
  // allocate a slug mid-edit; the note tells the writer to hit Save SEO.
  async function onPickOgFile(file: File) {
    setOgUploadNote(null);
    if (file.size > MAX_IMAGE_BYTES) {
      setOgUploadNote({ kind: "error", text: uploadErrorText("too-large") });
      return;
    }
    setOgUploading(true);
    console.info("[admin image-upload] picked", {
      slot: "article-og",
      articleId,
      name: file.name,
      bytes: file.size,
    });
    try {
      const form = new FormData();
      form.append("slot", "article-og");
      form.append("articleId", articleId);
      form.append("file", file);
      const resp = await fetch("/api/admin/uploads/image", {
        method: "POST",
        body: form,
      });
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as { url: string };
      console.info("[admin image-upload] ok", {
        slot: "article-og",
        articleId,
        url: data.url,
      });
      setOgImage(data.url);
      setOgUploadNote({ kind: "ok", text: "Uploaded — Save SEO to apply." });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[admin image-upload] failed", {
        slot: "article-og",
        articleId,
        error: msg,
      });
      setOgUploadNote({ kind: "error", text: uploadErrorText(msg) });
    } finally {
      setOgUploading(false);
      // Reset so re-picking the same file fires the change event again.
      if (ogFileRef.current) ogFileRef.current.value = "";
    }
  }

  return (
    <div className={SECTION_WRAP}>
      <div className={SECTION_LABEL}>SEO</div>
      <form action={updateArticleSeoAction} className="space-y-3">
        <input type="hidden" name="id" value={articleId} />

        <label className="block">
          <span className="mb-0.5 flex items-center justify-between">
            <span className={SMALL_LABEL.replace("mb-0.5 ", "")}>Slug</span>
            <span
              className={`font-mono text-[10px] ${slugValid ? "text-muted" : "text-danger"}`}
            >
              /articles/{language}/{slug || "—"}
            </span>
          </span>
          <input
            name="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder="lowercase-with-hyphens"
            className={`${FIELD} font-mono ${slugValid ? "border-line" : "border-danger/50"}`}
            spellCheck={false}
          />
          {!slugValid && (
            <span className="mt-0.5 block font-mono text-[10px] text-danger">
              Lowercase letters, digits, and hyphens. No leading or trailing
              hyphen.
            </span>
          )}
        </label>

        <label className="block">
          <span className="mb-0.5 flex items-center justify-between">
            <span className={SMALL_LABEL.replace("mb-0.5 ", "")}>
              Meta title
            </span>
            <span className={`font-mono text-[10px] ${stateClass(titleState)}`}>
              {metaTitle.trim().length}/{META_TITLE_OPTIMAL}
              {titleState === "tight" ? " (tight)" : ""}
              {titleState === "long" ? " (too long)" : ""}
            </span>
          </span>
          <input
            name="meta_title"
            value={metaTitle}
            onChange={(e) => setMetaTitle(e.target.value)}
            placeholder="Shown in search results. Falls back to title."
            className={`${FIELD} ${stateBorder(titleState)}`}
            dir={direction}
            maxLength={META_TITLE_MAX + 30}
          />
        </label>

        <label className="block">
          <span className="mb-0.5 flex items-center justify-between">
            <span className={SMALL_LABEL.replace("mb-0.5 ", "")}>
              Meta description
            </span>
            <span className={`font-mono text-[10px] ${stateClass(descState)}`}>
              {metaDesc.trim().length}/{META_DESC_OPTIMAL}
              {descState === "tight" ? " (tight)" : ""}
              {descState === "long" ? " (too long)" : ""}
            </span>
          </span>
          <textarea
            name="meta_description"
            value={metaDesc}
            onChange={(e) => setMetaDesc(e.target.value)}
            placeholder="One or two sentences. Falls back to summary."
            rows={3}
            className={`${FIELD} ${stateBorder(descState)}`}
            dir={direction}
            maxLength={META_DESC_MAX + 60}
          />
        </label>

        {/* A div, not a label — the Upload button would otherwise become the
            label's implicit control (first labelable descendant) and clicking
            the field's title would open the file picker. */}
        <div className="block">
          <span className="mb-0.5 flex items-center justify-between">
            <span className={SMALL_LABEL.replace("mb-0.5 ", "")}>
              Social card image (OG)
            </span>
            <button
              type="button"
              disabled={ogUploading}
              onClick={() => ogFileRef.current?.click()}
              className={`font-mono text-[10px] uppercase tracking-wider text-muted underline-offset-2 hover:text-accent hover:underline ${
                ogUploading ? "cursor-wait opacity-60" : ""
              }`}
            >
              {ogUploading ? "Uploading…" : "Upload"}
            </button>
          </span>
          <input
            name="og_image"
            value={ogImage}
            onChange={(e) => setOgImage(e.target.value)}
            placeholder="https://… (defaults to hero image)"
            aria-label="Social card image (OG) URL"
            className={`${FIELD} font-mono text-[11px]`}
            spellCheck={false}
          />
          <input
            ref={ogFileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onPickOgFile(f);
            }}
          />
          {ogUploadNote && (
            <span
              className={`mt-0.5 block font-mono text-[10px] ${
                ogUploadNote.kind === "ok" ? "text-cat-wholesome" : "text-danger"
              }`}
            >
              {ogUploadNote.text}
            </span>
          )}
          {ogImage && /^https?:\/\//.test(ogImage) && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={ogImage}
              alt=""
              className="mt-2 max-h-32 w-full rounded-md border border-line object-contain"
            />
          )}
        </div>

        <button type="submit" disabled={!slugValid} className={PRIMARY_BTN}>
          Save SEO
        </button>
      </form>

      <details className="mt-4">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-muted hover:text-ink">
          JSON-LD preview
        </summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-[10px] leading-snug text-ink">
          {jsonLdPreview}
        </pre>
      </details>
    </div>
  );
}
