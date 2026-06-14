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

const SLOT_HINTS: Record<string, string> = {
  "billboard.featured":
    "Only the first story is shown on the home Billboard. Extras are ignored.",
  "rail.continue":
    "Targets ~4–10 stories. Continue Watching does not auto-fill.",
  "rail.top10":
    "Targets exactly 10. Auto-fill pads with newest published when on.",
  "rail.new":
    "Targets ~6–10. Use for newest releases that aren't auto-detected.",
  "rail.entitled":
    "Legacy 'Entitled' rail on the home page. Will likely sunset in favour of category pages.",
};

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

  // Compute per-category counts once so the section headers can show
  // pinned / available without re-walking the directory inside each
  // editor.
  const categoryCounts = new Map<string, number>();
  for (const c of CATEGORY_KINDS) {
    categoryCounts.set(c, filterByCategory(stories, c).length);
  }

  return (
    <div className="space-y-6 pb-12">
      {/* Page header */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-extrabold tracking-tightest">
            Curation
          </h1>
          <p className="mt-1.5 max-w-[640px] text-[13px] text-muted">
            Pick which stories appear on the home page Billboard, in each rail,
            and on each category page. Drag pinned rows to reorder; click any
            story below to pin it.
          </p>
          <p className="mt-1.5 font-mono text-[11px] text-muted">
            {stories.length.toLocaleString()} published{" "}
            {stories.length === 1 ? "story" : "stories"} available
          </p>
        </div>
        <Link
          href="/admin/stories"
          className="font-mono text-[11px] text-muted transition-colors hover:text-ink"
        >
          ← Stories
        </Link>
      </header>

      {/* Flash banners */}
      {sp.saved && (
        <div className="rounded-xl border border-cat-ok/40 bg-cat-ok/10 px-3 py-2 text-[12px] text-cat-ok">
          ✓ Saved <code>{decodeURIComponent(sp.saved)}</code>.
        </div>
      )}
      {sp.error && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {curationErrorMessage(sp.error)}
        </div>
      )}
      {sp.autofill_saved && (
        <div className="rounded-xl border border-cat-ok/40 bg-cat-ok/10 px-3 py-2 text-[12px] text-cat-ok">
          ✓ Auto-fill updated for{" "}
          <code>{decodeURIComponent(sp.autofill_saved)}</code>.
        </div>
      )}

      {stories.length === 0 && (
        <div className="rounded-xl border border-line bg-surface px-4 py-4 text-[13px] text-muted">
          <p className="text-ink">No published stories yet.</p>
          <p className="mt-1">
            Publish at least one story before curating &mdash; there&rsquo;s
            nothing to pin.
          </p>
        </div>
      )}

      {/* Front page section */}
      <section>
        <div className="mb-3">
          <h2 className="font-display text-[18px] font-bold tracking-tight">
            Front page
          </h2>
          <p className="mt-0.5 font-mono text-[10px] text-muted">
            Billboard + the four rails on the home page.
          </p>
        </div>
        <div className="space-y-4">
          {[...SINGLETON_SLOT_KINDS, ...RAIL_SLOT_KINDS].map((slotKind) => {
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
                  stories={stories}
                />
                {showAutofill && (
                  <AutofillToggle slotKind={slotKind} enabled={fillOn} />
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Category pages section */}
      <section>
        <div className="mb-3">
          <h2 className="font-display text-[18px] font-bold tracking-tight">
            Category pages
          </h2>
          <p className="mt-0.5 font-mono text-[10px] text-muted">
            One slot per category at <code>/c/&lt;Category&gt;</code>. Pinned
            stories appear first; the rest auto-fill newest-first.
          </p>
        </div>
        <div className="space-y-4">
          {CATEGORY_KINDS.map((category) => {
            const slotKind = `category.${category}`;
            const count = categoryCounts.get(category) ?? 0;
            const pinned = (slots[slotKind] ?? []).length;
            return (
              <CurationSlotEditor
                key={slotKind}
                slotKind={slotKind}
                label={`${category}`}
                hint={
                  count === 0
                    ? "No published stories tagged with this category yet."
                    : `${count} story${count === 1 ? "" : "ies"} in this category · ${pinned} pinned`
                }
                initialPicks={(slots[slotKind] ?? []).map((r) => ({
                  story_id: r.story_id,
                  publish_at: toDatetimeLocal(r.publish_at),
                  expires_at: toDatetimeLocal(r.expires_at),
                }))}
                stories={filterByCategory(stories, category)}
              />
            );
          })}
        </div>
      </section>
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
      className="flex items-center justify-between rounded-xl border border-line/70 bg-bg/60 px-4 py-2.5"
    >
      <input type="hidden" name="slot_kind" value={slotKind} />
      <input type="hidden" name="enabled" value={enabled ? "0" : "1"} />
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className={`relative inline-block h-5 w-9 rounded-full transition-colors ${
            enabled ? "bg-accent/40" : "bg-line/50"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-ink shadow-sm transition-transform ${
              enabled ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </span>
        <div>
          <div className="font-mono text-[11px] uppercase tracking-wider text-ink">
            Auto-fill remainder
          </div>
          <p className="text-[11px] text-muted">
            {enabled
              ? "Newest published stories pad this rail to 10 after your pins."
              : "Only your pinned stories render on the home page."}
          </p>
        </div>
      </div>
      <button
        type="submit"
        className={`rounded-md border px-3 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
          enabled
            ? "border-line text-muted hover:border-accent hover:text-accent"
            : "border-accent bg-accent/10 text-accent hover:bg-accent/20"
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

// Allowlist the error codes we surface — `sp.error` arrives on the URL
// and is rendered into the page text. Without an allowlist a phishing
// link could plant arbitrary copy inside the danger banner (no XSS
// because React escapes, but the banner already carries admin
// authority — "form was tampered with" — so unknown copy is misleading).
function curationErrorMessage(code: string): string {
  switch (code) {
    case "bad-slot-kind":
      return "Unknown slot kind. The form was tampered with — slot kinds are validated server-side.";
    case "bad-picks-json":
      return "Couldn't parse the schedule payload. Refresh and try again.";
    case "bad-picks-shape":
      return "Schedule payload was malformed. Refresh and try again.";
    case "bad-autofill-slot":
      return "Auto-fill toggles only apply to rail.top10 / rail.new / rail.entitled.";
    default:
      return "Something went wrong saving that slot. Please refresh and try again.";
  }
}
