"use client";

// Filter rail for the Reddit Sources list. Plain GET form so every filter
// combination is in the URL — bookmarkable, shareable, browser-back-friendly,
// trivially debuggable. The rail was extracted from page.tsx in 2026-06-16
// when we added auto-submit on the click-style inputs (checkboxes,
// dropdowns, dates): the lazy-user bar (rule 10) is "select a filter, see
// results", not "select a filter, scroll down, click Apply, see results".
// The Apply button stays for the text inputs you might want to type into
// before submitting (search + the numeric ranges).

import Link from "next/link";
import { useMemo, useState } from "react";
import type {
  RedditSourceOrderBy,
  RedditSourceStatus,
  RedditSourceStrength,
} from "@/lib/reddit-source";

interface FilterRailProps {
  searchParams: {
    q?: string;
    length_min?: string;
    length_max?: string;
    comments_min?: string;
    date_from?: string;
    date_to?: string;
  };
  activeStatuses: RedditSourceStatus[];
  activeSubreddits: string[];
  activeStrengths: RedditSourceStrength[];
  allSubreddits: string[];
  sort: RedditSourceOrderBy;
  validStatuses: ReadonlyArray<RedditSourceStatus>;
  statusLabel: Record<RedditSourceStatus, string>;
  validStrengths: ReadonlyArray<RedditSourceStrength>;
  strengthLabel: Record<RedditSourceStrength, string>;
  sortLabel: Record<RedditSourceOrderBy, string>;
}

// Submit the parent form when the user changes a click-style input. We use
// `currentTarget.form?.requestSubmit()` (instead of `.submit()`) so the
// browser fires the submit event and applies any HTML5 validity checks
// before navigating.
function submitParentForm(
  e:
    | React.ChangeEvent<HTMLInputElement>
    | React.ChangeEvent<HTMLSelectElement>,
) {
  e.currentTarget.form?.requestSubmit();
}

export default function FilterRail({
  searchParams,
  activeStatuses,
  activeSubreddits,
  activeStrengths,
  allSubreddits,
  sort,
  validStatuses,
  statusLabel,
  validStrengths,
  strengthLabel,
  sortLabel,
}: FilterRailProps) {
  return (
    <form
      method="get"
      className="space-y-4 rounded-xl border border-line bg-surface p-4"
    >
      <div>
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted">
          Search
        </label>
        <input
          type="search"
          name="q"
          defaultValue={searchParams.q ?? ""}
          placeholder="title or summary…"
          className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
        />
      </div>

      <fieldset>
        <legend className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted">
          Status
        </legend>
        <div className="grid grid-cols-2 gap-1">
          {validStatuses.map((s) => {
            const checked = activeStatuses.includes(s);
            return (
              <label
                key={s}
                className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink transition-colors has-[input:checked]:border-accent has-[input:checked]:bg-surface2"
              >
                <input
                  type="checkbox"
                  name="status"
                  value={s}
                  defaultChecked={checked}
                  onChange={submitParentForm}
                  className="accent-accent"
                />
                {statusLabel[s]}
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* 2026-06-23 IdeasDB priority import (see
          _plans/2026-06-23-ideasdb-priority-import.md). Strength rides on
          reddit_source as a first-class signal so editorial priority is
          filterable here, sortable via SORT_LABEL["strength DESC"] in
          page.tsx, and respected by the worker queue (claim_next_story_job
          ORDER BY strength weight DESC). Same auto-submit-on-click ergonomics
          as Status. */}
      <fieldset>
        <legend className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted">
          Priority
        </legend>
        <div className="grid grid-cols-3 gap-1">
          {validStrengths.map((s) => {
            const checked = activeStrengths.includes(s);
            return (
              <label
                key={s}
                className="flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink transition-colors has-[input:checked]:border-accent has-[input:checked]:bg-surface2"
              >
                <input
                  type="checkbox"
                  name="strength"
                  value={s}
                  defaultChecked={checked}
                  onChange={submitParentForm}
                  className="accent-accent"
                />
                {strengthLabel[s]}
              </label>
            );
          })}
        </div>
        <p className="mt-1 font-mono text-[9px] text-muted">
          Set by the IdeasDB importer. Strong &gt; Medium &gt; None in the
          worker queue.
        </p>
      </fieldset>

      <SubredditFieldset
        allSubreddits={allSubreddits}
        activeSubreddits={activeSubreddits}
      />

      <fieldset>
        <legend className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted">
          Length (chars)
        </legend>
        {/*
          Numeric ranges intentionally do NOT auto-submit. Typing the third
          digit of "1000" would otherwise re-query at "1", "10", "100" before
          you finish. They submit on blur so you can leave the field with
          tab / click-out and see results without hunting for Apply.
        */}
        <div className="flex gap-2">
          <input
            type="number"
            name="length_min"
            min={0}
            defaultValue={searchParams.length_min ?? ""}
            placeholder="min"
            onBlur={(e) => e.currentTarget.form?.requestSubmit()}
            className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
          />
          <input
            type="number"
            name="length_max"
            min={0}
            defaultValue={searchParams.length_max ?? ""}
            placeholder="max"
            onBlur={(e) => e.currentTarget.form?.requestSubmit()}
            className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
          />
        </div>
      </fieldset>

      <div>
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted">
          Min comments
        </label>
        <input
          type="number"
          name="comments_min"
          min={0}
          defaultValue={searchParams.comments_min ?? ""}
          placeholder="e.g. 100"
          onBlur={(e) => e.currentTarget.form?.requestSubmit()}
          className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
        />
      </div>

      <fieldset>
        <legend className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted">
          Date range
        </legend>
        <div className="space-y-1">
          <input
            type="date"
            name="date_from"
            defaultValue={searchParams.date_from ?? ""}
            onChange={submitParentForm}
            className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
          />
          <input
            type="date"
            name="date_to"
            defaultValue={searchParams.date_to ?? ""}
            onChange={submitParentForm}
            className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
          />
        </div>
      </fieldset>

      <div>
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted">
          Sort
        </label>
        <select
          name="sort"
          defaultValue={sort}
          onChange={submitParentForm}
          className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
        >
          {Object.entries(sortLabel).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Link
          href="/admin/reddit-sources"
          className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-ink"
        >
          Reset
        </Link>
        <button
          type="submit"
          className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90"
          title="Most filters auto-apply on change. The search box and number ranges submit on blur or via Enter — this button is the explicit fallback."
        >
          Apply
        </button>
      </div>
    </form>
  );
}

// Subreddit fieldset with a type-ahead filter above the multi-select.
// Typing narrows the visible options as you go; the currently-selected
// subreddits are ALWAYS in the visible list (pinned above the filter
// matches) so a query that excludes them doesn't make the active state
// look like it vanished. Selection auto-submits the parent form via
// the existing onChange path; the search input itself is local-only
// (no form submission, no URL state) — it's a UI affordance, not a
// query parameter, so a reload starts with the full list.
function SubredditFieldset({
  allSubreddits,
  activeSubreddits,
}: {
  allSubreddits: string[];
  activeSubreddits: string[];
}) {
  const [query, setQuery] = useState("");

  const { visible, matchCount } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const activeSet = new Set(activeSubreddits);
    // Active subreddits sit at the top of the list whether or not they
    // match the query — losing sight of the active selection while
    // searching for the next addition would be disorienting.
    const active = allSubreddits.filter((s) => activeSet.has(s));
    const inactiveAll = allSubreddits.filter((s) => !activeSet.has(s));
    const inactiveMatches = q
      ? inactiveAll.filter((s) => s.toLowerCase().includes(q))
      : inactiveAll;
    return {
      visible: [...active, ...inactiveMatches],
      matchCount: inactiveMatches.length,
    };
  }, [allSubreddits, activeSubreddits, query]);

  const showingFilteredOut = query.trim().length > 0;

  return (
    <fieldset>
      <legend className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted">
        Subreddit
      </legend>

      {/* Type-ahead filter. Not a form field — local state only — so the
          rail's GET form doesn't pick it up as a query param on submit.
          Keystrokes never trigger a navigation; the user filters in
          place, then clicks an option which auto-submits via the
          existing onChange handler. */}
      <div className="relative mb-1.5">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter subreddits…"
          aria-label="Filter the subreddit list"
          className="w-full rounded-md border border-line bg-bg px-2 py-1 pr-7 text-[12px] text-ink outline-none placeholder:text-muted focus:border-accent"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear filter"
            className="absolute inset-y-0 right-1 my-auto flex h-5 w-5 items-center justify-center rounded-sm font-mono text-[12px] text-muted transition-colors hover:bg-surface2 hover:text-ink"
          >
            ×
          </button>
        )}
      </div>

      <select
        name="subreddits"
        multiple
        defaultValue={activeSubreddits}
        size={8}
        onChange={submitParentForm}
        className="w-full rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
      >
        {visible.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      <p className="mt-1 font-mono text-[9px] text-muted">
        {showingFilteredOut ? (
          <>
            {matchCount} {matchCount === 1 ? "match" : "matches"}
            {activeSubreddits.length > 0 ? " + active selection" : ""} ·
            Ctrl/⌘-click to multi-select
          </>
        ) : (
          <>Ctrl/⌘-click to multi-select</>
        )}
      </p>
    </fieldset>
  );
}
