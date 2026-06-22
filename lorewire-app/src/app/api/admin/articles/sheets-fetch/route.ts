// POST /api/admin/articles/sheets-fetch
//
// Powers the in-editor SheetsRef block. The NodeView posts a sheet URL +
// optional range, this route resolves to the underlying sheet via the same
// Sheets helper the bootstrap import uses, reads the chosen tab, and
// returns header + rows so the writer sees the data inline. Read-only;
// hardcoded scope; no writes.
//
// The response shape mirrors what the NodeView stores on the node's
// attributes — the writer can refresh at any time and the block updates
// in place.

import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/dal";
import {
  isConfigured as isSheetsConfigured,
  listTabs,
  parseSheetRef,
  readRows,
} from "@/lib/sheets";

interface FetchRequest {
  sheetUrl?: unknown;
  tab?: unknown;
  limit?: unknown;
}

interface RowObject {
  [header: string]: string;
}

function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(req: Request): Promise<NextResponse> {
  await requireCapability("content.manage");
  if (!isSheetsConfigured()) {
    return NextResponse.json(
      { error: "sheets-not-configured" },
      { status: 503 },
    );
  }
  let body: FetchRequest;
  try {
    body = (await req.json()) as FetchRequest;
  } catch {
    return badRequest("bad-json");
  }
  const sheetUrl = typeof body.sheetUrl === "string" ? body.sheetUrl : "";
  const ref = parseSheetRef(sheetUrl);
  if (!ref) return badRequest("bad-url");

  const limit = Math.max(
    1,
    Math.min(
      200,
      typeof body.limit === "number" && Number.isFinite(body.limit)
        ? Math.trunc(body.limit)
        : 50,
    ),
  );

  let tabIdentifier: string | number;
  const tabFromBody = typeof body.tab === "string" ? body.tab.trim() : "";
  if (tabFromBody) {
    tabIdentifier = tabFromBody;
  } else if (ref.gid !== null) {
    tabIdentifier = ref.gid;
  } else {
    // No explicit tab and no gid in the URL — fall back to the first tab so
    // a writer who pastes a bare spreadsheet ID still sees something.
    try {
      const info = await listTabs(ref.spreadsheetId);
      if (info.tabs.length === 0) {
        return NextResponse.json(
          { error: "no-tabs" },
          { status: 404 },
        );
      }
      tabIdentifier = info.tabs[0].title;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[articles sheets-ref] list-tabs FAILED:", msg);
      return NextResponse.json(
        { error: "sheets-read-failed" },
        { status: 503 },
      );
    }
  }

  let sheet;
  try {
    sheet = await readRows(ref.spreadsheetId, tabIdentifier, { limit });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[articles sheets-ref] read FAILED:", msg);
    return NextResponse.json(
      { error: "sheets-read-failed" },
      { status: 503 },
    );
  }

  const rows: RowObject[] = sheet.rows.map((row) => {
    const obj: RowObject = {};
    sheet.headers.forEach((header, idx) => {
      obj[header] = row[idx] ?? "";
    });
    return obj;
  });

  console.info("[articles sheets-ref] fetch ok", {
    spreadsheetId: ref.spreadsheetId,
    tab: typeof tabIdentifier === "string" ? tabIdentifier : `gid:${tabIdentifier}`,
    headerCount: sheet.headers.length,
    rowCount: rows.length,
  });

  return NextResponse.json({
    spreadsheetId: ref.spreadsheetId,
    tab: typeof tabIdentifier === "string" ? tabIdentifier : String(tabIdentifier),
    headers: sheet.headers,
    rows,
    fetchedAt: new Date().toISOString(),
  });
}
