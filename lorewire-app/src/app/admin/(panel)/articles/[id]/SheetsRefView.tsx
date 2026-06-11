"use client";

// React NodeView for the sheetsRef research block. The writer pastes a
// sheet URL, optionally names a tab, hits Fetch, and the view displays
// the headers + rows inline. Data lives on the node's attributes so a
// reopen doesn't re-hit the network; Refresh re-fetches.
//
// Public render. The renderer in src/lib/article-html.ts strips this
// node type before serialization, so the block never reaches the public
// reader. The data is purely for the writer.

import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useState } from "react";
import type { SheetsRefRow } from "@/lib/tiptap-sheets-ref";

const BTN =
  "rounded-md border border-line bg-bg px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40";
const FIELD =
  "w-full rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent";

interface FetchResponse {
  spreadsheetId: string;
  tab: string;
  headers: string[];
  rows: SheetsRefRow[];
  fetchedAt: string;
}

interface ErrorResponse {
  error?: string;
}

function fmtClock(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 16);
  }
}

export function SheetsRefView({
  node,
  updateAttributes,
  deleteNode,
  selected,
}: NodeViewProps) {
  const initialUrl = String(node.attrs.spreadsheetId ?? "");
  const initialTab = String(node.attrs.tab ?? "");
  const fetchedAt =
    typeof node.attrs.fetchedAt === "string"
      ? (node.attrs.fetchedAt as string)
      : null;
  const headers = Array.isArray(node.attrs.headers)
    ? (node.attrs.headers as string[])
    : [];
  const rows = Array.isArray(node.attrs.rows)
    ? (node.attrs.rows as SheetsRefRow[])
    : [];
  const note = String(node.attrs.note ?? "");

  const [urlInput, setUrlInput] = useState(initialUrl);
  const [tabInput, setTabInput] = useState(initialTab);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function doFetch(): Promise<void> {
    if (!urlInput.trim()) {
      setError("Paste a sheet URL or id.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const resp = await fetch("/api/admin/articles/sheets-fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sheetUrl: urlInput.trim(),
          tab: tabInput.trim() || undefined,
          limit: 50,
        }),
      });
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as ErrorResponse;
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as FetchResponse;
      updateAttributes({
        spreadsheetId: data.spreadsheetId,
        tab: data.tab,
        headers: data.headers,
        rows: data.rows,
        fetchedAt: data.fetchedAt,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <NodeViewWrapper
      as="div"
      data-sheets-ref=""
      className={`my-3 rounded-lg border bg-surface p-3 transition-colors ${
        selected ? "border-accent" : "border-line"
      }`}
      contentEditable={false}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Sheets research · editor only
        </span>
        <button
          type="button"
          onClick={() => deleteNode()}
          className={`${BTN} hover:border-danger/40 hover:text-danger`}
        >
          Remove
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-[2fr_1fr_auto]">
        <input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="Sheet URL or id"
          className={`${FIELD} font-mono text-[11px]`}
          spellCheck={false}
        />
        <input
          value={tabInput}
          onChange={(e) => setTabInput(e.target.value)}
          placeholder="Tab (optional)"
          className={`${FIELD} font-mono text-[11px]`}
          spellCheck={false}
        />
        <button
          type="button"
          onClick={doFetch}
          disabled={loading}
          className={BTN}
        >
          {loading
            ? "Fetching…"
            : rows.length > 0
              ? "Refresh"
              : "Fetch"}
        </button>
      </div>

      <input
        value={note}
        onChange={(e) => updateAttributes({ note: e.target.value })}
        placeholder="Note for yourself (e.g. ignore footer row)"
        className={`${FIELD} mt-2`}
      />

      {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}

      {fetchedAt && (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-muted">
          Last fetched {fmtClock(fetchedAt)}
        </p>
      )}

      {rows.length > 0 && (
        <div className="mt-2 max-h-96 overflow-auto rounded-md border border-line">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-bg">
              <tr className="border-b border-line">
                {headers.map((h) => (
                  <th
                    key={h}
                    className="px-2 py-1 text-left font-mono text-[10px] uppercase tracking-wider text-muted"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  {headers.map((h) => (
                    <td
                      key={h}
                      className="max-w-[240px] truncate px-2 py-1 align-top text-ink"
                    >
                      {row[h] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </NodeViewWrapper>
  );
}
