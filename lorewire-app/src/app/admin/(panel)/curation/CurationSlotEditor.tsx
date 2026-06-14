"use client";

// One section on /admin/curation — pinned stories for one slot.
//
// Local state: picked story_ids array. Editing is in-memory until the
// admin clicks Save, which posts a comma-joined hidden input to
// setCurationSlotAction. Atomic replace on the server.
//
// Keyboard-friendly by design: every action is a real button. No drag
// dependency, no global keyboard listener. Up/down move buttons preserve
// order; the X button removes; the search input filters the pickable
// directory by title substring (case-insensitive).

import { useMemo, useState } from "react";
import { setCurationSlotAction } from "@/app/admin/actions";
import type { CurationStoryOption } from "@/lib/curation";

interface Props {
  slotKind: string;
  label: string;
  hint?: string;
  initialPicks: string[];
  stories: CurationStoryOption[];
  /** When true, only the first story is honoured at render time — the
   *  UI enforces a 1-row cap so the admin sees the same shape the
   *  public page will. */
  singleton?: boolean;
}

export default function CurationSlotEditor({
  slotKind,
  label,
  hint,
  initialPicks,
  stories,
  singleton = false,
}: Props) {
  const [picks, setPicks] = useState<string[]>(initialPicks);
  const [q, setQ] = useState("");
  const [dirty, setDirty] = useState(false);

  const storiesById = useMemo(() => {
    const m = new Map<string, CurationStoryOption>();
    for (const s of stories) m.set(s.id, s);
    return m;
  }, [stories]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return stories.filter((s) => {
      if (picks.includes(s.id)) return false; // already pinned
      if (!needle) return true;
      return (s.title ?? "").toLowerCase().includes(needle);
    });
  }, [q, stories, picks]);

  function add(id: string) {
    if (picks.includes(id)) return;
    const next = singleton ? [id] : [...picks, id];
    setPicks(next);
    setDirty(true);
  }

  function remove(id: string) {
    setPicks(picks.filter((p) => p !== id));
    setDirty(true);
  }

  function move(id: string, delta: -1 | 1) {
    const i = picks.indexOf(id);
    if (i < 0) return;
    const j = i + delta;
    if (j < 0 || j >= picks.length) return;
    const next = [...picks];
    [next[i], next[j]] = [next[j], next[i]];
    setPicks(next);
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
        {picks.map((id, idx) => {
          const s = storiesById.get(id);
          return (
            <li
              key={id}
              className="flex items-center gap-3 rounded-md border border-line bg-bg px-3 py-2"
            >
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
                </div>
              </div>
              <div className="flex items-center gap-1">
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
        <input type="hidden" name="story_ids" value={picks.join(",")} />
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
