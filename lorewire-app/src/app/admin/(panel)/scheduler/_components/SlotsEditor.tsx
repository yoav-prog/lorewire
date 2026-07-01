"use client";

// Posting-slot editor: existing slots as removable chips plus an input to
// add one. Persists the whole list as a JSON array of "HH:MM" strings via
// the generic saveSettingAction, matching what getPlatformSlots parses.

import { useState, useTransition } from "react";
import { saveSettingAction } from "@/app/admin/actions";

// Client-side mirror of parseSlot (server-only, can't import here).
function normalizeSlot(raw: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function SlotsEditor({
  settingKey,
  initialSlots,
}: {
  settingKey: string;
  initialSlots: string[];
}) {
  const [slots, setSlots] = useState<string[]>(initialSlots);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function persist(next: string[]) {
    setSlots(next);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("key", settingKey);
      fd.set("value", JSON.stringify(next));
      await saveSettingAction(fd);
    });
  }

  function add() {
    const v = normalizeSlot(draft);
    if (!v) {
      setError("Use 24-hour HH:MM, e.g. 09:00");
      return;
    }
    if (slots.includes(v)) {
      setError("That time is already a slot");
      setDraft("");
      return;
    }
    setError(null);
    persist([...slots, v].sort((a, b) => a.localeCompare(b)));
    setDraft("");
  }

  function remove(slot: string) {
    persist(slots.filter((s) => s !== slot));
  }

  return (
    <div className={isPending ? "opacity-70" : ""}>
      <div className="flex flex-wrap gap-1.5">
        {slots.length === 0 && (
          <span className="text-[12px] text-muted">No slots yet — add one below.</span>
        )}
        {slots.map((s) => (
          <span
            key={s}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface2 px-2.5 py-0.5 font-mono text-[12px] tabular-nums text-ink"
          >
            {s}
            <button
              type="button"
              aria-label={`Remove ${s}`}
              onClick={() => remove(s)}
              className="text-muted transition-colors hover:text-accent"
            >
              &times;
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="09:00"
          inputMode="numeric"
          className="w-24 rounded-lg border border-line bg-bg px-3 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={add}
          className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink transition-colors hover:border-accent hover:text-accent"
        >
          Add slot
        </button>
      </div>
      {error && <p className="mt-1.5 text-[12px] text-accent">{error}</p>}
    </div>
  );
}
