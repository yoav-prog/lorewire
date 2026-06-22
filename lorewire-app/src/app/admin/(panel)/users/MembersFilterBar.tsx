"use client";

// Filter bar for the Members list. Plain GET form so every filter combination
// lives in the URL — bookmarkable, shareable, browser-back-friendly. The
// dropdowns auto-submit on change (rule 10: pick a filter, see results); the
// search box submits on Enter or via the Search button, so typing "ali" never
// re-queries at "a" then "al". Mirrors the Reddit Sources FilterRail contract.

import Link from "next/link";
import { PROVIDER_LABEL } from "./member-display";

interface MembersFilterBarProps {
  q: string;
  provider: string;
  status: string;
  sort: string;
  providers: string[];
}

function submitParentForm(e: React.ChangeEvent<HTMLSelectElement>) {
  e.currentTarget.form?.requestSubmit();
}

export default function MembersFilterBar({
  q,
  provider,
  status,
  sort,
  providers,
}: MembersFilterBarProps) {
  const isFiltered = Boolean(q || provider || status || sort !== "recent");
  return (
    <form
      method="get"
      className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3"
    >
      <input
        type="search"
        name="q"
        defaultValue={q}
        placeholder="Search name or email…"
        aria-label="Search members"
        className="min-w-[220px] flex-1 rounded-md border border-line bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
      />

      <select
        name="provider"
        defaultValue={provider}
        onChange={submitParentForm}
        aria-label="Filter by provider"
        className="rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
      >
        <option value="">All providers</option>
        {providers.map((p) => (
          <option key={p} value={p}>
            {PROVIDER_LABEL[p] ?? p}
          </option>
        ))}
      </select>

      <select
        name="status"
        defaultValue={status}
        onChange={submitParentForm}
        aria-label="Filter by status"
        className="rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
      >
        <option value="">All statuses</option>
        <option value="active">Active</option>
        <option value="suspended">Suspended</option>
      </select>

      <select
        name="sort"
        defaultValue={sort}
        onChange={submitParentForm}
        aria-label="Sort members"
        className="rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
      >
        <option value="recent">Recently active</option>
        <option value="joined">Newest first</option>
      </select>

      <button
        type="submit"
        className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90"
      >
        Search
      </button>

      {isFiltered && (
        <Link
          href="/admin/users"
          className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-ink"
        >
          Reset
        </Link>
      )}
    </form>
  );
}
