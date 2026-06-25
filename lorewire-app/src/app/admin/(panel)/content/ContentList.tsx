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
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  bulkCompleteAndPublishAction,
  bulkPublishToSocialsAction,
  bulkUpdateContentAction,
  bulkDeleteContentAction,
  bulkReclassifyStoriesAction,
  bulkRegenerateContentAction,
  type BulkActionResult,
  type BulkCompleteAndPublishOutcome,
  type BulkCompleteAndPublishResult,
  type BulkContentItem,
  type BulkPublishResult,
  type BulkRegenResult,
  type BulkRegenTarget,
  type BulkUpdateOp,
  type ReclassifyResult,
} from "@/app/admin/actions";
import {
  ARTICLE_LANGUAGE_LABELS,
  ARTICLE_TYPE_LABELS,
  articleDirection,
} from "@/lib/articles";
import type {
  ContentRow,
  ContentSubKind,
  ProgressSnapshot,
  PublishedOn,
  SocialPlatform,
} from "@/lib/repo";
import { CATEGORIES, STATUSES, statusClass } from "@/app/admin/ui";
import { matchesContentSearch } from "@/lib/content-search";

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

// Per-category chip tint, matched to the --color-cat-* design tokens.
// Explicit strings (not dynamic Tailwind class generation) so the purge
// step keeps the classes in the production bundle. Same mapping the
// CategoryChipGroup in the story editor uses — keeping the two surfaces
// visually consistent.
type CategoryName = (typeof CATEGORIES)[number];
const CATEGORY_CHIP_CLASS: Record<CategoryName, string> = {
  Drama: "border-cat-drama/40 bg-cat-drama/15 text-cat-drama",
  Entitled: "border-cat-entitled/40 bg-cat-entitled/15 text-cat-entitled",
  Humor: "border-cat-humor/40 bg-cat-humor/15 text-cat-humor",
  Wholesome: "border-cat-wholesome/40 bg-cat-wholesome/15 text-cat-wholesome",
  Dating: "border-cat-dating/40 bg-cat-dating/15 text-cat-dating",
  Roommate: "border-cat-roommate/40 bg-cat-roommate/15 text-cat-roommate",
};
function categoryChipClass(category: string | null | undefined): string {
  if (!category) return "border-line bg-bg text-muted";
  return (
    CATEGORY_CHIP_CLASS[category as CategoryName] ??
    "border-line bg-bg text-muted"
  );
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
  scenes: {
    label: "All scene images",
    verb: "Regenerate all scene images",
    perStoryHint: "~30 i2i calls per story (varies by duration)",
    body: "Queues a per-scene rebuild for each story. Largest bulk op. Each story passes through the daily image-budget gate.",
  },
  voice: {
    label: "Voiceover",
    verb: "Regenerate voiceovers",
    perStoryHint:
      "1 TTS run per story (~$0.04 ElevenLabs Flash, ~$0.38 Multilingual)",
    body: "Queues a TTS re-synthesis per story using each story's voice override (provider + voice id). Already-in-flight stories are skipped, not double-charged.",
  },
  pipeline: {
    label: "Restart entire pipeline",
    verb: "Restart the entire pipeline",
    perStoryHint: "≈ $0.50 per story (LLM + TTS + images + assembly)",
    body: "Re-runs the Python story_jobs pipeline from script onward. Replaces script, voice, scenes, hero, short, article. Only stories with a reddit_source can be re-run; pre-pipeline manual seeds are skipped.",
  },
};

export function ContentList({ rows }: { rows: ContentRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [typedConfirm, setTypedConfirm] = useState("");
  const [failures, setFailures] = useState<
    { kind: Kind; id: string; reason: string }[]
  >([]);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [query, setQuery] = useState("");
  // 2026-06-21 reclassify result banner. Null = no banner; the banner
  // renders the last LLM-classify run's counts and a button to clear it.
  // Plan: _plans/2026-06-21-category-classifier-and-pills.md.
  const [reclassifyResult, setReclassifyResult] = useState<
    ReclassifyResult | null
  >(null);
  const [reclassifyConfirmOpen, setReclassifyConfirmOpen] = useState(false);
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

  // Cancel any pending undo timer when the component unmounts so a navigation
  // away doesn't leak a stale setState.
  useEffect(() => {
    return () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    };
  }, []);

  const rowByKey = useMemo(() => {
    const m = new Map<string, ContentRow>();
    for (const r of rows) m.set(rowKey(r.kind, r.id), r);
    return m;
  }, [rows]);

  // The search bar narrows the visible row set in place. The full `rows`
  // array still drives rowByKey so a row that's selected and then hidden
  // by the query stays in `selected` — clearing the query restores it.
  const filteredRows = useMemo(() => {
    if (!query.trim()) return rows;
    return rows.filter((r) => matchesContentSearch(r, query));
  }, [rows, query]);

  const filteredKeySet = useMemo(() => {
    const s = new Set<string>();
    for (const r of filteredRows) s.add(rowKey(r.kind, r.id));
    return s;
  }, [filteredRows]);

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
  // Header checkbox tracks the *visible* set (rows after the search filter).
  // This matches the lazy-user expectation: type to narrow, click select-all,
  // get exactly the rows you can see.
  const allFilteredSelected = useMemo(() => {
    if (filteredRows.length === 0) return false;
    for (const key of filteredKeySet) {
      if (!selected.has(key)) return false;
    }
    return true;
  }, [filteredRows, filteredKeySet, selected]);

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
      if (allFilteredSelected) {
        // Deselect the visible set; rows hidden by the search query stay
        // selected so they are not silently dropped.
        for (const key of filteredKeySet) next.delete(key);
      } else {
        for (const key of filteredKeySet) next.add(key);
      }
      console.info("[content list selection]", { count: next.size });
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  // Open the confirm modal with the chosen action. Per-row actions reuse this
  // by passing a one-item array, so there's exactly one execution path.
  function requestAction(
    items: BulkContentItem[],
    op: BulkUpdateOp | { type: "delete" },
  ) {
    if (items.length === 0) return;
    setTypedConfirm("");
    setFailures([]);
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
    setConfirm({ verb, items, op, destructive: op.type === "delete" });
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
    const { items, op } = confirm;
    console.info("[content list bulk submit]", {
      type: op.type,
      count: items.length,
    });
    startTransition(async () => {
      let result: BulkActionResult;
      try {
        if (op.type === "delete") {
          result = await bulkDeleteContentAction(items);
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
      if (op.type !== "delete" && result.ok.length > 0) {
        scheduleUndo(op, result.prev);
      }
      clearSelection();
      router.refresh();
    });
  }

  // 2026-06-21: count the rows currently visible that are eligible for the
  // LLM reclassify backfill (NULL or "Drama" categories). Used to label
  // the button and the confirm dialog with a concrete number.
  const reclassifyEligibleCount = useMemo(() => {
    let n = 0;
    for (const r of rows) {
      if (r.kind !== "story") continue;
      if (r.badge === null || r.badge === "Drama") n += 1;
    }
    return n;
  }, [rows]);

  function requestRegen(target: BulkRegenTarget) {
    // Filter to stories at the request edge — the server enforces this too
    // (articles come back with reason "not-a-story") but stripping client-
    // side keeps the modal's "0 articles will be skipped" copy honest.
    const storyItems = selectedItems.filter((i) => i.kind === "story");
    if (storyItems.length === 0) return;
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
      let result: BulkRegenResult;
      try {
        result = await bulkRegenerateContentAction(items, target);
      } catch (err) {
        result = {
          target,
          ok: [],
          failed: items.map((it) => ({
            ...it,
            reason: err instanceof Error ? err.message : String(err),
          })),
        };
      }
      console.info("[content list regen result]", {
        target,
        ok: result.ok.length,
        failed: result.failed.length,
      });
      setRegenConfirm(null);
      setRegenResult(result);
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

  function runReclassify() {
    console.info("[content list reclassify submit]");
    setReclassifyConfirmOpen(false);
    startTransition(async () => {
      try {
        const result = await bulkReclassifyStoriesAction();
        console.info("[content list reclassify result]", {
          scanned: result.scanned,
          reclassified: result.reclassified,
          unchanged: result.unchanged,
          failed: result.failed.length,
        });
        setReclassifyResult(result);
        router.refresh();
      } catch (err) {
        console.error("[content list reclassify failed]", {
          error: err instanceof Error ? err.message : String(err),
        });
        setReclassifyResult({
          scanned: 0,
          reclassified: 0,
          unchanged: 0,
          failed: [
            {
              id: "—",
              title: "—",
              reason: err instanceof Error ? err.message : String(err),
            },
          ],
          changes: [],
        });
      }
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

      {reclassifyResult && (
        <ReclassifyResultBanner
          result={reclassifyResult}
          onDismiss={() => setReclassifyResult(null)}
        />
      )}

      {regenResult && (
        <RegenResultBanner
          result={regenResult}
          rowByKey={rowByKey}
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

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-2">
        <span className="font-mono text-[11px] text-muted">
          <span className="text-ink">{reclassifyEligibleCount}</span> stor
          {reclassifyEligibleCount === 1 ? "y" : "ies"} tagged Drama or
          uncategorized.
          {reclassifyEligibleCount === 0 ? " Backlog is clean." : ""}
        </span>
        <button
          type="button"
          onClick={() => setReclassifyConfirmOpen(true)}
          disabled={pending || reclassifyEligibleCount === 0}
          title="Run the LLM classifier on every story tagged Drama or uncategorized. Manually-set non-Drama categories are not touched."
          className="rounded-md border border-accent/50 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-accent transition-colors hover:bg-accent hover:text-bg disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "Working…" : "Reclassify Drama + uncategorized"}
        </button>
      </div>

      {reclassifyConfirmOpen && (
        <ReclassifyConfirmModal
          eligibleCount={reclassifyEligibleCount}
          pending={pending}
          onCancel={() => setReclassifyConfirmOpen(false)}
          onRun={runReclassify}
        />
      )}

      <div className="relative">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title, slug, category, status, id…"
          aria-label="Search content"
          className="w-full rounded-xl border border-line bg-surface px-4 py-2 pr-9 text-[13px] text-ink placeholder:text-muted focus:border-accent focus:outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-0.5 font-mono text-[12px] text-muted transition-colors hover:text-ink"
          >
            ×
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        {rows.length === 0 ? (
          <p className="bg-surface p-6 text-center text-[14px] text-muted">
            No content matches this filter.
          </p>
        ) : filteredRows.length === 0 ? (
          <p className="bg-surface p-6 text-center text-[14px] text-muted">
            No content matches{" "}
            <span className="font-mono text-ink">&ldquo;{query.trim()}&rdquo;</span>
            .
          </p>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-line bg-surface2 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-muted">
              <input
                type="checkbox"
                checked={allFilteredSelected}
                onChange={toggleAll}
                aria-label={
                  allFilteredSelected ? "Clear selection" : "Select all"
                }
                className="h-3.5 w-3.5 cursor-pointer accent-accent"
              />
              <span>
                {anySelected
                  ? `${counts.total} selected`
                  : query.trim()
                    ? `${filteredRows.length} of ${rows.length} ${rows.length === 1 ? "item" : "items"}`
                    : `${rows.length} ${rows.length === 1 ? "item" : "items"}`}
              </span>
            </div>
            {filteredRows.map((r) => {
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

      {anySelected && (
        <BulkActionBar
          counts={counts}
          disabled={pending}
          onAction={(op) => requestAction(selectedItems, op)}
          onRegen={requestRegen}
          onBulkPublish={runBulkPublish}
          onBulkComplete={requestComplete}
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
    </>
  );
}

// --- Bulk action bar (sticky bottom) ----------------------------------------

function BulkActionBar({
  counts,
  disabled,
  onAction,
  onRegen,
  onBulkPublish,
  onBulkComplete,
  onClear,
}: {
  counts: { total: number; stories: number; articles: number };
  disabled: boolean;
  onAction: (op: BulkUpdateOp | { type: "delete" }) => void;
  onRegen: (target: BulkRegenTarget) => void;
  onBulkPublish: (platforms: SocialPlatform[]) => void;
  onBulkComplete: () => void;
  onClear: () => void;
}) {
  const categoryDisabled = counts.articles > 0;
  // Regen targets fan out to story-pipeline primitives — articles are not
  // pipeline citizens, so the menu is dark when the selection is articles-
  // only. Mixed selections light up but the server filters to stories.
  const regenDisabled = counts.stories === 0;
  const bulkPublishDisabled = counts.stories === 0;
  const completeDisabled = counts.stories === 0;
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
          options={CATEGORIES.map((c) => ({ value: c, label: c }))}
          onPick={(value) => onAction({ type: "category", category: value })}
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
          options={(Object.keys(REGEN_TARGET_META) as BulkRegenTarget[]).map(
            (t) => ({
              value: t,
              label: REGEN_TARGET_META[t].label,
            }),
          )}
          onPick={(value) => onRegen(value as BulkRegenTarget)}
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
          className={`absolute right-0 z-20 ${menuPos} min-w-[180px] overflow-hidden rounded-md border border-line bg-surface shadow-2xl`}
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
  disabled,
  onAction,
}: {
  row: ContentRow;
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
        <ul className="absolute right-3 top-full z-20 mt-1 min-w-[180px] overflow-hidden rounded-md border border-line bg-surface shadow-2xl">
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
              options={CATEGORIES.map((c) => ({ value: c, label: c }))}
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
// 6-option dropdown that calls the existing single-item bulk-update
// path. Articles don't render this — they have no writable category
// column. Plan: _plans/2026-06-21-category-classifier-and-pills.md.
function RowCategoryChip({
  currentCategory,
  disabled,
  onPick,
}: {
  currentCategory: string | null;
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
  return (
    <div ref={wrap} className="relative mr-2 flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-label={`Change category (currently ${label})`}
        title="Change category"
        className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 ${categoryChipClass(
          currentCategory,
        )}`}
      >
        {label}
      </button>
      {open && (
        <ul className="absolute right-0 top-full z-20 mt-1 min-w-[140px] overflow-hidden rounded-md border border-line bg-surface shadow-2xl">
          {CATEGORIES.map((c) => (
            <li key={c}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  if (c === currentCategory) return;
                  onPick(c);
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-surface2 ${
                  c === currentCategory ? "text-muted" : "text-ink"
                }`}
              >
                <span
                  aria-hidden
                  className={`inline-block h-2 w-2 rounded-full border ${categoryChipClass(c)}`}
                />
                {c}
                {c === currentCategory ? (
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
          {state.verb} {state.items.length}{" "}
          {state.items.length === 1 ? "item" : "items"}?
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
              Hard delete is permanent. Rendered audio and video are also
              removed from storage. Type DELETE to confirm.
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

// --- Reclassify confirm modal + result banner -------------------------------
// 2026-06-21. Same modal shape as ConfirmModal but scoped to the LLM
// reclassify backfill. Body explains exactly what the action will do so
// a lazy-user (rule 10) doesn't have to reverse-engineer the verb.
// Plan: _plans/2026-06-21-category-classifier-and-pills.md.

function ReclassifyConfirmModal({
  eligibleCount,
  pending,
  onCancel,
  onRun,
}: {
  eligibleCount: number;
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
          Reclassify {eligibleCount} stor{eligibleCount === 1 ? "y" : "ies"}?
        </h3>
        <p className="mt-2 text-[13px] text-muted">
          The LLM will read each story&apos;s title + article body and pick
          one of Drama / Entitled / Humor / Wholesome / Dating / Roommate.
          Only stories tagged{" "}
          <span className="text-ink font-semibold">Drama</span> or
          <span className="text-ink font-semibold"> uncategorized</span> are
          scanned. Manually-set non-Drama categories stay untouched.
        </p>
        <p className="mt-2 font-mono text-[11px] text-muted">
          One small LLM call per story. Capped at 200 per run.
        </p>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onRun}
            disabled={pending || eligibleCount === 0}
            className="flex-1 rounded-md bg-accent px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Working…" : "Reclassify"}
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
  onDismiss,
}: {
  result: ReclassifyResult;
  onDismiss: () => void;
}) {
  const previewChanges = result.changes.slice(0, 6);
  const overflow = result.changes.length - previewChanges.length;
  return (
    <div className="space-y-2 rounded-xl border border-accent/40 bg-accent/10 p-3 font-mono text-[11px] text-ink">
      <div className="flex items-center justify-between gap-3">
        <span>
          Scanned {result.scanned} · Reclassified{" "}
          <span className="text-accent">{result.reclassified}</span> · Unchanged{" "}
          {result.unchanged}
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
      {previewChanges.length > 0 && (
        <ul className="space-y-0.5 border-t border-accent/20 pt-2 text-muted">
          {previewChanges.map((c) => (
            <li key={c.id}>
              <span className="text-ink">{c.title}</span>
              <span className="opacity-70">
                {" "}
                — {c.prev ?? "uncategorized"} → {c.next}
              </span>
            </li>
          ))}
          {overflow > 0 && <li>…and {overflow} more</li>}
        </ul>
      )}
      {result.failed.length > 0 && (
        <ul className="space-y-0.5 border-t border-danger/30 pt-2 text-danger">
          {result.failed.slice(0, 5).map((f) => (
            <li key={f.id}>
              <span className="text-ink">{f.title}</span>
              <span className="opacity-70"> — {f.reason}</span>
            </li>
          ))}
          {result.failed.length > 5 && (
            <li>…and {result.failed.length - 5} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

// --- Bulk regen confirm modal + result banner -------------------------------
// 2026-06-24. Same modal shape as ConfirmModal / ReclassifyConfirmModal. The
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
  const meta = REGEN_TARGET_META[target];
  const previewCount = Math.min(items.length, 6);
  const overflow = items.length - previewCount;
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
          Estimate: {meta.perStoryHint} × {items.length} stor
          {items.length === 1 ? "y" : "ies"}.
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
  onDismiss,
}: {
  result: BulkRegenResult;
  rowByKey: Map<string, ContentRow>;
  onDismiss: () => void;
}) {
  const meta = REGEN_TARGET_META[result.target];
  const previewFailures = result.failed.slice(0, 6);
  const overflow = result.failed.length - previewFailures.length;
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
          pipeline. A 2-minute cron then publishes each story to all
          four socials (Facebook + Instagram Reels &amp; Stories, YouTube,
          TikTok) the moment every asset is ready.
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
