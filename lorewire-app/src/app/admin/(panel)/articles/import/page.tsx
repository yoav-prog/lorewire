// Sheets bootstrap import page.
//
// Three states stitched into one page:
//   1. Empty — user pastes a sheet URL and submits.
//   2. Tab-picker / preview — once `spreadsheet_id` is in the URL we load
//      the tab list + the chosen tab's headers and a sample of rows.
//   3. Commit — user picks the title column (required) + optional summary /
//      body / row-id columns + the article type and language, submits, and
//      the action inserts draft articles.
//
// Per the Phase 3 plan: idempotent via source_sheet_row_id (handled in the
// commit action) so re-importing the same sheet doesn't double-create.
// Read-only Sheets scope; service-account auth lives in src/lib/sheets.ts.

import Link from "next/link";
import { requireCapability } from "@/lib/dal";
import {
  previewSheetImportAction,
  commitSheetImportAction,
} from "@/app/admin/actions";
import {
  isConfigured as isSheetsConfigured,
  listTabs,
  readRows,
  type SheetTabInfo,
} from "@/lib/sheets";
import { ARTICLE_TYPES, ARTICLE_LANGUAGES } from "@/lib/repo";
import {
  ARTICLE_TYPE_LABELS,
  ARTICLE_LANGUAGE_LABELS,
} from "@/lib/articles";

const FIELD =
  "w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";
const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";
const SECTION = "rounded-xl border border-line bg-surface p-4";
const PRIMARY_BTN =
  "rounded-lg bg-accent px-5 py-2.5 font-semibold text-bg transition-opacity hover:opacity-90";
const SECONDARY_BTN =
  "rounded-lg border border-line px-4 py-2 font-mono text-[12px] uppercase tracking-wider text-muted hover:text-ink";

// Friendly error rewrites for the redirects coming back from the actions.
function errorMessage(code: string): string {
  switch (code) {
    case "sheets-not-configured":
      return "Sheets is not configured. Set SHEETS_SERVICE_ACCOUNT_EMAIL and SHEETS_PRIVATE_KEY (or share the sheet with the GCS service email and reuse GCS_*).";
    case "bad-url":
      return "That doesn't look like a Sheet URL. Paste the address from your browser.";
    case "missing-spreadsheet-id":
      return "Missing spreadsheet id. Start over from the URL.";
    case "missing-tab":
      return "Pick a tab before continuing.";
    case "missing-title-column":
      return "Map a column to Title before continuing.";
    case "title-column-not-in-sheet":
      return "The chosen Title column wasn't found. The sheet may have been edited in another tab.";
    case "bad-type":
    case "bad-language":
      return "Invalid article type or language.";
    case "sheets-read-failed":
      return "Could not read the sheet. The service email may not have access — share the sheet with it (view-only is fine).";
    default:
      return code.replace(/-/g, " ");
  }
}

export default async function ImportSheetPage({
  searchParams,
}: {
  searchParams: Promise<{
    spreadsheet_id?: string;
    tab?: string;
    gid?: string;
    error?: string;
  }>;
}) {
  await requireCapability("content.manage");
  const sp = await searchParams;

  // Empty + error states render the same minimal landing surface — we want
  // the writer to see "paste a URL" first, errors as a banner above it.
  const hasSpreadsheet = Boolean(sp.spreadsheet_id);
  const configured = isSheetsConfigured();

  // Tab list + preview rows are only loaded when we have a spreadsheet id.
  // We catch and surface failures inline so the page never 500s for a
  // missing share or a typo'd id; the writer can then start over.
  let title = "";
  let tabs: SheetTabInfo[] = [];
  let chosenTabIdentifier: string | number | null = null;
  let chosenTabTitle: string | null = null;
  let preview: { headers: string[]; rows: string[][] } | null = null;
  let loadError: string | null = null;

  if (hasSpreadsheet && configured) {
    try {
      const info = await listTabs(sp.spreadsheet_id!);
      title = info.title;
      tabs = info.tabs;
      // Resolve the tab to load:
      //   1. explicit ?tab=<title>
      //   2. ?gid=<number>
      //   3. first tab
      if (sp.tab) {
        const match = tabs.find((t) => t.title === sp.tab);
        if (match) {
          chosenTabIdentifier = match.title;
          chosenTabTitle = match.title;
        }
      } else if (sp.gid) {
        const gid = Number(sp.gid);
        const match = tabs.find((t) => t.sheetId === gid);
        if (match) {
          chosenTabIdentifier = match.sheetId;
          chosenTabTitle = match.title;
        }
      }
      if (chosenTabIdentifier === null && tabs.length > 0) {
        chosenTabIdentifier = tabs[0].title;
        chosenTabTitle = tabs[0].title;
      }
      if (chosenTabIdentifier !== null) {
        preview = await readRows(sp.spreadsheet_id!, chosenTabIdentifier, {
          limit: 5,
        });
      }
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <div className="mx-auto max-w-[920px] space-y-5">
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/admin/articles"
          className="font-mono text-[12px] text-muted hover:text-ink"
        >
          &larr; Articles
        </Link>
      </div>

      <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
        Import from Google Sheets
      </h1>
      <p className="font-mono text-[11px] text-muted">
        Bulk-create draft articles from a sheet. Share the sheet with the
        service account email first (view-only is enough). Re-importing the
        same sheet skips rows already imported.
      </p>

      {!configured && (
        <p className="rounded-lg border border-cat-entitled/40 bg-cat-entitled/15 px-4 py-2 text-[12px] text-cat-entitled">
          Sheets is not configured. Set <code>SHEETS_SERVICE_ACCOUNT_EMAIL</code>{" "}
          and <code>SHEETS_PRIVATE_KEY</code>, or share the target sheet with
          the GCS service email so <code>GCS_*</code> can be reused.
        </p>
      )}

      {sp.error && (
        <p className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 text-[12px] text-danger">
          {errorMessage(sp.error)}
        </p>
      )}

      {loadError && (
        <p className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 text-[12px] text-danger">
          {loadError}
        </p>
      )}

      {/* Step 1: URL paste. Always visible so the writer can pivot to a
          different sheet without going back to the articles list. */}
      <form action={previewSheetImportAction} className={`${SECTION} space-y-3`}>
        <div>
          <label className={LABEL}>Sheet URL or ID</label>
          <input
            name="sheetUrl"
            defaultValue={sp.spreadsheet_id ?? ""}
            placeholder="https://docs.google.com/spreadsheets/d/…"
            className={`${FIELD} font-mono text-[12px]`}
            spellCheck={false}
            required
          />
        </div>
        <div className="flex items-center justify-end gap-3">
          <button type="submit" disabled={!configured} className={PRIMARY_BTN}>
            {hasSpreadsheet ? "Load different sheet" : "Load sheet"}
          </button>
        </div>
      </form>

      {hasSpreadsheet && configured && !loadError && (
        <>
          <div className={SECTION}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="font-mono text-[11px] uppercase tracking-wider text-muted">
                Workbook
              </span>
              <span className="text-[14px] text-ink">{title}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                Tab
              </span>
              {tabs.map((t) => {
                const active = chosenTabTitle === t.title;
                const href = `/admin/articles/import?spreadsheet_id=${encodeURIComponent(sp.spreadsheet_id!)}&tab=${encodeURIComponent(t.title)}`;
                return (
                  <Link
                    key={t.sheetId}
                    href={href}
                    className={`rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                      active
                        ? "border-ink/30 bg-surface2 text-ink"
                        : "border-line text-muted hover:text-ink"
                    }`}
                  >
                    {t.title}
                    <span className="ml-1 text-muted">·{t.rowCount}</span>
                  </Link>
                );
              })}
            </div>
          </div>

          {preview && chosenTabTitle && (
            <form
              action={commitSheetImportAction}
              className={`${SECTION} space-y-4`}
            >
              <input
                type="hidden"
                name="spreadsheet_id"
                value={sp.spreadsheet_id}
              />
              <input type="hidden" name="tab" value={chosenTabTitle} />

              {preview.headers.length === 0 ? (
                <p className="text-[13px] text-muted">
                  This tab has no headers. Add a header row in the first row of
                  the sheet and reload.
                </p>
              ) : (
                <>
                  {/* Sample preview table — first 5 rows. */}
                  <div>
                    <div className={LABEL}>
                      Preview (first {preview.rows.length} rows)
                    </div>
                    <div className="overflow-x-auto rounded-md border border-line">
                      <table className="w-full text-[12px]">
                        <thead>
                          <tr className="border-b border-line bg-bg">
                            {preview.headers.map((h) => (
                              <th
                                key={h}
                                className="px-2 py-1.5 text-left font-mono text-[10px] uppercase tracking-wider text-muted"
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {preview.rows.length === 0 ? (
                            <tr>
                              <td
                                colSpan={Math.max(preview.headers.length, 1)}
                                className="px-2 py-3 text-center text-muted"
                              >
                                No data rows in this tab.
                              </td>
                            </tr>
                          ) : (
                            preview.rows.map((row, i) => (
                              <tr
                                key={i}
                                className="border-b border-line last:border-0"
                              >
                                {preview.headers.map((_, j) => (
                                  <td
                                    key={j}
                                    className="max-w-[200px] truncate px-2 py-1 text-ink"
                                  >
                                    {row[j] ?? ""}
                                  </td>
                                ))}
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {preview.rows.length > 0 && (
                    <>
                      {/* Column mapper + per-import defaults. */}
                      <div className="grid gap-3 sm:grid-cols-2">
                        <ColumnSelect
                          label="Title column (required)"
                          name="col_title"
                          headers={preview.headers}
                          required
                          defaultHeader={preview.headers[0]}
                        />
                        <ColumnSelect
                          label="Summary column (optional)"
                          name="col_summary"
                          headers={preview.headers}
                        />
                        <ColumnSelect
                          label="Body column (optional)"
                          name="col_body"
                          headers={preview.headers}
                        />
                        <ColumnSelect
                          label="Row ID column (optional)"
                          name="col_row_id"
                          headers={preview.headers}
                          help="Stable identifier. If left blank the title is hashed instead."
                        />
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <span className={LABEL}>Article type</span>
                          <div className="grid grid-cols-2 gap-1">
                            {ARTICLE_TYPES.map((t, i) => (
                              <label
                                key={t}
                                className="flex cursor-pointer items-center gap-2 rounded-md border border-line bg-bg px-2.5 py-1.5 text-[12px] transition-colors hover:border-accent has-[input:checked]:border-accent has-[input:checked]:bg-surface2"
                              >
                                <input
                                  type="radio"
                                  name="article_type"
                                  value={t}
                                  defaultChecked={i === 1 /* feature */}
                                  className="accent-accent"
                                  required
                                />
                                {ARTICLE_TYPE_LABELS[t]}
                              </label>
                            ))}
                          </div>
                        </div>
                        <div>
                          <span className={LABEL}>Language</span>
                          <div className="grid grid-cols-2 gap-1">
                            {ARTICLE_LANGUAGES.map((l, i) => (
                              <label
                                key={l}
                                className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-line bg-bg px-2.5 py-1.5 text-[12px] transition-colors hover:border-accent has-[input:checked]:border-accent has-[input:checked]:bg-surface2"
                              >
                                <input
                                  type="radio"
                                  name="article_language"
                                  value={l}
                                  defaultChecked={i === 1 /* en */}
                                  className="accent-accent"
                                  required
                                />
                                {ARTICLE_LANGUAGE_LABELS[l]}
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>

                      <p className="font-mono text-[10px] text-muted">
                        Up to 200 rows imported per run. Existing rows (matched
                        by source row id) are skipped, not overwritten.
                      </p>

                      <div className="flex items-center justify-end gap-3">
                        <Link href="/admin/articles" className={SECONDARY_BTN}>
                          Cancel
                        </Link>
                        <button type="submit" className={PRIMARY_BTN}>
                          Import as drafts
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </form>
          )}
        </>
      )}
    </div>
  );
}

function ColumnSelect({
  label,
  name,
  headers,
  required,
  defaultHeader,
  help,
}: {
  label: string;
  name: string;
  headers: string[];
  required?: boolean;
  defaultHeader?: string;
  help?: string;
}) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <select
        name={name}
        defaultValue={defaultHeader ?? ""}
        required={required}
        className={FIELD}
      >
        {!required && <option value="">— none —</option>}
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      {help && (
        <span className="mt-0.5 block font-mono text-[10px] text-muted">
          {help}
        </span>
      )}
    </label>
  );
}
