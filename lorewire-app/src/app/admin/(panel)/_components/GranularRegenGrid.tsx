// Per-image regen grid. Renders a thumbnail per asset element with a small
// Regenerate button next to each one. Used for the bulk slugs where the
// admin sometimes wants to redo just one item — story scenes, story props,
// article body images, article gallery items.
//
// Slug shape matches the queue contract (see image-render-queue.ts):
//   scene:N        story scenes
//   prop:N         story props
//   body:N         article body images
//   gallery:N      article gallery items (flat index across galleries)
//
// Each row is independent — the RegenButton's local pending state is
// per-button, so the user can fire several in parallel.

import {
  estimateImageRegenCostCents,
  latestRenderForAsset,
  type AssetOwnerKind,
  type ImageRenderRow,
} from "@/lib/image-render-queue";
import { RegenButton } from "./RegenButton";

export interface GranularItem {
  /** Asset slug stored on the queue row, e.g. "scene:3". */
  asset: string;
  /** Image URL to show as the thumbnail. */
  src: string;
  /** Short caption under the thumbnail, e.g. "Scene 4". */
  label: string;
  /** Optional second-line meta, e.g. "right · prop". */
  meta?: string;
}

const TRANSITIONAL = new Set(["queued", "generating"]);

function statusBadge(row: ImageRenderRow | null): string | null {
  if (!row) return null;
  if (row.status === "queued") return "Queued";
  if (row.status === "generating") return "Generating";
  if (row.status === "error") return "Failed";
  return null;
}

export async function GranularRegenGrid({
  ownerKind,
  ownerId,
  title,
  description,
  items,
}: {
  ownerKind: AssetOwnerKind;
  ownerId: string;
  title: string;
  description?: string;
  items: GranularItem[];
}) {
  if (items.length === 0) return null;

  const enriched = await Promise.all(
    items.map(async (it) => ({
      ...it,
      estimateCents: await estimateImageRegenCostCents(it.asset),
      latest: await latestRenderForAsset(ownerKind, ownerId, it.asset),
    })),
  );

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <header className="mb-3">
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-muted">
          {title}
        </h3>
        {description && (
          <p className="mt-0.5 text-[12px] text-muted">{description}</p>
        )}
      </header>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {enriched.map((it) => {
          const badge = statusBadge(it.latest);
          const transitional =
            it.latest !== null && TRANSITIONAL.has(it.latest.status);
          return (
            <li
              key={it.asset}
              className="overflow-hidden rounded-lg border border-line bg-bg"
            >
              <div className="relative aspect-square overflow-hidden bg-surface2">
                {it.src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={it.src}
                    alt={it.label}
                    className={`h-full w-full object-cover transition-opacity ${
                      transitional ? "opacity-50" : ""
                    }`}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center font-mono text-[10px] text-muted">
                    no image
                  </div>
                )}
                {badge && (
                  <span
                    className={`absolute right-1.5 top-1.5 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider ${
                      it.latest?.status === "error"
                        ? "border-danger/40 bg-danger/15 text-danger"
                        : "border-warn/40 bg-warn/15 text-warn"
                    }`}
                  >
                    {badge}
                  </span>
                )}
              </div>
              <div className="space-y-1 p-2">
                <p className="truncate text-[11px] font-semibold text-ink">
                  {it.label}
                </p>
                {it.meta && (
                  <p className="truncate font-mono text-[10px] text-muted">
                    {it.meta}
                  </p>
                )}
                <RegenButton
                  ownerKind={ownerKind}
                  ownerId={ownerId}
                  asset={it.asset}
                  estimateCents={it.estimateCents}
                  label="Redo"
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
