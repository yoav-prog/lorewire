// Google Sheets bootstrap import helper. One source of truth for:
//   - service-account JWT auth (env-only, never logged)
//   - parsing a Sheet URL into its spreadsheet + tab IDs
//   - listing the tabs in a workbook
//   - reading rows (header + data) from a chosen tab
//
// Credentials. We accept either a dedicated SHEETS_* pair OR fall back to
// the existing GCS_* service account if the project owner added the Sheets
// API scope and shared the target sheets with the GCS service email. This
// avoids forcing a second key rotation during Phase 3 while still leaving
// the cleaner "separate principals per surface" door open for production.
//
// Safety. Logs redact the private key. Errors thrown here carry no key
// material; they describe what went wrong (missing env, bad URL, sheet
// not shared with the service email) so the import UI can surface a clear
// message without leaking secrets.

import "server-only";
import { JWT } from "google-auth-library";
import { GoogleSpreadsheet } from "google-spreadsheet";

const SCOPES = [
  // Read-only is enough for bootstrap import. Adding write scope here would
  // be a privilege creep, since the import only ever reads.
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];

function privateKeyFromEnv(): string | null {
  // Same massage step as the GCS helper: .env stores `\n` as a literal
  // backslash-n; PEM parsing needs real newlines.
  const raw = process.env.SHEETS_PRIVATE_KEY ?? process.env.GCS_PRIVATE_KEY;
  if (!raw) return null;
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function clientEmailFromEnv(): string | null {
  return (
    process.env.SHEETS_SERVICE_ACCOUNT_EMAIL ??
    process.env.GCS_CLIENT_EMAIL ??
    null
  );
}

export function isConfigured(): boolean {
  return Boolean(clientEmailFromEnv() && privateKeyFromEnv());
}

function makeAuth(): JWT {
  const email = clientEmailFromEnv();
  const key = privateKeyFromEnv();
  if (!email || !key) {
    throw new Error(
      "Sheets import is not configured. Set SHEETS_SERVICE_ACCOUNT_EMAIL " +
        "and SHEETS_PRIVATE_KEY (or reuse GCS_CLIENT_EMAIL / GCS_PRIVATE_KEY).",
    );
  }
  return new JWT({ email, key, scopes: SCOPES });
}

// --- URL parsing -----------------------------------------------------------
// Accepts the canonical https://docs.google.com/spreadsheets/d/<id>/... shape
// plus the looser "just paste the id" form so the user doesn't have to clip
// the URL. `gid` (the tab numeric id, not the title) is returned when present
// so the import page can pre-select the right tab.

export interface ParsedSheetRef {
  spreadsheetId: string;
  gid: number | null;
}

const ID_RE = /\/d\/([A-Za-z0-9_-]{20,})/;

export function parseSheetRef(input: string): ParsedSheetRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Bare-id shape: 30+ chars of [A-Za-z0-9_-]. Google IDs are 44 chars
  // today; we accept >=20 for some forward compatibility.
  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
    return { spreadsheetId: trimmed, gid: null };
  }
  const m = ID_RE.exec(trimmed);
  if (!m) return null;
  const spreadsheetId = m[1];
  // gid lives either in the hash (#gid=123) or the search (?gid=123). We
  // grep both — parseSheetRef stays parser-only with no URL constructor
  // because we want to tolerate funky inputs (truncated URLs, missing
  // protocols) without throwing.
  const gidMatch = trimmed.match(/[?#&]gid=(\d+)/);
  const gid = gidMatch ? Number(gidMatch[1]) : null;
  return { spreadsheetId, gid: Number.isFinite(gid) ? (gid as number) : null };
}

// --- loading + reading -----------------------------------------------------

export interface SheetTabInfo {
  sheetId: number;
  title: string;
  index: number;
  rowCount: number;
}

export async function listTabs(
  spreadsheetId: string,
): Promise<{ title: string; tabs: SheetTabInfo[] }> {
  const doc = new GoogleSpreadsheet(spreadsheetId, makeAuth());
  await doc.loadInfo();
  const tabs: SheetTabInfo[] = doc.sheetsByIndex.map((s) => ({
    sheetId: s.sheetId,
    title: s.title,
    index: s.index,
    rowCount: s.rowCount,
  }));
  console.info("[articles sheets-import] list-tabs", {
    spreadsheetId,
    tabCount: tabs.length,
    title: doc.title.slice(0, 80),
  });
  return { title: doc.title, tabs };
}

export interface SheetRows {
  headers: string[];
  // Each row is a parallel array to `headers`; rows.length is the count of
  // non-empty data rows below the header. Trailing fully-empty rows are
  // dropped so a Sheet with 100 blank rows at the bottom imports cleanly.
  rows: string[][];
}

export async function readRows(
  spreadsheetId: string,
  tabIdentifier: string | number,
  opts: { limit?: number } = {},
): Promise<SheetRows> {
  const doc = new GoogleSpreadsheet(spreadsheetId, makeAuth());
  await doc.loadInfo();
  // `tabIdentifier` can be either the title (string) or the gid (number,
  // which is what URLs carry). We resolve both shapes against the loaded
  // tabs list so the caller does not need to know which one it has.
  const sheet =
    typeof tabIdentifier === "number"
      ? doc.sheetsByIndex.find((s) => s.sheetId === tabIdentifier)
      : doc.sheetsByTitle[tabIdentifier];
  if (!sheet) {
    throw new Error(`Tab "${String(tabIdentifier)}" not found in this sheet.`);
  }
  // Loading all rows up front is the documented v4 API. The library reads
  // the underlying values via the Sheets REST API in chunks; we trust the
  // cap (50 rows in a typical bootstrap import) to keep this lightweight.
  const rawRows = await sheet.getRows({ limit: opts.limit });
  const headers = sheet.headerValues ?? [];
  const rows: string[][] = [];
  for (const row of rawRows) {
    // get() returns string | undefined per header; null cells become "".
    const projected = headers.map((h) => {
      const v = row.get(h);
      return v == null ? "" : String(v);
    });
    // Drop a row that is fully empty across every column — happens at the
    // end of sheets with trailing blank rows.
    if (projected.some((s) => s.trim() !== "")) {
      rows.push(projected);
    }
  }
  console.info("[articles sheets-import] read-rows", {
    spreadsheetId,
    tab: typeof tabIdentifier === "string" ? tabIdentifier : `gid:${tabIdentifier}`,
    headerCount: headers.length,
    rowCount: rows.length,
  });
  return { headers, rows };
}

// --- stable row id ---------------------------------------------------------
// source_sheet_row_id is the idempotency key. The user designates one
// spreadsheet column as the ID column; if missing, we hash a tuple of
// (sheetId, rowIdColumnValue OR title-ish content) so re-importing the
// same workbook doesn't double-insert. The hash format is intentionally
// stable across processes and engines: SHA-256 over a delimiter-joined
// string, hex-encoded, first 24 chars (enough for collision-resistance at
// our scale; longer would just bloat the column).

import { createHash } from "node:crypto";

export function stableRowId(parts: {
  spreadsheetId: string;
  rowKey: string;
}): string {
  const h = createHash("sha256");
  h.update("lw-sheet:");
  h.update(parts.spreadsheetId);
  h.update("|");
  h.update(parts.rowKey);
  return h.digest("hex").slice(0, 24);
}
