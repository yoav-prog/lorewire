// Phase 5 of _plans/2026-06-15-curation-system.md.
//
// Sidebar panel on the story editor (`/admin/stories/[id]`). Two jobs:
//
//   1. Show every slot this story is already pinned to, with a one-click
//      Remove button per row.
//   2. Let the admin pin the story to a new slot via a single select
//      (every valid slot_kind from the registry) — no need to navigate
//      to /admin/curation when the admin's already on the story page
//      that just got published.
//
// Server component. The two forms POST to the per-story actions in
// `actions.ts` which handle authorization, mutation, and revalidation.
// We render a soft confirmation/error banner based on the
// `?curation_added=` / `?curation_removed=` / `?curation_note=` query
// hints the actions set on redirect — there's no client state here.

import {
  CURATION_SLOT_KINDS,
  listSlotsForStory,
  type CurationSlotRow,
} from "@/lib/curation";
import {
  addStoryToSlotAction,
  removeStoryFromSlotAction,
} from "@/app/admin/actions";

const PANEL = "rounded-xl border border-line bg-surface p-4";
const LABEL = "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";
const FIELD =
  "w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";

export async function StoryCurationPanel({
  storyId,
  storyTitle,
  banner,
}: {
  storyId: string;
  storyTitle?: string | null;
  /** Soft message rendered above the form. Built by the parent page from
   *  the curation_* query params the server actions set on redirect. */
  banner?: { tone: "ok" | "warn"; text: string } | null;
}) {
  const rows = await listSlotsForStory(storyId);
  // Group by kind so a story pinned to two rails doesn't render two
  // header-less rows. We keep one entry per (kind, story) but a story
  // can sit in distinct kinds (rail.top10 + category.Drama).
  const occupiedKinds = new Set(rows.map((r) => r.slot_kind));
  const available = CURATION_SLOT_KINDS.filter((k) => !occupiedKinds.has(k));

  return (
    <div className={PANEL}>
      <div className={LABEL}>Curation</div>
      <p className="mb-3 text-[12px] text-muted">
        Where this story appears on the public site.
        {storyTitle ? ` "${storyTitle}"` : ""}
      </p>

      {banner && (
        <div
          role="status"
          className={`mb-3 rounded-md border px-3 py-2 text-[12px] ${
            banner.tone === "ok"
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-amber-500/40 bg-amber-500/10 text-amber-300"
          }`}
        >
          {banner.text}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="mb-3 text-[12px] text-muted">
          Not pinned to any slot yet. Pick one below to surface this story.
        </p>
      ) : (
        <ul className="mb-3 space-y-1.5">
          {rows.map((r) => (
            <StoryCurationRow key={r.id} row={r} storyId={storyId} />
          ))}
        </ul>
      )}

      {available.length === 0 ? (
        <p className="text-[12px] text-muted">
          Pinned to every slot — nothing more to add.
        </p>
      ) : (
        <form action={addStoryToSlotAction} className="space-y-2">
          <label className={LABEL} htmlFor={`add-slot-${storyId}`}>
            Pin to slot
          </label>
          <input type="hidden" name="story_id" value={storyId} />
          <select
            id={`add-slot-${storyId}`}
            name="slot_kind"
            defaultValue=""
            required
            className={FIELD}
          >
            <option value="" disabled>
              Choose a slot…
            </option>
            <optgroup label="Front page">
              {available
                .filter((k) => k === "billboard.featured" || k.startsWith("rail."))
                .map((k) => (
                  <option key={k} value={k}>
                    {labelForSlot(k)}
                  </option>
                ))}
            </optgroup>
            <optgroup label="Category pages">
              {available
                .filter((k) => k.startsWith("category."))
                .map((k) => (
                  <option key={k} value={k}>
                    {labelForSlot(k)}
                  </option>
                ))}
            </optgroup>
          </select>
          <button
            type="submit"
            className="w-full rounded-md border border-line px-3 py-1.5 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent"
          >
            Pin
          </button>
        </form>
      )}
    </div>
  );
}

function StoryCurationRow({
  row,
  storyId,
}: {
  row: CurationSlotRow;
  storyId: string;
}) {
  return (
    <li className="flex items-center gap-2 rounded-lg border border-line bg-bg px-3 py-2">
      <div className="flex-1 truncate font-mono text-[12px] text-ink">
        {labelForSlot(row.slot_kind)}
        <span className="ml-2 text-[10px] text-muted">
          #{row.position + 1}
        </span>
      </div>
      <form action={removeStoryFromSlotAction}>
        <input type="hidden" name="story_id" value={storyId} />
        <input type="hidden" name="slot_id" value={row.id} />
        <input type="hidden" name="slot_kind" value={row.slot_kind} />
        <button
          type="submit"
          aria-label={`Remove from ${labelForSlot(row.slot_kind)}`}
          className="rounded-md border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-accent hover:text-accent"
        >
          Remove
        </button>
      </form>
    </li>
  );
}

// Human label for each slot kind. Falls through to the raw key so an
// unknown kind (legacy / future) still renders.
export function labelForSlot(slotKind: string): string {
  switch (slotKind) {
    case "billboard.featured":
      return "Billboard — featured";
    case "rail.continue":
      return "Rail — Continue Watching";
    case "rail.top10":
      return "Rail — Top 10 Today";
    case "rail.new":
      return "Rail — New on LoreWire";
    case "rail.entitled":
      return "Rail — Entitled";
    default:
      if (slotKind.startsWith("category.")) {
        return `Category — ${slotKind.slice("category.".length)}`;
      }
      return slotKind;
  }
}
