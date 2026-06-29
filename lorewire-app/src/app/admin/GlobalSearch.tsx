"use client";

// Admin top-bar search. Single visible surface for "find anything"
// (plan: _plans/2026-06-19-global-admin-search.md).
//
// UX (rule 10 / rule 16):
//   - Visible in the header on every admin page.
//   - `/` or Cmd-K / Ctrl-K from anywhere → focus the bar (unless user
//     is already typing into an input). Esc clears, then blurs.
//   - Arrow keys move the highlight through results; Enter navigates.
//   - Recent picks shown when the input is empty.
//   - Loading shimmer only after 150 ms so a fast LAN doesn't flash.
//   - Empty / error states are explicit and recoverable.
//
// State machine (kept simple on purpose):
//   - q              user-controlled input value
//   - debouncedQ     q after the 200 ms debounce — the fetch trigger
//   - status         "idle" | "loading" | "ok" | "error" — drives render
//   - results        last successful payload (kept while a new fetch runs)
//   - highlight      0..results-1, points into the flattened result list
//   - recent         localStorage-backed picks, shown when q is empty
//
// Observability (rule 14): one [admin search ui] log per meaningful
// action (focus, navigate, pick) so a future "the bar didn't open"
// report has a paper trail.

import {
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { addRecent, readRecent, removeRecent, RecentPick } from "@/lib/admin-search-recent";

const DEBOUNCE_MS = 200;
const LOADING_THRESHOLD_MS = 150;
const MAX_RECENTS = 6;

interface RedditHit {
  reddit_id: string;
  subreddit: string;
  title: string;
  snippet: string;
  href: string;
  score: number;
}

interface StoryHit {
  id: string;
  category: string;
  title: string;
  snippet: string;
  href: string;
  score: number;
}

interface SearchResponse {
  q: string;
  took_ms: number;
  reddit: RedditHit[];
  stories: StoryHit[];
}

type Status = "idle" | "loading" | "ok" | "error";

/** Flattened result entry the highlight cursor moves through. Each entry
 * carries everything needed to render + navigate + persist to recents on
 * Enter without re-mapping back to the source dict. */
interface FlatEntry {
  kind: "reddit" | "story";
  id: string;
  href: string;
  label: string;
  subLabel: string;
  snippet: string;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

/** Render markdown-bold (**foo**) spans as <mark>. Whole-text fallback
 * for empty / no-match cases. Pure parsing; no DOMPurify needed because
 * we only ever interpret `**…**` and never inject raw HTML. */
function renderSnippet(snippet: string): React.ReactNode {
  if (!snippet) return null;
  const parts = snippet.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return (
        <mark key={i} className="bg-accent/20 px-0.5 text-ink rounded-sm">
          {p.slice(2, -2)}
        </mark>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

export default function GlobalSearch() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [recent, setRecent] = useState<RecentPick[]>([]);
  const [showLoadingShimmer, setShowLoadingShimmer] = useState(false);
  const fetchSeq = useRef(0);

  // Mount: read recents from localStorage. SSR returns []; this hydrates
  // after the client lands.
  useEffect(() => {
    setRecent(readRecent(MAX_RECENTS));
  }, []);

  // Debounce: track q → debouncedQ.
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQ(q), DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [q]);

  // Global keybinds: `/`, Cmd-K, Ctrl-K → focus. Skip when user is
  // typing. Mounted once on the document.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isSlash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey;
      const isCmdK =
        (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.altKey;
      if (!isSlash && !isCmdK) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      console.info("[admin search ui]", { event: "focus_keybind", via: isSlash ? "slash" : "cmd_k" });
      inputRef.current?.focus();
      inputRef.current?.select();
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Outside-click closes the dropdown.
  useEffect(() => {
    function onPointer(e: MouseEvent) {
      if (!open) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (
        inputRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  // Fetch on debouncedQ change. Tracks a fetch sequence number so a
  // late-arriving response from a stale q doesn't overwrite a fresh one.
  useEffect(() => {
    if (!debouncedQ.trim()) {
      setStatus("idle");
      setResults(null);
      setShowLoadingShimmer(false);
      return;
    }
    const seq = ++fetchSeq.current;
    setStatus("loading");
    // Shimmer only after 150 ms.
    const shimmerHandle = window.setTimeout(() => {
      if (fetchSeq.current === seq) setShowLoadingShimmer(true);
    }, LOADING_THRESHOLD_MS);

    fetch(`/api/admin/search?q=${encodeURIComponent(debouncedQ)}`, {
      credentials: "same-origin",
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<SearchResponse>;
      })
      .then((payload) => {
        if (fetchSeq.current !== seq) return;
        setResults(payload);
        setStatus("ok");
        setHighlight(0);
      })
      .catch((err) => {
        if (fetchSeq.current !== seq) return;
        console.warn("[admin search ui] fetch failed", { err: String(err).slice(0, 200) });
        setStatus("error");
      })
      .finally(() => {
        if (fetchSeq.current === seq) setShowLoadingShimmer(false);
        window.clearTimeout(shimmerHandle);
      });
    return () => window.clearTimeout(shimmerHandle);
  }, [debouncedQ]);

  // Flattened entry list — drives keyboard nav. Reddit first to match
  // the dropdown sections; empty query falls back to recents.
  const flat = useMemo<FlatEntry[]>(() => {
    if (!q.trim()) {
      return recent.map((r) => ({
        kind: r.kind,
        id: r.id,
        href:
          r.kind === "reddit"
            ? `/admin/reddit-sources/${encodeURIComponent(r.id)}`
            : `/admin/stories/${encodeURIComponent(r.id)}`,
        label: r.label,
        subLabel: r.kind === "reddit" ? "Reddit source" : "Story",
        snippet: "",
      }));
    }
    if (!results) return [];
    const reddit = results.reddit.map<FlatEntry>((r) => ({
      kind: "reddit",
      id: r.reddit_id,
      href: r.href,
      label: r.title,
      subLabel: `r/${r.subreddit}`,
      snippet: r.snippet,
    }));
    const stories = results.stories.map<FlatEntry>((s) => ({
      kind: "story",
      id: s.id,
      href: s.href,
      label: s.title,
      subLabel: s.category,
      snippet: s.snippet,
    }));
    return [...reddit, ...stories];
  }, [q, results, recent]);

  const navigateToEntry = useCallback(
    (entry: FlatEntry) => {
      console.info("[admin search ui]", { event: "pick", kind: entry.kind, id: entry.id });
      addRecent({ kind: entry.kind, id: entry.id, label: entry.label }, MAX_RECENTS);
      setRecent(readRecent(MAX_RECENTS));
      setOpen(false);
      setQ("");
      router.push(entry.href);
    },
    [router],
  );

  const handleInputKey = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        if (q.length > 0) {
          setQ("");
        } else {
          inputRef.current?.blur();
          setOpen(false);
        }
        e.preventDefault();
        return;
      }
      if (e.key === "ArrowDown") {
        if (flat.length === 0) return;
        setHighlight((h) => (h + 1) % flat.length);
        e.preventDefault();
        return;
      }
      if (e.key === "ArrowUp") {
        if (flat.length === 0) return;
        setHighlight((h) => (h - 1 + flat.length) % flat.length);
        e.preventDefault();
        return;
      }
      if (e.key === "Enter") {
        const entry = flat[highlight];
        if (entry) navigateToEntry(entry);
        e.preventDefault();
        return;
      }
    },
    [q, flat, highlight, navigateToEntry],
  );

  const retry = useCallback(() => {
    // Bump the seq to discard any in-flight; re-fetching is just a
    // matter of forcing the debouncedQ effect to re-run.
    fetchSeq.current++;
    setStatus("loading");
    setDebouncedQ((d) => d + ""); // identity — won't re-fire useEffect.
    // Actually re-run the fetch directly:
    const seq = ++fetchSeq.current;
    fetch(`/api/admin/search?q=${encodeURIComponent(debouncedQ)}`, {
      credentials: "same-origin",
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<SearchResponse>;
      })
      .then((payload) => {
        if (fetchSeq.current !== seq) return;
        setResults(payload);
        setStatus("ok");
        setHighlight(0);
      })
      .catch((err) => {
        if (fetchSeq.current !== seq) return;
        console.warn("[admin search ui] retry failed", { err: String(err).slice(0, 200) });
        setStatus("error");
      });
  }, [debouncedQ]);

  const dropdownVisible =
    open && (q.trim().length > 0 || recent.length > 0);

  const hasResults = results !== null && (results.reddit.length > 0 || results.stories.length > 0);
  const showEmpty = status === "ok" && !hasResults && q.trim().length > 0;

  return (
    <div className="relative w-full max-w-md">
      <div className="relative">
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={dropdownVisible}
          aria-controls={listboxId}
          aria-autocomplete="list"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleInputKey}
          placeholder="Search anything…"
          className="w-full rounded-md border border-line bg-bg px-3 py-1.5 pr-12 font-mono text-[12px] text-ink placeholder:text-muted outline-none focus:border-accent"
        />
        <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted">
          /
        </kbd>
      </div>

      {dropdownVisible && (
        <div
          ref={dropdownRef}
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-20 max-h-[60vh] overflow-auto rounded-md border border-line bg-surface shadow-2xl"
        >
          {q.trim().length === 0 && recent.length > 0 && (
            <Section label="Recent">
              {recent.map((pick, idx) => {
                const entry = flat[idx];
                if (!entry) return null;
                return (
                  <RecentRow
                    key={`${pick.kind}-${pick.id}`}
                    entry={entry}
                    highlighted={idx === highlight}
                    onHover={() => setHighlight(idx)}
                    onPick={() => navigateToEntry(entry)}
                    onRemove={() => {
                      removeRecent(pick.kind, pick.id);
                      setRecent(readRecent(MAX_RECENTS));
                    }}
                  />
                );
              })}
            </Section>
          )}

          {q.trim().length > 0 && (
            <>
              {showLoadingShimmer && (
                <div className="px-4 py-3 text-[12px] text-muted">
                  <div className="h-3 w-3/4 animate-pulse rounded bg-surface2" />
                </div>
              )}

              {status === "error" && (
                <div className="flex items-center justify-between px-4 py-3 text-[12px] text-muted">
                  <span>Search unavailable.</span>
                  <button
                    type="button"
                    onClick={retry}
                    className="rounded border border-line bg-bg px-2 py-0.5 font-mono text-[11px] text-ink hover:bg-surface2"
                  >
                    Retry
                  </button>
                </div>
              )}

              {showEmpty && (
                <div className="px-4 py-3 text-[12px] text-muted">
                  No matches for <span className="text-ink">&ldquo;{q}&rdquo;</span>.{" "}
                  <button
                    type="button"
                    onClick={() => setQ("")}
                    className="font-mono text-[11px] text-accent hover:underline"
                  >
                    Clear
                  </button>
                </div>
              )}

              {results !== null && results.reddit.length > 0 && (
                <Section label="Reddit sources">
                  {results.reddit.map((hit, i) => {
                    const idx = i;
                    const entry = flat[idx];
                    if (!entry) return null;
                    return (
                      <ResultRow
                        key={hit.reddit_id}
                        entry={entry}
                        highlighted={idx === highlight}
                        onHover={() => setHighlight(idx)}
                        onPick={() => navigateToEntry(entry)}
                      />
                    );
                  })}
                </Section>
              )}

              {results !== null && results.stories.length > 0 && (
                <Section label="Stories">
                  {results.stories.map((hit, i) => {
                    const idx = (results?.reddit.length ?? 0) + i;
                    const entry = flat[idx];
                    if (!entry) return null;
                    return (
                      <ResultRow
                        key={hit.id}
                        entry={entry}
                        highlighted={idx === highlight}
                        onHover={() => setHighlight(idx)}
                        onPick={() => navigateToEntry(entry)}
                      />
                    );
                  })}
                </Section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line last:border-b-0">
      <div className="px-4 pt-2.5 pb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
        {label}
      </div>
      <div className="pb-1">{children}</div>
    </div>
  );
}

function ResultRow({
  entry,
  highlighted,
  onHover,
  onPick,
}: {
  entry: FlatEntry;
  highlighted: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <a
      href={entry.href}
      role="option"
      aria-selected={highlighted}
      onMouseEnter={onHover}
      onClick={(e) => {
        // Plain left-click navigates via the SPA router (records the
        // recent pick + closes the dropdown). Cmd/Ctrl/middle-click
        // falls through to the browser so "open in new tab" works.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onPick();
      }}
      className={`block px-4 py-2 transition-colors ${
        highlighted ? "bg-surface2" : "hover:bg-surface2"
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
          {entry.subLabel}
        </span>
        <span className="truncate text-[13px] text-ink">{entry.label || "(untitled)"}</span>
      </div>
      {entry.snippet && (
        <div className="mt-0.5 line-clamp-1 text-[12px] text-muted">
          {renderSnippet(entry.snippet)}
        </div>
      )}
    </a>
  );
}

function RecentRow({
  entry,
  highlighted,
  onHover,
  onPick,
  onRemove,
}: {
  entry: FlatEntry;
  highlighted: boolean;
  onHover: () => void;
  onPick: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      onMouseEnter={onHover}
      className={`flex items-center transition-colors ${
        highlighted ? "bg-surface2" : "hover:bg-surface2"
      }`}
    >
      <a
        href={entry.href}
        role="option"
        aria-selected={highlighted}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onPick();
        }}
        className="flex-1 px-4 py-2"
      >
        <div className="flex items-baseline gap-2">
          <span className="rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
            {entry.subLabel}
          </span>
          <span className="truncate text-[13px] text-ink">{entry.label || "(untitled)"}</span>
        </div>
      </a>
      <button
        type="button"
        aria-label={`Remove ${entry.label} from recent`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove();
        }}
        className="px-3 py-2 text-muted opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
        style={{ opacity: highlighted ? 1 : undefined }}
      >
        ×
      </button>
    </div>
  );
}
