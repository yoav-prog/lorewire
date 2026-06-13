// MediaRegenPanel — server-rendered list of regen-able assets for a story
// or article, with per-asset cost estimates, latest queue status, and a
// budget bar showing daily spend.
//
// Owner-kind dispatch: the panel takes a generic `assets` array so the
// caller (story editor, article editor) decides what's surfaced. Story
// callers pass {hero, scenes, props, mouth_swap}; article callers pass
// {hero, og, gallery, body} per their domain.
//
// Polling: <RegenAutoRefresh> only ticks when at least one asset has a
// transitional render. Idle panels stay quiet.

import {
  ACTIVE_IMAGE_RENDER_STATUSES,
  estimateImageRegenCostCents,
  getDailyImageBudget,
  latestBulkScenes,
  latestRenderForAsset,
  type AssetOwnerKind,
  type ImageRenderRow,
} from "@/lib/image-render-queue";
import { RegenButton } from "./RegenButton";
import { RegenAutoRefresh } from "./RegenAutoRefresh";
import { RebuildAllButton } from "./RebuildAllButton";
import { RenderEventTimeline } from "./RenderEventTimeline";
import { StopButton } from "./StopButton";
import { StopAllButton } from "./StopAllButton";

export interface MediaAssetSpec {
  /** Stable slug stored on the render row. */
  asset: string;
  /** User-facing label, e.g. "Hero image". */
  label: string;
  /** One-line description shown below the label. */
  hint: string;
  /** Optional override for the image count when the asset's count comes from
   *  somewhere other than admin settings — e.g. article body images counted
   *  from the Tiptap doc. */
  imageCountOverride?: number;
}

const TRANSITIONAL = ACTIVE_IMAGE_RENDER_STATUSES;

export async function MediaRegenPanel({
  ownerKind,
  ownerId,
  assets,
}: {
  ownerKind: AssetOwnerKind;
  ownerId: string;
  assets: MediaAssetSpec[];
}) {
  // Resolve everything in one pass so the panel paints in a single tick.
  // Story "scenes" reads its row state from the aggregate of scene:N rows
  // because the legacy single 'scenes' row was retired in the 2026-06-13
  // per-scene-queue migration. The card still surfaces as one entry to
  // the admin; the aggregate carries the active count for Stop-all.
  const scenesBulk =
    ownerKind === "story" && assets.some((a) => a.asset === "scenes")
      ? await latestBulkScenes(ownerKind, ownerId)
      : null;

  const enriched = await Promise.all(
    assets.map(async (a) => {
      const isScenes = ownerKind === "story" && a.asset === "scenes";
      return {
        ...a,
        estimateCents: await estimateImageRegenCostCents(
          a.asset,
          a.imageCountOverride,
        ),
        latest:
          isScenes && scenesBulk
            ? scenesBulk.latest
            : await latestRenderForAsset(ownerKind, ownerId, a.asset),
        bulkActiveIds:
          isScenes && scenesBulk ? scenesBulk.activeIds : ([] as string[]),
        bulkProgress:
          isScenes && scenesBulk
            ? {
                done: scenesBulk.done,
                total: scenesBulk.total,
                active: scenesBulk.active,
                error: scenesBulk.error,
                cancelled: scenesBulk.cancelled,
              }
            : null,
      };
    }),
  );
  const budget = await getDailyImageBudget();

  // Sum every active queue row owned by this story/article, not just the
  // visible cards. The scenes aggregate may contribute N rows from a single
  // card, so totalActiveCount drives both the polling refresh and the
  // header "Stop all" affordance.
  const totalActiveCount = enriched.reduce((sum, a) => {
    if (a.bulkProgress) return sum + a.bulkProgress.active;
    return sum + (a.latest && TRANSITIONAL.has(a.latest.status) ? 1 : 0);
  }, 0);
  const activeRows = totalActiveCount;

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <RegenAutoRefresh activeRows={activeRows} />

      <header className="mb-3">
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-muted">
          Media re-render
        </h3>
        <BudgetBar
          spentCents={budget.spentCents}
          capCents={budget.capCents}
        />
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-[200px] flex-1">
          <RebuildAllButton
            ownerKind={ownerKind}
            ownerId={ownerId}
            specs={enriched.map((a) => ({
              asset: a.asset,
              label: a.label,
              estimateCents: a.estimateCents,
            }))}
          />
        </div>
        <StopAllButton
          ownerKind={ownerKind}
          ownerId={ownerId}
          activeCount={totalActiveCount}
        />
      </div>

      <ul className="space-y-2">
        {enriched.map((a) => {
          const rowIsActive =
            a.latest != null && TRANSITIONAL.has(a.latest.status);
          // Bulk scenes use their own active count; per-row Stop on a
          // single scene cancels just that row, so the card's Stop
          // affordance has to cover every active scene:N at once.
          const hasBulkActive = (a.bulkProgress?.active ?? 0) > 0;
          return (
            <li
              key={a.asset}
              className="rounded-lg border border-line bg-bg p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-ink">
                    {a.label}
                  </div>
                  <p className="mt-0.5 text-[12px] text-muted">{a.hint}</p>
                  <LatestRenderLine
                    row={a.latest}
                    bulkProgress={a.bulkProgress}
                  />
                  {a.latest && (
                    <RenderEventTimeline
                      renderId={a.latest.id}
                      isActive={TRANSITIONAL.has(a.latest.status)}
                    />
                  )}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <RegenButton
                    ownerKind={ownerKind}
                    ownerId={ownerId}
                    asset={a.asset}
                    estimateCents={a.estimateCents}
                  />
                  {hasBulkActive ? (
                    <StopAllButton
                      ownerKind={ownerKind}
                      ownerId={ownerId}
                      activeCount={a.bulkProgress!.active}
                    />
                  ) : rowIsActive && a.latest ? (
                    <StopButton renderId={a.latest.id} />
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BudgetBar({
  spentCents,
  capCents,
}: {
  spentCents: number;
  capCents: number;
}) {
  const pct =
    capCents <= 0 ? 0 : Math.min(100, Math.round((spentCents / capCents) * 100));
  const over = spentCents > capCents;
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between font-mono text-[10px] text-muted">
        <span>
          Today: ${(spentCents / 100).toFixed(2)} of $
          {(capCents / 100).toFixed(2)}
        </span>
        <span className={over ? "text-danger" : "text-muted"}>{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface2">
        <div
          className={`h-full ${over ? "bg-danger" : "bg-accent"} transition-[width]`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function LatestRenderLine({
  row,
  bulkProgress,
}: {
  row: ImageRenderRow | null;
  bulkProgress?: {
    done: number;
    total: number;
    active: number;
    error: number;
    cancelled: number;
  } | null;
}) {
  if (!row) {
    return (
      <p className="mt-1 font-mono text-[11px] text-muted">
        Never regenerated.
      </p>
    );
  }
  const ts = row.finished_at ?? row.requested_at;
  const ago = formatAgo(ts);
  // Bulk surfaces win over the single-row status: when 27 scene:N rows
  // share a card, "12/27 done · 3 in flight" is what the admin needs to
  // see, not the status of whichever row happened to be newest.
  if (bulkProgress && bulkProgress.total > 0) {
    const tone =
      bulkProgress.active > 0
        ? "text-warn"
        : bulkProgress.error > 0 || bulkProgress.cancelled > 0
          ? "text-muted"
          : "text-muted";
    const parts: string[] = [`${bulkProgress.done}/${bulkProgress.total} done`];
    if (bulkProgress.active > 0) parts.push(`${bulkProgress.active} in flight`);
    if (bulkProgress.error > 0) parts.push(`${bulkProgress.error} error`);
    if (bulkProgress.cancelled > 0)
      parts.push(`${bulkProgress.cancelled} cancelled`);
    return (
      <p className={`mt-1 font-mono text-[11px] ${tone}`}>
        {parts.join(" · ")} · {ago}
      </p>
    );
  }
  if (row.status === "queued") {
    return (
      <p className="mt-1 font-mono text-[11px] text-warn">
        Queued · {ago}
      </p>
    );
  }
  if (row.status === "generating") {
    return (
      <p className="mt-1 font-mono text-[11px] text-warn">
        Generating · {ago}
      </p>
    );
  }
  if (row.status === "error") {
    return (
      <p className="mt-1 font-mono text-[11px] text-danger">
        Error: {row.error ?? "unknown"} · {ago}
      </p>
    );
  }
  if (row.status === "cancelled") {
    return (
      <p className="mt-1 font-mono text-[11px] text-muted">
        Cancelled · {ago}
      </p>
    );
  }
  return (
    <p className="mt-1 font-mono text-[11px] text-muted">
      Last regenerated {ago}
      {row.cost_cents != null
        ? ` · cost $${(row.cost_cents / 100).toFixed(2)}`
        : ""}
    </p>
  );
}

function formatAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
