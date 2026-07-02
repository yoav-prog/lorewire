"use client";

// Weekly posting-times editor. The "Every day" times are removable chips
// plus an input to add one; each weekday can then be customized (its own
// times, or explicitly no posts). Persists the whole schedule as the v2
// object shape via the generic saveSettingAction, matching what
// parseSlotsSetting parses; the server keeps reading the old flat-array
// shape from before this editor existed, so nothing needs migrating.

import { useState, useTransition } from "react";
import { saveSettingAction } from "@/app/admin/actions";

// Client-side mirrors of the server-only slot types/validation
// (publish-scheduler.ts is "server-only" and must not be imported here).
type WeekdayKey = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export interface WeeklySlotsValue {
  default: string[];
  overrides: Partial<Record<WeekdayKey, string[]>>;
}

const DAYS: { key: WeekdayKey; label: string }[] = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
];

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
  initialSlots: WeeklySlotsValue;
}) {
  const [weekly, setWeekly] = useState<WeeklySlotsValue>(initialSlots);
  const [isPending, startTransition] = useTransition();

  function persist(next: WeeklySlotsValue) {
    setWeekly(next);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("key", settingKey);
      fd.set("value", JSON.stringify(next));
      await saveSettingAction(fd);
    });
  }

  function setDefault(slots: string[]) {
    persist({ ...weekly, default: slots });
  }

  function setOverride(day: WeekdayKey, slots: string[]) {
    persist({ ...weekly, overrides: { ...weekly.overrides, [day]: slots } });
  }

  function clearOverride(day: WeekdayKey) {
    const overrides = { ...weekly.overrides };
    delete overrides[day];
    persist({ ...weekly, overrides });
  }

  return (
    <div className={isPending ? "opacity-70" : ""}>
      <SlotChips value={weekly.default} onChange={setDefault} />
      <details className="mt-3">
        <summary className="cursor-pointer text-[12px] font-semibold text-muted transition-colors hover:text-ink">
          Customize by day of week
        </summary>
        <ul className="mt-2 space-y-2">
          {DAYS.map(({ key, label }) => {
            const override = weekly.overrides[key];
            const custom = override !== undefined;
            const resolved = override ?? weekly.default;
            return (
              <li
                key={key}
                className="rounded-lg border border-line bg-surface2/50 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] text-ink">{label}</span>
                  <span className="flex items-center gap-3">
                    {!custom && (
                      <span className="font-mono text-[11px] tabular-nums text-muted">
                        {resolved.length > 0 ? resolved.join(" · ") : "no posts"}
                      </span>
                    )}
                    {custom && resolved.length === 0 && (
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                        no posts
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        custom
                          ? clearOverride(key)
                          : setOverride(key, [...weekly.default])
                      }
                      className="text-[12px] text-muted transition-colors hover:text-accent"
                    >
                      {custom ? "Use every-day times" : "Customize"}
                    </button>
                  </span>
                </div>
                {custom && (
                  <div className="mt-2">
                    <SlotChips
                      value={override}
                      onChange={(slots) => setOverride(key, slots)}
                      emptyHint="No times — nothing posts this day. Add one below to change that."
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}

// One chip list + add input, used for the every-day times and for each
// customized weekday.
function SlotChips({
  value,
  onChange,
  emptyHint = "No slots yet — add one below.",
}: {
  value: string[];
  onChange: (slots: string[]) => void;
  emptyHint?: string;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function add() {
    const v = normalizeSlot(draft);
    if (!v) {
      setError("Use 24-hour HH:MM, e.g. 09:00");
      return;
    }
    if (value.includes(v)) {
      setError("That time is already a slot");
      setDraft("");
      return;
    }
    setError(null);
    onChange([...value, v].sort((a, b) => a.localeCompare(b)));
    setDraft("");
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {value.length === 0 && (
          <span className="text-[12px] text-muted">{emptyHint}</span>
        )}
        {value.map((s) => (
          <span
            key={s}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface2 px-2.5 py-0.5 font-mono text-[12px] tabular-nums text-ink"
          >
            {s}
            <button
              type="button"
              aria-label={`Remove ${s}`}
              onClick={() => onChange(value.filter((x) => x !== s))}
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
