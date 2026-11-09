// POST /api/admin/uploads/image
//
// Multipart image upload for the admin's URL-based image fields (SEO default
// OG image, organization logo, per-article OG override). The browser POSTs a
// File plus a `slot` from the closed AdminImageSlot enum; we validate auth +
// size + magic bytes, store the ORIGINAL bytes (no WebP re-encode — social
// crawlers like LinkedIn and WhatsApp don't render WebP og:image), and return
// the public URL for the field.
//
// Storage goes through lib/gcs uploadBuffer, which writes to R2 (media bucket,
// MEDIA_PUBLIC_BASE URL, immutable cache) when the R2 media cutover is active
// — which it is in production — and falls back to GCS otherwise. Keys are
// content-addressed so a replaced image busts caches under the immutable
// Cache-Control and identical re-uploads dedupe.
//
// Plan: _plans/2026-07-05-admin-image-upload-to-r2.md.

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireCapability } from "@/lib/dal";
import { getArticle } from "@/lib/repo";
import { uploadBuffer } from "@/lib/gcs";
import {
  IMAGE_EXT_BY_MIME,
  MAX_IMAGE_BYTES,
  SLOT_ACCEPTED_MIME,
  buildSlotKey,
  detectImageMime,
  isAdminImageSlot,
  slotRequiresArticleId,
} from "@/lib/admin-image-upload";

export const runtime = "nodejs";

function badRequest(error: string, status = 400): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: Request): Promise<NextResponse> {
  await requireCapability("content.manage");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return badRequest("bad-multipart");
  }

  const slot = String(form.get("slot") ?? "");
  if (!isAdminImageSlot(slot)) {
    console.warn("[admin image-upload] reject bad slot", {
      slot: slot.slice(0, 32),
    });
    return badRequest("bad-slot");
  }

  // The article slot writes under articles/<id>/ — confirm the target exists
  // before we burn storage bandwidth, mirroring the article body uploader.
  const articleId = String(form.get("articleId") ?? "");
  if (slotRequiresArticleId(slot)) {
    if (!articleId) return badRequest("missing-articleId");
    const article = await getArticle(articleId);
    if (!article) return badRequest("article-not-found", 404);
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return badRequest("no-file");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return badRequest("too-large", 413);
  }
  // Browser MIME is advisory; we sniff the real bytes below. We do reject
  // here on advisory mismatch so an obviously-wrong upload fails before we
  // allocate the buffer.
  const advisoryMime = file.type || "";
  if (advisoryMime && !SLOT_ACCEPTED_MIME.has(advisoryMime)) {
    return badRequest("bad-mime");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detectedMime = detectImageMime(bytes);
  if (!detectedMime || !SLOT_ACCEPTED_MIME.has(detectedMime)) {
    return badRequest("not-an-image");
  }

  const contentHash = createHash("sha256")
    .update(bytes)
    .digest("hex")
    .slice(0, 16);
  const key = buildSlotKey(
    slot,
    contentHash,
    IMAGE_EXT_BY_MIME[detectedMime],
    articleId || undefined,
  );

  let url: string;
  try {
    // compress: false — these bytes feed og:image / logo tags, which must
    // stay in the format the admin uploaded (see route header).
    url = await uploadBuffer(bytes, key, detectedMime, { compress: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[admin image-upload] store FAILED", { slot, key, msg });
    return NextResponse.json({ error: "storage-failed" }, { status: 503 });
  }

  console.info("[admin image-upload] ok", {
    slot,
    key,
    bytes: bytes.byteLength,
    mime: detectedMime,
  });

  return NextResponse.json({ url });
}
