// Unified content inbox. Replaces the dedicated Stories and Articles tabs in
// the admin nav: same chrome, one feed, kind chip per row. Routes click
// through to the right editor (/admin/stories/[id] vs /admin/articles/[id]).
// Stories aren't created here — they come from the Python pipeline — so the
// "New" CTA only offers a new article.
//
// The row list itself is a client island (ContentList) so the admin can
// multi-select and bulk publish / unpublish / change status / change story
// category / delete. Filter chips stay server-rendered. See
// _plans/2026-06-19-content-bulk-actions.md.

import Link from "next/link";
import { requireCapability } from "@/lib/dal";
import {
  listContentSlim,
  CONTENT_SUBKINDS,
  ARTICLE_LANGUAGES,
  SOCIAL_PLATFORMS,
  type ContentSubKind,
  type SocialPlatform,
} from "@/lib/repo";
import { ARTICLE_LANGUAGE_LABELS } from "@/lib/articles";
import { CATEGORIES, STATUSES } from "@/app/admin/ui";
import { ContentList } from "./ContentList";

const LIST_LIMIT = 200;

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

const PLATFORM_FILTER_LABELS: Record<SocialPlatform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  youtube: "YouTube",
  tiktok: "TikTok",
};

function parsePlatformList(raw: string | undefined): SocialPlatform[] {
  if (!raw) return [];
  const seen = new Set<SocialPlatform>();
  for (const part of raw.split(",")) {
    const v = part.trim().toLowerCase();
    if (
      v === "facebook" ||
      v === "instagram" ||
      v === "youtube" ||
      v === "tiktok"
    ) {
      seen.add(v);
    }
  }
  return Array.from(seen);
}

/** Pure: flip a single platform's presence in a comma-joined list.
 *  Returns the new comma-joined string (or undefined when the list is
 *  now empty so the URL drops the param entirely). */
function togglePlatform(
  current: SocialPlatform[],
  platform: SocialPlatform,
): string | undefined {
  const has = current.includes(platform);
  const next = has
    ? current.filter((p) => p !== platform)
    : [...current, platform];
  return next.length === 0 ? undefined : next.join(",");
}

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<{
    kind?: string;
    status?: string;
    language?: string;
    category?: string;
    publishedOn?: string;
    publishedNotOn?: string;
  }>;
}) {
  await requireCapability("content.manage");
  const sp = await searchParams;
  const subKind = isSubKind(sp.kind) ? sp.kind : undefined;
  const status = sp.status || undefined;
  const language = sp.language || undefined;
  // Closed-enum guard so a hand-edited URL with `?category=Foo` collapses
  // to "All" instead of producing an empty SQL clause.
  const category =
    sp.category && (CATEGORIES as readonly string[]).includes(sp.category)
      ? sp.category
      : undefined;
  const publishedOn = parsePlatformList(sp.publishedOn);
  const publishedNotOn = parsePlatformList(sp.publishedNotOn);
  const rows = await listContentSlim({
    subKind,
    status,
    language,
    category,
    publishedOn: publishedOn.length > 0 ? publishedOn : undefined,
    publishedNotOn: publishedNotOn.length > 0 ? publishedNotOn : undefined,
    limit: LIST_LIMIT,
  });

  // Filter chips share a builder so adding a new dimension (Phase 3 will add
  // author) only edits one function. Clearing a filter means dropping its key.
  const baseQs = (override: Partial<Record<string, string | undefined>>) => {
    const next = new URLSearchParams();
    const merged = {
      kind: subKind,
      status,
      language,
      category,
      publishedOn: publishedOn.length > 0 ? publishedOn.join(",") : undefined,
      publishedNotOn:
        publishedNotOn.length > 0 ? publishedNotOn.join(",") : undefined,
      ...override,
    };
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
            Category
          </span>
          {chip(
            `/admin/content${baseQs({ category: undefined })}`,
            "All",
            !category,
          )}
          {CATEGORIES.map((c) =>
            chip(
              `/admin/content${baseQs({ category: c })}`,
              c,
              category === c,
            ),
          )}
          <span className="font-mono text-[10px] text-muted">
            (video stories only)
          </span>
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

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Published on
          </span>
          {chip(
            `/admin/content${baseQs({ publishedOn: undefined })}`,
            "All",
            publishedOn.length === 0,
          )}
          {SOCIAL_PLATFORMS.map((p) =>
            chip(
              `/admin/content${baseQs({ publishedOn: togglePlatform(publishedOn, p) })}`,
              PLATFORM_FILTER_LABELS[p],
              publishedOn.includes(p),
            ),
          )}
          <span className="font-mono text-[10px] text-muted">
            (video stories only · multi-select for "live on all selected")
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Not on
          </span>
          {chip(
            `/admin/content${baseQs({ publishedNotOn: undefined })}`,
            "All",
            publishedNotOn.length === 0,
          )}
          {SOCIAL_PLATFORMS.map((p) =>
            chip(
              `/admin/content${baseQs({ publishedNotOn: togglePlatform(publishedNotOn, p) })}`,
              PLATFORM_FILTER_LABELS[p],
              publishedNotOn.includes(p),
            ),
          )}
          <span className="font-mono text-[10px] text-muted">
            (use to find stories MISSING from a platform)
          </span>
        </div>
      </div>

      <ContentList rows={rows} />

      {rows.length >= LIST_LIMIT && (
        <p className="font-mono text-[11px] text-muted">
          Showing the {LIST_LIMIT} most recently updated. Filter to narrow.
        </p>
      )}
    </div>
  );
}
