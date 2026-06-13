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
} from "@/lib/image-render-queue";
import { GranularImageCard } from "./GranularImageCard";

export interface GranularItem {
  /** Asset slug stored on the queue row, e.g. "scene:3". */
  asset: string;
  /** Image URL to show as the thumbnail. */
  src: string;
  /** Short caption under the thumbnail, e.g. "Scene 4". */
  label: string;
  /** Optional second-line meta, e.g. "right · prop". */
  meta?: string;
  /** Stored prompt that produced this image — surfaced in the lightbox
   *  so the admin can debug "why does this image look unrelated" without
   *  digging into the DB. For story scenes this comes from
   *  doodle_frames[i].image_prompt; other slugs may not have one
   *  persisted yet. */
  prompt?: string;
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

  // Server-side enrichment: each item picks up its per-image cost estimate
  // and the latest queue row (drives the status badge + the cache-bust
  // token on the thumbnail). Each card itself is a client component so
  // the click-to-zoom modal + the prompt-copy button can be interactive
  // without forcing the whole grid down the client bundle.
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
        <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted">
          Tip: click any thumbnail to see it full-size + the prompt that drew it.
        </p>
      </header>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {enriched.map((it) => (
          <GranularImageCard
            key={it.asset}
            ownerKind={ownerKind}
            ownerId={ownerId}
            asset={it.asset}
            src={it.src}
            label={it.label}
            meta={it.meta}
            estimateCents={it.estimateCents}
            latest={it.latest}
            prompt={it.prompt ?? ""}
          />
        ))}
      </ul>
    </div>
  );
}
