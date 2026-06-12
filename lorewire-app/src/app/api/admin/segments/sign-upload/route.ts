// POST /api/admin/segments/sign-upload
//
// Initiates a direct-to-GCS resumable upload for the segment library. The
// browser sends a tiny JSON request (≤1 KB), the route checks auth + shape,
// inserts a `status='pending'` row in video_segments, asks GCS for a session
// URI, and hands the URI back. The browser then PUTs the video bytes
// straight to GCS without ever touching this function — that's the whole
// point: Vercel Functions cap request bodies at 4.5 MB; video segments are
// 5–500 MB.
//
// Once the browser confirms the PUT finished, it calls
// /api/admin/segments/finalize which flips the row to `uploading` so
// pipeline/segments_worker.py picks it up for ffmpeg normalize.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/dal";
import { createResumableUploadSession } from "@/lib/gcs";
import { upsertSegment } from "@/lib/repo";
import {
  ACCEPTED_MIME,
  MAX_UPLOAD_BYTES,
  extFromFilename,
  isAcceptedKind,
  newSegmentId,
  sanitizeLabel,
} from "@/lib/segments-upload";
import { isVideoAspect, LEGACY_DEFAULT_ASPECT, type VideoAspect } from "@/lib/aspect";

interface SignUploadRequest {
  kind: unknown;
  label: unknown;
  filename: unknown;
  size: unknown;
  contentType: unknown;
  aspect: unknown;
}

function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(req: Request): Promise<NextResponse> {
  await requireAdmin();

  let payload: SignUploadRequest;
  try {
    payload = (await req.json()) as SignUploadRequest;
  } catch {
    return badRequest("bad-json");
  }
  const { kind, label, filename, size, contentType, aspect: rawAspect } =
    payload;

  if (!isAcceptedKind(kind)) return badRequest("bad-kind");
  // Phase 4 of _plans/2026-06-12-video-aspect-ratio.md: validate at the
  // boundary. A tampered client that posts an unsupported aspect falls
  // back to the legacy default rather than the request failing — the
  // worker's normalize would also reject the bad value at render time,
  // but rejecting here keeps the row clean.
  const aspect: VideoAspect = isVideoAspect(rawAspect)
    ? rawAspect
    : LEGACY_DEFAULT_ASPECT;
  if (typeof filename !== "string" || !filename) return badRequest("bad-filename");
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return badRequest("bad-size");
  }
  if (size > MAX_UPLOAD_BYTES) return badRequest("too-large");
  if (typeof contentType !== "string" || !ACCEPTED_MIME.has(contentType)) {
    return badRequest("bad-mime");
  }
  const ext = extFromFilename(filename);
  if (!ext) return badRequest("bad-ext");

  const labelStr =
    typeof label === "string" ? sanitizeLabel(label) : "";
  const segId = newSegmentId();
  const sourceKey = `segments/${segId}.source${ext}`;

  let session;
  try {
    session = await createResumableUploadSession(sourceKey, contentType);
  } catch (e) {
    console.error(
      `[admin segments sign-upload] gcs init FAILED segId=${segId}:`,
      e,
    );
    return NextResponse.json({ error: "gcs-init-failed" }, { status: 503 });
  }

  // Row goes in with `status='pending'` and `enabled=0` so it shows up in the
  // admin list immediately ("Processing…" chip) but cannot be set active
  // until the worker flips it to `ready`. We persist `source_url` now so the
  // worker knows where to download the source bytes from once finalize fires.
  await upsertSegment({
    id: segId,
    kind,
    label: labelStr ||
      (filename.lastIndexOf(".") >= 0
        ? filename.slice(0, filename.lastIndexOf("."))
        : filename),
    source_url: session.publicUrl,
    normalized_url: null,
    duration_ms: null,
    enabled: 0,
    status: "pending",
    error: null,
    uploaded_at: null,
    aspect,
  });

  console.info(
    `[admin segments sign-upload] ok kind=${kind} segId=${segId} size=${size} contentType=${contentType} aspect=${aspect}`,
  );

  return NextResponse.json({
    segId,
    sessionUri: session.sessionUri,
    sourceUrl: session.publicUrl,
  });
}
