// POST /api/admin/segments/finalize
//
// Called by the upload form once the browser's PUT to the GCS session URI
// finishes. Flips the row from `status='pending'` to `status='uploading'`
// so pipeline/segments_worker.py picks it up.
//
// We do NOT verify the bytes landed in GCS here. A HEAD against GCS would
// cost a round trip AND race with eventual consistency, AND the worker is
// the source of truth: if bytes aren't there, ffmpeg fails, the row flips
// to `status='error'` with a clear message and the admin sees it in red.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/dal";
import { getSegment, markSegmentUploading } from "@/lib/repo";

interface FinalizeRequest {
  segId: unknown;
}

export async function POST(req: Request): Promise<NextResponse> {
  await requireAdmin();

  let payload: FinalizeRequest;
  try {
    payload = (await req.json()) as FinalizeRequest;
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  const { segId } = payload;
  if (typeof segId !== "string" || !segId) {
    return NextResponse.json({ error: "missing-segId" }, { status: 400 });
  }

  const row = await getSegment(segId);
  if (!row) {
    return NextResponse.json({ error: "segment-not-found" }, { status: 404 });
  }
  // Idempotent: a second finalize for an already-uploading or already-ready
  // row is a no-op success — saves the client from racing itself on retries.
  if (row.status === "pending") {
    await markSegmentUploading(segId);
    console.info(`[admin segments finalize] flipped pending->uploading segId=${segId}`);
  } else {
    console.info(
      `[admin segments finalize] no-op segId=${segId} status=${row.status}`,
    );
  }

  revalidatePath("/admin/segments");
  return NextResponse.json({ segId, status: "uploading" });
}
