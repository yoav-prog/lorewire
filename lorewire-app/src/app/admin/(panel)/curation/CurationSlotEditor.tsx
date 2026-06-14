"use client";

// One section on /admin/curation — pinned stories for one slot plus
// the always-visible "available stories" directory below.
//
// What this gives the admin:
//   - Pinned stories grouped at the top with up/down/remove + a ⏱
//     button that reveals UTC datetime pickers for publish_at /
//     expires_at scheduling.
//   - Drag handles on every pinned row (dnd-kit @ SortableContext) so
//     reordering is mouse-driven AND still keyboard-accessible via the
//     arrow buttons.
//   - A categorized, always-visible directory of unpicked stories
//     beneath each slot. Search just narrows what's shown — no need
//     to type before you can find anything. Each card has a one-click
//     "Pin" button.
//
// State stays local in `picks` until the admin clicks Save. The form
// submits picks_json so per-row schedules round-trip.

import { useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { setCurationSlotAction } from "@/app/admin/actions";
import type { CurationStoryOption } from "@/lib/curation";

interface PickRow {
  story_id: string;
  publish_at: string;
  expires_at: string;
}

interface Props {
  slotKind: string;
  label: string;
  hint?: string;
  initialPicks: PickRow[];
  stories: CurationStoryOption[];
  /** When true, only the first story is honoured at render time — the
   *  UI enforces a 1-row cap so the admin sees the same shape the
   *  public page will. */
  singleton?: boolean;
}

// Trim a server-side ISO down to the "YYYY-MM-DDTHH:mm" shape the
// `<input type="datetime-local">` widget accepts. Returns "" for null
// so the input renders empty.
//
// Accepts both ISO-T-separated ("2026-06-15T12:00:00Z") and the
// space-separated shape Postgres TIMESTAMP columns emit
// ("2026-06-15 12:00:00+00") — the dual-driver layer stores everything
// as TEXT today, but a future migration to TIMESTAMPTZ would silently
// break the schedule UI without the second pattern.
export function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]}T${m[2]}` : "";
}

export default function CurationSlotEditor({
  slotKind,
  label,
  hint,
  initialPicks,
  stories,
  singleton = false,
}: Props) {
  const [picks, setPicks] = useState<PickRow[]>(initialPicks);
  const [q, setQ] = useState("");
  const [dirty, setDirty] = useState(false);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const storiesById = useMemo(() => {
    const m = new Map<string, CurationStoryOption>();
    for (const s of stories) m.set(s.id, s);
    return m;
  }, [stories]);

  const pickedIds = useMemo(
    () => new Set(picks.map((p) => p.story_id)),
    [picks],
  );

  // Available = stories not yet pinned. Search filters this list, but
  // when the search box is empty the full directory still renders so
  // the admin can scroll and click without typing.
  const available = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return stories.filter((s) => {
      if (pickedIds.has(s.id)) return false;
      if (!needle) return true;
      const hay = `${s.title ?? ""} ${s.id} ${s.category ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [q, stories, pickedIds]);

  // Group the directory by category so the admin sees the catalog
  // organised. Inside each group, newest-first (matches the home rail's
  // implicit ordering when auto-fill kicks in).
  const directoryGroups = useMemo(() => {
    const groups = new Map<string, CurationStoryOption[]>();
    for (const s of available) {
      const key = s.category ?? "Uncategorized";
      const list = groups.get(key) ?? [];
      list.push(s);
      groups.set(key, list);
    }
    // Newest-first within each group based on published_at.
    for (const list of groups.values()) {
      list.sort((a, b) => {
        const ax = a.published_at ?? "";
        const bx = b.published_at ?? "";
        return bx.localeCompare(ax);
      });
    }
    // Stable group order: known categories alphabetically, Uncategorized
    // at the end so the well-tagged content surfaces first.
    return Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === "Uncategorized") return 1;
      if (b === "Uncategorized") return -1;
      return a.localeCompare(b);
    });
  }, [available]);

  function add(id: string) {
    if (pickedIds.has(id)) return;
    const row: PickRow = { story_id: id, publish_at: "", expires_at: "" };
    const next = singleton ? [row] : [...picks, row];
    setPicks(next);
    setDirty(true);
  }

  function remove(id: string) {
    setPicks(picks.filter((p) => p.story_id !== id));
    setDirty(true);
    if (expandedRow === id) setExpandedRow(null);
  }

  function move(id: string, delta: -1 | 1) {
    const i = picks.findIndex((p) => p.story_id === id);
    if (i < 0) return;
    const j = i + delta;
    if (j < 0 || j >= picks.length) return;
    setPicks(arrayMove(picks, i, j));
    setDirty(true);
  }

  function setSchedule(
    id: string,
    field: "publish_at" | "expires_at",
    value: string,
  ) {
    setPicks(
      picks.map((p) =>
        p.story_id === id ? { ...p, [field]: value } : p,
      ),
    );
    setDirty(true);
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = picks.findIndex((p) => p.story_id === active.id);
    const newIndex = picks.findIndex((p) => p.story_id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    setPicks(arrayMove(picks, oldIndex, newIndex));
    setDirty(true);
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
      {/* Header */}
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line/60 px-5 py-4">
        <div>
          <h2 className="font-display text-[17px] font-extrabold tracking-tight">
            {label}
          </h2>
          {hint && (
            <p className="mt-1 font-mono text-[10px] text-muted">{hint}</p>
          )}
        </div>
        <span className="rounded-full border border-line bg-bg px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
          {picks.length} pinned
          {singleton && picks.length > 1 && (
            <span className="ml-2 text-danger">(extras ignored)</span>
          )}
        </span>
      </header>

      {/* Pinned list */}
      <div className="border-b border-line/60 px-5 py-4">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          Pinned · admin order
        </div>
        {picks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line/60 bg-bg/40 px-4 py-6 text-center font-mono text-[11px] text-muted">
            No stories pinned. {singleton
              ? "Pick one from the directory below."
              : "Drag from the directory below or click Pin."}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={picks.map((p) => p.story_id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="space-y-1.5">
                {picks.map((row, idx) => (
                  <SortablePickRow
                    key={row.story_id}
                    row={row}
                    idx={idx}
                    total={picks.length}
                    story={storiesById.get(row.story_id) ?? null}
                    expanded={expandedRow === row.story_id}
                    singleton={singleton}
                    slotKind={slotKind}
                    onToggleExpand={() =>
                      setExpandedRow(
                        expandedRow === row.story_id ? null : row.story_id,
                      )
                    }
                    onMoveUp={() => move(row.story_id, -1)}
                    onMoveDown={() => move(row.story_id, 1)}
                    onRemove={() => remove(row.story_id)}
                    onSchedule={(field, value) =>
                      setSchedule(row.story_id, field, value)
                    }
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Directory */}
      <div className="bg-bg/40 px-5 py-4">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            Available stories · {available.length}
            {stories.length > 0 &&
              available.length !== stories.length && (
                <span className="ml-1 normal-case text-muted/70">
                  ({stories.length - available.length} already pinned)
                </span>
              )}
          </div>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              stories.length === 0
                ? "No published stories available"
                : "Search by title, category, id…"
            }
            disabled={stories.length === 0}
            className="w-full max-w-[280px] rounded-lg border border-line bg-bg px-3 py-1.5 text-[13px] text-ink outline-none transition-colors focus:border-accent disabled:opacity-50"
          />
        </div>

        {stories.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line/60 bg-bg/30 px-4 py-6 text-center font-mono text-[11px] text-muted">
            No published stories yet. Publish a story to start curating this slot.
          </p>
        ) : available.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line/60 bg-bg/30 px-4 py-6 text-center font-mono text-[11px] text-muted">
            {q.trim()
              ? `No matches for "${q.trim()}".`
              : "Every published story for this slot is already pinned."}
          </p>
        ) : (
          <div className="space-y-4">
            {directoryGroups.map(([category, items]) => (
              <div key={category}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                    {category}
                  </span>
                  <span className="font-mono text-[10px] text-muted/60">
                    {items.length}
                  </span>
                  <span className="h-px flex-1 bg-line/40" aria-hidden="true" />
                </div>
                <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {items.map((s) => (
                    <DirectoryCard
                      key={s.id}
                      story={s}
                      onAdd={() => add(s.id)}
                      singleton={singleton}
                      hasPick={picks.length > 0}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Save */}
      <form
        action={setCurationSlotAction}
        className="flex items-center justify-end gap-3 border-t border-line/60 bg-surface/80 px-5 py-3"
      >
        <input type="hidden" name="slot_kind" value={slotKind} />
        {/* Phase 6 payload: per-row publish_at / expires_at travel with
            the story id. The action also still accepts `story_ids` for
            backwards-compat callers, but the editor always ships the
            richer shape so the schedule round-trips. */}
        <input
          type="hidden"
          name="picks_json"
          value={JSON.stringify(
            picks.map((p) => ({
              story_id: p.story_id,
              publish_at: p.publish_at || null,
              expires_at: p.expires_at || null,
            })),
          )}
        />
        <span
          className={`font-mono text-[10px] uppercase tracking-wider ${
            dirty ? "text-accent" : "text-muted"
          }`}
        >
          {dirty ? "● Unsaved" : "✓ Saved"}
        </span>
        <button
          type="submit"
          disabled={!dirty}
          className="rounded-md bg-accent px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save slot
        </button>
      </form>
    </section>
  );
}

function SortablePickRow({
  row,
  idx,
  total,
  story,
  expanded,
  singleton,
  slotKind,
  onToggleExpand,
  onMoveUp,
  onMoveDown,
  onRemove,
  onSchedule,
}: {
  row: PickRow;
  idx: number;
  total: number;
  story: CurationStoryOption | null;
  expanded: boolean;
  singleton: boolean;
  slotKind: string;
  onToggleExpand: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onSchedule: (field: "publish_at" | "expires_at", value: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.story_id });
  const scheduled = row.publish_at !== "" || row.expires_at !== "";
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={`overflow-hidden rounded-lg border bg-bg shadow-sm transition-colors ${
        isDragging
          ? "border-accent/60 ring-1 ring-accent/30"
          : "border-line/70 hover:border-line"
      }`}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        {/* Drag handle */}
        <button
          type="button"
          aria-label="Drag to reorder"
          className={`flex h-8 w-6 cursor-grab items-center justify-center rounded text-muted hover:text-ink active:cursor-grabbing ${
            singleton ? "opacity-30 cursor-not-allowed" : ""
          }`}
          disabled={singleton}
          {...attributes}
          {...(singleton ? {} : listeners)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="9" cy="6" r="1.5" />
            <circle cx="15" cy="6" r="1.5" />
            <circle cx="9" cy="12" r="1.5" />
            <circle cx="15" cy="12" r="1.5" />
            <circle cx="9" cy="18" r="1.5" />
            <circle cx="15" cy="18" r="1.5" />
          </svg>
        </button>

        <span className="w-5 text-right font-mono text-[10px] text-muted">
          {idx + 1}
        </span>

        {story?.hero_image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={story.hero_image}
            alt=""
            className="h-12 w-12 rounded-md border border-line object-cover"
          />
        ) : (
          <div className="grid h-12 w-12 place-items-center rounded-md border border-line bg-surface font-mono text-[10px] text-muted">
            —
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-ink">
            {story?.title ?? (
              <em className="text-muted">Unknown story · {row.story_id}</em>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-muted">
            {story?.category && (
              <span className="rounded bg-surface px-1.5 py-0.5">
                {story.category}
              </span>
            )}
            <code className="text-muted/70">{row.story_id}</code>
            {scheduled && (
              <span
                className="rounded-full border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-accent"
                title={`publish ${row.publish_at || "now"} · expires ${
                  row.expires_at || "never"
                }`}
              >
                ⏱ scheduled
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onToggleExpand}
            aria-expanded={expanded}
            aria-controls={`schedule-${slotKind}-${row.story_id}`}
            title={expanded ? "Hide schedule" : "Schedule this row"}
            className={`rounded-md border px-2 py-1 font-mono text-[10px] transition-colors ${
              scheduled || expanded
                ? "border-accent/50 bg-accent/10 text-accent hover:bg-accent/20"
                : "border-line text-muted hover:border-accent hover:text-accent"
            }`}
          >
            ⏱
          </button>
          <button
            type="button"
            onClick={onMoveUp}
            disabled={idx === 0 || singleton}
            title="Move up (or use the drag handle)"
            className="rounded-md border border-line px-2 py-1 font-mono text-[10px] text-muted hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={idx === total - 1 || singleton}
            title="Move down"
            className="rounded-md border border-line px-2 py-1 font-mono text-[10px] text-muted hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={onRemove}
            title="Remove from slot"
            className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1 font-mono text-[10px] text-danger hover:bg-danger/20"
          >
            ×
          </button>
        </div>
      </div>
      {expanded && (
        <div
          id={`schedule-${slotKind}-${row.story_id}`}
          className="grid grid-cols-1 gap-2 border-t border-line/60 bg-surface/60 px-3 py-3 sm:grid-cols-2"
        >
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted">
              Publish at (UTC)
            </span>
            <input
              type="datetime-local"
              value={row.publish_at}
              onChange={(e) => onSchedule("publish_at", e.target.value)}
              className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted">
              Expires at (UTC)
            </span>
            <input
              type="datetime-local"
              value={row.expires_at}
              onChange={(e) => onSchedule("expires_at", e.target.value)}
              className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
            />
          </label>
          <p className="font-mono text-[10px] text-muted sm:col-span-2">
            Both clocks are UTC. Blank publish = live now. Blank expires =
            never expires. Expired rows hide from the public site immediately
            and get cleaned up after a week.
          </p>
        </div>
      )}
    </li>
  );
}

function DirectoryCard({
  story,
  onAdd,
  singleton,
  hasPick,
}: {
  story: CurationStoryOption;
  onAdd: () => void;
  singleton: boolean;
  hasPick: boolean;
}) {
  // Singleton slots already have a pick? The new card warns that
  // clicking Pin will replace it — same shape as the schedule loss note
  // in the parent component, just surfaced earlier so the admin isn't
  // surprised.
  const willReplace = singleton && hasPick;
  return (
    <li className="group flex items-center gap-3 rounded-lg border border-line/70 bg-bg p-2.5 transition-colors hover:border-accent/50 hover:bg-surface">
      {story.hero_image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={story.hero_image}
          alt=""
          className="h-12 w-12 shrink-0 rounded-md border border-line object-cover"
        />
      ) : (
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-md border border-line bg-surface font-mono text-[10px] text-muted">
          —
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-ink">
          {story.title ?? <em className="text-muted">{story.id}</em>}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-muted">
          {story.category && (
            <span className="rounded bg-surface px-1.5 py-0.5">
              {story.category}
            </span>
          )}
          {story.published_at && (
            <span className="text-muted/70">
              {story.published_at.slice(0, 10)}
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onAdd}
        title={willReplace ? "Replace the currently pinned story" : "Pin to slot"}
        className={`shrink-0 rounded-md border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
          willReplace
            ? "border-danger/40 bg-danger/10 text-danger hover:bg-danger/20"
            : "border-accent bg-accent/10 text-accent hover:bg-accent/20"
        }`}
      >
        {willReplace ? "Replace" : "Pin"}
      </button>
    </li>
  );
}
