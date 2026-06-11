// Articles list. Mirrors the stories list shape so the admin chrome stays
// consistent: filter chips along the top, slim table below, soft cap to
// avoid painting unbounded rows. Filters compose: status + type + language.

import Link from "next/link";
import { requireAdmin } from "@/lib/dal";
import {
  listArticlesSlim,
  ARTICLE_STATUSES,
  ARTICLE_TYPES,
  ARTICLE_LANGUAGES,
} from "@/lib/repo";
import {
  ARTICLE_TYPE_LABELS,
  ARTICLE_LANGUAGE_LABELS,
  articleDirection,
} from "@/lib/articles";
import { statusClass } from "@/app/admin/ui";

const LIST_LIMIT = 200;

export default async function ArticlesPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    type?: string;
    language?: string;
    imported?: string;
    skipped?: string;
  }>;
}) {
  await requireAdmin();
  const { status, type, language, imported, skipped } = await searchParams;
  const rows = await listArticlesSlim({
    status,
    type,
    language,
    limit: LIST_LIMIT,
  });

  // Filter chips share a builder so the all/specific styling stays uniform
  // and adding a new filter group (Phase 3 will add `author`) only edits one
  // function.
  const baseQs = (override: Partial<Record<string, string | undefined>>) => {
    const next = new URLSearchParams();
    const merged = { status, type, language, ...override };
    for (const [k, v] of Object.entries(merged)) {
      if (v) next.set(k, v);
    }
    const qs = next.toString();
    return qs ? `?${qs}` : "";
  };

  const chip = (href: string, label: string, active: boolean) => (
    <Link
      key={`${label}-${href}`}
      href={href}
      className={`rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${
        active
          ? "border-ink/30 bg-surface2 text-ink"
          : "border-line text-muted hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
          Articles
        </h1>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/articles/import"
            className="rounded-lg border border-line px-4 py-2 font-mono text-[12px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent"
          >
            Import from Sheets
          </Link>
          <Link
            href="/admin/articles/new"
            className="rounded-lg bg-accent px-4 py-2 font-semibold text-bg transition-opacity hover:opacity-90"
          >
            New article
          </Link>
        </div>
      </div>

      {imported && (
        <p className="rounded-lg border border-cat-wholesome/40 bg-cat-wholesome/15 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-cat-wholesome">
          Imported {imported} draft{imported === "1" ? "" : "s"} from Sheets
          {skipped ? ` (skipped ${skipped} already imported)` : ""}.
        </p>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Status
          </span>
          {chip(`/admin/articles${baseQs({ status: undefined })}`, "All", !status)}
          {ARTICLE_STATUSES.map((s) =>
            chip(`/admin/articles${baseQs({ status: s })}`, s, status === s),
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Type
          </span>
          {chip(`/admin/articles${baseQs({ type: undefined })}`, "All", !type)}
          {ARTICLE_TYPES.map((t) =>
            chip(
              `/admin/articles${baseQs({ type: t })}`,
              ARTICLE_TYPE_LABELS[t],
              type === t,
            ),
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Language
          </span>
          {chip(
            `/admin/articles${baseQs({ language: undefined })}`,
            "All",
            !language,
          )}
          {ARTICLE_LANGUAGES.map((l) =>
            chip(
              `/admin/articles${baseQs({ language: l })}`,
              ARTICLE_LANGUAGE_LABELS[l],
              language === l,
            ),
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        {rows.length === 0 ? (
          <p className="bg-surface p-6 text-center text-[14px] text-muted">
            No articles match this filter.
          </p>
        ) : (
          rows.map((a) => (
            <Link
              key={a.id}
              href={`/admin/articles/${a.id}`}
              className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 last:border-0 hover:bg-surface2"
            >
              <span className="min-w-0">
                <span
                  dir={articleDirection(a.language)}
                  className="block truncate text-[14px] text-ink"
                >
                  {a.title || a.slug || a.id.slice(0, 8)}
                </span>
                <span className="font-mono text-[11px] text-muted">
                  {a.type ? ARTICLE_TYPE_LABELS[a.type as never] ?? a.type : "—"}
                  {" · "}
                  {a.language ?? "?"}
                  {a.updated_at ? ` · ${a.updated_at.slice(0, 10)}` : ""}
                </span>
              </span>
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${statusClass(
                  a.status,
                )}`}
              >
                {a.status ?? "draft"}
              </span>
            </Link>
          ))
        )}
      </div>

      {rows.length >= LIST_LIMIT && (
        <p className="font-mono text-[11px] text-muted">
          Showing the {LIST_LIMIT} most recently updated. Filter to narrow.
        </p>
      )}
    </div>
  );
}
