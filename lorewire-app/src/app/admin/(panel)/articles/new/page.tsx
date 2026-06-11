// New-article picker. Type and language are set at creation only — both are
// load-bearing for the editor preset (Phase 2) and the reader template so we
// don't let the writer change them mid-life. The default language reads from
// the `articles.default_language` setting and falls back to "en" per the
// approved plan; default type defaults to "feature".

import Link from "next/link";
import { requireAdmin } from "@/lib/dal";
import { getSetting } from "@/lib/repo";
import { ARTICLE_TYPES, ARTICLE_LANGUAGES } from "@/lib/repo";
import {
  ARTICLE_TYPE_LABELS,
  ARTICLE_TYPE_DESCRIPTIONS,
  ARTICLE_LANGUAGE_LABELS,
  isArticleLanguage,
  isArticleType,
} from "@/lib/articles";
import { createArticleAction } from "@/app/admin/actions";

const FIELD =
  "w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";
const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";

export default async function NewArticlePage() {
  await requireAdmin();
  const [rawDefaultType, rawDefaultLang] = await Promise.all([
    getSetting("articles.default_type"),
    getSetting("articles.default_language"),
  ]);
  const defaultType = isArticleType(rawDefaultType) ? rawDefaultType : "feature";
  const defaultLanguage = isArticleLanguage(rawDefaultLang)
    ? rawDefaultLang
    : "en";

  return (
    <div className="mx-auto max-w-[640px] space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/admin/articles"
          className="font-mono text-[12px] text-muted hover:text-ink"
        >
          &larr; Articles
        </Link>
      </div>

      <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
        New article
      </h1>

      <form action={createArticleAction} className="space-y-5">
        <div>
          <label className={LABEL}>Working title</label>
          <input
            name="title"
            required
            placeholder="Where it shows up in the list. You can rename later."
            className={FIELD}
            autoFocus
          />
        </div>

        <div>
          <span className={LABEL}>Type</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {ARTICLE_TYPES.map((t) => (
              <label
                key={t}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface p-3 transition-colors hover:border-accent has-[input:checked]:border-accent has-[input:checked]:bg-surface2"
              >
                <input
                  type="radio"
                  name="type"
                  value={t}
                  defaultChecked={t === defaultType}
                  className="mt-1 accent-accent"
                  required
                />
                <span className="min-w-0">
                  <span className="block text-[14px] text-ink">
                    {ARTICLE_TYPE_LABELS[t]}
                  </span>
                  <span className="block text-[12px] leading-snug text-muted">
                    {ARTICLE_TYPE_DESCRIPTIONS[t]}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <span className={LABEL}>Language</span>
          <div className="grid grid-cols-2 gap-2">
            {ARTICLE_LANGUAGES.map((l) => (
              <label
                key={l}
                className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-line bg-surface p-3 transition-colors hover:border-accent has-[input:checked]:border-accent has-[input:checked]:bg-surface2"
              >
                <input
                  type="radio"
                  name="language"
                  value={l}
                  defaultChecked={l === defaultLanguage}
                  className="accent-accent"
                  required
                />
                <span className="text-[14px] text-ink">
                  {ARTICLE_LANGUAGE_LABELS[l]}
                </span>
              </label>
            ))}
          </div>
          <p className="mt-1 font-mono text-[11px] text-muted">
            Direction is fixed at creation. New article in the other language is
            a separate row.
          </p>
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <Link
            href="/admin/articles"
            className="rounded-lg border border-line px-4 py-2 font-mono text-[12px] uppercase tracking-wider text-muted hover:text-ink"
          >
            Cancel
          </Link>
          <button
            type="submit"
            className="rounded-lg bg-accent px-5 py-2.5 font-semibold text-bg transition-opacity hover:opacity-90"
          >
            Create draft
          </button>
        </div>
      </form>
    </div>
  );
}
