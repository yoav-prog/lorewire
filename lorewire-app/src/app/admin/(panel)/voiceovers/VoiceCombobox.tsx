"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type VoiceOption = {
  voice_id: string;
  name: string;
  gender?: string;
  accent?: string;
};

type GenderFilter = "all" | "Female" | "Male";

// A searchable voice picker. Renders a hidden <input name=...> so the
// surrounding <form> submits the chosen voice exactly like a native <select>,
// while giving a type-to-filter panel (by name / gender / character hint),
// gender quick-filters, full keyboard nav, and click-outside-to-close.
export default function VoiceCombobox({
  name,
  voices,
  defaultValue,
}: {
  name: string;
  voices: VoiceOption[];
  defaultValue: string;
}) {
  const [selected, setSelected] = useState(
    defaultValue || voices[0]?.voice_id || "",
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [gender, setGender] = useState<GenderFilter>("all");
  const [active, setActive] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedVoice =
    voices.find((v) => v.voice_id === selected) ?? voices[0];

  const femaleCount = voices.filter((v) => v.gender === "Female").length;
  const maleCount = voices.filter((v) => v.gender === "Male").length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return voices.filter((v) => {
      if (gender !== "all" && v.gender !== gender) return false;
      if (!q) return true;
      return (
        v.name.toLowerCase().includes(q) ||
        (v.gender ?? "").toLowerCase().includes(q) ||
        (v.accent ?? "").toLowerCase().includes(q)
      );
    });
  }, [voices, query, gender]);

  // Clamp the active row on render rather than in an effect (no cascading
  // setState) so a narrowing filter never leaves it out of range.
  const activeIndex = filtered.length
    ? Math.min(active, filtered.length - 1)
    : 0;

  // Click outside closes. (setState inside the listener is fine — the lint rule
  // only bans setState run synchronously in the effect body.)
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the active row scrolled into view as it moves (no setState here).
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function openPanel() {
    setQuery("");
    setGender("all");
    setActive(0);
    setOpen(true);
  }

  function choose(v: VoiceOption) {
    setSelected(v.voice_id);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(activeIndex + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const v = filtered[activeIndex];
      if (v) choose(v);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <input type="hidden" name={name} value={selected} />

      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-left text-[14px] text-ink outline-none transition-colors hover:border-accent/60 focus:border-accent"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">
            {selectedVoice?.name ?? "Select a voice"}
          </span>
          {selectedVoice?.gender && <GenderBadge gender={selectedVoice.gender} />}
          {selectedVoice?.accent && (
            <span className="truncate text-[12px] text-muted">
              {selectedVoice.accent}
            </span>
          )}
        </span>
        <svg
          viewBox="0 0 20 20"
          fill="none"
          className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <path
            d="M5 7.5 10 12.5 15 7.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-line bg-surface shadow-xl">
          <div className="border-b border-line p-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={`Search ${voices.length} voices…`}
              aria-label="Search voices"
              className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent"
            />
            <div className="mt-2 flex gap-1.5">
              {([
                ["all", `All ${voices.length}`],
                ["Female", `Female ${femaleCount}`],
                ["Male", `Male ${maleCount}`],
              ] as const).map(([g, label]) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => {
                    setGender(g);
                    setActive(0);
                  }}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    gender === g
                      ? "bg-accent text-bg"
                      : "border border-line text-muted hover:border-accent/50 hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <ul ref={listRef} role="listbox" className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-6 text-center text-[13px] text-muted">
                No voices match “{query}”.
              </li>
            ) : (
              filtered.map((v, i) => {
                const isSelected = v.voice_id === selected;
                const isActive = i === activeIndex;
                return (
                  <li
                    key={v.voice_id}
                    data-idx={i}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(v)}
                    className={`flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-2 transition-colors ${
                      isActive ? "bg-surface2" : ""
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className={`truncate text-[14px] ${isSelected ? "font-semibold text-accent" : "text-ink"}`}
                      >
                        {v.name}
                      </span>
                      {v.accent && (
                        <span className="truncate text-[12px] text-muted">
                          {v.accent}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {v.gender && <GenderBadge gender={v.gender} />}
                      {isSelected && (
                        <svg
                          viewBox="0 0 20 20"
                          fill="none"
                          className="h-4 w-4 text-accent"
                          aria-hidden="true"
                        >
                          <path
                            d="M5 10.5 8.5 14 15 6.5"
                            stroke="currentColor"
                            strokeWidth="1.75"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </span>
                  </li>
                );
              })
            )}
          </ul>

          <div className="border-t border-line px-3 py-1.5 text-right font-mono text-[10px] uppercase tracking-wider text-muted">
            {filtered.length} of {voices.length}
          </div>
        </div>
      )}
    </div>
  );
}

function GenderBadge({ gender }: { gender: string }) {
  const female = gender === "Female";
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
        female
          ? "border-pink-400/25 bg-pink-400/10 text-pink-200"
          : "border-sky-400/25 bg-sky-400/10 text-sky-200"
      }`}
    >
      {female ? "F" : "M"}
    </span>
  );
}
