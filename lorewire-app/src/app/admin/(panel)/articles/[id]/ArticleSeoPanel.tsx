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

import { useMemo, useState } from "react";
import { updateArticleSeoAction } from "@/app/admin/actions";
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

  const slugValid = useMemo(() => isValidSlugShape(slug), [slug]);
  const titleState = useMemo(() => metaTitleState(metaTitle), [metaTitle]);
  const descState = useMemo(() => metaDescState(metaDesc), [metaDesc]);

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

        <label className="block">
          <span className={SMALL_LABEL}>Social card image (OG)</span>
          <input
            name="og_image"
            value={ogImage}
            onChange={(e) => setOgImage(e.target.value)}
            placeholder="https://… (defaults to hero image)"
            className={`${FIELD} font-mono text-[11px]`}
            spellCheck={false}
          />
          {ogImage && /^https?:\/\//.test(ogImage) && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={ogImage}
              alt=""
              className="mt-2 max-h-32 w-full rounded-md border border-line object-contain"
            />
          )}
        </label>

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
