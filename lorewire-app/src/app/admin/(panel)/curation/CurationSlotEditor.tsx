"use client";

// One section on /admin/curation — pinned stories for one slot.
//
// Local state: picked rows (story_id + optional publish_at / expires_at).
// Editing is in-memory until the admin clicks Save, which posts a JSON
// payload to setCurationSlotAction. Atomic replace on the server.
//
// Phase 6 adds optional per-row scheduling. Each row has a collapsed
// "Schedule" button; click it to expose two datetime-local inputs.
// Leaving them blank keeps the row "active immediately, never expires"
// — same shape as Phase 2's unscheduled writes, so the admin doesn't
// pay UI cost when they don't care about timing.
//
// Keyboard-friendly by design: every action is a real button. No drag
// dependency, no global keyboard listener. Up/down move buttons preserve
// order; the X button removes; the search input filters the pickable
// directory by title substring (case-insensitive).

import { useMemo, useState } from "react";
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
export function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  // ISO from the DB is UTC. We strip seconds/zone so the widget shows
  // the bare timestamp — the action re-attaches Z on parse. This means
  // the admin's clock and the DB clock both speak UTC; explained in the
  // hint copy below.
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : "";
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

  const storiesById = useMemo(() => {
    const m = new Map<string, CurationStoryOption>();
    for (const s of stories) m.set(s.id, s);
    return m;
  }, [stories]);

  const pickedIds = useMemo(
    () => new Set(picks.map((p) => p.story_id)),
    [picks],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return stories.filter((s) => {
      if (pickedIds.has(s.id)) return false; // already pinned
      if (!needle) return true;
      return (s.title ?? "").toLowerCase().includes(needle);
    });
  }, [q, stories, pickedIds]);

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
  }

  function move(id: string, delta: -1 | 1) {
    const i = picks.findIndex((p) => p.story_id === id);
    if (i < 0) return;
    const j = i + delta;
    if (j < 0 || j >= picks.length) return;
    const next = [...picks];
    [next[i], next[j]] = [next[j], next[i]];
    setPicks(next);
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

  return (
    <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="font-display text-[15px] font-bold tracking-tight">
            {label}
          </h2>
          {hint && (
            <p className="mt-0.5 font-mono text-[10px] text-muted">{hint}</p>
          )}
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          {picks.length} pinned
          {singleton && picks.length > 1 && (
            <span className="ml-2 text-danger">
              (singleton — extras ignored)
            </span>
          )}
        </span>
      </header>

      <ul className="space-y-1.5">
        {picks.length === 0 && (
          <li className="rounded-md border border-dashed border-line px-3 py-3 text-center font-mono text-[11px] text-muted">
            No stories pinned. {singleton
              ? "Pick one below."
              : "Pick from the directory below to add."}
          </li>
        )}
        {picks.map((row, idx) => {
          const { story_id: id } = row;
          const s = storiesById.get(id);
          const scheduled = row.publish_at !== "" || row.expires_at !== "";
          const expanded = expandedRow === id;
          return (
            <li
              key={id}
              className="rounded-md border border-line bg-bg"
            >
              <div className="flex items-center gap-3 px-3 py-2">
                <span className="font-mono text-[10px] text-muted w-6 text-right">
                  {idx + 1}.
                </span>
                {s?.hero_image ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={s.hero_image}
                    alt=""
                    className="h-10 w-10 rounded object-cover border border-line"
                  />
                ) : (
                  <div className="h-10 w-10 rounded border border-line bg-surface" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="truncate text-[13px] text-ink">
                    {s?.title ?? <em className="text-muted">{id}</em>}
                  </div>
                  <div className="font-mono text-[10px] text-muted">
                    {s?.category ?? "—"} ·{" "}
                    <code className="text-muted">{id}</code>
                    {scheduled && (
                      <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-accent">
                        scheduled
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setExpandedRow(expanded ? null : id)}
                    aria-expanded={expanded}
                    aria-controls={`schedule-${slotKind}-${id}`}
                    title={expanded ? "Hide schedule" : "Schedule this row"}
                    className={`rounded-md border px-2 py-1 font-mono text-[10px] ${
                      scheduled
                        ? "border-accent/50 text-accent hover:bg-accent/10"
                        : "border-line text-muted hover:text-ink"
                    }`}
                  >
                    ⏱
                  </button>
                  <button
                    type="button"
                    onClick={() => move(id, -1)}
                    disabled={idx === 0 || singleton}
                    title="Move up"
                    className="rounded-md border border-line px-2 py-1 font-mono text-[10px] text-muted hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(id, 1)}
                    disabled={idx === picks.length - 1 || singleton}
                    title="Move down"
                    className="rounded-md border border-line px-2 py-1 font-mono text-[10px] text-muted hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(id)}
                    title="Remove from slot"
                    className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1 font-mono text-[10px] text-danger hover:opacity-80"
                  >
                    ×
                  </button>
                </div>
              </div>
              {expanded && (
                <div
                  id={`schedule-${slotKind}-${id}`}
                  className="grid grid-cols-1 gap-2 border-t border-line bg-surface/60 px-3 py-2 sm:grid-cols-2"
                >
                  <label className="block">
                    <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted">
                      Publish at (UTC)
                    </span>
                    <input
                      type="datetime-local"
                      value={row.publish_at}
                      onChange={(e) =>
                        setSchedule(id, "publish_at", e.target.value)
                      }
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
                      onChange={(e) =>
                        setSchedule(id, "expires_at", e.target.value)
                      }
                      className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
                    />
                  </label>
                  <p className="font-mono text-[10px] text-muted sm:col-span-2">
                    Both clocks are UTC. Blank publish = live now. Blank
                    expires = never expires. Expired rows hide from the
                    public site immediately and get cleaned up after a week.
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="space-y-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={
            stories.length === 0
              ? "No published stories available"
              : "Search published stories by title…"
          }
          disabled={stories.length === 0}
          className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
        />
        {q.trim() && (
          <ul className="max-h-[200px] overflow-y-auto rounded-md border border-line bg-bg">
            {filtered.length === 0 && (
              <li className="px-3 py-2 font-mono text-[11px] text-muted">
                No matches.
              </li>
            )}
            {filtered.slice(0, 50).map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-3 border-b border-line last:border-0 px-3 py-1.5"
              >
                {s.hero_image ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={s.hero_image}
                    alt=""
                    className="h-8 w-8 rounded object-cover border border-line"
                  />
                ) : (
                  <div className="h-8 w-8 rounded border border-line bg-surface" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="truncate text-[12px] text-ink">
                    {s.title ?? s.id}
                  </div>
                  <div className="font-mono text-[10px] text-muted">
                    {s.category ?? "—"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    add(s.id);
                    setQ("");
                  }}
                  className="rounded-md border border-accent bg-accent/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-accent hover:bg-accent/20"
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form action={setCurationSlotAction} className="flex items-center justify-end gap-2">
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
        <span className="font-mono text-[10px] text-muted">
          {dirty ? "Unsaved changes" : "Saved"}
        </span>
        <button
          type="submit"
          disabled={!dirty}
          className="rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save slot
        </button>
      </form>
    </section>
  );
}
