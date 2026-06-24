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
  JOB_STATUSES,
  type ContentSubKind,
  type JobStatus,
  type SocialPlatform,
} from "@/lib/repo";
import { ARTICLE_LANGUAGE_LABELS } from "@/lib/articles";
import { CATEGORIES, STATUSES } from "@/app/admin/ui";
import { ContentList } from "./ContentList";

const LIST_LIMIT = 200;

// 2026-06-24 last-updated filter. Bucket chips collapse the common case
// ("what changed today") to one click; "Custom" reveals a from/to date
// pair for the rest. Keys land in the URL so refresh keeps the filter
// and a copy-paste link shares the same view.
const DATE_BUCKETS = ["today", "7d", "30d", "90d", "custom"] as const;
type DateBucket = (typeof DATE_BUCKETS)[number];
const DATE_BUCKET_LABELS: Record<DateBucket, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  custom: "Custom…",
};

function isDateBucket(v: string | undefined): v is DateBucket {
  return DATE_BUCKETS.includes(v as DateBucket);
}

/** Resolve a preset bucket to the (since, until?) pair listContentSlim
 *  applies. `until` is exclusive so "today" covers [start-of-today,
 *  start-of-tomorrow); the rolling windows leave until=undefined. */
function resolveBucket(
  bucket: Exclude<DateBucket, "custom">,
  now = new Date(),
): { since: string; until?: string } {
  const ms = 24 * 60 * 60 * 1000;
  const startOfTodayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  switch (bucket) {
    case "today":
      return {
        since: startOfTodayUtc.toISOString(),
        until: new Date(startOfTodayUtc.getTime() + ms).toISOString(),
      };
    case "7d":
      return { since: new Date(now.getTime() - 7 * ms).toISOString() };
    case "30d":
      return { since: new Date(now.getTime() - 30 * ms).toISOString() };
    case "90d":
      return { since: new Date(now.getTime() - 90 * ms).toISOString() };
  }
}

/** YYYY-MM-DD validator. Rebuilding through Date and comparing back to the
 *  input rejects impossible dates like 2026-13-45 without a third-party lib. */
function parseDateInput(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  if (d.toISOString().slice(0, 10) !== raw) return undefined;
  return d.toISOString();
}

function isJobStatus(v: string | undefined): v is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(v ?? "");
}

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
    jobStatus?: string;
    updatedBucket?: string;
    updatedAfter?: string;
    updatedBefore?: string;
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
  const jobStatus = isJobStatus(sp.jobStatus) ? sp.jobStatus : undefined;
  const updatedBucket = isDateBucket(sp.updatedBucket)
    ? sp.updatedBucket
    : undefined;
  // updatedAfter / updatedBefore are only honored when bucket=custom; for
  // preset buckets, resolveBucket() owns the math so the chip describes
  // exactly what it filters to.
  const customAfter =
    updatedBucket === "custom" ? parseDateInput(sp.updatedAfter) : undefined;
  // The form input is a date, so "Before 2026-06-24" should still include
  // all of the 24th. parseDateInput returns start-of-day UTC; bump by one
  // day so the comparison reads inclusive-of-that-day.
  const customBeforeRaw =
    updatedBucket === "custom" ? parseDateInput(sp.updatedBefore) : undefined;
  const customBefore = customBeforeRaw
    ? new Date(
        new Date(customBeforeRaw).getTime() + 24 * 60 * 60 * 1000,
      ).toISOString()
    : undefined;
  const resolvedRange =
    updatedBucket === undefined
      ? undefined
      : updatedBucket === "custom"
        ? { since: customAfter, until: customBefore }
        : resolveBucket(updatedBucket);
  const rows = await listContentSlim({
    subKind,
    status,
    language,
    category,
    publishedOn: publishedOn.length > 0 ? publishedOn : undefined,
    publishedNotOn: publishedNotOn.length > 0 ? publishedNotOn : undefined,
    jobStatus,
    updatedSince: resolvedRange?.since || undefined,
    updatedUntil: resolvedRange?.until || undefined,
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
      jobStatus,
      updatedBucket,
      // Only persist the custom range when bucket=custom — otherwise switching
      // from custom → 7d would drag stale date params along in the URL.
      updatedAfter: updatedBucket === "custom" ? sp.updatedAfter : undefined,
      updatedBefore: updatedBucket === "custom" ? sp.updatedBefore : undefined,
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

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Job
          </span>
          {chip(
            `/admin/content${baseQs({ jobStatus: undefined })}`,
            "All",
            !jobStatus,
          )}
          {JOB_STATUSES.map((s) =>
            chip(
              `/admin/content${baseQs({ jobStatus: s })}`,
              s,
              jobStatus === s,
            ),
          )}
          <span className="font-mono text-[10px] text-muted">
            (latest pipeline run · video stories only)
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Updated
          </span>
          {chip(
            `/admin/content${baseQs({ updatedBucket: undefined, updatedAfter: undefined, updatedBefore: undefined })}`,
            "All",
            !updatedBucket,
          )}
          {DATE_BUCKETS.map((b) =>
            chip(
              `/admin/content${baseQs({ updatedBucket: b })}`,
              DATE_BUCKET_LABELS[b],
              updatedBucket === b,
            ),
          )}
        </div>

        {updatedBucket === "custom" && (
          // GET form so the inputs land back in the URL — same persistence
          // story as the chips. An explicit Apply button (instead of
          // submit-on-change) avoids one fetch per keystroke as the
          // operator types a date.
          <form
            method="GET"
            action="/admin/content"
            className="flex flex-wrap items-center gap-2 pl-1"
          >
            {/* Re-thread every active filter so the Apply round-trip doesn't
                drop the rest. Hidden inputs only. */}
            {subKind && <input type="hidden" name="kind" value={subKind} />}
            {status && <input type="hidden" name="status" value={status} />}
            {language && (
              <input type="hidden" name="language" value={language} />
            )}
            {category && (
              <input type="hidden" name="category" value={category} />
            )}
            {publishedOn.length > 0 && (
              <input
                type="hidden"
                name="publishedOn"
                value={publishedOn.join(",")}
              />
            )}
            {publishedNotOn.length > 0 && (
              <input
                type="hidden"
                name="publishedNotOn"
                value={publishedNotOn.join(",")}
              />
            )}
            {jobStatus && (
              <input type="hidden" name="jobStatus" value={jobStatus} />
            )}
            <input type="hidden" name="updatedBucket" value="custom" />
            <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted">
              From
              <input
                type="date"
                name="updatedAfter"
                defaultValue={sp.updatedAfter ?? ""}
                className="rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] text-ink"
              />
            </label>
            <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted">
              To
              <input
                type="date"
                name="updatedBefore"
                defaultValue={sp.updatedBefore ?? ""}
                className="rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] text-ink"
              />
            </label>
            <button
              type="submit"
              className="rounded-md border border-accent px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-accent transition-colors hover:bg-accent hover:text-bg"
            >
              Apply
            </button>
            {(sp.updatedAfter || sp.updatedBefore) && (
              <Link
                href={`/admin/content${baseQs({ updatedAfter: undefined, updatedBefore: undefined })}`}
                className="font-mono text-[10px] text-muted underline-offset-2 hover:text-ink hover:underline"
              >
                clear
              </Link>
            )}
          </form>
        )}
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
