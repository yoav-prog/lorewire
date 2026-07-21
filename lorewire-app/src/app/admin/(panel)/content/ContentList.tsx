"use client";

// Client island for the /admin/content list. Owns:
//   - selection state (multi-row checkboxes + a header "select all" toggle)
//   - a sticky bulk action bar that appears when >=1 row is ticked
//   - a per-row hover ⋯ menu with the same actions, scoped to one row
//   - the shared confirm modal (typed DELETE for destructive ops)
//   - a transient inline undo banner for reversible bulk ops
//
// The list rendering itself replaces the inline `rows.map(<Link>)` block that
// used to live in page.tsx — the rest of the page (heading, filter chips,
// "New article" button) stays a server component.
//
// Plan: _plans/2026-06-19-content-bulk-actions.md.

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
} from "react";
import {
  bulkCompleteAndPublishAction,
  bulkFullPipelineAction,
  bulkPublishToSocialsAction,
  bulkReclassifyContentAction,
  bulkRefreshAssetsAction,
  bulkStopRunsAction,
  bulkUpdateContentAction,
  bulkUpdateContentByFilterAction,
  bulkDeleteContentAction,
  bulkRegenerateContentAction,
  bulkRegenerateTitlesAction,
  bulkRestartPipelineForceAction,
  type BulkActionFailure,
  type BulkActionResult,
  type BulkCompleteAndPublishOutcome,
  type BulkCompleteAndPublishResult,
  type BulkContentItem,
  type BulkFullPipelineOutcome,
  type BulkFullPipelineResult,
  type BulkPublishResult,
  type BulkReclassifyOutcome,
  type BulkReclassifyResult,
  type BulkRefreshAssetsOutcome,
  type BulkRefreshAssetsResult,
  type BulkRegenResult,
  type BulkRegenTarget,
  type BulkRegenTitlesOutcome,
  type BulkRegenTitlesResult,
  type BulkStopRunsResult,
  type BulkUpdateOp,
} from "@/app/admin/actions";
import {
  ARTICLE_LANGUAGE_LABELS,
  ARTICLE_TYPE_LABELS,
  articleDirection,
} from "@/lib/articles";
import type {
  ContentPageOpts,
  ContentRow,
  ContentSubKind,
  ProgressSnapshot,
  PublishedOn,
  SocialPlatform,
} from "@/lib/repo";
import { STATUSES, statusClass } from "@/app/admin/ui";
import { useContentData } from "./useContentData";
import { AutoRefresh } from "./AutoRefresh";
import {
  MAX_BULK_DESTRUCTIVE_ITEMS,
  MAX_BULK_PAID_ITEMS,
  SPEND_CONFIRM_THRESHOLD_USD,
  estimateRegenCostUsd,
} from "@/lib/bulk-safety";
import { TITLE_MAX_CHARS, TITLE_MAX_WORDS } from "@/lib/title-policy";

/** Active category options for the row chip + the bulk picker. Fetched
 *  from the `categories` table by the server page (the 2026-07-01 data-
 *  driven taxonomy) and passed down — the old hardcoded six-item manifest
 *  no longer matches what the classifier writes. */
export interface CategoryOption {
  label: string;
  /** Hex like "#C06234", or null for rows seeded without a color. */
  color: string | null;
}

const SUBKIND_LABELS: Record<ContentSubKind, string> = {
  video: "Video story",
  news: ARTICLE_TYPE_LABELS.news,
  feature: ARTICLE_TYPE_LABELS.feature,
  listicle: ARTICLE_TYPE_LABELS.listicle,
  review: ARTICLE_TYPE_LABELS.review,
};

// Articles only support the 4-step lifecycle; the pipeline-only statuses
// (scripted/rendering/ready) are story-exclusive. Filtering at the UI level
// keeps the bulk bar and the row menu from offering an option that the
// server would reject with `invalid-status-for-article`.
const ARTICLE_STATUSES = ["draft", "review", "published", "archived"] as const;

function statusesFor(kinds: { stories: number; articles: number }): readonly string[] {
  if (kinds.articles === 0) return STATUSES;
  if (kinds.stories === 0) return ARTICLE_STATUSES;
  return ARTICLE_STATUSES;
}

const UNDO_TIMEOUT_MS = 10_000;

// Per-category chip tint. Categories are DB rows now (admin-editable
// hex per row), so the tint is an inline style derived from the hex —
// static Tailwind classes can't exist for runtime-created categories
// (they'd be purged at build). "66"/"26" are the 40%/15% alpha suffixes
// the old --color-cat-* classes used.
const CATEGORY_CHIP_FALLBACK_CLASS = "border-line bg-bg text-muted";
function categoryChipStyle(
  color: string | null | undefined,
): CSSProperties | undefined {
  if (!color) return undefined;
  return {
    borderColor: `${color}66`,
    backgroundColor: `${color}26`,
    color,
  };
}

// 2026-06-24 latest pipeline-job state per row. Explicit class strings (no
// dynamic Tailwind generation) so the purge step keeps them in the prod
// bundle, matching the category chip pattern above. `processing` gets a
// subtle animated pulse — the only state that's actively changing.
const JOB_STATUS_CHIP_CLASS: Record<
  NonNullable<ContentRow["job_status"]>,
  string
> = {
  queued: "border-warn/40 bg-warn/15 text-warn",
  processing: "border-warn/40 bg-warn/20 text-warn animate-pulse",
  done: "border-cat-wholesome/40 bg-cat-wholesome/15 text-cat-wholesome",
  error: "border-danger/40 bg-danger/15 text-danger",
};

const JOB_STATUS_LABEL: Record<
  NonNullable<ContentRow["job_status"]>,
  string
> = {
  queued: "queued",
  processing: "processing",
  done: "done",
  error: "error",
};

type Kind = "story" | "article";

interface UndoState {
  op: BulkUpdateOp;
  prev: Record<string, string | null>;
}

interface ConfirmState {
  verb: string;
  items: BulkContentItem[];
  op: BulkUpdateOp | { type: "delete" };
  destructive: boolean;
  /** Select-all-matching: run the op against every row matching the current
   *  filter (server-resolved), not just `items`. `matchingTotal` is the count
   *  shown in the confirm. Cheap status / category ops only. */
  byFilter?: boolean;
  matchingTotal?: number;
}

function rowKey(kind: Kind, id: string): string {
  return `${kind}:${id}`;
}

function rowHref(row: ContentRow): string {
  return row.kind === "story"
    ? `/admin/stories/${row.id}`
    : `/admin/articles/${row.id}`;
}

function describeReason(reason: string): string {
  if (reason.startsWith("alt-missing-")) {
    const n = reason.slice("alt-missing-".length);
    return `${n} images missing alt text`;
  }
  switch (reason) {
    case "not-found":
      return "row not found (already removed?)";
    case "kind-mismatch-category":
      return "category only applies to video stories";
    case "invalid-status-for-story":
      return "this status is not valid for a video story";
    case "invalid-status-for-article":
      return "this status is not valid for an article";
    case "not-a-story":
      return "regenerate targets only apply to video stories";
    case "daily-budget-exceeded":
      return "today's image budget is spent — raise the cap in Settings or wait until tomorrow";
    case "empty-body":
      return "story has no body to synthesize";
    case "race-loss":
      return "already in flight (skipped)";
    case "no-reddit-source":
      return "story has no reddit_id — pipeline restart not available";
    case "pipeline-already-running":
      return "pipeline already running for this story";
    case "reddit-source-locked":
      return "reddit source is used or skipped — pipeline cannot re-run";
    case "reddit-source-skipped":
      return "you skipped this source — hit Re-run anyway to override";
    case "not-enqueued":
      return "could not enqueue (no matching reddit source)";
    default:
      return reason;
  }
}

// 2026-06-24 per-platform metadata for the per-row icons + the bulk
// publish-to-socials picker. Letter badges (F/I/Y/T) with brand colors
// keep the bundle dependency-free; full logos require licensing care
// and add weight for marginal admin-only value. Hover label surfaces
// the platform name + "live on …" tooltip.
const PLATFORM_META: Record<
  SocialPlatform,
  { label: string; letter: string; chipClass: string }
> = {
  facebook: {
    label: "Facebook",
    letter: "F",
    chipClass: "border-[#1877F2]/60 bg-[#1877F2]/15 text-[#1877F2]",
  },
  instagram: {
    label: "Instagram",
    letter: "I",
    chipClass:
      "border-[#E1306C]/60 bg-gradient-to-br from-[#F58529]/15 via-[#DD2A7B]/15 to-[#8134AF]/15 text-[#E1306C]",
  },
  youtube: {
    label: "YouTube",
    letter: "Y",
    chipClass: "border-[#FF0000]/60 bg-[#FF0000]/15 text-[#FF0000]",
  },
  tiktok: {
    label: "TikTok",
    letter: "T",
    chipClass: "border-[#25F4EE]/60 bg-black/40 text-[#25F4EE]",
  },
};

const PLATFORMS_ORDER: SocialPlatform[] = [
  "facebook",
  "instagram",
  "youtube",
  "tiktok",
];

// 2026-06-24 bulk regen targets surfaced under the Regenerate ▾ picker in the
// bulk action bar. Each picks the same primitive the single-story editor
// already uses; cost hints feed the confirm modal so a 30-story click that
// would queue 900 i2i calls is never a surprise.
const REGEN_TARGET_META: Record<
  BulkRegenTarget,
  {
    label: string;
    verb: string;
    perStoryHint: string;
    body: string;
  }
> = {
  hero: {
    label: "Hero image",
    verb: "Regenerate hero images",
    perStoryHint: "~1 i2i call per story",
    body: "Queues a hero re-render per story. Each story passes through the daily image-budget gate, so spend pauses once today's cap is reached.",
  },
  hero_thumbnail: {
    label: "Hero + thumbnails (from short)",
    verb: "Regenerate hero + thumbnails",
    perStoryHint: "5 i2i calls per story (~$0.25)",
    body: "Rebuilds the full poster set per story from the short's character + a picker-chosen scene: the clean hero (portrait + landscape) AND the three title-baked thumbnails. Use this when the hero and the card thumbnail stopped matching. Each story passes through the daily image-budget gate.",
  },
  scenes: {
    label: "Scene images (article illustrations)",
    verb: "Regenerate all scene images",
    perStoryHint: "~30 i2i calls per story (varies by duration)",
    body: "Queues a per-scene rebuild for each story's stories.images set — the inline article illustrations. Largest bulk op. Each story passes through the daily image-budget gate.",
  },
  voice: {
    label: "Voiceover",
    verb: "Regenerate voiceovers",
    perStoryHint:
      "1 TTS run per story (~$0.04 ElevenLabs Flash, ~$0.38 Multilingual)",
    body: "Queues a TTS re-synthesis per story using each story's voice override (provider + voice id). Already-in-flight stories are skipped, not double-charged.",
  },
  pipeline: {
    label: "Restart entire pipeline (article + media)",
    verb: "Restart the entire pipeline",
    perStoryHint: "≈ $0.50 per story (LLM + TTS + images + assembly)",
    body: "Re-runs the Python story_jobs pipeline from script onward. Replaces script, voice, scenes, hero, short, article. Already-shipped stories re-run too — they drop off the public site while they rewrite (~30-60s) and reappear when done. Sources you previously skipped are left alone; use Re-run anyway on those. Pre-pipeline manual seeds (no reddit source) can't be re-run this way.",
  },
  // 2026-06-28 short re-render target. Re-runs the full shorts pipeline so
  // the LLM is called against the CURRENT shorts_narration prompt — the only
  // way the latest rules (hook-first structure + clarity bar + POV) reach
  // an existing short's script. See _plans/2026-06-28-bulk-regen-shorts.md.
  short: {
    label: "Short video (hook-first rebuild)",
    verb: "Regenerate short video",
    perStoryHint: "≈ $1.13 per story (LLM + ~22 images + voice + render)",
    body: "Re-runs the full short pipeline on the current hook-first flow — hook first, then intro, story, outro — with the locked brand voice rules: fresh script (third-person narrator, hook names the loss directly), fresh scene art, fresh narration, fresh MP4. Replaces the existing MP4 when done. Hero + thumbnails are NOT touched — pick Restart short + hero + thumbnails for that. In-flight renders are skipped.",
  },
};

// The Regenerate menu also offers the refresh-assets chain (voice → short →
// hero + 5 thumbnails, /api/refresh_assets cron) under a name that says what
// it does. It is not a BulkRegenTarget — the picker routes it to the
// existing bulk Refresh assets flow, which has its own confirm + banner.
const RESTART_SHORT_MENU_VALUE = "restart-short-everything";

export function ContentList({
  pageOpts,
  categories,
}: {
  pageOpts: ContentPageOpts;
  categories: CategoryOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { rows, total, loading, loadingMore, reachedEnd, loadMore, refresh } =
    useContentData(pageOpts);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [typedConfirm, setTypedConfirm] = useState("");
  const [failures, setFailures] = useState<
    { kind: Kind; id: string; reason: string }[]
  >([]);
  // 2026-07-15 danger-cap notice. Set when a destructive / paid bulk action is
  // attempted on more rows than @/lib/bulk-safety allows, so the operator gets
  // a plain message instead of a raw server "exceeds N items" error. The server
  // enforces the same caps regardless. Plan:
  // _plans/2026-07-15-content-pagination-and-bulk-safety.md.
  const [dangerNotice, setDangerNotice] = useState<string | null>(null);
  // 2026-07-15 select-all-matching. When the whole loaded page is ticked and
  // more rows match the filter, the operator can extend a CHEAP status /
  // category op to all matching rows (server-resolved). Only meaningful while
  // every loaded row is selected — `matchingMode` below gates on that.
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Search box value. Local state for typing responsiveness; a debounced effect
  // pushes it to the URL (?q=), which re-derives pageOpts and refetches page 1
  // server-side. Initialised from the URL so a shared / refreshed link keeps it.
  const [searchInput, setSearchInput] = useState(pageOpts.q ?? "");
  // 2026-06-24 bulk regen. `regenConfirm` opens the cost modal; `regenResult`
  // surfaces the post-run "queued N, failed M" banner so the operator sees
  // exactly what landed without scrolling to per-story render lines.
  const [regenConfirm, setRegenConfirm] = useState<{
    target: BulkRegenTarget;
    items: BulkContentItem[];
  } | null>(null);
  const [regenResult, setRegenResult] = useState<BulkRegenResult | null>(null);
  // 2026-06-24 bulk publish-to-socials picker state. `pickedPlatforms`
  // is the multi-select inside the dropdown; `publishResult` surfaces
  // the post-run banner. Plan:
  // _plans/2026-06-24-bulk-publish-from-content.md.
  const [publishResult, setPublishResult] = useState<BulkPublishResult | null>(
    null,
  );
  // 2026-06-25 bulk complete-and-publish. `completeConfirm` opens the
  // cost confirmation; `completeResult` shows the per-row outcome
  // banner after the action returns. Plan:
  // _plans/2026-06-25-bulk-complete-and-publish.md.
  const [completeConfirm, setCompleteConfirm] = useState<
    BulkContentItem[] | null
  >(null);
  const [completeResult, setCompleteResult] =
    useState<BulkCompleteAndPublishResult | null>(null);
  // 2026-06-25 bulk refresh-assets state machine click + result.
  // Different from Complete & publish: this regenerates voice +
  // short + hero+thumbnails for stories that already have all the
  // assets but rendered with older defaults (old voice, hero not
  // aligned to the short character). Preserves story_id / URL / SEO /
  // comments. Plan: _plans/2026-06-25-bulk-complete-and-publish.md
  // follow-up.
  const [refreshConfirm, setRefreshConfirm] = useState<
    BulkContentItem[] | null
  >(null);
  const [refreshResult, setRefreshResult] =
    useState<BulkRefreshAssetsResult | null>(null);
  // 2026-07-02 bulk full pipeline & publish. Same confirm/result pattern
  // as the other bulk flows. Plan:
  // _plans/2026-07-02-content-admin-cleanup-and-full-pipeline.md.
  const [fullPipelineConfirm, setFullPipelineConfirm] = useState<
    BulkContentItem[] | null
  >(null);
  const [fullPipelineResult, setFullPipelineResult] =
    useState<BulkFullPipelineResult | null>(null);
  // 2026-07-03 STOP RUNS: cancel everything in flight for the selected
  // rows. Result banner shows per-kind cancel counts. Plan:
  // _plans/2026-07-03-unified-live-runs-and-stop.md.
  const [stopRunsResult, setStopRunsResult] =
    useState<BulkStopRunsResult | null>(null);
  // 2026-07-05 bulk AI reclassify: re-run the multi-tag classifier on the
  // selection. Same confirm/result pattern as the other bulk flows. Plan:
  // _plans/2026-07-05-bulk-ai-reclassify.md.
  const [reclassifyConfirm, setReclassifyConfirm] = useState<
    BulkContentItem[] | null
  >(null);
  const [reclassifyResult, setReclassifyResult] =
    useState<BulkReclassifyResult | null>(null);
  // 2026-07-15 bulk "Regenerate titles": rewrite too-long story titles with
  // the branded prompt. Pairs with the "Title: Too long" filter. Same
  // confirm/result pattern as reclassify (per-story synchronous LLM). Plan:
  // _plans/2026-07-15-too-long-title-filter-and-bulk-fix.md.
  const [titleRegenConfirm, setTitleRegenConfirm] = useState<
    BulkContentItem[] | null
  >(null);
  const [titleRegenResult, setTitleRegenResult] =
    useState<BulkRegenTitlesResult | null>(null);
  // label → color hex for the row chips; misses (legacy / unclassified
  // labels) fall back to the muted chip class.
  const categoryColorByLabel = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const c of categories) m.set(c.label, c.color);
    return m;
  }, [categories]);

  // Cancel any pending undo timer when the component unmounts so a navigation
  // away doesn't leak a stale setState.
  useEffect(() => {
    return () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    };
  }, []);

  // Debounce the search box into the URL (?q=). router.replace keeps history
  // clean; page.tsx reads ?q= back into pageOpts and useContentData refetches
  // page 1 from the server. The no-op guard stops a URL echo (pageOpts.q ===
  // searchInput after navigation) from re-pushing.
  useEffect(() => {
    if (searchInput === (pageOpts.q ?? "")) return;
    const t = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (searchInput.trim()) params.set("q", searchInput.trim());
      else params.delete("q");
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, pageOpts.q, searchParams, pathname, router]);

  const rowByKey = useMemo(() => {
    const m = new Map<string, ContentRow>();
    for (const r of rows) m.set(rowKey(r.kind, r.id), r);
    return m;
  }, [rows]);

  // Search + filtering are server-side now, so the loaded set IS the visible
  // set. This keyset drives select-all-loaded.
  const loadedKeySet = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) s.add(rowKey(r.kind, r.id));
    return s;
  }, [rows]);

  // selectedItems is the source of truth for "what's actually actionable".
  // Stale keys (selected rows that vanished after a filter change or a
  // delete) silently drop out here rather than being explicitly cleared,
  // which both avoids the setState-in-effect anti-pattern and preserves
  // selection across filter changes — handy when the operator filters,
  // ticks, switches filter, and comes back.
  const selectedItems: BulkContentItem[] = useMemo(() => {
    const items: BulkContentItem[] = [];
    for (const key of selected) {
      const r = rowByKey.get(key);
      if (r) items.push({ kind: r.kind, id: r.id });
    }
    return items;
  }, [selected, rowByKey]);

  const counts = useMemo(() => {
    let stories = 0;
    let articles = 0;
    for (const item of selectedItems) {
      if (item.kind === "story") stories += 1;
      else articles += 1;
    }
    return { stories, articles, total: selectedItems.length };
  }, [selectedItems]);

  const anySelected = counts.total > 0;
  // Header checkbox tracks the loaded set (server search/filters already
  // narrowed it). Select-all ticks every row loaded so far; Load more brings in
  // more rows the operator can then tick.
  const allLoadedSelected = useMemo(() => {
    if (rows.length === 0) return false;
    for (const key of loadedKeySet) {
      if (!selected.has(key)) return false;
    }
    return true;
  }, [rows, loadedKeySet, selected]);

  // Effective select-all-matching: armed, the whole loaded page ticked, and
  // more rows actually match. Un-ticking a row, changing the filter (new rows
  // aren't ticked), or clearing all collapses it automatically.
  const matchingMode =
    selectAllMatching &&
    allLoadedSelected &&
    total != null &&
    total > rows.length;

  function toggleOne(kind: Kind, id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = rowKey(kind, id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      console.info("[content list selection]", { count: next.size });
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allLoadedSelected) {
        for (const key of loadedKeySet) next.delete(key);
      } else {
        for (const key of loadedKeySet) next.add(key);
      }
      console.info("[content list selection]", { count: next.size });
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
    setSelectAllMatching(false);
  }

  // Open the confirm modal with the chosen action. Per-row actions reuse this
  // by passing a one-item array, so there's exactly one execution path.
  // Block a destructive / paid bulk action that exceeds its server cap — with a
  // clear message, before any confirm opens or the server is called. Returns
  // true when blocked. Clears the notice when within cap. Mirrors the caps in
  // @/lib/bulk-safety, which the server enforces regardless (defense in depth).
  function overDangerCap(count: number, cap: number, verb: string): boolean {
    if (count <= cap) {
      setDangerNotice(null);
      return false;
    }
    setDangerNotice(
      `${verb} runs on at most ${cap} at a time — you have ${count} selected. Narrow the selection, then try again.`,
    );
    return true;
  }

  function requestAction(
    items: BulkContentItem[],
    op: BulkUpdateOp | { type: "delete" },
    byFilter = false,
  ) {
    if (items.length === 0) return;
    if (
      op.type === "delete" &&
      overDangerCap(items.length, MAX_BULK_DESTRUCTIVE_ITEMS, "Delete")
    ) {
      return;
    }
    setTypedConfirm("");
    setFailures([]);
    setDangerNotice(null);
    const verb =
      op.type === "delete"
        ? "Delete"
        : op.type === "status"
          ? op.status === "published"
            ? "Publish"
            : op.status === "draft"
              ? "Unpublish"
              : `Set status to "${op.status}"`
          : `Set category to "${op.category}"`;
    setConfirm({
      verb,
      items,
      op,
      destructive: op.type === "delete",
      byFilter,
      matchingTotal: byFilter ? (total ?? items.length) : undefined,
    });
  }

  function clearUndo() {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = null;
    setUndo(null);
  }

  function scheduleUndo(op: BulkUpdateOp, prev: Record<string, string | null>) {
    if (Object.keys(prev).length === 0) return;
    setUndo({ op, prev });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_TIMEOUT_MS);
  }

  function runUndo() {
    if (!undo) return;
    const reversals = new Map<string, BulkContentItem[]>();
    for (const [key, prevValue] of Object.entries(undo.prev)) {
      if (prevValue == null) continue;
      const [kind, id] = key.split(":") as [Kind, string];
      const bucket = reversals.get(prevValue) ?? [];
      bucket.push({ kind, id });
      reversals.set(prevValue, bucket);
    }
    if (reversals.size === 0) {
      clearUndo();
      return;
    }
    console.info("[content list undo]", {
      type: undo.op.type,
      count: Object.keys(undo.prev).length,
    });
    const opType = undo.op.type;
    startTransition(async () => {
      for (const [value, items] of reversals.entries()) {
        const op: BulkUpdateOp =
          opType === "status"
            ? { type: "status", status: value }
            : { type: "category", category: value };
        try {
          await bulkUpdateContentAction(items, op);
        } catch (err) {
          console.error("[content list undo failed]", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      clearUndo();
      router.refresh();
    });
  }

  function runConfirmed() {
    if (!confirm) return;
    const { items, op, byFilter } = confirm;
    console.info("[content list bulk submit]", {
      type: op.type,
      count: items.length,
    });
    startTransition(async () => {
      let result: BulkActionResult;
      try {
        if (op.type === "delete") {
          result = await bulkDeleteContentAction(items);
        } else if (byFilter) {
          // Select-all-matching: apply to every row matching the filter,
          // server-resolved. Cheap ops only (paid/destructive never set this).
          result = await bulkUpdateContentByFilterAction(pageOpts, op);
        } else {
          result = await bulkUpdateContentAction(items, op);
        }
      } catch (err) {
        setFailures([
          {
            kind: items[0].kind,
            id: items[0].id,
            reason: err instanceof Error ? err.message : String(err),
          },
        ]);
        setConfirm(null);
        return;
      }
      setFailures(result.failed);
      setConfirm(null);
      // Undo replays through the per-id action (capped) — skip it for a
      // by-filter run that could span far more rows than that.
      if (op.type !== "delete" && !byFilter && result.ok.length > 0) {
        scheduleUndo(op, result.prev);
      }
      clearSelection();
      router.refresh();
    });
  }

  // 2026-06-28: rows eligible for the "Regenerate all published shorts"
  // one-click — published stories. ContentRow doesn't carry video_url, so
  // we lean on status as the proxy: a published story has, by convention,
  // already been through the short pipeline. Edge cases (published with
  // no short) are caught by the cost-preview modal so the operator can
  // bail. See _plans/2026-06-28-bulk-regen-shorts.md.
  const publishedShortsItems = useMemo<BulkContentItem[]>(() => {
    return rows
      .filter((r) => r.kind === "story" && r.status === "published")
      .map((r) => ({ kind: "story", id: r.id }));
  }, [rows]);

  function requestRegen(target: BulkRegenTarget) {
    // Filter to stories at the request edge — the server enforces this too
    // (articles come back with reason "not-a-story") but stripping client-
    // side keeps the modal's "0 articles will be skipped" copy honest.
    const storyItems = selectedItems.filter((i) => i.kind === "story");
    if (storyItems.length === 0) return;
    if (overDangerCap(storyItems.length, MAX_BULK_PAID_ITEMS, "Regenerate"))
      return;
    console.info("[content list regen request]", {
      target,
      count: storyItems.length,
    });
    setRegenResult(null);
    setRegenConfirm({ target, items: storyItems });
  }

  function runRegenConfirmed() {
    if (!regenConfirm) return;
    const { target, items } = regenConfirm;
    console.info("[content list regen submit]", {
      target,
      count: items.length,
    });
    startTransition(async () => {
      // Fire in batches of MAX_BULK_PAID_ITEMS so each server call stays under
      // the paid cap while the sanctioned "Regenerate ALL published shorts"
      // rebuild (which can far exceed it) still runs from one click + the
      // cost/typed-count confirm. Sequential, not parallel: the server's
      // per-story image-budget gate needs to see the running total, the same
      // reason the action loop itself is sequential. Post-pagination
      // "rebuild thousands" should graduate to an async job (Phase 1).
      const result: BulkRegenResult = { target, ok: [], failed: [] };
      for (let i = 0; i < items.length; i += MAX_BULK_PAID_ITEMS) {
        const batch = items.slice(i, i + MAX_BULK_PAID_ITEMS);
        try {
          const r = await bulkRegenerateContentAction(batch, target);
          result.ok.push(...r.ok);
          result.failed.push(...r.failed);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          for (const it of batch) result.failed.push({ ...it, reason });
        }
      }
      console.info("[content list regen result]", {
        target,
        ok: result.ok.length,
        failed: result.failed.length,
        batches: Math.ceil(items.length / MAX_BULK_PAID_ITEMS),
      });
      setRegenConfirm(null);
      setRegenResult(result);
      clearSelection();
      router.refresh();
    });
  }

  // 2026-07-19 "Re-run anyway" — the override behind a reddit-source-skipped
  // failure in the pipeline restart banner. Un-skips + re-enqueues exactly the
  // refused rows through the force action, then replaces the banner with the
  // fresh result so the operator sees whether the override took.
  function runRestartForce(failedItems: BulkActionFailure[]) {
    const items: BulkContentItem[] = failedItems.map((f) => ({
      kind: f.kind,
      id: f.id,
    }));
    if (items.length === 0) return;
    console.info("[content list restart-force request]", {
      count: items.length,
    });
    startTransition(async () => {
      const result = await bulkRestartPipelineForceAction(items);
      console.info("[content list restart-force result]", {
        ok: result.ok.length,
        failed: result.failed.length,
      });
      setRegenResult(result);
      clearSelection();
      router.refresh();
    });
  }

  // 2026-07-03 STOP RUNS. window.confirm (not the typed-confirm modal)
  // because stopping is recoverable — anything cancelled can simply be
  // re-queued; the copy still says spend already incurred is gone.
  function runStopRuns() {
    if (selectedItems.length === 0) return;
    const ok = window.confirm(
      `Stop all runs for ${selectedItems.length} selected item${selectedItems.length === 1 ? "" : "s"}?\n\n` +
        "Queued and in-flight work settles as cancelled: image renders, voiceovers, shorts, pipeline jobs, pending hero+thumbnail finishers, and refresh chains. Spend already incurred is non-refundable.",
    );
    if (!ok) return;
    console.info("[content list stop-runs request]", {
      count: selectedItems.length,
    });
    setStopRunsResult(null);
    startTransition(async () => {
      try {
        const result = await bulkStopRunsAction(selectedItems);
        console.info("[content list stop-runs result]", result.counts);
        setStopRunsResult(result);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error("[content list stop-runs failed]", { error: reason });
        setFailures([{ ...selectedItems[0], reason }]);
      }
      clearSelection();
      router.refresh();
    });
  }

  function runBulkPublish(platforms: SocialPlatform[]) {
    // Stories-only at the request edge — server enforces too but trimming
    // here keeps the result banner honest. Articles in the selection would
    // otherwise land in the skipped bucket with N platforms each.
    const storyItems = selectedItems.filter((i) => i.kind === "story");
    if (storyItems.length === 0 || platforms.length === 0) return;
    if (
      overDangerCap(storyItems.length, MAX_BULK_PAID_ITEMS, "Publish to socials")
    )
      return;
    console.info("[content list bulk-publish request]", {
      count: storyItems.length,
      platforms,
    });
    setPublishResult(null);
    startTransition(async () => {
      let result: BulkPublishResult;
      try {
        result = await bulkPublishToSocialsAction(storyItems, platforms);
      } catch (err) {
        result = {
          posted: [],
          pending: [],
          skipped: [],
          failed: storyItems.flatMap((it) =>
            platforms.map((p) => ({
              ...it,
              platform: p,
              reason: err instanceof Error ? err.message : String(err),
            })),
          ),
        };
      }
      console.info("[content list bulk-publish result]", {
        posted: result.posted.length,
        pending: result.pending.length,
        failed: result.failed.length,
        skipped: result.skipped.length,
      });
      setPublishResult(result);
      clearSelection();
      router.refresh();
    });
  }

  function requestComplete() {
    const storyItems = selectedItems.filter((i) => i.kind === "story");
    if (storyItems.length === 0) return;
    if (overDangerCap(storyItems.length, MAX_BULK_PAID_ITEMS, "Complete & publish"))
      return;
    setCompleteResult(null);
    setCompleteConfirm(storyItems);
  }

  function runCompleteConfirmed() {
    if (!completeConfirm) return;
    const items = completeConfirm;
    console.info("[content list complete-and-publish request]", {
      count: items.length,
    });
    startTransition(async () => {
      let result: BulkCompleteAndPublishResult;
      try {
        result = await bulkCompleteAndPublishAction(items);
      } catch (err) {
        result = {
          flaggedCount: 0,
          skippedCount: 0,
          erroredCount: items.length,
          outcomes: items.map((it) => ({
            kind: it.kind,
            id: it.id,
            state: "errored" as const,
            missing: [],
            enqueued: [],
            reason: err instanceof Error ? err.message : String(err),
          })),
        };
      }
      console.info("[content list complete-and-publish result]", {
        flaggedCount: result.flaggedCount,
        skippedCount: result.skippedCount,
        erroredCount: result.erroredCount,
      });
      setCompleteConfirm(null);
      setCompleteResult(result);
      clearSelection();
      router.refresh();
    });
  }

  function requestRefresh() {
    const storyItems = selectedItems.filter((i) => i.kind === "story");
    if (storyItems.length === 0) return;
    if (overDangerCap(storyItems.length, MAX_BULK_PAID_ITEMS, "Refresh assets"))
      return;
    setRefreshResult(null);
    setRefreshConfirm(storyItems);
  }

  function runRefreshConfirmed() {
    if (!refreshConfirm) return;
    const items = refreshConfirm;
    console.info("[content list refresh-assets request]", {
      count: items.length,
    });
    startTransition(async () => {
      let result: BulkRefreshAssetsResult;
      try {
        result = await bulkRefreshAssetsAction(items);
      } catch (err) {
        result = {
          startedCount: 0,
          alreadyRefreshingCount: 0,
          skippedCount: 0,
          erroredCount: items.length,
          outcomes: items.map((it) => ({
            kind: it.kind,
            id: it.id,
            state: "errored" as const,
            reason: err instanceof Error ? err.message : String(err),
          })),
        };
      }
      console.info("[content list refresh-assets result]", {
        startedCount: result.startedCount,
        alreadyRefreshingCount: result.alreadyRefreshingCount,
        skippedCount: result.skippedCount,
        erroredCount: result.erroredCount,
      });
      setRefreshConfirm(null);
      setRefreshResult(result);
      clearSelection();
      router.refresh();
    });
  }

  function requestFullPipeline() {
    const storyItems = selectedItems.filter((i) => i.kind === "story");
    if (storyItems.length === 0) return;
    if (overDangerCap(storyItems.length, MAX_BULK_PAID_ITEMS, "Full pipeline"))
      return;
    setFullPipelineResult(null);
    setFullPipelineConfirm(storyItems);
  }

  function runFullPipelineConfirmed() {
    if (!fullPipelineConfirm) return;
    const items = fullPipelineConfirm;
    console.info("[content list full-pipeline request]", {
      count: items.length,
    });
    startTransition(async () => {
      let result: BulkFullPipelineResult;
      try {
        result = await bulkFullPipelineAction(items);
      } catch (err) {
        result = {
          startedCount: 0,
          skippedCount: 0,
          erroredCount: items.length,
          outcomes: items.map((it) => ({
            kind: it.kind,
            id: it.id,
            state: "errored" as const,
            reason: err instanceof Error ? err.message : String(err),
          })),
        };
      }
      console.info("[content list full-pipeline result]", {
        startedCount: result.startedCount,
        skippedCount: result.skippedCount,
        erroredCount: result.erroredCount,
      });
      setFullPipelineConfirm(null);
      setFullPipelineResult(result);
      clearSelection();
      router.refresh();
    });
  }

  function requestReclassify() {
    const storyItems = selectedItems.filter((i) => i.kind === "story");
    if (storyItems.length === 0) return;
    setReclassifyResult(null);
    setReclassifyConfirm(storyItems);
  }

  function runReclassifyConfirmed() {
    if (!reclassifyConfirm) return;
    const items = reclassifyConfirm;
    console.info("[content list reclassify-ai request]", {
      count: items.length,
    });
    startTransition(async () => {
      let result: BulkReclassifyResult;
      try {
        result = await bulkReclassifyContentAction(items);
      } catch (err) {
        result = {
          retaggedCount: 0,
          unchangedCount: 0,
          needsReviewCount: 0,
          skippedCount: 0,
          erroredCount: items.length,
          outcomes: items.map((it) => ({
            kind: it.kind,
            id: it.id,
            state: "errored" as const,
            reason: err instanceof Error ? err.message : String(err),
          })),
        };
      }
      console.info("[content list reclassify-ai result]", {
        retaggedCount: result.retaggedCount,
        unchangedCount: result.unchangedCount,
        needsReviewCount: result.needsReviewCount,
        skippedCount: result.skippedCount,
        erroredCount: result.erroredCount,
      });
      setReclassifyConfirm(null);
      setReclassifyResult(result);
      clearSelection();
      router.refresh();
    });
  }

  function requestTitleRegen() {
    const storyItems = selectedItems.filter((i) => i.kind === "story");
    if (storyItems.length === 0) return;
    if (overDangerCap(storyItems.length, MAX_BULK_PAID_ITEMS, "Regenerate titles"))
      return;
    setTitleRegenResult(null);
    setTitleRegenConfirm(storyItems);
  }

  function runTitleRegenConfirmed() {
    if (!titleRegenConfirm) return;
    const items = titleRegenConfirm;
    console.info("[content list title-regen request]", {
      count: items.length,
    });
    startTransition(async () => {
      let result: BulkRegenTitlesResult;
      try {
        result = await bulkRegenerateTitlesAction(items);
      } catch (err) {
        result = {
          regeneratedCount: 0,
          skippedCount: 0,
          erroredCount: items.length,
          outcomes: items.map((it) => ({
            kind: it.kind,
            id: it.id,
            state: "errored" as const,
            reason: err instanceof Error ? err.message : String(err),
          })),
        };
      }
      console.info("[content list title-regen result]", {
        regeneratedCount: result.regeneratedCount,
        skippedCount: result.skippedCount,
        erroredCount: result.erroredCount,
      });
      setTitleRegenConfirm(null);
      setTitleRegenResult(result);
      clearSelection();
      router.refresh();
    });
  }

  // --- render ---------------------------------------------------------------

  return (
    <>
      {undo && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent/10 px-4 py-2 font-mono text-[11px] text-ink">
          <span>
            Applied to {Object.keys(undo.prev).length}{" "}
            {Object.keys(undo.prev).length === 1 ? "item" : "items"}.
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={runUndo}
              disabled={pending}
              className="rounded-md border border-accent px-2 py-0.5 text-accent transition-colors hover:bg-accent hover:text-bg disabled:cursor-not-allowed disabled:opacity-40"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={clearUndo}
              className="text-muted transition-colors hover:text-ink"
              aria-label="Dismiss"
            >
              ×
            </button>
          </span>
        </div>
      )}

      {dangerNotice && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-warn/40 bg-warn/10 px-4 py-2 font-mono text-[11px] text-ink">
          <span>{dangerNotice}</span>
          <button
            type="button"
            onClick={() => setDangerNotice(null)}
            className="text-muted transition-colors hover:text-ink"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {failures.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-danger/40 bg-danger/10 p-3 font-mono text-[11px] text-danger">
          {failures.map((f, i) => {
            const r = rowByKey.get(rowKey(f.kind, f.id));
            const label = r?.title ?? r?.slug ?? f.id.slice(0, 8);
            return (
              <li key={i}>
                <span className="text-ink">{label}</span>
                <span className="opacity-70"> — {describeReason(f.reason)}</span>
              </li>
            );
          })}
        </ul>
      )}

      {regenResult && (
        <RegenResultBanner
          result={regenResult}
          rowByKey={rowByKey}
          pending={pending}
          onRerunSkipped={runRestartForce}
          onDismiss={() => setRegenResult(null)}
        />
      )}

      {publishResult && (
        <BulkPublishResultBanner
          result={publishResult}
          rowByKey={rowByKey}
          onDismiss={() => setPublishResult(null)}
        />
      )}

      {completeResult && (
        <CompleteResultBanner
          result={completeResult}
          rowByKey={rowByKey}
          onDismiss={() => setCompleteResult(null)}
        />
      )}

      {refreshResult && (
        <RefreshResultBanner
          result={refreshResult}
          rowByKey={rowByKey}
          onDismiss={() => setRefreshResult(null)}
        />
      )}

      {fullPipelineResult && (
        <FullPipelineResultBanner
          result={fullPipelineResult}
          rowByKey={rowByKey}
          onDismiss={() => setFullPipelineResult(null)}
        />
      )}

      {stopRunsResult && (
        <StopRunsResultBanner
          result={stopRunsResult}
          onDismiss={() => setStopRunsResult(null)}
        />
      )}

      {reclassifyResult && (
        <ReclassifyResultBanner
          result={reclassifyResult}
          rowByKey={rowByKey}
          onDismiss={() => setReclassifyResult(null)}
        />
      )}

      {titleRegenResult && (
        <TitleRegenResultBanner
          result={titleRegenResult}
          rowByKey={rowByKey}
          onDismiss={() => setTitleRegenResult(null)}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-2">
        <span className="font-mono text-[11px] text-muted">
          Rebuild <span className="text-ink">{publishedShortsItems.length}</span>{" "}
          published {publishedShortsItems.length === 1 ? "short" : "shorts"} on
          the current hook-first flow (hook → intro → story → outro)?
          {publishedShortsItems.length === 0 ? " Nothing to rebuild." : ""}
        </span>
        <button
          type="button"
          onClick={() => {
            if (publishedShortsItems.length === 0) return;
            console.info("[content list regen request]", {
              target: "short",
              count: publishedShortsItems.length,
              source: "regen-all-button",
            });
            setRegenResult(null);
            setRegenConfirm({ target: "short", items: publishedShortsItems });
          }}
          disabled={pending || publishedShortsItems.length === 0}
          title="Re-render every published story's short on the current hook-first flow (hook → intro → story → outro) with the locked brand voice rules. Cost is surfaced before commit."
          className="rounded-md border border-accent/50 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-accent transition-colors hover:bg-accent hover:text-bg disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending
            ? "Working…"
            : `Regenerate ALL published shorts (${publishedShortsItems.length})`}
        </button>
      </div>

      <div className="relative">
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search title, slug, category, status, id…"
          aria-label="Search content"
          className="w-full rounded-xl border border-line bg-surface px-4 py-2 pr-9 text-[13px] text-ink placeholder:text-muted focus:border-accent focus:outline-none"
        />
        {searchInput && (
          <button
            type="button"
            onClick={() => setSearchInput("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-0.5 font-mono text-[12px] text-muted transition-colors hover:text-ink"
          >
            ×
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        {loading && rows.length === 0 ? (
          <p className="bg-surface p-6 text-center text-[14px] text-muted">
            Loading…
          </p>
        ) : rows.length === 0 ? (
          <p className="bg-surface p-6 text-center text-[14px] text-muted">
            {searchInput.trim() ? (
              <>
                No content matches{" "}
                <span className="font-mono text-ink">
                  &ldquo;{searchInput.trim()}&rdquo;
                </span>
                .
              </>
            ) : (
              "No content matches these filters."
            )}
          </p>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-line bg-surface2 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-muted">
              <input
                type="checkbox"
                checked={allLoadedSelected}
                onChange={toggleAll}
                aria-label={
                  allLoadedSelected ? "Clear selection" : "Select all"
                }
                className="h-3.5 w-3.5 cursor-pointer accent-accent"
              />
              <span>
                {anySelected
                  ? `${counts.total} selected`
                  : total != null && total > rows.length
                    ? `${rows.length} of ${total} loaded`
                    : `${rows.length} ${rows.length === 1 ? "item" : "items"}`}
              </span>
            </div>
            {rows.map((r) => {
              const key = rowKey(r.kind, r.id);
              const isSelected = selected.has(key);
              return (
                <div
                  key={key}
                  className={`group flex items-stretch border-b border-line last:border-0 ${
                    isSelected ? "bg-surface2" : "bg-surface hover:bg-surface2"
                  }`}
                >
                  <label className="flex shrink-0 cursor-pointer items-center pl-4 pr-2">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(r.kind, r.id)}
                      aria-label={`Select ${r.title ?? r.slug ?? r.id}`}
                      className="h-3.5 w-3.5 cursor-pointer accent-accent"
                    />
                  </label>
                  <Link
                    href={rowHref(r)}
                    className="flex min-w-0 flex-1 items-center gap-3 py-3 pr-3"
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
                          {r.kind === "article"
                            ? r.badge ?? "—"
                            : null}
                          {r.kind === "article" && r.language
                            ? ` · ${ARTICLE_LANGUAGE_LABELS[r.language as keyof typeof ARTICLE_LANGUAGE_LABELS] ?? r.language}`
                            : ""}
                          {r.kind === "article" && r.updated_at
                            ? ` · ${r.updated_at.slice(0, 10)}`
                            : ""}
                          {r.kind === "story" && r.updated_at
                            ? `updated ${r.updated_at.slice(0, 10)}`
                            : ""}
                        </span>
                      </span>
                    </span>
                  </Link>
                  {r.kind === "story" && (
                    <RowCategoryChip
                      currentCategory={r.badge}
                      categories={categories}
                      colorByLabel={categoryColorByLabel}
                      disabled={pending}
                      onPick={(category) =>
                        requestAction([{ kind: "story", id: r.id }], {
                          type: "category",
                          category,
                        })
                      }
                    />
                  )}
                  {r.kind === "story" && (
                    <PublishedOnStrip
                      published={r.published_on}
                    />
                  )}
                  {r.kind === "story" && r.job_status && (
                    <span
                      title={`Latest pipeline run: ${JOB_STATUS_LABEL[r.job_status]}`}
                      className={`mr-2 shrink-0 self-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${JOB_STATUS_CHIP_CLASS[r.job_status]}`}
                    >
                      {JOB_STATUS_LABEL[r.job_status]}
                    </span>
                  )}
                  {r.kind === "story" && r.flagged && (
                    <FlaggedPill attempts={r.flagged_attempts} />
                  )}
                  {r.kind === "story" && r.refresh_state && (
                    <RefreshingPill state={r.refresh_state} />
                  )}
                  {r.kind === "story" &&
                    r.publish_blockers != null &&
                    r.publish_blockers.length > 0 && (
                      <PublishBlockersPill gates={r.publish_blockers} />
                    )}
                  {r.kind === "story" && r.progress && (
                    <ProgressPill snapshot={r.progress} />
                  )}
                  <span
                    className={`mr-2 shrink-0 self-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${statusClass(
                      r.status,
                    )}`}
                  >
                    {r.status ?? "draft"}
                  </span>
                  <RowMenu
                    row={r}
                    categories={categories}
                    disabled={pending}
                    onAction={(op) =>
                      requestAction([{ kind: r.kind, id: r.id }], op)
                    }
                  />
                </div>
              );
            })}
          </>
        )}
      </div>

      {rows.length > 0 && !reachedEnd && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-lg border border-line px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loadingMore
              ? "Loading…"
              : total != null
                ? `Load more (${total - rows.length} more)`
                : "Load more"}
          </button>
        </div>
      )}

      {/* Live-progress polling only exists while something is rendering. Driven
          by the pager's in-place refresh(), so it updates the loaded window
          without resetting the cursor or selection. */}
      {rows.some((r) => r.progress != null) && (
        <AutoRefresh onTick={refresh} />
      )}

      {allLoadedSelected && total != null && total > rows.length && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent/10 px-4 py-2 font-mono text-[11px] text-ink">
          {matchingMode ? (
            <>
              <span>
                All <span className="text-accent">{total}</span> matching this
                filter selected. Cheap status / category changes apply to every
                one; delete and paid actions still use the {rows.length} loaded.
              </span>
              <button
                type="button"
                onClick={() => setSelectAllMatching(false)}
                className="rounded-md border border-accent px-2 py-0.5 text-accent transition-colors hover:bg-accent hover:text-bg"
              >
                Just these {rows.length}
              </button>
            </>
          ) : (
            <>
              <span>
                All {rows.length} on this page selected.{" "}
                <span className="text-muted">
                  {total - rows.length} more match this filter.
                </span>
              </span>
              <button
                type="button"
                onClick={() => setSelectAllMatching(true)}
                className="rounded-md border border-accent px-2 py-0.5 text-accent transition-colors hover:bg-accent hover:text-bg"
              >
                Select all {total} matching
              </button>
            </>
          )}
        </div>
      )}

      {anySelected && (
        <BulkActionBar
          counts={counts}
          categories={categories}
          disabled={pending}
          onAction={(op) =>
            requestAction(
              selectedItems,
              op,
              matchingMode && op.type !== "delete",
            )
          }
          onRegen={requestRegen}
          onBulkPublish={runBulkPublish}
          onBulkComplete={requestComplete}
          onBulkRefresh={requestRefresh}
          onFullPipeline={requestFullPipeline}
          onReclassify={requestReclassify}
          onTitleRegen={requestTitleRegen}
          onStopRuns={runStopRuns}
          onClear={clearSelection}
        />
      )}

      {confirm && (
        <ConfirmModal
          state={confirm}
          rowByKey={rowByKey}
          typedConfirm={typedConfirm}
          onTypedConfirmChange={setTypedConfirm}
          pending={pending}
          onCancel={() => setConfirm(null)}
          onRun={runConfirmed}
        />
      )}

      {completeConfirm && (
        <CompleteConfirmModal
          items={completeConfirm}
          rowByKey={rowByKey}
          pending={pending}
          onCancel={() => setCompleteConfirm(null)}
          onRun={runCompleteConfirmed}
        />
      )}

      {regenConfirm && (
        <RegenConfirmModal
          target={regenConfirm.target}
          items={regenConfirm.items}
          rowByKey={rowByKey}
          pending={pending}
          onCancel={() => setRegenConfirm(null)}
          onRun={runRegenConfirmed}
        />
      )}

      {refreshConfirm && (
        <RefreshConfirmModal
          items={refreshConfirm}
          rowByKey={rowByKey}
          pending={pending}
          onCancel={() => setRefreshConfirm(null)}
          onRun={runRefreshConfirmed}
        />
      )}

      {fullPipelineConfirm && (
        <FullPipelineConfirmModal
          items={fullPipelineConfirm}
          rowByKey={rowByKey}
          pending={pending}
          onCancel={() => setFullPipelineConfirm(null)}
          onRun={runFullPipelineConfirmed}
        />
      )}

      {reclassifyConfirm && (
        <ReclassifyConfirmModal
          items={reclassifyConfirm}
          rowByKey={rowByKey}
          pending={pending}
          onCancel={() => setReclassifyConfirm(null)}
          onRun={runReclassifyConfirmed}
        />
      )}

      {titleRegenConfirm && (
        <TitleRegenConfirmModal
          items={titleRegenConfirm}
          rowByKey={rowByKey}
          pending={pending}
          onCancel={() => setTitleRegenConfirm(null)}
          onRun={runTitleRegenConfirmed}
        />
      )}
    </>
  );
}

// --- Bulk action bar (sticky bottom) ----------------------------------------

function BulkActionBar({
  counts,
  categories,
  disabled,
  onAction,
  onRegen,
  onBulkPublish,
  onBulkComplete,
  onBulkRefresh,
  onFullPipeline,
  onReclassify,
  onTitleRegen,
  onStopRuns,
  onClear,
}: {
  counts: { total: number; stories: number; articles: number };
  categories: CategoryOption[];
  disabled: boolean;
  onAction: (op: BulkUpdateOp | { type: "delete" }) => void;
  onRegen: (target: BulkRegenTarget) => void;
  onBulkPublish: (platforms: SocialPlatform[]) => void;
  onBulkComplete: () => void;
  onBulkRefresh: () => void;
  onFullPipeline: () => void;
  onReclassify: () => void;
  onTitleRegen: () => void;
  onStopRuns: () => void;
  onClear: () => void;
}) {
  const categoryDisabled = counts.articles > 0;
  // AI reclassify only touches stories; mixed selections stay clickable and
  // the server skips articles, matching the Regenerate menu's semantics.
  const reclassifyDisabled = counts.stories === 0;
  // Regen targets fan out to story-pipeline primitives — articles are not
  // pipeline citizens, so the menu is dark when the selection is articles-
  // only. Mixed selections light up but the server filters to stories.
  const regenDisabled = counts.stories === 0;
  const bulkPublishDisabled = counts.stories === 0;
  const completeDisabled = counts.stories === 0;
  const fullPipelineDisabled = counts.stories === 0;
  return (
    <div className="sticky bottom-4 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface2 px-4 py-3 shadow-2xl">
      <span className="font-mono text-[11px] uppercase tracking-wider text-ink">
        {counts.total} selected
        <span className="ml-2 text-muted">
          ({counts.stories} stories · {counts.articles} articles)
        </span>
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {/* Complete & Publish: the one-click "fill in missing assets +
            publish to all socials when ready" button. Placed left of the
            existing PUBLISH TO SOCIALS picker because it supersedes that
            flow for the common case (all four platforms, auto). Stays
            disabled when the selection has no video stories — articles
            don't have a short to publish. */}
        <BarButton
          label="Complete & publish"
          accent
          disabled={disabled || completeDisabled}
          onClick={onBulkComplete}
        />
        {/* Full pipeline: rebuild EVERYTHING from the reddit source —
            article, voice, hook-first short, hero + thumbnails — then
            auto-publish to the site + every social when the fresh set is
            ready. The expensive sibling of Complete & publish (which only
            fills in what's missing). */}
        <BarButton
          label="Full pipeline"
          accent
          disabled={disabled || fullPipelineDisabled}
          onClick={onFullPipeline}
        />
        <BulkPublishPicker
          disabled={disabled || bulkPublishDisabled}
          disabledHint={
            bulkPublishDisabled
              ? "Bulk publish-to-socials applies to video stories only"
              : null
          }
          storyCount={counts.stories}
          onConfirm={onBulkPublish}
        />
        <BarButton
          label="Publish"
          disabled={disabled}
          onClick={() => onAction({ type: "status", status: "published" })}
        />
        <BarButton
          label="Unpublish"
          disabled={disabled}
          onClick={() => onAction({ type: "status", status: "draft" })}
        />
        {/* direction="up" keeps the menus from clipping below the sticky
            bar — the bar lives at the bottom of the viewport, so a downward
            menu always rendered off-screen (the original bug). */}
        <Picker
          label="Status ▾"
          direction="up"
          disabled={disabled}
          options={statusesFor(counts).map((s) => ({ value: s, label: s }))}
          onPick={(value) => onAction({ type: "status", status: value })}
        />
        <Picker
          label="Category ▾"
          direction="up"
          disabled={disabled || categoryDisabled}
          disabledHint={
            categoryDisabled ? "Category applies to video stories only" : null
          }
          options={categories.map((c) => ({ value: c.label, label: c.label }))}
          onPick={(value) => onAction({ type: "category", category: value })}
        />
        {/* The AI sibling of the manual Category picker: re-runs the
            multi-tag classifier on the selection and writes tags + label.
            Low-confidence stories are left untouched for a manual pick. */}
        <BarButton
          label="Reclassify AI"
          disabled={disabled || reclassifyDisabled}
          onClick={onReclassify}
        />
        {/* Fix too-long titles: rewrite each selected story's title with the
            branded prompt, bounded to the length policy. The paired action for
            the "Title: Too long" filter. Stories-only (same gate as Reclassify
            AI); the server skips articles in a mixed selection. */}
        <BarButton
          label="Regenerate titles"
          disabled={disabled || reclassifyDisabled}
          onClick={onTitleRegen}
        />
        <Picker
          label="Regenerate ▾"
          direction="up"
          disabled={disabled || regenDisabled}
          disabledHint={
            regenDisabled
              ? "Regenerate targets only apply to video stories"
              : null
          }
          options={[
            ...(Object.keys(REGEN_TARGET_META) as BulkRegenTarget[]).map(
              (t) => ({
                value: t,
                label: REGEN_TARGET_META[t].label,
              }),
            ),
            // The refresh-assets chain, surfaced where the operator looks
            // for "rebuild the short". Routes to its own confirm flow.
            {
              value: RESTART_SHORT_MENU_VALUE,
              label: "Restart short + hero + thumbnails",
            },
          ]}
          onPick={(value) => {
            if (value === RESTART_SHORT_MENU_VALUE) onBulkRefresh();
            else onRegen(value as BulkRegenTarget);
          }}
        />
        {/* STOP RUNS: cancel everything in flight for the selection
            (images, voice, shorts, pipeline jobs, pending finishers,
            refresh chains). Sits between the run-starting controls and
            Delete because it is their undo-ish counterpart. */}
        <BarButton
          label="Stop runs"
          disabled={disabled}
          onClick={onStopRuns}
        />
        <BarButton
          label="Delete"
          danger
          disabled={disabled}
          onClick={() => onAction({ type: "delete" })}
        />
        <button
          type="button"
          onClick={onClear}
          disabled={disabled}
          className="rounded-md border border-line px-2 py-1 font-mono text-[11px] text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

function BarButton({
  label,
  danger,
  accent,
  disabled,
  onClick,
}: {
  label: string;
  danger?: boolean;
  /** Primary highlight — used for the "Complete & publish" action so it
   *  reads as the recommended one-click path next to the more granular
   *  pickers around it. */
  accent?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const tone = danger
    ? "border-danger/50 text-danger hover:bg-danger hover:text-bg"
    : accent
      ? "border-accent bg-accent/10 text-accent hover:bg-accent hover:text-bg"
      : "border-line text-ink hover:border-accent hover:text-accent";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tone}`}
    >
      {label}
    </button>
  );
}

// --- Inline pickers (status / category) -------------------------------------

function Picker({
  label,
  options,
  onPick,
  disabled,
  disabledHint,
  direction = "down",
}: {
  label: string;
  options: { value: string; label: string }[];
  onPick: (value: string) => void;
  disabled: boolean;
  disabledHint?: string | null;
  /** "up" drops the menu above the button instead of below. Used by the
   *  sticky bulk-action bar so menus don't clip off the bottom of the
   *  viewport. */
  direction?: "up" | "down";
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const menuPos =
    direction === "up" ? "bottom-full mb-1" : "top-full mt-1";
  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title={disabled && disabledHint ? disabledHint : undefined}
        className="rounded-md border border-line px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        {label}
      </button>
      {open && (
        <ul
          className={`absolute right-0 z-20 ${menuPos} max-h-80 min-w-[180px] overflow-auto rounded-md border border-line bg-surface shadow-2xl`}
        >
          {options.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick(o.value);
                }}
                className="block w-full px-3 py-1.5 text-left font-mono text-[11px] text-ink transition-colors hover:bg-surface2"
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Per-row hover menu -----------------------------------------------------

function RowMenu({
  row,
  categories,
  disabled,
  onAction,
}: {
  row: ContentRow;
  categories: CategoryOption[];
  disabled: boolean;
  onAction: (op: BulkUpdateOp | { type: "delete" }) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isStory = row.kind === "story";
  const isPublished = row.status === "published";

  return (
    <div ref={wrap} className="relative flex shrink-0 items-center pr-3">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-label="Row actions"
        className="rounded-md border border-transparent px-2 py-1 font-mono text-[12px] text-muted opacity-0 transition-opacity hover:border-line hover:text-ink group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-20"
      >
        ⋯
      </button>
      {open && (
        <ul className="absolute right-3 top-full z-20 mt-1 max-h-96 min-w-[180px] overflow-auto rounded-md border border-line bg-surface shadow-2xl">
          <RowMenuItem
            label={isPublished ? "Unpublish" : "Publish"}
            onClick={() => {
              setOpen(false);
              onAction({
                type: "status",
                status: isPublished ? "draft" : "published",
              });
            }}
          />
          <RowMenuPicker
            label="Set status →"
            options={(isStory ? STATUSES : ARTICLE_STATUSES).map((s) => ({
              value: s,
              label: s,
            }))}
            onPick={(value) => {
              setOpen(false);
              onAction({ type: "status", status: value });
            }}
          />
          {isStory && (
            <RowMenuPicker
              label="Set category →"
              options={categories.map((c) => ({
                value: c.label,
                label: c.label,
              }))}
              onPick={(value) => {
                setOpen(false);
                onAction({ type: "category", category: value });
              }}
            />
          )}
          <li className="border-t border-line">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onAction({ type: "delete" });
              }}
              className="block w-full px-3 py-1.5 text-left font-mono text-[11px] text-danger transition-colors hover:bg-danger hover:text-bg"
            >
              Delete
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

function RowMenuItem({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="block w-full px-3 py-1.5 text-left font-mono text-[11px] text-ink transition-colors hover:bg-surface2"
      >
        {label}
      </button>
    </li>
  );
}

function RowMenuPicker({
  label,
  options,
  onPick,
}: {
  label: string;
  options: { value: string; label: string }[];
  onPick: (value: string) => void;
}) {
  return (
    <li className="border-t border-line">
      <div className="px-3 pt-1.5 pb-0.5 font-mono text-[9px] uppercase tracking-wider text-muted">
        {label}
      </div>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onPick(o.value)}
          className="block w-full px-3 py-1 text-left font-mono text-[11px] text-ink transition-colors hover:bg-surface2"
        >
          {o.label}
        </button>
      ))}
    </li>
  );
}

// 2026-06-21 inline category chip for the story rows. Visible at all
// times so the current category is glanceable, and clickable to open a
// dropdown of the ACTIVE categories (DB-driven since the 2026-07-01
// taxonomy arc) that calls the existing single-item bulk-update path.
// Articles don't render this — they have no writable category column.
// Plan: _plans/2026-06-21-category-classifier-and-pills.md.
function RowCategoryChip({
  currentCategory,
  categories,
  colorByLabel,
  disabled,
  onPick,
}: {
  currentCategory: string | null;
  categories: CategoryOption[];
  colorByLabel: Map<string, string | null>;
  disabled: boolean;
  onPick: (category: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const label = currentCategory ?? "uncategorized";
  const currentStyle = currentCategory
    ? categoryChipStyle(colorByLabel.get(currentCategory))
    : undefined;
  return (
    <div ref={wrap} className="relative mr-2 flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-label={`Change category (currently ${label})`}
        title="Change category"
        style={currentStyle}
        className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 ${
          currentStyle ? "" : CATEGORY_CHIP_FALLBACK_CLASS
        }`}
      >
        {label}
      </button>
      {open && (
        <ul className="absolute right-0 top-full z-20 mt-1 max-h-72 min-w-[200px] overflow-auto rounded-md border border-line bg-surface shadow-2xl">
          {categories.map((c) => (
            <li key={c.label}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  if (c.label === currentCategory) return;
                  onPick(c.label);
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-surface2 ${
                  c.label === currentCategory ? "text-muted" : "text-ink"
                }`}
              >
                <span
                  aria-hidden
                  style={
                    c.color ? { backgroundColor: c.color } : undefined
                  }
                  className={`inline-block h-2 w-2 rounded-full ${
                    c.color ? "" : "border border-line"
                  }`}
                />
                {c.label}
                {c.label === currentCategory ? (
                  <span className="ml-auto text-muted">current</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Confirm modal ----------------------------------------------------------

function ConfirmModal({
  state,
  rowByKey,
  typedConfirm,
  onTypedConfirmChange,
  pending,
  onCancel,
  onRun,
}: {
  state: ConfirmState;
  rowByKey: Map<string, ContentRow>;
  typedConfirm: string;
  onTypedConfirmChange: (v: string) => void;
  pending: boolean;
  onCancel: () => void;
  onRun: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, onCancel]);

  let stories = 0;
  let articles = 0;
  for (const item of state.items) {
    if (item.kind === "story") stories += 1;
    else articles += 1;
  }
  const previewCount = Math.min(state.items.length, 6);
  const overflow = state.items.length - previewCount;
  const destructive = state.destructive;
  const confirmDisabled = pending || (destructive && typedConfirm !== "DELETE");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-confirm-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-6"
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-2xl">
        <h3
          id="bulk-confirm-title"
          className="font-display text-[16px] font-bold text-ink"
        >
          {state.verb}{" "}
          {state.byFilter && state.matchingTotal != null
            ? `${state.matchingTotal} matching`
            : `${state.items.length} ${state.items.length === 1 ? "item" : "items"}`}
          ?
        </h3>
        <p className="mt-1 font-mono text-[11px] text-muted">
          {stories} {stories === 1 ? "story" : "stories"} · {articles}{" "}
          {articles === 1 ? "article" : "articles"}
        </p>
        <ul className="mt-3 max-h-48 space-y-1 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-[11px] text-muted">
          {state.items.slice(0, previewCount).map((it) => {
            const r = rowByKey.get(rowKey(it.kind, it.id));
            const label = r?.title ?? r?.slug ?? it.id.slice(0, 8);
            return (
              <li key={`${it.kind}:${it.id}`} className="truncate text-ink">
                {label}
              </li>
            );
          })}
          {overflow > 0 && (
            <li className="text-muted">
              …and {overflow} {overflow === 1 ? "more" : "more"}
            </li>
          )}
        </ul>
        {destructive && (
          <div className="mt-3 space-y-2">
            <p className="font-mono text-[11px] text-danger">
              Hard delete is permanent — there is no trash and no undo.
              Rendered audio and video are also removed from storage. Type
              DELETE to confirm.
            </p>
            <input
              type="text"
              value={typedConfirm}
              onChange={(e) =>
                onTypedConfirmChange(e.target.value.toUpperCase())
              }
              placeholder="DELETE"
              autoFocus
              className="w-full rounded-md border border-danger/50 bg-bg px-3 py-2 font-mono text-[12px] text-ink placeholder:text-muted focus:border-danger focus:outline-none"
            />
          </div>
        )}
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onRun}
            disabled={confirmDisabled}
            className={`flex-1 rounded-md px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${
              destructive
                ? "bg-danger text-bg hover:opacity-90"
                : "bg-accent text-bg hover:opacity-90"
            }`}
          >
            {pending ? "Working…" : state.verb}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Bulk regen confirm modal + result banner -------------------------------
// 2026-06-24. Same modal shape as ConfirmModal. The
// body is target-specific (cost hint + plain-English explanation of what
// will be queued) so a 30-story click is not a surprise.

function RegenConfirmModal({
  target,
  items,
  rowByKey,
  pending,
  onCancel,
  onRun,
}: {
  target: BulkRegenTarget;
  items: BulkContentItem[];
  rowByKey: Map<string, ContentRow>;
  pending: boolean;
  onCancel: () => void;
  onRun: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, onCancel]);
  const [typedCount, setTypedCount] = useState("");
  const meta = REGEN_TARGET_META[target];
  const previewCount = Math.min(items.length, 6);
  const overflow = items.length - previewCount;
  // Total estimated spend (null for daily-budget-gated targets like hero /
  // scenes). Over the threshold the operator must type the story count to
  // commit — one click shouldn't fire a large, real-money regenerate. Plan:
  // _plans/2026-07-15-content-pagination-and-bulk-safety.md.
  const totalCostUsd = estimateRegenCostUsd(target, items.length);
  const totalCostText =
    totalCostUsd != null ? `$${totalCostUsd.toFixed(2)}` : null;
  const requiresTypedConfirm =
    totalCostUsd != null && totalCostUsd >= SPEND_CONFIRM_THRESHOLD_USD;
  const confirmBlocked =
    pending || (requiresTypedConfirm && typedCount !== String(items.length));
  // A pipeline restart on a live story pulls it off the public site while it
  // rewrites. Surface that count up front so it's a decision, not a surprise.
  const liveCount =
    target === "pipeline"
      ? items.filter(
          (it) => rowByKey.get(`${it.kind}:${it.id}`)?.status === "published",
        ).length
      : 0;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="regen-confirm-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-6"
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-2xl">
        <h3
          id="regen-confirm-title"
          className="font-display text-[16px] font-bold text-ink"
        >
          {meta.verb} for {items.length}{" "}
          {items.length === 1 ? "story" : "stories"}?
        </h3>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          {meta.body}
        </p>
        <p className="mt-2 font-mono text-[11px] text-muted">
          {meta.perStoryHint} × {items.length} stor
          {items.length === 1 ? "y" : "ies"}
        </p>
        <p className="mt-1 font-mono text-[12px] font-bold text-ink">
          {totalCostText != null
            ? `≈ ${totalCostText} total`
            : "Total scales with today's image budget"}
        </p>
        {liveCount > 0 && (
          <p className="mt-2 font-mono text-[11px] text-warn">
            {liveCount} of these {liveCount === 1 ? "is" : "are"} live and will
            drop off the site while {liveCount === 1 ? "it rewrites" : "they rewrite"}.
          </p>
        )}
        <ul className="mt-3 max-h-40 space-y-1 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-[11px] text-muted">
          {items.slice(0, previewCount).map((it) => {
            const r = rowByKey.get(`${it.kind}:${it.id}`);
            const label = r?.title ?? r?.slug ?? it.id.slice(0, 8);
            return (
              <li key={`${it.kind}:${it.id}`} className="truncate text-ink">
                {label}
              </li>
            );
          })}
          {overflow > 0 && (
            <li className="text-muted">…and {overflow} more</li>
          )}
        </ul>
        {requiresTypedConfirm && (
          <div className="mt-3 space-y-2">
            <p className="font-mono text-[11px] text-warn">
              This spends about {totalCostText}. Type{" "}
              <span className="text-ink">{items.length}</span> to confirm.
            </p>
            <input
              type="text"
              inputMode="numeric"
              value={typedCount}
              onChange={(e) =>
                setTypedCount(e.target.value.replace(/[^0-9]/g, ""))
              }
              placeholder={String(items.length)}
              autoFocus
              className="w-full rounded-md border border-warn/50 bg-bg px-3 py-2 font-mono text-[12px] text-ink placeholder:text-muted focus:border-warn focus:outline-none"
            />
          </div>
        )}
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onRun}
            disabled={confirmBlocked}
            className="flex-1 rounded-md bg-accent px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Queueing…" : `Queue ${items.length}`}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function RegenResultBanner({
  result,
  rowByKey,
  pending,
  onRerunSkipped,
  onDismiss,
}: {
  result: BulkRegenResult;
  rowByKey: Map<string, ContentRow>;
  pending: boolean;
  onRerunSkipped: (failed: BulkActionFailure[]) => void;
  onDismiss: () => void;
}) {
  const meta = REGEN_TARGET_META[result.target];
  const previewFailures = result.failed.slice(0, 6);
  const overflow = result.failed.length - previewFailures.length;
  // Rows the restart refused because the operator had skipped them. These get
  // an explicit one-click override — the "nothing should stop me" affordance.
  const skippedFailures =
    result.target === "pipeline"
      ? result.failed.filter((f) => f.reason === "reddit-source-skipped")
      : [];
  return (
    <div className="space-y-2 rounded-xl border border-accent/40 bg-accent/10 p-3 font-mono text-[11px] text-ink">
      <div className="flex items-center justify-between gap-3">
        <span>
          <span className="text-muted">{meta.label}:</span> Queued{" "}
          <span className="text-accent">{result.ok.length}</span>
          {result.failed.length > 0
            ? ` · Failed ${result.failed.length}`
            : ""}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted transition-colors hover:text-ink"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      {previewFailures.length > 0 && (
        <ul className="space-y-0.5 border-t border-danger/30 pt-2 text-danger">
          {previewFailures.map((f) => {
            const r = rowByKey.get(`${f.kind}:${f.id}`);
            const label = r?.title ?? r?.slug ?? f.id.slice(0, 8);
            return (
              <li key={`${f.kind}:${f.id}`}>
                <span className="text-ink">{label}</span>
                <span className="opacity-70"> — {describeReason(f.reason)}</span>
              </li>
            );
          })}
          {overflow > 0 && <li>…and {overflow} more</li>}
        </ul>
      )}
      {skippedFailures.length > 0 && (
        <button
          type="button"
          onClick={() => onRerunSkipped(skippedFailures)}
          disabled={pending}
          className="w-full rounded-md border border-warn/50 bg-warn/10 px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-warn transition-colors hover:bg-warn/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending
            ? "Re-running…"
            : `Re-run anyway (${skippedFailures.length} skipped)`}
        </button>
      )}
    </div>
  );
}

// 2026-07-03 STOP RUNS result banner. Counts-only (no per-row failure
// list): the action is a broad sweep and its per-kind cancel counts are
// the useful signal; a story with nothing in flight simply contributes
// zeros. Plan: _plans/2026-07-03-unified-live-runs-and-stop.md.
function StopRunsResultBanner({
  result,
  onDismiss,
}: {
  result: BulkStopRunsResult;
  onDismiss: () => void;
}) {
  const c = result.counts;
  const parts = [
    c.images > 0 ? `${c.images} image${c.images === 1 ? "" : "s"}` : null,
    c.voices > 0 ? `${c.voices} voice` : null,
    c.shorts > 0 ? `${c.shorts} short${c.shorts === 1 ? "" : "s"}` : null,
    c.jobs > 0 ? `${c.jobs} pipeline job${c.jobs === 1 ? "" : "s"}` : null,
    c.finishers > 0 ? `${c.finishers} finisher${c.finishers === 1 ? "" : "s"}` : null,
    c.refreshes > 0 ? `${c.refreshes} refresh chain${c.refreshes === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  const scope =
    result.articles > 0
      ? `${result.stories} stories · ${result.articles} articles`
      : `${result.stories} stor${result.stories === 1 ? "y" : "ies"}`;
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent/10 p-3 font-mono text-[11px] text-ink">
      <span>
        <span className="text-muted">Stop runs ({scope}):</span>{" "}
        {parts.length > 0
          ? `cancelled ${parts.join(", ")}`
          : "nothing was in flight"}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="text-muted transition-colors hover:text-ink"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

// --- Per-row flag pill ------------------------------------------------------
// 2026-06-25. Renders only when stories.auto_publish_when_ready=1 so the
// operator can spot at a glance which rows the /api/auto_complete_publish
// cron is currently watching. Attempts counter turns warn → danger past
// the half-budget mark (DEFAULT_MAX_ATTEMPTS = 12 in the cron); that's
// the same "struggling" threshold the header status card uses.

const FLAG_STRUGGLING_THRESHOLD = 6;

function FlaggedPill({ attempts }: { attempts: number }) {
  const struggling = attempts >= FLAG_STRUGGLING_THRESHOLD;
  const tone = struggling
    ? "border-danger/50 bg-danger/15 text-danger"
    : "border-accent/40 bg-accent/15 text-accent";
  return (
    <span
      title={`Flagged for auto-publish · ${attempts} attempt${attempts === 1 ? "" : "s"} so far${
        struggling
          ? " (struggling — check Vercel function logs)"
          : ""
      }`}
      className={`mr-2 shrink-0 self-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${tone}`}
    >
      flagged{attempts > 0 ? ` · ${attempts}` : ""}
    </span>
  );
}

// --- Per-row in-flight progress pill ----------------------------------------
// 2026-06-25. Renders only for stories with an active short_renders /
// image_renders / voice_renders / story_jobs row. The aggregator in
// repo.ts picks the most-prominent signal per story; this just paints
// it. Rendering = warn-accent, queued = muted-accent. Tooltip carries
// the full context for ops-debug.

const PROGRESS_KIND_LABEL: Record<ProgressSnapshot["kind"], string> = {
  short: "short",
  images: "images",
  voice: "voice",
  pipeline: "pipeline",
};

function ProgressPill({ snapshot }: { snapshot: ProgressSnapshot }) {
  const active = snapshot.status === "rendering" || snapshot.status === "processing";
  const tone = active
    ? "border-warn/50 bg-warn/15 text-warn animate-pulse"
    : "border-warn/40 bg-warn/10 text-warn/80";
  const label = formatProgressLabel(snapshot);
  const tooltip = formatProgressTooltip(snapshot);
  return (
    <span
      title={tooltip}
      className={`mr-2 shrink-0 self-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${tone}`}
    >
      {label}
    </span>
  );
}

function formatProgressLabel(snapshot: ProgressSnapshot): string {
  const kindLabel =
    snapshot.kind === "images" && snapshot.count
      ? `${snapshot.count} ${snapshot.count === 1 ? "image" : "images"}`
      : PROGRESS_KIND_LABEL[snapshot.kind];
  const parts: string[] = [kindLabel];
  if (snapshot.progressPct != null) {
    parts.push(`${snapshot.progressPct}%`);
  } else {
    parts.push(snapshot.status);
  }
  if (snapshot.phase) parts.push(snapshot.phase);
  return parts.join(" · ");
}

function formatProgressTooltip(snapshot: ProgressSnapshot): string {
  const parts: string[] = [
    `${PROGRESS_KIND_LABEL[snapshot.kind]} ${snapshot.status}`,
  ];
  if (snapshot.progressPct != null) parts.push(`${snapshot.progressPct}%`);
  if (snapshot.phase) parts.push(`phase: ${snapshot.phase}`);
  if (snapshot.count != null) parts.push(`${snapshot.count} job(s)`);
  return parts.join(" · ");
}

// --- Per-row publish-blockers pill ------------------------------------------
// 2026-07-21. Renders only for stories whose Publish would be rejected
// right now — publish_blockers is the asset gate's `blocking` list,
// stamped per page by listContentPageAction. The chip shows up to three
// short labels; the tooltip carries the full list plus the fix hint, so
// the operator knows what's missing without clicking into the story.
// Codes not in the maps (a future gate) fall back to the raw code — the
// chip degrades to jargon rather than hiding a blocker.
// Plan: _plans/2026-07-21-content-row-publish-blockers.md.

const BLOCKER_CHIP_LABEL: Record<string, string> = {
  body: "body",
  hero_image: "hero",
  thumbnail_image: "thumb",
  short_render: "short",
  video_url: "video",
  voiceover: "voice",
  scene_images: "scenes",
  poll: "poll",
};

const BLOCKER_FULL_LABEL: Record<string, string> = {
  body: "article body",
  hero_image: "hero image",
  thumbnail_image: "card thumbnail",
  short_render: "finished short video",
  video_url: "playable video URL",
  voiceover: "voiceover",
  scene_images: "scene images",
  poll: "enabled poll",
};

const BLOCKER_CHIP_MAX = 3;

function PublishBlockersPill({ gates }: { gates: string[] }) {
  const shown = gates.slice(0, BLOCKER_CHIP_MAX);
  const overflow = gates.length - shown.length;
  const label = shown.map((g) => BLOCKER_CHIP_LABEL[g] ?? g).join(" · ");
  const full = gates.map((g) => BLOCKER_FULL_LABEL[g] ?? g).join(", ");
  return (
    <span
      title={`Publish is blocked — still missing: ${full}. Select the row and run Complete & publish to backfill and ship automatically.`}
      className="mr-2 shrink-0 self-center rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-warn"
    >
      missing: {label}
      {overflow > 0 ? ` +${overflow}` : ""}
    </span>
  );
}

// --- Per-row published-on icon strip ----------------------------------------
// 2026-06-24. Renders one letter badge per platform the story is live on.
// Empty render when nothing is published — keeps the row chrome quiet.

function PublishedOnStrip({ published }: { published: PublishedOn }) {
  const live = PLATFORMS_ORDER.filter((p) => published[p]);
  if (live.length === 0) {
    return (
      <span
        className="mr-2 shrink-0 self-center font-mono text-[9px] uppercase tracking-wider text-muted/60"
        title="Not published on any social"
      >
        —
      </span>
    );
  }
  return (
    <span className="mr-2 flex shrink-0 items-center gap-1">
      {live.map((p) => {
        const meta = PLATFORM_META[p];
        return (
          <span
            key={p}
            title={`Live on ${meta.label}`}
            aria-label={`Live on ${meta.label}`}
            className={`inline-flex h-5 w-5 items-center justify-center rounded-full border font-mono text-[10px] font-bold ${meta.chipClass}`}
          >
            {meta.letter}
          </span>
        );
      })}
    </span>
  );
}

// --- Bulk publish-to-socials picker -----------------------------------------
// 2026-06-24. Dropdown with one checkbox per platform + a confirm
// button at the bottom that fires the bulk action with the selected
// platforms. State is local to the picker — closes after confirm so
// the next click starts from a clean slate.

function BulkPublishPicker({
  disabled,
  disabledHint,
  storyCount,
  onConfirm,
}: {
  disabled: boolean;
  disabledHint: string | null;
  storyCount: number;
  onConfirm: (platforms: SocialPlatform[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<SocialPlatform>>(new Set());
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle(p: SocialPlatform) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  function confirm() {
    if (picked.size === 0) return;
    setOpen(false);
    const arr = PLATFORMS_ORDER.filter((p) => picked.has(p));
    setPicked(new Set());
    onConfirm(arr);
  }

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title={disabled && disabledHint ? disabledHint : undefined}
        className="rounded-md border border-accent/50 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-accent transition-colors hover:bg-accent hover:text-bg disabled:cursor-not-allowed disabled:opacity-40"
      >
        Publish to socials ▾
      </button>
      {open && (
        <div className="absolute right-0 bottom-full z-20 mb-1 min-w-[220px] overflow-hidden rounded-md border border-line bg-surface shadow-2xl">
          <ul className="border-b border-line">
            {PLATFORMS_ORDER.map((p) => {
              const meta = PLATFORM_META[p];
              const isPicked = picked.has(p);
              return (
                <li key={p}>
                  <button
                    type="button"
                    onClick={() => toggle(p)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] text-ink transition-colors hover:bg-surface2"
                  >
                    <input
                      type="checkbox"
                      checked={isPicked}
                      readOnly
                      className="h-3.5 w-3.5 accent-accent"
                    />
                    <span
                      aria-hidden
                      className={`inline-flex h-4 w-4 items-center justify-center rounded-full border font-bold text-[9px] ${meta.chipClass}`}
                    >
                      {meta.letter}
                    </span>
                    {meta.label}
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={confirm}
            disabled={picked.size === 0}
            className="block w-full bg-accent px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {picked.size === 0
              ? "Pick at least one platform"
              : `Publish ${storyCount} ${storyCount === 1 ? "story" : "stories"} to ${picked.size} ${picked.size === 1 ? "platform" : "platforms"}`}
          </button>
        </div>
      )}
    </div>
  );
}

// --- Bulk publish result banner --------------------------------------------
// 2026-06-24. Same shape as RegenResultBanner. Surfaces per-bucket
// counts (posted / pending / failed / skipped) and the first few
// failure reasons. Pending bucket is highlighted as the
// "TikTok-drafts or IG-async" case so the operator knows the retry
// cron will finish the work.

function BulkPublishResultBanner({
  result,
  rowByKey,
  onDismiss,
}: {
  result: BulkPublishResult;
  rowByKey: Map<string, ContentRow>;
  onDismiss: () => void;
}) {
  const previewFailures = result.failed.slice(0, 6);
  const overflowFailures = result.failed.length - previewFailures.length;
  // Skipped items carry the same {kind, id, platform, reason?} shape as
  // failures — surface them too so "Skipped 2" with no detail (the
  // original UX bug) never wastes operator time. Examples:
  //   - "no completed short render"
  //   - "missing YOUTUBE_CHANNEL_ID or YOUTUBE_REFRESH_TOKEN"
  //   - "missing TIKTOK_OPEN_ID or TIKTOK_REFRESH_TOKEN"
  //   - "missing env config" (FB / IG when env vars are blank)
  //   - "articles cannot publish to social"
  const previewSkipped = result.skipped.slice(0, 6);
  const overflowSkipped = result.skipped.length - previewSkipped.length;
  return (
    <div className="space-y-2 rounded-xl border border-accent/40 bg-accent/10 p-3 font-mono text-[11px] text-ink">
      <div className="flex items-center justify-between gap-3">
        <span>
          <span className="text-muted">Bulk publish:</span> Posted{" "}
          <span className="text-accent">{result.posted.length}</span>
          {result.pending.length > 0 && (
            <>
              {" · "}Queued <span className="text-accent">{result.pending.length}</span>{" "}
              <span className="text-muted">
                (retry cron will finish in ~5 min)
              </span>
            </>
          )}
          {result.failed.length > 0 && ` · Failed ${result.failed.length}`}
          {result.skipped.length > 0 && ` · Skipped ${result.skipped.length}`}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted transition-colors hover:text-ink"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      {previewFailures.length > 0 && (
        <ul className="space-y-0.5 border-t border-danger/30 pt-2 text-danger">
          {previewFailures.map((f) => {
            const r = rowByKey.get(`${f.kind}:${f.id}`);
            const label = r?.title ?? r?.slug ?? f.id.slice(0, 8);
            return (
              <li key={`${f.kind}:${f.id}:${f.platform}`}>
                <span className="text-ink">{label}</span>
                <span className="opacity-70">
                  {" "}
                  · {PLATFORM_META[f.platform].label} — {f.reason ?? "unknown"}
                </span>
              </li>
            );
          })}
          {overflowFailures > 0 && (
            <li>…and {overflowFailures} more</li>
          )}
        </ul>
      )}
      {previewSkipped.length > 0 && (
        <ul className="space-y-0.5 border-t border-muted/30 pt-2 text-muted">
          <li className="font-semibold uppercase tracking-wider text-[10px]">
            Skipped (publisher never tried)
          </li>
          {previewSkipped.map((s) => {
            const r = rowByKey.get(`${s.kind}:${s.id}`);
            const label = r?.title ?? r?.slug ?? s.id.slice(0, 8);
            return (
              <li key={`${s.kind}:${s.id}:${s.platform}`}>
                <span className="text-ink">{label}</span>
                <span className="opacity-70">
                  {" "}
                  · {PLATFORM_META[s.platform].label} — {s.reason ?? "no reason given"}
                </span>
              </li>
            );
          })}
          {overflowSkipped > 0 && <li>…and {overflowSkipped} more</li>}
        </ul>
      )}
    </div>
  );
}

// --- Bulk complete-and-publish modal + banner -------------------------------
// 2026-06-25. Same modal/banner pattern as RegenConfirmModal +
// RegenResultBanner. The action is asynchronous: clicking it
// enqueues missing assets and FLAGS the stories — the cron at
// /api/auto_complete_publish drives the actual publishes minutes
// later. The modal warns about the cost; the banner reports what
// got flagged vs skipped vs errored.

function CompleteConfirmModal({
  items,
  rowByKey,
  pending,
  onCancel,
  onRun,
}: {
  items: BulkContentItem[];
  rowByKey: Map<string, ContentRow>;
  pending: boolean;
  onCancel: () => void;
  onRun: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, onCancel]);
  const previewCount = Math.min(items.length, 6);
  const overflow = items.length - previewCount;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="complete-confirm-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-6"
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-2xl">
        <h3
          id="complete-confirm-title"
          className="font-display text-[16px] font-bold text-ink"
        >
          Complete &amp; publish {items.length}{" "}
          {items.length === 1 ? "story" : "stories"}?
        </h3>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          For each story missing an asset (article body, hero,
          thumbnails, short, voiceover, scene images, or poll), the
          missing pieces will be enqueued through the existing
          pipeline. A 2-minute cron then publishes each story to up
          to 6 surfaces the moment every asset is ready: Facebook
          Reel, Facebook Story, Instagram Reel, Instagram Story,
          YouTube, TikTok. Story posts are gated by their
          per-platform toggle in Settings / Socials.
        </p>
        <p className="mt-2 font-mono text-[11px] text-muted">
          Worst case (full pipeline restart): ≈ $0.50 per story · ≈ $
          {(items.length * 0.5).toFixed(2)} total. Already-complete
          stories cost nothing. The cron flags and publishes them on
          the next tick.
        </p>
        <ul className="mt-3 max-h-40 space-y-1 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-[11px] text-muted">
          {items.slice(0, previewCount).map((it) => {
            const r = rowByKey.get(`${it.kind}:${it.id}`);
            const label = r?.title ?? r?.slug ?? it.id.slice(0, 8);
            return (
              <li key={`${it.kind}:${it.id}`} className="truncate text-ink">
                {label}
              </li>
            );
          })}
          {overflow > 0 && (
            <li className="text-muted">…and {overflow} more</li>
          )}
        </ul>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onRun}
            disabled={pending}
            className="flex-1 rounded-md bg-accent px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Flagging…" : `Flag ${items.length} for auto-publish`}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function CompleteResultBanner({
  result,
  rowByKey,
  onDismiss,
}: {
  result: BulkCompleteAndPublishResult;
  rowByKey: Map<string, ContentRow>;
  onDismiss: () => void;
}) {
  const errored = result.outcomes.filter((o) => o.state === "errored");
  const skipped = result.outcomes.filter((o) => o.state === "skipped");
  const previewErrored = errored.slice(0, 5);
  const overflowErrored = errored.length - previewErrored.length;
  const previewSkipped = skipped.slice(0, 5);
  const overflowSkipped = skipped.length - previewSkipped.length;
  return (
    <div className="space-y-2 rounded-xl border border-accent/40 bg-accent/10 p-3 font-mono text-[11px] text-ink">
      <div className="flex items-center justify-between gap-3">
        <span>
          <span className="text-muted">Complete &amp; publish:</span> Flagged{" "}
          <span className="text-accent">{result.flaggedCount}</span>{" "}
          <span className="text-muted">
            (cron will publish each within ~2 min of being ready)
          </span>
          {result.skippedCount > 0 ? ` · Skipped ${result.skippedCount}` : ""}
          {result.erroredCount > 0 ? ` · Errored ${result.erroredCount}` : ""}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted transition-colors hover:text-ink"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      {previewErrored.length > 0 && (
        <ul className="space-y-0.5 border-t border-danger/30 pt-2 text-danger">
          {previewErrored.map((o) => (
            <li key={`err:${o.kind}:${o.id}`}>
              <span className="text-ink">
                {labelFor(o, rowByKey)}
              </span>
              <span className="opacity-70"> — {o.reason ?? "unknown"}</span>
              {o.missing.length > 0 && (
                <span className="opacity-70">
                  {" "}· missing: {o.missing.join(", ")}
                </span>
              )}
            </li>
          ))}
          {overflowErrored > 0 && <li>…and {overflowErrored} more</li>}
        </ul>
      )}
      {previewSkipped.length > 0 && (
        <ul className="space-y-0.5 border-t border-muted/30 pt-2 text-muted">
          <li className="font-semibold uppercase tracking-wider text-[10px]">
            Skipped (no flag set)
          </li>
          {previewSkipped.map((o) => (
            <li key={`skip:${o.kind}:${o.id}`}>
              <span className="text-ink">{labelFor(o, rowByKey)}</span>
              <span className="opacity-70"> — {o.reason ?? "—"}</span>
              {o.missing.length > 0 && (
                <span className="opacity-70">
                  {" "}· missing: {o.missing.join(", ")}
                </span>
              )}
            </li>
          ))}
          {overflowSkipped > 0 && <li>…and {overflowSkipped} more</li>}
        </ul>
      )}
    </div>
  );
}

function labelFor(
  outcome: BulkCompleteAndPublishOutcome,
  rowByKey: Map<string, ContentRow>,
): string {
  const r = rowByKey.get(`${outcome.kind}:${outcome.id}`);
  return r?.title ?? r?.slug ?? outcome.id.slice(0, 8);
}

// --- Refresh assets confirm modal + result banner + row pill ---------------
// 2026-06-25 follow-up. Different from Complete & publish: this is the
// "story is already live but its assets are stale" path. The action
// enqueues a fresh voice render and the cron at /api/refresh_assets
// chains voice -> short (force re-generation) -> hero+thumbnails
// (finisher). Story_id / URL / SEO / comments are preserved.

function RefreshConfirmModal({
  items,
  rowByKey,
  pending,
  onCancel,
  onRun,
}: {
  items: BulkContentItem[];
  rowByKey: Map<string, ContentRow>;
  pending: boolean;
  onCancel: () => void;
  onRun: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, onCancel]);
  const previewCount = Math.min(items.length, 6);
  const overflow = items.length - previewCount;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="refresh-confirm-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-6"
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-2xl">
        <h3
          id="refresh-confirm-title"
          className="font-display text-[16px] font-bold text-ink"
        >
          Refresh assets for {items.length}{" "}
          {items.length === 1 ? "story" : "stories"}?
        </h3>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          For each story: re-render voice with the CURRENT defaults,
          regenerate the short from scratch (picks up the new voice +
          current scene defaults), then trigger the finisher to write
          a fresh hero + 5 thumbnail variants from the new short&apos;s
          character. Story id, URL, SEO, and comments are preserved.
          The cron at /api/refresh_assets walks the chain every 1 min.
        </p>
        <p className="mt-2 font-mono text-[11px] text-muted">
          Worst case: ≈ $0.50 per story (full short re-generation +
          5 hero/thumb i2i calls) · ≈ $
          {(items.length * 0.5).toFixed(2)} total.
        </p>
        <ul className="mt-3 max-h-40 space-y-1 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-[11px] text-muted">
          {items.slice(0, previewCount).map((it) => {
            const r = rowByKey.get(`${it.kind}:${it.id}`);
            const label = r?.title ?? r?.slug ?? it.id.slice(0, 8);
            return (
              <li key={`${it.kind}:${it.id}`} className="truncate text-ink">
                {label}
              </li>
            );
          })}
          {overflow > 0 && (
            <li className="text-muted">…and {overflow} more</li>
          )}
        </ul>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onRun}
            disabled={pending}
            className="flex-1 rounded-md bg-accent px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Starting…" : `Refresh ${items.length}`}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function RefreshResultBanner({
  result,
  rowByKey,
  onDismiss,
}: {
  result: BulkRefreshAssetsResult;
  rowByKey: Map<string, ContentRow>;
  onDismiss: () => void;
}) {
  const errored = result.outcomes.filter((o) => o.state === "errored");
  const skipped = result.outcomes.filter((o) => o.state === "skipped");
  const previewErrored = errored.slice(0, 5);
  const overflowErrored = errored.length - previewErrored.length;
  const previewSkipped = skipped.slice(0, 5);
  const overflowSkipped = skipped.length - previewSkipped.length;
  return (
    <div className="space-y-2 rounded-xl border border-accent/40 bg-accent/10 p-3 font-mono text-[11px] text-ink">
      <div className="flex items-center justify-between gap-3">
        <span>
          <span className="text-muted">Refresh assets:</span> Started{" "}
          <span className="text-accent">{result.startedCount}</span>
          {result.alreadyRefreshingCount > 0
            ? ` · Already refreshing ${result.alreadyRefreshingCount}`
            : ""}
          {result.skippedCount > 0 ? ` · Skipped ${result.skippedCount}` : ""}
          {result.erroredCount > 0 ? ` · Errored ${result.erroredCount}` : ""}
          <span className="ml-1 text-muted">
            (watch the per-row pill — voice → short → hero usually
            lands in 5-10 min)
          </span>
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted transition-colors hover:text-ink"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      {previewErrored.length > 0 && (
        <ul className="space-y-0.5 border-t border-danger/30 pt-2 text-danger">
          {previewErrored.map((o) => (
            <li key={`err:${o.kind}:${o.id}`}>
              <span className="text-ink">{refreshLabelFor(o, rowByKey)}</span>
              <span className="opacity-70"> — {o.reason ?? "unknown"}</span>
            </li>
          ))}
          {overflowErrored > 0 && <li>…and {overflowErrored} more</li>}
        </ul>
      )}
      {previewSkipped.length > 0 && (
        <ul className="space-y-0.5 border-t border-muted/30 pt-2 text-muted">
          <li className="font-semibold uppercase tracking-wider text-[10px]">
            Skipped
          </li>
          {previewSkipped.map((o) => (
            <li key={`skip:${o.kind}:${o.id}`}>
              <span className="text-ink">{refreshLabelFor(o, rowByKey)}</span>
              <span className="opacity-70"> — {o.reason ?? "—"}</span>
            </li>
          ))}
          {overflowSkipped > 0 && <li>…and {overflowSkipped} more</li>}
        </ul>
      )}
    </div>
  );
}

function refreshLabelFor(
  outcome: BulkRefreshAssetsOutcome,
  rowByKey: Map<string, ContentRow>,
): string {
  const r = rowByKey.get(`${outcome.kind}:${outcome.id}`);
  return r?.title ?? r?.slug ?? outcome.id.slice(0, 8);
}

const REFRESH_STATE_LABEL: Record<string, string> = {
  voice_pending: "voice",
  short_pending: "short",
  hero_pending: "hero+thumb",
};

function RefreshingPill({ state }: { state: string }) {
  const label = REFRESH_STATE_LABEL[state] ?? state;
  return (
    <span
      title={`Refresh assets: ${state} — the /api/refresh_assets cron is walking voice → short → hero+thumbnails`}
      className="mr-2 shrink-0 self-center rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent animate-pulse"
    >
      refresh · {label}
    </span>
  );
}

// --- Full pipeline confirm modal + result banner -----------------------------
// 2026-07-02. Same modal/banner pattern as the other bulk flows. The
// action rebuilds article + voice + hook-first short + hero + thumbnails
// from the reddit source and flags the story so the auto-publish cron
// ships it to the site + all socials once every fresh asset is ready.
// Plan: _plans/2026-07-02-content-admin-cleanup-and-full-pipeline.md.

function FullPipelineConfirmModal({
  items,
  rowByKey,
  pending,
  onCancel,
  onRun,
}: {
  items: BulkContentItem[];
  rowByKey: Map<string, ContentRow>;
  pending: boolean;
  onCancel: () => void;
  onRun: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, onCancel]);
  const previewCount = Math.min(items.length, 6);
  const overflow = items.length - previewCount;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="full-pipeline-confirm-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-6"
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-2xl">
        <h3
          id="full-pipeline-confirm-title"
          className="font-display text-[16px] font-bold text-ink"
        >
          Run the full pipeline for {items.length}{" "}
          {items.length === 1 ? "story" : "stories"}?
        </h3>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          Rebuilds EVERYTHING from the reddit source: fresh article, fresh
          voice, fresh hook-first short (hook → intro → story → outro),
          fresh hero + 5 thumbnails. When the full set is ready, the
          auto-publish cron ships each story to the site and every social
          platform. Platforms that already have the story are skipped, so
          nothing double-posts.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          A story that is currently live leaves the public site while it
          rebuilds (typically 15–30 min) and republishes automatically.
          Story id, URL, and comments are preserved. Stories without a
          reddit source are skipped — use Restart short + hero + thumbnails
          for those.
        </p>
        <p className="mt-2 font-mono text-[11px] text-muted">
          Worst case: ≈ $1.50 per story (article LLM + short + hero +
          thumbnails) · ≈ ${(items.length * 1.5).toFixed(2)} total.
        </p>
        <ul className="mt-3 max-h-40 space-y-1 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-[11px] text-muted">
          {items.slice(0, previewCount).map((it) => {
            const r = rowByKey.get(`${it.kind}:${it.id}`);
            const label = r?.title ?? r?.slug ?? it.id.slice(0, 8);
            return (
              <li key={`${it.kind}:${it.id}`} className="truncate text-ink">
                {label}
              </li>
            );
          })}
          {overflow > 0 && (
            <li className="text-muted">…and {overflow} more</li>
          )}
        </ul>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onRun}
            disabled={pending}
            className="flex-1 rounded-md bg-accent px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Starting…" : `Rebuild & publish ${items.length}`}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function FullPipelineResultBanner({
  result,
  rowByKey,
  onDismiss,
}: {
  result: BulkFullPipelineResult;
  rowByKey: Map<string, ContentRow>;
  onDismiss: () => void;
}) {
  const errored = result.outcomes.filter((o) => o.state === "errored");
  const skipped = result.outcomes.filter((o) => o.state === "skipped");
  const previewErrored = errored.slice(0, 5);
  const overflowErrored = errored.length - previewErrored.length;
  const previewSkipped = skipped.slice(0, 5);
  const overflowSkipped = skipped.length - previewSkipped.length;
  return (
    <div className="space-y-2 rounded-xl border border-accent/40 bg-accent/10 p-3 font-mono text-[11px] text-ink">
      <div className="flex items-center justify-between gap-3">
        <span>
          <span className="text-muted">Full pipeline:</span> Started{" "}
          <span className="text-accent">{result.startedCount}</span>
          {result.skippedCount > 0 ? ` · Skipped ${result.skippedCount}` : ""}
          {result.erroredCount > 0 ? ` · Errored ${result.erroredCount}` : ""}
          <span className="ml-1 text-muted">
            (watch the row pills — each story republishes on its own once
            everything fresh is ready)
          </span>
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted transition-colors hover:text-ink"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      {previewErrored.length > 0 && (
        <ul className="space-y-0.5 border-t border-danger/30 pt-2 text-danger">
          {previewErrored.map((o) => (
            <li key={`err:${o.kind}:${o.id}`}>
              <span className="text-ink">
                {fullPipelineLabelFor(o, rowByKey)}
              </span>
              <span className="opacity-70">
                {" "}
                — {describeReason(o.reason ?? "unknown")}
              </span>
            </li>
          ))}
          {overflowErrored > 0 && <li>…and {overflowErrored} more</li>}
        </ul>
      )}
      {previewSkipped.length > 0 && (
        <ul className="space-y-0.5 border-t border-muted/30 pt-2 text-muted">
          <li className="font-semibold uppercase tracking-wider text-[10px]">
            Skipped
          </li>
          {previewSkipped.map((o) => (
            <li key={`skip:${o.kind}:${o.id}`}>
              <span className="text-ink">
                {fullPipelineLabelFor(o, rowByKey)}
              </span>
              <span className="opacity-70">
                {" "}
                — {describeReason(o.reason ?? "—")}
              </span>
            </li>
          ))}
          {overflowSkipped > 0 && <li>…and {overflowSkipped} more</li>}
        </ul>
      )}
    </div>
  );
}

function fullPipelineLabelFor(
  outcome: BulkFullPipelineOutcome,
  rowByKey: Map<string, ContentRow>,
): string {
  const r = rowByKey.get(`${outcome.kind}:${outcome.id}`);
  return r?.title ?? r?.slug ?? outcome.id.slice(0, 8);
}

function ReclassifyConfirmModal({
  items,
  rowByKey,
  pending,
  onCancel,
  onRun,
}: {
  items: BulkContentItem[];
  rowByKey: Map<string, ContentRow>;
  pending: boolean;
  onCancel: () => void;
  onRun: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, onCancel]);
  const previewCount = Math.min(items.length, 6);
  const overflow = items.length - previewCount;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reclassify-confirm-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-6"
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-2xl">
        <h3
          id="reclassify-confirm-title"
          className="font-display text-[16px] font-bold text-ink"
        >
          Reclassify {items.length}{" "}
          {items.length === 1 ? "story" : "stories"} with AI?
        </h3>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          Runs the category classifier on each story and applies the result:
          category label + tags, first tag primary. A story the model is not
          confident about (below 60%) is left exactly as it is and listed for
          a manual pick via its row chip. Uses the Writing (LLM) model from
          the Models page.
        </p>
        <p className="mt-2 font-mono text-[11px] text-muted">
          One small LLM call per story — well under a cent each.
        </p>
        <ul className="mt-3 max-h-40 space-y-1 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-[11px] text-muted">
          {items.slice(0, previewCount).map((it) => {
            const r = rowByKey.get(`${it.kind}:${it.id}`);
            const label = r?.title ?? r?.slug ?? it.id.slice(0, 8);
            return (
              <li key={`${it.kind}:${it.id}`} className="truncate text-ink">
                {label}
              </li>
            );
          })}
          {overflow > 0 && (
            <li className="text-muted">…and {overflow} more</li>
          )}
        </ul>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onRun}
            disabled={pending}
            className="flex-1 rounded-md bg-accent px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Classifying…" : `Reclassify ${items.length}`}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ReclassifyResultBanner({
  result,
  rowByKey,
  onDismiss,
}: {
  result: BulkReclassifyResult;
  rowByKey: Map<string, ContentRow>;
  onDismiss: () => void;
}) {
  const retagged = result.outcomes.filter((o) => o.state === "retagged");
  const needsReview = result.outcomes.filter(
    (o) => o.state === "needs_review",
  );
  const errored = result.outcomes.filter((o) => o.state === "errored");
  const previewRetagged = retagged.slice(0, 5);
  const overflowRetagged = retagged.length - previewRetagged.length;
  const previewReview = needsReview.slice(0, 5);
  const overflowReview = needsReview.length - previewReview.length;
  const previewErrored = errored.slice(0, 5);
  const overflowErrored = errored.length - previewErrored.length;
  return (
    <div className="space-y-2 rounded-xl border border-accent/40 bg-accent/10 p-3 font-mono text-[11px] text-ink">
      <div className="flex items-center justify-between gap-3">
        <span>
          <span className="text-muted">Reclassify AI:</span> Retagged{" "}
          <span className="text-accent">{result.retaggedCount}</span>
          {result.unchangedCount > 0
            ? ` · Already right ${result.unchangedCount}`
            : ""}
          {result.needsReviewCount > 0
            ? ` · Needs a manual pick ${result.needsReviewCount}`
            : ""}
          {result.skippedCount > 0 ? ` · Skipped ${result.skippedCount}` : ""}
          {result.erroredCount > 0 ? ` · Errored ${result.erroredCount}` : ""}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted transition-colors hover:text-ink"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      {previewRetagged.length > 0 && (
        <ul className="space-y-0.5 border-t border-accent/30 pt-2">
          {previewRetagged.map((o) => (
            <li key={`re:${o.kind}:${o.id}`}>
              <span className="text-ink">{reclassifyLabelFor(o, rowByKey)}</span>
              <span className="text-muted">
                {" "}
                — {o.prevCategory ?? "uncategorized"} →{" "}
              </span>
              <span className="text-accent">{o.nextCategory}</span>
              {typeof o.confidence === "number" && (
                <span className="text-muted">
                  {" "}
                  ({Math.round(o.confidence * 100)}%)
                </span>
              )}
            </li>
          ))}
          {overflowRetagged > 0 && (
            <li className="text-muted">…and {overflowRetagged} more</li>
          )}
        </ul>
      )}
      {previewReview.length > 0 && (
        <ul className="space-y-0.5 border-t border-muted/30 pt-2 text-muted">
          <li className="font-semibold uppercase tracking-wider text-[10px]">
            Needs a manual pick
          </li>
          {previewReview.map((o) => (
            <li key={`rev:${o.kind}:${o.id}`}>
              <span className="text-ink">{reclassifyLabelFor(o, rowByKey)}</span>
              <span className="opacity-70"> — {o.reason ?? "—"}</span>
            </li>
          ))}
          {overflowReview > 0 && <li>…and {overflowReview} more</li>}
        </ul>
      )}
      {previewErrored.length > 0 && (
        <ul className="space-y-0.5 border-t border-danger/30 pt-2 text-danger">
          {previewErrored.map((o) => (
            <li key={`err:${o.kind}:${o.id}`}>
              <span className="text-ink">{reclassifyLabelFor(o, rowByKey)}</span>
              <span className="opacity-70">
                {" "}
                — {describeReason(o.reason ?? "unknown")}
              </span>
            </li>
          ))}
          {overflowErrored > 0 && <li>…and {overflowErrored} more</li>}
        </ul>
      )}
    </div>
  );
}

function reclassifyLabelFor(
  outcome: BulkReclassifyOutcome,
  rowByKey: Map<string, ContentRow>,
): string {
  const r = rowByKey.get(`${outcome.kind}:${outcome.id}`);
  return r?.title ?? r?.slug ?? outcome.id.slice(0, 8);
}

function TitleRegenConfirmModal({
  items,
  rowByKey,
  pending,
  onCancel,
  onRun,
}: {
  items: BulkContentItem[];
  rowByKey: Map<string, ContentRow>;
  pending: boolean;
  onCancel: () => void;
  onRun: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, onCancel]);
  const previewCount = Math.min(items.length, 6);
  const overflow = items.length - previewCount;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="title-regen-confirm-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-6"
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-2xl">
        <h3
          id="title-regen-confirm-title"
          className="font-display text-[16px] font-bold text-ink"
        >
          Regenerate {items.length}{" "}
          {items.length === 1 ? "title" : "titles"}?
        </h3>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          Rewrites each story&rsquo;s title with the same branded prompt the
          pipeline uses, kept under {TITLE_MAX_WORDS} words / {TITLE_MAX_CHARS}{" "}
          characters so it renders cleanly on the cover. The current title is
          replaced. A story with no body is skipped (nothing to base a title
          on).
        </p>
        <p className="mt-2 font-mono text-[11px] text-muted">
          One small LLM call per story — well under a cent each.
        </p>
        <ul className="mt-3 max-h-40 space-y-1 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-[11px] text-muted">
          {items.slice(0, previewCount).map((it) => {
            const r = rowByKey.get(`${it.kind}:${it.id}`);
            const label = r?.title ?? r?.slug ?? it.id.slice(0, 8);
            return (
              <li key={`${it.kind}:${it.id}`} className="truncate text-ink">
                {label}
              </li>
            );
          })}
          {overflow > 0 && (
            <li className="text-muted">…and {overflow} more</li>
          )}
        </ul>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onRun}
            disabled={pending}
            className="flex-1 rounded-md bg-accent px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Regenerating…" : `Regenerate ${items.length}`}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function TitleRegenResultBanner({
  result,
  rowByKey,
  onDismiss,
}: {
  result: BulkRegenTitlesResult;
  rowByKey: Map<string, ContentRow>;
  onDismiss: () => void;
}) {
  const regenerated = result.outcomes.filter((o) => o.state === "regenerated");
  const skipped = result.outcomes.filter((o) => o.state === "skipped");
  const errored = result.outcomes.filter((o) => o.state === "errored");
  const previewRegen = regenerated.slice(0, 5);
  const overflowRegen = regenerated.length - previewRegen.length;
  const previewSkipped = skipped.slice(0, 5);
  const overflowSkipped = skipped.length - previewSkipped.length;
  const previewErrored = errored.slice(0, 5);
  const overflowErrored = errored.length - previewErrored.length;
  return (
    <div className="space-y-2 rounded-xl border border-accent/40 bg-accent/10 p-3 font-mono text-[11px] text-ink">
      <div className="flex items-center justify-between gap-3">
        <span>
          <span className="text-muted">Regenerate titles:</span> Regenerated{" "}
          <span className="text-accent">{result.regeneratedCount}</span>
          {result.skippedCount > 0 ? ` · Skipped ${result.skippedCount}` : ""}
          {result.erroredCount > 0 ? ` · Errored ${result.erroredCount}` : ""}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted transition-colors hover:text-ink"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      {previewRegen.length > 0 && (
        <ul className="space-y-0.5 border-t border-accent/30 pt-2">
          {previewRegen.map((o) => (
            <li key={`re:${o.kind}:${o.id}`}>
              <span className="text-muted line-through">
                {o.prevTitle ?? "—"}
              </span>
              <span className="text-muted"> → </span>
              <span className="text-accent">{o.nextTitle}</span>
            </li>
          ))}
          {overflowRegen > 0 && (
            <li className="text-muted">…and {overflowRegen} more</li>
          )}
        </ul>
      )}
      {previewSkipped.length > 0 && (
        <ul className="space-y-0.5 border-t border-muted/30 pt-2 text-muted">
          <li className="font-semibold uppercase tracking-wider text-[10px]">
            Skipped
          </li>
          {previewSkipped.map((o) => (
            <li key={`skip:${o.kind}:${o.id}`}>
              <span className="text-ink">{titleRegenLabelFor(o, rowByKey)}</span>
              <span className="opacity-70"> — {describeReason(o.reason ?? "—")}</span>
            </li>
          ))}
          {overflowSkipped > 0 && <li>…and {overflowSkipped} more</li>}
        </ul>
      )}
      {previewErrored.length > 0 && (
        <ul className="space-y-0.5 border-t border-danger/30 pt-2 text-danger">
          {previewErrored.map((o) => (
            <li key={`err:${o.kind}:${o.id}`}>
              <span className="text-ink">{titleRegenLabelFor(o, rowByKey)}</span>
              <span className="opacity-70">
                {" "}
                — {describeReason(o.reason ?? "unknown")}
              </span>
            </li>
          ))}
          {overflowErrored > 0 && <li>…and {overflowErrored} more</li>}
        </ul>
      )}
    </div>
  );
}

function titleRegenLabelFor(
  outcome: BulkRegenTitlesOutcome,
  rowByKey: Map<string, ContentRow>,
): string {
  const r = rowByKey.get(`${outcome.kind}:${outcome.id}`);
  return r?.title ?? r?.slug ?? outcome.id.slice(0, 8);
}
