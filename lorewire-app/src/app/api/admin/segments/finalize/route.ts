// POST /api/admin/segments/finalize
//
// Called by the upload form after the browser's PUT(s) to the GCS session
// URI complete — OR after they fail. The client cannot trust its own PUT
// result because GCS does not include `Access-Control-Allow-Origin` on the
// PUT response (it sends it on the OPTIONS preflight only), so Chrome
// rejects the 200 OK response as a CORS violation and `fetch` throws
// "Failed to fetch" even though the bytes are in GCS.
//
// To work around that, we always HEAD the source_url here — GCS is the
// source of truth. If bytes are present, flip pending->uploading so the
// pipeline worker picks the row up. If not, flip pending->error with a
// clear message. Either way, the admin sees an accurate state immediately
// instead of a row that spins for 5 minutes before the abandoned-sweep.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/dal";
import { getSegment, markSegmentUploading, setSegmentError } from "@/lib/repo";

interface FinalizeRequest {
  segId: unknown;
  // Optional hint from the client about whether its own PUT(s) appeared to
  // succeed. Purely informational — we never trust it; the GCS HEAD below
  // is authoritative. Logged so we can correlate JS-reported failures with
  // server-confirmed successes.
  clientReportedOk?: unknown;
}

async function gcsSourcePresent(url: string): Promise<{ ok: boolean; size: number }> {
  // GCS public-read objects respond to HEAD without any auth header. We use
  // a short timeout so the route stays under Vercel's function budget.
  try {
    const resp = await fetch(url, { method: "HEAD" });
    const size = Number(resp.headers.get("content-length") ?? "0");
    return { ok: resp.ok, size };
  } catch {
    return { ok: false, size: 0 };
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  await requireAdmin();

  let payload: FinalizeRequest;
  try {
    payload = (await req.json()) as FinalizeRequest;
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  const { segId, clientReportedOk } = payload;
  if (typeof segId !== "string" || !segId) {
    return NextResponse.json({ error: "missing-segId" }, { status: 400 });
  }

  const row = await getSegment(segId);
  if (!row) {
    return NextResponse.json({ error: "segment-not-found" }, { status: 404 });
  }
  // Idempotent: a second finalize for an already-uploading / normalizing /
  // ready / error row is a no-op success. Saves the client from racing on
  // retries and means an admin who re-clicks Upload won't double-process.
  if (row.status !== "pending") {
    console.info(
      `[admin segments finalize] no-op segId=${segId} status=${row.status}`,
    );
    return NextResponse.json({ segId, status: row.status });
  }
  if (!row.source_url) {
    // Programmer error — sign-upload always writes a source_url. Treat as
    // unrecoverable so the row doesn't sit in `pending` forever.
    await setSegmentError(segId, "row has no source_url");
    return NextResponse.json({ segId, status: "error", error: "no-source-url" }, { status: 500 });
  }

  const head = await gcsSourcePresent(row.source_url);
  console.info(
    `[admin segments finalize] segId=${segId} clientReportedOk=${clientReportedOk} gcsBytes=${head.ok ? head.size : "missing"}`,
  );

  if (head.ok && head.size > 0) {
    await markSegmentUploading(segId);
    revalidatePath("/admin/segments");
    return NextResponse.json({ segId, status: "uploading" });
  }

  // No bytes in GCS — the upload genuinely failed. Mark immediately so the
  // admin sees a red chip instead of waiting 5 minutes for the sweeper.
  await setSegmentError(
    segId,
    "no bytes in GCS — upload did not reach the bucket",
  );
  revalidatePath("/admin/segments");
  return NextResponse.json(
    { segId, status: "error", error: "no-bytes-in-gcs" },
    { status: 502 },
  );
}
