// Unified content inbox. Replaces the dedicated Stories and Articles tabs in
// the admin nav: same chrome, one feed, kind chip per row. Routes click
// through to the right editor (/admin/stories/[id] vs /admin/articles/[id]).
// Stories aren't created here — they come from the Python pipeline — so the
// "New" CTA only offers a new article.

import Link from "next/link";
import { requireAdmin } from "@/lib/dal";
import {
  listContentSlim,
  CONTENT_SUBKINDS,
  ARTICLE_LANGUAGES,
  type ContentRow,
  type ContentSubKind,
} from "@/lib/repo";
import {
  ARTICLE_TYPE_LABELS,
  ARTICLE_LANGUAGE_LABELS,
  articleDirection,
} from "@/lib/articles";
import { statusClass, STATUSES } from "@/app/admin/ui";

const LIST_LIMIT = 200;

const SUBKIND_LABELS: Record<ContentSubKind, string> = {
  video: "Video story",
  news: ARTICLE_TYPE_LABELS.news,
  feature: ARTICLE_TYPE_LABELS.feature,
  listicle: ARTICLE_TYPE_LABELS.listicle,
  review: ARTICLE_TYPE_LABELS.review,
};

const SUBKIND_FILTER_LABELS: Record<ContentSubKind, string> = {
  video: "Videos",
  news: "News",
  feature: "Features",
  listicle: "Listicles",
  review: "Reviews",
};

function isSubKind(v: string | undefined): v is ContentSubKind {
  return (
    v === "video" ||
    v === "news" ||
    v === "feature" ||
    v === "listicle" ||
    v === "review"
  );
}

function rowHref(row: ContentRow): string {
  return row.kind === "story"
    ? `/admin/stories/${row.id}`
    : `/admin/articles/${row.id}`;
}

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<{
    kind?: string;
    status?: string;
    language?: string;
  }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const subKind = isSubKind(sp.kind) ? sp.kind : undefined;
  const status = sp.status || undefined;
  const language = sp.language || undefined;
  const rows = await listContentSlim({
    subKind,
    status,
    language,
    limit: LIST_LIMIT,
  });

  // Filter chips share a builder so adding a new dimension (Phase 3 will add
  // author) only edits one function. Clearing a filter means dropping its key.
  const baseQs = (override: Partial<Record<string, string | undefined>>) => {
    const next = new URLSearchParams();
    const merged = { kind: subKind, status, language, ...override };
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
          Content
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

      <p className="font-mono text-[11px] text-muted">
        Video stories arrive from the Reddit pipeline. Articles are
        hand-authored here.
      </p>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Kind
          </span>
          {chip(`/admin/content${baseQs({ kind: undefined })}`, "All", !subKind)}
          {CONTENT_SUBKINDS.map((k) =>
            chip(
              `/admin/content${baseQs({ kind: k })}`,
              SUBKIND_FILTER_LABELS[k],
              subKind === k,
            ),
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Status
          </span>
          {chip(
            `/admin/content${baseQs({ status: undefined })}`,
            "All",
            !status,
          )}
          {STATUSES.map((s) =>
            chip(`/admin/content${baseQs({ status: s })}`, s, status === s),
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Language
          </span>
          {chip(
            `/admin/content${baseQs({ language: undefined })}`,
            "All",
            !language,
          )}
          {ARTICLE_LANGUAGES.map((l) =>
            chip(
              `/admin/content${baseQs({ language: l })}`,
              ARTICLE_LANGUAGE_LABELS[l],
              language === l,
            ),
          )}
          <span className="font-mono text-[10px] text-muted">
            (articles only)
          </span>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        {rows.length === 0 ? (
          <p className="bg-surface p-6 text-center text-[14px] text-muted">
            No content matches this filter.
          </p>
        ) : (
          rows.map((r) => (
            <Link
              key={`${r.kind}-${r.id}`}
              href={rowHref(r)}
              className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 last:border-0 hover:bg-surface2"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span
                  className={`shrink-0 rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                    r.kind === "story"
                      ? "border-cat-entitled/40 bg-cat-entitled/15 text-cat-entitled"
                      : "border-accent/40 bg-accent/15 text-accent"
                  }`}
                >
                  {SUBKIND_LABELS[r.subKind]}
                </span>
                <span className="min-w-0">
                  <span
                    dir={articleDirection(r.language)}
                    className="block truncate text-[14px] text-ink"
                  >
                    {r.title || r.slug || r.id.slice(0, 8)}
                  </span>
                  <span className="font-mono text-[11px] text-muted">
                    {r.badge ?? "—"}
                    {r.language ? ` · ${r.language}` : ""}
                    {r.updated_at ? ` · ${r.updated_at.slice(0, 10)}` : ""}
                  </span>
                </span>
              </span>
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${statusClass(
                  r.status,
                )}`}
              >
                {r.status ?? "draft"}
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
