"use client";

// "Auto-fill SEO" panel. Mounts inside the ArticleSeoPanel sidebar. One
// click hits /api/admin/seo-suggest, which calls the active LLM model
// (Settings → Models) with the article body and returns suggestions for
// meta_title, meta_description, keywords, and an OG image alt idea.
//
// The Apply buttons write into the existing ArticleSeoPanel form inputs by
// name (document.querySelector) — no shared state plumbing needed, the
// existing form submission still goes through saveArticleSeoAction.
// Keywords aren't a persisted field today; they show up as copyable chips
// the writer can paste anywhere.

import { useState } from "react";

interface Suggestions {
  meta_title?: string;
  meta_description?: string;
  keywords?: string[];
  og_image_alt?: string;
}

interface ApiOk {
  suggestions: Suggestions;
  model: string;
  provider: string;
}

interface ApiErr {
  error: string;
}

export function SeoSuggestPanel({ articleId }: { articleId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [modelInfo, setModelInfo] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    setSuggestions(null);
    setModelInfo(null);
    try {
      const r = await fetch("/api/admin/seo-suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ articleId }),
      });
      const data = (await r.json()) as ApiOk | ApiErr;
      if (!r.ok || "error" in data) {
        setError("error" in data ? data.error : `Request failed (${r.status})`);
        return;
      }
      setSuggestions(data.suggestions);
      setModelInfo(`${data.provider} · ${data.model}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function applyToField(name: string, value: string) {
    const el = document.querySelector(
      `[name="${name}"]`,
    ) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-ink">Auto-fill SEO</p>
          <p className="mt-0.5 text-[12px] text-muted">
            Use the active LLM model to suggest a meta title and description from the article body.
          </p>
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={loading}
          className="shrink-0 rounded-lg border border-accent bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? "Generating…" : "Generate"}
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger">
          {error}
        </p>
      )}

      {suggestions && (
        <div className="mt-3 space-y-3">
          {modelInfo && (
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
              Model: {modelInfo}
            </p>
          )}

          {suggestions.meta_title && (
            <SuggestionRow
              label="Meta title"
              value={suggestions.meta_title}
              meta={`${suggestions.meta_title.length} chars`}
              onApply={() =>
                applyToField("meta_title", suggestions.meta_title ?? "")
              }
            />
          )}

          {suggestions.meta_description && (
            <SuggestionRow
              label="Meta description"
              value={suggestions.meta_description}
              meta={`${suggestions.meta_description.length} chars`}
              onApply={() =>
                applyToField(
                  "meta_description",
                  suggestions.meta_description ?? "",
                )
              }
            />
          )}

          {suggestions.og_image_alt && (
            <SuggestionRow
              label="OG image alt idea"
              value={suggestions.og_image_alt}
              meta="No matching field — copy and paste into the OG alt of your choice"
              onApply={null}
            />
          )}

          {suggestions.keywords && suggestions.keywords.length > 0 && (
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted">
                Keyword ideas
              </div>
              <div className="flex flex-wrap gap-1.5">
                {suggestions.keywords.map((k) => (
                  <span
                    key={k}
                    className="rounded-full border border-line bg-bg px-2 py-0.5 font-mono text-[11px] text-ink"
                  >
                    {k}
                  </span>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-muted">
                Discovery hints — not persisted. Use them as a checklist while
                editing.
              </p>
            </div>
          )}

          <p className="text-[11px] text-muted">
            Applied values aren&apos;t saved until you hit Save on the SEO form below.
          </p>
        </div>
      )}
    </div>
  );
}

function SuggestionRow({
  label,
  value,
  meta,
  onApply,
}: {
  label: string;
  value: string;
  meta: string;
  onApply: (() => void) | null;
}) {
  return (
    <div className="rounded-md border border-line bg-bg p-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
          {label}
        </div>
        <div className="font-mono text-[10px] text-muted">{meta}</div>
      </div>
      <p className="text-[13px] text-ink">{value}</p>
      {onApply && (
        <button
          type="button"
          onClick={onApply}
          className="mt-2 rounded-md border border-line px-2.5 py-1 text-[11px] text-ink transition-colors hover:border-accent hover:text-accent"
        >
          Apply to field
        </button>
      )}
    </div>
  );
}
