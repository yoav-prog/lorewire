// POST /api/admin/segments/upload-local
//
// Dev-only fallback for the segment upload flow. Accepts multipart/form-data
// containing the file, runs system ffmpeg to normalize, and writes both the
// source and normalized copies to `lorewire-app/public/segments/`. The row
// lands as `status='ready'` immediately — there's no off-process worker in
// this path because the normalize ran inline.
//
// Why this exists: the prod path (browser -> GCS resumable + pipeline
// worker) requires GCS env vars. Dev iteration on the upload UX shouldn't
// require setting them up. When `GCS_BUCKET` is unset, page.tsx renders
// the form pointing here instead.
//
// Hard guard: refuses to run on Vercel (`process.env.VERCEL === "1"`).
// Writing to public/ at runtime doesn't survive a deploy anyway (Vercel
// snapshots public/ at build time), so this would be quietly broken in
// prod even without the guard — the guard makes the failure loud.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/dal";
import {
  getSegment,
  getSetting,
  setSetting,
  upsertSegment,
} from "@/lib/repo";
import {
  ACCEPTED_MIME,
  MAX_UPLOAD_BYTES,
  extFromFilename,
  isAcceptedKind,
  newSegmentId,
  sanitizeLabel,
} from "@/lib/segments-upload";
import {
  activeSegmentSettingKey,
  isVideoAspect,
  LEGACY_DEFAULT_ASPECT,
  type VideoAspect,
} from "@/lib/aspect";

function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (process.env.VERCEL === "1") {
    // Defense in depth. The page also chooses sign-upload when GCS_BUCKET
    // is set (which it always is in prod), but a stray client call still
    // should not succeed here.
    return NextResponse.json(
      { error: "upload-local-disabled-in-prod" },
      { status: 503 },
    );
  }
  await requireCapability("settings.manage");

  // Late import so the heavy ffmpeg/fs code never enters a function bundle
  // that doesn't actually need it. The web build tree-shakes this out of
  // every page except this route.
  const { normalizeAndPublishLocal } = await import("@/lib/segments-local");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return badRequest("bad-multipart");
  }

  const kind = form.get("kind");
  if (!isAcceptedKind(kind)) return badRequest("bad-kind");

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return badRequest("no-file");
  if (file.size > MAX_UPLOAD_BYTES) return badRequest("too-large");

  const contentType = file.type || "video/mp4";
  if (!ACCEPTED_MIME.has(contentType)) return badRequest("bad-mime");
  const ext = extFromFilename(file.name);
  if (!ext) return badRequest("bad-ext");

  const labelStr =
    typeof form.get("label") === "string"
      ? sanitizeLabel(String(form.get("label")))
      : "";
  const filenameBase =
    file.name.lastIndexOf(".") >= 0
      ? file.name.slice(0, file.name.lastIndexOf("."))
      : file.name;
  const label = labelStr || filenameBase;

  // Phase 4 of _plans/2026-06-12-video-aspect-ratio.md: the upload form
  // picks which canvas shape this segment normalises to. Anything outside
  // the supported pair falls through to the legacy 9:16 default so a
  // malformed client cannot wedge the worker into a bad ffmpeg target.
  const rawAspect = form.get("aspect");
  const aspect: VideoAspect = isVideoAspect(rawAspect)
    ? rawAspect
    : LEGACY_DEFAULT_ASPECT;

  const segId = newSegmentId();
  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    const { sourceUrl, normalizedUrl, durationMs } = await normalizeAndPublishLocal({
      id: segId,
      ext,
      bytes,
      aspect,
    });

    await upsertSegment({
      id: segId,
      kind,
      label,
      source_url: sourceUrl,
      normalized_url: normalizedUrl,
      duration_ms: durationMs,
      enabled: 1,
      status: "ready",
      error: null,
      uploaded_at: new Date().toISOString(),
      aspect,
    });

    // Auto-activate the first segment of its kind AND aspect so the admin
    // doesn't have to click "Set as active" on a fresh install. Keyed per
    // aspect (2026-06-15) so a 9:16 upload doesn't claim the 16:9 slot.
    // Mirrors the pipeline worker's behavior on the prod path.
    const slotKey = activeSegmentSettingKey(kind, aspect);
    const currentActive = (await getSetting(slotKey)) ?? "";
    if (!currentActive) {
      await setSetting(slotKey, segId);
      console.info(
        `[admin segments upload-local] auto-activate kind=${kind} aspect=${aspect} segId=${segId}`,
      );
    }

    console.info(
      `[admin segments upload-local] ok kind=${kind} segId=${segId} size=${file.size} duration_ms=${durationMs}`,
    );
    revalidatePath("/admin/segments");

    // Confirm the row landed before returning — defense against a partial
    // write that the form would otherwise treat as success.
    const row = await getSegment(segId);
    if (!row || row.status !== "ready") {
      return NextResponse.json(
        { error: "row-not-persisted" },
        { status: 500 },
      );
    }
    return NextResponse.json({ segId, status: "ready" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[admin segments upload-local] FAILED kind=${kind} segId=${segId}: ${msg}`,
    );
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
