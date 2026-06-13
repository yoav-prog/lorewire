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
  estimateImageRegenCostCents,
  getDailyImageBudget,
  latestRenderForAsset,
  type AssetOwnerKind,
  type ImageRenderRow,
} from "@/lib/image-render-queue";
import { RegenButton } from "./RegenButton";
import { RegenAutoRefresh } from "./RegenAutoRefresh";
import { RebuildAllButton } from "./RebuildAllButton";
import { RenderEventTimeline } from "./RenderEventTimeline";

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

const TRANSITIONAL = new Set(["queued", "generating"]);

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
  const enriched = await Promise.all(
    assets.map(async (a) => ({
      ...a,
      estimateCents: await estimateImageRegenCostCents(
        a.asset,
        a.imageCountOverride,
      ),
      latest: await latestRenderForAsset(ownerKind, ownerId, a.asset),
    })),
  );
  const budget = await getDailyImageBudget();

  const activeRows = enriched.filter(
    (a) => a.latest && TRANSITIONAL.has(a.latest.status),
  ).length;

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

      <div className="mb-3">
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

      <ul className="space-y-2">
        {enriched.map((a) => (
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
                <LatestRenderLine row={a.latest} />
                {a.latest && (
                  <RenderEventTimeline
                    renderId={a.latest.id}
                    isActive={TRANSITIONAL.has(a.latest.status)}
                  />
                )}
              </div>
              <RegenButton
                ownerKind={ownerKind}
                ownerId={ownerId}
                asset={a.asset}
                estimateCents={a.estimateCents}
              />
            </div>
          </li>
        ))}
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

function LatestRenderLine({ row }: { row: ImageRenderRow | null }) {
  if (!row) {
    return (
      <p className="mt-1 font-mono text-[11px] text-muted">
        Never regenerated.
      </p>
    );
  }
  const ts = row.finished_at ?? row.requested_at;
  const ago = formatAgo(ts);
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
