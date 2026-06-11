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
import { requireAdmin } from "@/lib/dal";
import { getArticle } from "@/lib/repo";
import { uploadBuffer } from "@/lib/gcs";

// 4 MB image cap. Vercel Functions reject request bodies over ~4.5 MB; we
// leave room for the multipart envelope so a genuine 4 MB image still fits.
// For anything larger, the editor would need to switch to the resumable
// browser->GCS flow the segments uploader uses — out of scope for Phase 2.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const ACCEPTED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

// Magic-byte sniffing — the browser-supplied MIME and filename are advisory;
// a hostile (or just confused) client can rename a payload to .png. We
// validate the first few bytes against the four formats we accept.
function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  // WEBP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  // GIF: 47 49 46 38 (followed by 37 or 39)
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  return null;
}

function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(req: Request): Promise<NextResponse> {
  await requireAdmin();

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

  const ext = EXT_BY_MIME[detectedMime];
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
