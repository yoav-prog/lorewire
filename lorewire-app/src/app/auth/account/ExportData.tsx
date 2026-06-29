"use client";

// Self-serve data export for the account page (GDPR Article 15 / 20).
// "Download my data" POSTs /api/user/export, saves the returned JSON as a
// file, and shows a readable summary of what's inside.
//
// NOT WIRED YET: the account page (page.tsx) is owned by the in-flight
// Facebook + data-deletion work, so this is left unmounted to avoid a merge
// collision. To enable, add one line under the AccountForm in page.tsx:
//   import ExportData from "./ExportData";
//   <ExportData />
//
// Mirrors AccountForm / DeleteAccount styling so it reads as one surface.
//
// Plan: _plans/2026-06-22-gdpr-compliance.md §Phase 2 (export).

import { useState } from "react";

// Friendly labels keyed by the export registry's table names.
const SUMMARY_LABELS: Record<string, string> = {
  users: "Account profile",
  user_saves: "Saved stories",
  user_likes: "Liked stories",
  user_fav_categories: "Favorite categories",
  user_recently_viewed: "Recently viewed",
  user_continue: "Reading and watching progress",
  poll_votes: "Poll votes",
};

interface DataExport {
  exportedAt: string;
  userId: string;
  data: Record<string, unknown[]>;
}

export default function ExportData() {
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Array<[string, number]> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onExport() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/user/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: "{}",
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; export?: DataExport }
        | null;
      if (!res.ok || !data?.ok || !data.export) {
        setError(data?.error ?? "Couldn't build your export. Try again.");
        setBusy(false);
        return;
      }
      triggerDownload(data.export);
      setSummary(
        Object.entries(data.export.data).map(
          ([table, rows]) => [table, rows.length] as [string, number],
        ),
      );
      setBusy(false);
    } catch (err) {
      console.warn("[account data export network-error]", { err: String(err) });
      setError("Couldn't reach the server. Check your connection.");
      setBusy(false);
    }
  }

  return (
    <section className="mt-12 border-t border-line pt-8">
      <h2 className="text-[12px] font-mono uppercase tracking-[.2em] text-muted">
        Your data
      </h2>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Download a copy of your profile and activity as a JSON file.
        </p>
        <button
          type="button"
          onClick={onExport}
          disabled={busy}
          className="rounded-md border border-ink bg-bg px-4 py-2 text-sm font-medium text-ink hover:bg-ink hover:text-bg disabled:opacity-60"
        >
          {busy ? "Preparing…" : "Download my data"}
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-[12px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {summary ? (
        <div className="mt-4 rounded-md border border-line bg-bg/60 p-4">
          <p className="text-[12px] font-mono uppercase tracking-[.2em] text-muted">
            In your download
          </p>
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {summary.map(([table, count]) => (
              <li key={table} className="flex justify-between gap-4">
                <span>{SUMMARY_LABELS[table] ?? table}</span>
                <span className="text-muted">{count}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function triggerDownload(data: DataExport) {
  const day = (data.exportedAt || new Date().toISOString()).slice(0, 10);
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lorewire-data-${day}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
