// Admin curation page.
//
// Phase 2 of _plans/2026-06-15-curation-system.md. One section per
// slot_kind: Billboard, the four rails, the six category pages. Each
// section is a self-contained client editor — local state for the
// picked story_ids, an inline search (filters the in-page directory
// of published stories), and up/down/remove buttons per row. Saving
// posts the new ordered list to setCurationSlotAction which does an
// atomic replace in curation_slots.
//
// No drag-and-drop in this first cut (Phase 2.5 if it'd actually help —
// keyboard-friendly up/down buttons ship today, work in every browser,
// and don't require pulling dnd-kit into the admin bundle).

import Link from "next/link";
import { requireAdmin } from "@/lib/dal";
import {
  CATEGORY_KINDS,
  RAIL_SLOT_KINDS,
  SINGLETON_SLOT_KINDS,
  isAutofillableRail,
  listAllSlots,
  listPublishedStoriesForCuration,
  readAutofillSettings,
  type CurationStoryOption,
} from "@/lib/curation";
import { setCurationAutofillAction } from "@/app/admin/actions";
import CurationSlotEditor, { toDatetimeLocal } from "./CurationSlotEditor";

export const dynamic = "force-dynamic";

interface PageSearchParams {
  saved?: string;
  error?: string;
  autofill_saved?: string;
}

const SLOT_LABELS: Record<string, string> = {
  "billboard.featured": "Billboard — Featured story",
  "rail.continue": "Rail — Continue Watching",
  "rail.top10": "Rail — Top 10 Today",
  "rail.new": "Rail — New",
  "rail.entitled": "Rail — Entitled",
};

for (const c of CATEGORY_KINDS) {
  SLOT_LABELS[`category.${c}`] = `Category page — ${c}`;
}

const SLOT_HINTS: Record<string, string> = {
  "billboard.featured":
    "Only the first story is shown on the home Billboard. Extras are ignored.",
  "rail.continue":
    "Targets ~4–10 stories. Phase 6 auto-fill will pad shorter rails.",
  "rail.top10": "Targets exactly 10.",
  "rail.new": "Targets ~6–10. Use for newest releases that aren't auto-detected.",
  "rail.entitled":
    "Legacy 'Entitled' rail on the home page. Will likely sunset in favour of category pages.",
};

const SLOT_ORDER: string[] = [
  ...SINGLETON_SLOT_KINDS,
  ...RAIL_SLOT_KINDS,
  ...CATEGORY_KINDS.map((c) => `category.${c}`),
];

export default async function CurationPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  await requireAdmin();
  const sp = await searchParams;

  const [slots, stories, autofillEnabled] = await Promise.all([
    listAllSlots(),
    listPublishedStoriesForCuration(),
    readAutofillSettings(),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
            Curation
          </h1>
          <p className="mt-1 font-mono text-[11px] text-muted">
            Pick which stories appear on the home page Billboard, in each rail,
            and on each category page.{" "}
            {stories.length.toLocaleString()} published story
            {stories.length === 1 ? "" : "ies"} available.
          </p>
        </div>
        <Link
          href="/admin/stories"
          className="font-mono text-[11px] text-muted hover:text-ink"
        >
          ← Stories
        </Link>
      </div>

      {sp.saved && (
        <div className="rounded-xl border border-cat-ok/40 bg-cat-ok/10 px-3 py-2 text-[12px] text-cat-ok">
          Saved <code>{decodeURIComponent(sp.saved)}</code>.
        </div>
      )}
      {sp.error && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {sp.error === "bad-slot-kind"
            ? "Unknown slot kind. The form was tampered with — slot kinds are validated server-side."
            : sp.error === "bad-picks-json"
              ? "Couldn't parse the schedule payload. Refresh and try again."
              : sp.error === "bad-picks-shape"
                ? "Schedule payload was malformed. Refresh and try again."
                : sp.error === "bad-autofill-slot"
                  ? "Auto-fill toggles only apply to rail.top10 / rail.new / rail.entitled."
                  : sp.error.replace(/-/g, " ")}
        </div>
      )}
      {sp.autofill_saved && (
        <div className="rounded-xl border border-cat-ok/40 bg-cat-ok/10 px-3 py-2 text-[12px] text-cat-ok">
          Auto-fill updated for{" "}
          <code>{decodeURIComponent(sp.autofill_saved)}</code>.
        </div>
      )}

      {stories.length === 0 && (
        <div className="rounded-xl border border-line bg-surface px-3 py-3 text-[12px] text-muted">
          No published stories yet. Publish at least one story before curating —
          there&rsquo;s nothing to pin.
        </div>
      )}

      <div className="space-y-5">
        {SLOT_ORDER.map((slotKind) => {
          const showAutofill = isAutofillableRail(slotKind);
          const fillOn = showAutofill && autofillEnabled.has(slotKind);
          return (
            <div key={slotKind} className="space-y-2">
              <CurationSlotEditor
                slotKind={slotKind}
                label={SLOT_LABELS[slotKind] ?? slotKind}
                hint={SLOT_HINTS[slotKind]}
                initialPicks={(slots[slotKind] ?? []).map((r) => ({
                  story_id: r.story_id,
                  publish_at: toDatetimeLocal(r.publish_at),
                  expires_at: toDatetimeLocal(r.expires_at),
                }))}
                singleton={(SINGLETON_SLOT_KINDS as readonly string[]).includes(
                  slotKind,
                )}
                stories={
                  slotKind.startsWith("category.")
                    ? // Category slots only suggest stories of that category in
                      // the picker — saves the admin from wading through every
                      // published story to find Drama ones.
                      filterByCategory(stories, slotKind.slice("category.".length))
                    : stories
                }
              />
              {showAutofill && (
                <AutofillToggle slotKind={slotKind} enabled={fillOn} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AutofillToggle({
  slotKind,
  enabled,
}: {
  slotKind: string;
  enabled: boolean;
}) {
  return (
    <form
      action={setCurationAutofillAction}
      className="flex items-center justify-between rounded-lg border border-line bg-bg px-3 py-2"
    >
      <input type="hidden" name="slot_kind" value={slotKind} />
      <input type="hidden" name="enabled" value={enabled ? "0" : "1"} />
      <div>
        <div className="font-mono text-[11px] uppercase tracking-wider text-ink">
          Auto-fill remainder
        </div>
        <p className="font-mono text-[10px] text-muted">
          {enabled
            ? `On — newest published stories pad this rail to ${10} after your pins.`
            : "Off — only your pinned stories render."}
        </p>
      </div>
      <button
        type="submit"
        className={`rounded-md border px-3 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
          enabled
            ? "border-accent/40 bg-accent/10 text-accent hover:bg-accent/20"
            : "border-line text-muted hover:border-accent hover:text-accent"
        }`}
      >
        {enabled ? "Disable" : "Enable"}
      </button>
    </form>
  );
}

function filterByCategory(
  stories: CurationStoryOption[],
  category: string,
): CurationStoryOption[] {
  return stories.filter((s) => s.category === category);
}
