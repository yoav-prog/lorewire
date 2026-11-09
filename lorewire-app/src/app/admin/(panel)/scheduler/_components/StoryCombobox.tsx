"use client";

// Searchable story picker. A raw <select> over hundreds of stories is
// unfindable; this is a type-ahead: type a few words of the title,
// arrow/click to pick. Pure client filtering over the list the server
// already provides.

import { useMemo, useRef, useState } from "react";

export interface StoryOption {
  id: string;
  title: string;
}

/** Case-insensitive every-word match: "dollar spons" finds
 *  "DOLLAR TREE SPONSORSHIP". Exported for tests. */
export function filterStories(
  stories: StoryOption[],
  query: string,
  limit = 12,
): StoryOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return stories.slice(0, limit);
  const out: StoryOption[] = [];
  for (const s of stories) {
    const title = s.title.toLowerCase();
    if (words.every((w) => title.includes(w))) {
      out.push(s);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function StoryCombobox({
  stories,
  value,
  onChange,
  placeholder = "Type to find a story…",
}: {
  stories: StoryOption[];
  value: StoryOption | null;
  onChange: (story: StoryOption | null) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => filterStories(stories, query), [stories, query]);

  function pick(story: StoryOption) {
    onChange(story);
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (matches[highlight]) pick(matches[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="relative w-full max-w-[320px]">
      <input
        ref={inputRef}
        value={open ? query : (value?.title ?? "")}
        placeholder={value && !open ? value.title : placeholder}
        onFocus={() => {
          setOpen(true);
          setQuery("");
          setHighlight(0);
        }}
        onBlur={() => {
          // Delay so a click on an option lands before the list closes.
          setTimeout(() => setOpen(false), 150);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
        className="w-full rounded-lg border border-line bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
      />
      {open && (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-line bg-surface shadow-lg">
          {matches.length === 0 && (
            <li className="px-3 py-2 text-[12px] text-muted">
              No story matches &quot;{query}&quot;.
            </li>
          )}
          {matches.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault(); // beat the input's onBlur
                  pick(s);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={`block w-full truncate px-3 py-2 text-left text-[13px] ${
                  i === highlight ? "bg-accent/10 text-ink" : "text-ink"
                }`}
              >
                {s.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
