// POST /api/admin/articles/images
//
// Multipart image upload from the article editor. The browser POSTs a single
// File field plus the target article id; we validate auth + shape + magic
// bytes, upload to GCS via uploadBuffer (server-mediated, suitable for the
// <5 MB images typical in editorial copy), and return the public URL plus a
// stable id the editor stores on the image block.
//
// Why not the resumable browser->GCS pattern segments use? Images are small
// enough to fit in a Vercel Function body (cap is 4.5 MB), and the editor UX
// is much better with one round trip than three. The size cap below is a
// belt-and-braces guard so a stray 10 MB PNG fails fast rather than hitting
// Vercel's limit and returning an opaque 413.

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { requireCapability } from "@/lib/dal";
import { getArticle } from "@/lib/repo";
import { uploadBuffer } from "@/lib/gcs";
import {
  IMAGE_EXT_BY_MIME,
  MAX_IMAGE_BYTES,
  detectImageMime,
} from "@/lib/admin-image-upload";

// Body/gallery images accept GIF on top of the raster trio — animated GIFs
// are legitimate editorial content, unlike the OG/logo slots where the
// social crawlers can't render them.
const ACCEPTED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(req: Request): Promise<NextResponse> {
  await requireCapability("content.manage");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return badRequest("bad-multipart");
  }

  const articleId = String(form.get("articleId") ?? "");
  if (!articleId) return badRequest("missing-articleId");

  // Confirm the target article exists before we burn GCS bandwidth. The image
  // block on the editor side carries this through to save, so a bogus id here
  // would create an orphan object the writer could never use.
  const article = await getArticle(articleId);
  if (!article) {
    return NextResponse.json({ error: "article-not-found" }, { status: 404 });
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return badRequest("no-file");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return badRequest("too-large");
  }
  // Browser MIME is advisory; we sniff the real bytes below. We do reject
  // here on advisory mismatch so an obviously-wrong upload fails before we
  // allocate the buffer.
  const advisoryMime = file.type || "";
  if (advisoryMime && !ACCEPTED_MIME.has(advisoryMime)) {
    return badRequest("bad-mime");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detectedMime = detectImageMime(bytes);
  if (!detectedMime) return badRequest("not-an-image");

  const ext = IMAGE_EXT_BY_MIME[detectedMime];
  const imageId = randomBytes(6).toString("hex");
  const key = `articles/${articleId}/img-${imageId}${ext}`;

  let url: string;
  try {
    url = await uploadBuffer(bytes, key, detectedMime);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[articles upload] gcs FAILED articleId=${articleId} imageId=${imageId}: ${msg}`,
    );
    return NextResponse.json({ error: "gcs-failed" }, { status: 503 });
  }

  console.info("[articles upload] ok", {
    articleId,
    imageId,
    bytes: bytes.byteLength,
    mime: detectedMime,
  });

  return NextResponse.json({
    imageId,
    url,
    width: null,
    height: null,
  });
}
