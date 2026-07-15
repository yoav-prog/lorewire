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
  getAutoPublishFlaggedSummary,
  CONTENT_SUBKINDS,
  ARTICLE_LANGUAGES,
  SOCIAL_PLATFORMS,
  JOB_STATUSES,
  type ContentPageOpts,
  type ContentSubKind,
  type JobStatus,
  type ProgressKind,
  type SocialPlatform,
} from "@/lib/repo";
import { ARTICLE_LANGUAGE_LABELS } from "@/lib/articles";
import { STATUSES } from "@/app/admin/ui";
import { listCategories } from "@/lib/categories/repo";
import { ContentList } from "./ContentList";
import { FilterPanel, type ActiveFilterChip } from "./FilterPanel";

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

// 2026-06-25 active-render filter values. The chip row collapses
// "any active" to a single click; specific kinds let the operator
// narrow to "stories whose short is rendering right now" etc.
const ACTIVE_KIND_VALUES = [
  "any",
  "short",
  "images",
  "voice",
  "pipeline",
] as const;
type ActiveKindValue = (typeof ACTIVE_KIND_VALUES)[number];

function isActiveKindValue(v: string | undefined): v is ActiveKindValue {
  return (ACTIVE_KIND_VALUES as readonly string[]).includes(v ?? "");
}

const ACTIVE_KIND_LABELS: Record<ActiveKindValue, string> = {
  any: "Any active",
  short: "Short rendering",
  images: "Images rendering",
  voice: "Voice rendering",
  pipeline: "Pipeline running",
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
    /** 2026-06-25 auto-publish cron flag filter. "1" = only flagged
     *  rows; "0" = only NOT-flagged rows; anything else / unset =
     *  no filter. The header status card links into ?flagged=1. */
    flagged?: string;
    /** 2026-06-25 active-render filter. Closed-enum, see
     *  ACTIVE_KIND_VALUES. Unset = no filter. */
    active?: string;
    /** 2026-07-15 Phase 1 free-text search, server-side (title/slug/id/status/
     *  badge). */
    q?: string;
  }>;
}) {
  await requireCapability("content.manage");
  const sp = await searchParams;
  // Categories are DB rows now (the 2026-07-01 taxonomy arc): the 18
  // granular actives drive the chips + the ContentList pickers; the
  // retired legacy six stay valid as a FILTER value only, so old links
  // and not-yet-reclassified stories remain reachable.
  const allCategories = await listCategories({ includeArchived: true });
  const activeCategories = allCategories.filter((c) => c.status === "active");
  const categoryLabels = new Set(allCategories.map((c) => c.label));
  const subKind = isSubKind(sp.kind) ? sp.kind : undefined;
  const status = sp.status || undefined;
  const language = sp.language || undefined;
  // Closed-set guard so a hand-edited URL with `?category=Foo` collapses
  // to "All" instead of producing an empty SQL clause.
  const category =
    sp.category && categoryLabels.has(sp.category) ? sp.category : undefined;
  const publishedOn = parsePlatformList(sp.publishedOn);
  const publishedNotOn = parsePlatformList(sp.publishedNotOn);
  const jobStatus = isJobStatus(sp.jobStatus) ? sp.jobStatus : undefined;
  // 2026-06-25 closed-enum filter: "1" / "0" or no filter. Anything
  // else collapses to "no filter" so a hand-edited URL can't produce
  // a weird third state.
  const flaggedFilter: boolean | undefined =
    sp.flagged === "1" ? true : sp.flagged === "0" ? false : undefined;
  const activeKindFilter: ProgressKind | "any" | undefined =
    isActiveKindValue(sp.active) ? sp.active : undefined;
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
  const flaggedSummary = await getAutoPublishFlaggedSummary();

  // Filters + search that reach the paginated data layer (loadContentPage, via
  // ContentList's client pager). Phase 2 moved the aggregate filters
  // (published-on / not-on / job-status / active-render) into SQL, so they pass
  // through here alongside the real-column filters.
  // Plan: _plans/2026-07-15-content-pagination-and-bulk-safety.md.
  const pageOpts: ContentPageOpts = {
    subKind,
    status,
    language,
    category,
    updatedSince: resolvedRange?.since || undefined,
    updatedUntil: resolvedRange?.until || undefined,
    flagged: flaggedFilter,
    publishedOn: publishedOn.length > 0 ? publishedOn : undefined,
    publishedNotOn: publishedNotOn.length > 0 ? publishedNotOn : undefined,
    jobStatus,
    activeKind: activeKindFilter,
    q: sp.q?.trim() || undefined,
  };

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
      flagged: sp.flagged,
      active: sp.active,
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

  // Active-filter summary for the collapsed FilterPanel header: one chip
  // per dimension (multi-selects join with " + "), each linking to the
  // URL with just that dimension cleared. Everything the operator applied
  // stays visible even while the full chip rows are collapsed.
  const activeFilters: ActiveFilterChip[] = [];
  if (subKind) {
    activeFilters.push({
      key: "Kind",
      label: SUBKIND_FILTER_LABELS[subKind],
      clearHref: `/admin/content${baseQs({ kind: undefined })}`,
    });
  }
  if (status) {
    activeFilters.push({
      key: "Status",
      label: status,
      clearHref: `/admin/content${baseQs({ status: undefined })}`,
    });
  }
  if (category) {
    activeFilters.push({
      key: "Category",
      label: category,
      clearHref: `/admin/content${baseQs({ category: undefined })}`,
    });
  }
  if (language) {
    activeFilters.push({
      key: "Language",
      label:
        ARTICLE_LANGUAGE_LABELS[
          language as keyof typeof ARTICLE_LANGUAGE_LABELS
        ] ?? language,
      clearHref: `/admin/content${baseQs({ language: undefined })}`,
    });
  }
  if (publishedOn.length > 0) {
    activeFilters.push({
      key: "On",
      label: publishedOn.map((p) => PLATFORM_FILTER_LABELS[p]).join(" + "),
      clearHref: `/admin/content${baseQs({ publishedOn: undefined })}`,
    });
  }
  if (publishedNotOn.length > 0) {
    activeFilters.push({
      key: "Not on",
      label: publishedNotOn.map((p) => PLATFORM_FILTER_LABELS[p]).join(" + "),
      clearHref: `/admin/content${baseQs({ publishedNotOn: undefined })}`,
    });
  }
  if (jobStatus) {
    activeFilters.push({
      key: "Job",
      label: jobStatus,
      clearHref: `/admin/content${baseQs({ jobStatus: undefined })}`,
    });
  }
  if (flaggedFilter !== undefined) {
    activeFilters.push({
      key: "Flagged",
      label: flaggedFilter ? "waiting for auto-publish" : "not flagged",
      clearHref: `/admin/content${baseQs({ flagged: undefined })}`,
    });
  }
  if (activeKindFilter) {
    activeFilters.push({
      key: "Active",
      label: ACTIVE_KIND_LABELS[activeKindFilter],
      clearHref: `/admin/content${baseQs({ active: undefined })}`,
    });
  }
  if (updatedBucket) {
    const rangeNote =
      updatedBucket === "custom"
        ? [sp.updatedAfter, sp.updatedBefore].filter(Boolean).join(" → ")
        : "";
    activeFilters.push({
      key: "Updated",
      label: rangeNote
        ? `${DATE_BUCKET_LABELS[updatedBucket]} ${rangeNote}`
        : DATE_BUCKET_LABELS[updatedBucket],
      clearHref: `/admin/content${baseQs({ updatedBucket: undefined, updatedAfter: undefined, updatedBefore: undefined })}`,
    });
  }

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

      {flaggedSummary.flagged > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent/10 px-4 py-2 font-mono text-[11px] text-ink">
          <span>
            <span className="text-accent">{flaggedSummary.flagged}</span>{" "}
            stor{flaggedSummary.flagged === 1 ? "y" : "ies"} flagged for
            auto-publish. The /api/auto_complete_publish cron picks each up
            within ~2 min of being ready.
            {flaggedSummary.struggling > 0 && (
              <>
                {" "}
                <span className="text-danger">
                  {flaggedSummary.struggling}
                </span>{" "}
                {flaggedSummary.struggling === 1 ? "is" : "are"} on attempt
                6+ &mdash; check the Vercel function logs for{" "}
                <span className="text-ink">
                  [auto-complete-publish-cron giveup]
                </span>{" "}
                events.
              </>
            )}
          </span>
          <Link
            href={`/admin/content${baseQs({ flagged: "1" })}`}
            className="rounded-md border border-accent px-2 py-0.5 text-accent transition-colors hover:bg-accent hover:text-bg"
          >
            View {flaggedSummary.flagged}
          </Link>
        </div>
      )}

      <FilterPanel active={activeFilters} clearAllHref="/admin/content">
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
          {activeCategories.map((c) =>
            chip(
              `/admin/content${baseQs({ category: c.label })}`,
              c.label,
              category === c.label,
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
            (video stories only · multi-select for &ldquo;live on all selected&rdquo;)
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
            Flagged
          </span>
          {chip(
            `/admin/content${baseQs({ flagged: undefined })}`,
            "All",
            flaggedFilter === undefined,
          )}
          {chip(
            `/admin/content${baseQs({ flagged: "1" })}`,
            "Waiting for auto-publish",
            flaggedFilter === true,
          )}
          {chip(
            `/admin/content${baseQs({ flagged: "0" })}`,
            "Not flagged",
            flaggedFilter === false,
          )}
          <span className="font-mono text-[10px] text-muted">
            (auto_publish_when_ready · video stories only)
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Active
          </span>
          {chip(
            `/admin/content${baseQs({ active: undefined })}`,
            "All",
            activeKindFilter === undefined,
          )}
          {ACTIVE_KIND_VALUES.map((k) =>
            chip(
              `/admin/content${baseQs({ active: k })}`,
              ACTIVE_KIND_LABELS[k],
              activeKindFilter === k,
            ),
          )}
          <span className="font-mono text-[10px] text-muted">
            (in-flight short/image/voice/pipeline render · video stories only)
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
            {sp.flagged && (
              <input type="hidden" name="flagged" value={sp.flagged} />
            )}
            {sp.active && (
              <input type="hidden" name="active" value={sp.active} />
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
      </FilterPanel>

      <ContentList
        pageOpts={pageOpts}
        categories={activeCategories.map((c) => ({
          label: c.label,
          color: c.color,
        }))}
      />
    </div>
  );
}
