"use client";

// Admin homepage-curation editor. One card per rail (Hero / TOP 10 /
// Continue / category rows / New); each card lists its curated stories
// with reorder + remove controls and an "Add story" button that opens
// the picker dialog. The picker autocompletes over every published
// non-noindex story; clicking a row appends to the surface.
//
// All state lives on the server — every click fires a server action +
// router.refresh() so the cards reflect the current DB. We use
// useTransition for the pending UX so the page never feels frozen but
// the source of truth is always the DB, not local state.
//
// Plan: _plans/2026-06-16-homepage-curation.md (phase 3).

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addCurationAction,
  moveCurationAction,
  removeCurationAction,
  type CurationPickerStory,
  type CurationServerRender,
  type CurationServerRenderRow,
} from "./actions";
import {
  HOMEPAGE_SURFACES,
  SURFACE_CAPACITY,
  type HomepageSurface,
} from "@/lib/homepage-curation-shared";

interface RailSpec {
  surface: HomepageSurface;
  title: string;
  /** Plain-language description the admin reads before deciding what
   *  to put in the slot. Mirrors the public rail title where possible. */
  hint: string;
}

const RAILS: RailSpec[] = [
  { surface: "hero", title: "Hero", hint: "The single front-and-centre pick at the top of the home page." },
  { surface: "top10", title: "TOP 10 Today", hint: "Numbered rail. Exactly 10 picks, ordered." },
  { surface: "continue", title: "Continue Watching", hint: "Editor-curated rail (no per-user state yet)." },
  { surface: "new_row", title: "New on LoreWire", hint: "Fresh-this-week strip; cross-category." },
  { surface: "entitled_row", title: "Audacity: Entitled People", hint: "Category rail · Entitled." },
  { surface: "humor_row", title: "Humor & Awkward Moments", hint: "Category rail · Humor." },
  { surface: "wholesome_row", title: "Wholesome Wins", hint: "Category rail · Wholesome." },
  { surface: "dating_row", title: "Dating Disasters", hint: "Category rail · Dating." },
  { surface: "roommate_row", title: "Roommate Files", hint: "Category rail · Roommate." },
  { surface: "drama_row", title: "Pure Drama", hint: "Category rail · Drama." },
];

// Defensive sanity check at module load: every HomepageSurface must
// have a RailSpec, otherwise the page silently drops the surface from
// the editor and the admin can't curate it. Surfaces should rarely
// change so a hard check at boot is cheaper than a per-render branch.
{
  const railSurfaces = new Set(RAILS.map((r) => r.surface));
  for (const s of HOMEPAGE_SURFACES) {
    if (!railSurfaces.has(s)) {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[admin curation rails missing]", { surface: s });
    }
  }
}

export function CurationClient({
  initial,
}: {
  initial: CurationServerRender;
}) {
  const router = useRouter();
  const [pickerSurface, setPickerSurface] = useState<HomepageSurface | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function call(
    op: () => Promise<{ ok: boolean; error?: string }>,
    onSuccess?: () => void,
  ): void {
    setError(null);
    startTransition(async () => {
      const r = await op();
      if (!r.ok) {
        setError(r.error ?? "operation failed");
        return;
      }
      onSuccess?.();
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
            Homepage curation
          </h1>
          <p className="mt-1 font-mono text-[11px] text-muted">
            Pick which stories appear on each rail. Changes go live on
            the next homepage load — no rebuild needed.
          </p>
        </div>
        {pending && (
          <span className="font-mono text-[11px] text-muted">Saving…</span>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-warn bg-warn/10 px-3 py-2 font-mono text-[11px] text-warn"
        >
          {error}
        </div>
      )}

      <div className="grid gap-4">
        {RAILS.map((rail) => {
          const rows = initial.surfaces[rail.surface] ?? [];
          const cap = SURFACE_CAPACITY[rail.surface];
          const isFull = cap !== null && rows.length >= cap;
          return (
            <section
              key={rail.surface}
              className="rounded-lg border border-line bg-surface p-4"
            >
              <header className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <h2 className="font-display text-[15px] font-bold">
                    {rail.title}
                  </h2>
                  <p className="mt-0.5 font-mono text-[10px] text-muted">
                    {rail.hint}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                    {rows.length}
                    {cap !== null ? ` / ${cap}` : ""} curated
                  </span>
                  <button
                    type="button"
                    onClick={() => setPickerSurface(rail.surface)}
                    disabled={isFull || pending}
                    className="rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    title={isFull ? `Full (${cap}/${cap}) — remove one first` : undefined}
                  >
                    + Add story
                  </button>
                </div>
              </header>

              {rows.length === 0 ? (
                <p className="rounded border border-dashed border-line p-3 text-center font-mono text-[11px] text-muted">
                  Empty — homepage falls back to the hardcoded default for this rail.
                </p>
              ) : (
                <ol className="space-y-2">
                  {rows.map((row, idx) => (
                    <CurationCardRow
                      key={row.id}
                      surface={rail.surface}
                      row={row}
                      index={idx}
                      total={rows.length}
                      pending={pending}
                      onMove={(direction) =>
                        call(() =>
                          moveCurationAction(rail.surface, row.story_id, direction),
                        )
                      }
                      onRemove={() =>
                        call(() =>
                          removeCurationAction(rail.surface, row.story_id),
                        )
                      }
                    />
                  ))}
                </ol>
              )}
            </section>
          );
        })}
      </div>

      {pickerSurface && (
        <CurationPickerDialog
          surface={pickerSurface}
          alreadyInSurface={
            initial.surfaces[pickerSurface]?.map((r) => r.story_id) ?? []
          }
          picker={initial.picker}
          onClose={() => setPickerSurface(null)}
          onPick={(storyId) => {
            const surface = pickerSurface;
            call(
              () => addCurationAction(surface, storyId),
              () => setPickerSurface(null),
            );
          }}
        />
      )}
    </div>
  );
}

function CurationCardRow({
  surface,
  row,
  index,
  total,
  pending,
  onMove,
  onRemove,
}: {
  surface: HomepageSurface;
  row: CurationServerRenderRow;
  index: number;
  total: number;
  pending: boolean;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
}) {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  return (
    <li className="flex items-center gap-3 rounded-md border border-line bg-bg p-2">
      <span className="w-6 shrink-0 text-center font-mono text-[10px] text-muted">
        {index + 1}
      </span>
      {row.hero_image ? (
        // eslint-disable-next-line @next/next/no-img-element -- thumbnail-only
        <img
          src={row.hero_image}
          alt=""
          className="h-10 w-10 shrink-0 rounded object-cover"
        />
      ) : (
        <div className="h-10 w-10 shrink-0 rounded bg-surface" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-body text-[13px] text-ink">
          {row.title ?? <span className="text-muted">(no title)</span>}
        </p>
        <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-muted">
          {row.category && <span>{row.category}</span>}
          <span className="truncate">{row.story_id}</span>
          {!row.is_published && (
            <span className="rounded bg-warn/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-warn">
              unpublished — won&apos;t show on homepage
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onMove("up")}
          disabled={isFirst || pending}
          aria-label={`Move ${row.title ?? row.story_id} up in ${surface}`}
          className="h-7 w-7 rounded border border-line font-mono text-[12px] text-ink transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-30"
          title="Move up"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => onMove("down")}
          disabled={isLast || pending}
          aria-label={`Move ${row.title ?? row.story_id} down in ${surface}`}
          className="h-7 w-7 rounded border border-line font-mono text-[12px] text-ink transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-30"
          title="Move down"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={pending}
          aria-label={`Remove ${row.title ?? row.story_id} from ${surface}`}
          className="h-7 w-7 rounded border border-line font-mono text-[12px] text-warn transition-colors hover:bg-warn/10 disabled:cursor-not-allowed disabled:opacity-30"
          title="Remove"
        >
          ✕
        </button>
      </div>
    </li>
  );
}

function CurationPickerDialog({
  surface,
  alreadyInSurface,
  picker,
  onClose,
  onPick,
}: {
  surface: HomepageSurface;
  alreadyInSurface: string[];
  picker: CurationPickerStory[];
  onClose: () => void;
  onPick: (storyId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("");
  const inSurfaceSet = useMemo(() => new Set(alreadyInSurface), [alreadyInSurface]);
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of picker) {
      if (p.category) set.add(p.category);
    }
    return Array.from(set).sort();
  }, [picker]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return picker.filter((p) => {
      if (category && p.category !== category) return false;
      if (!q) return true;
      const hay = `${p.title ?? ""} ${p.id} ${p.category ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [picker, category, query]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Add story to ${surface}`}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="mt-12 w-full max-w-2xl rounded-lg border border-line bg-surface p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-3 flex items-baseline justify-between gap-3">
          <div>
            <h2 className="font-display text-[16px] font-bold">
              Add to {surface}
            </h2>
            <p className="mt-0.5 font-mono text-[10px] text-muted">
              Picks from every published, non-noindex story.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-muted hover:bg-accent/10 hover:text-ink"
          >
            Close
          </button>
        </header>

        <div className="mb-3 flex flex-wrap gap-2">
          <input
            type="search"
            placeholder="Search title, id, category…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 rounded-md border border-line bg-bg px-3 py-1.5 font-body text-[13px] text-ink placeholder:text-muted"
            autoFocus
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-[12px] text-ink"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <ul className="max-h-[60vh] space-y-1 overflow-y-auto pr-1">
          {filtered.length === 0 && (
            <li className="rounded border border-dashed border-line p-4 text-center font-mono text-[11px] text-muted">
              No matches.
            </li>
          )}
          {filtered.map((p) => {
            const inSurface = inSurfaceSet.has(p.id);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={inSurface}
                  onClick={() => onPick(p.id)}
                  className="flex w-full items-center gap-3 rounded-md border border-line bg-bg p-2 text-left transition-colors hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-40"
                  title={inSurface ? "Already in this surface" : undefined}
                >
                  {p.hero_image ? (
                    // eslint-disable-next-line @next/next/no-img-element -- thumbnail-only
                    <img
                      src={p.hero_image}
                      alt=""
                      className="h-10 w-10 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <div className="h-10 w-10 shrink-0 rounded bg-surface" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-body text-[13px] text-ink">
                      {p.title ?? (
                        <span className="text-muted">(no title)</span>
                      )}
                    </p>
                    <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-muted">
                      {p.category && <span>{p.category}</span>}
                      <span className="truncate">{p.id}</span>
                      {inSurface && (
                        <span className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-accent">
                          already in {surface}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
