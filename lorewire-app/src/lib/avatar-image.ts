// Validate + re-encode an uploaded avatar into a safe WebP. This is the
// security gate for the platform's first user-generated content: re-encoding
// every upload through libvips (sharp) is what strips any embedded payload,
// EXIF, or script — the output is freshly-rendered pixels, never the bytes the
// user sent. We allowlist by MAGIC BYTES (not the declared Content-Type) so a
// renamed file or a spoofed type can't slip through, and we NEVER accept SVG
// (an XSS vector). Decompression-bomb defense is sharp's limitInputPixels,
// which rejects images whose header claims more than MAX_INPUT_PIXELS before
// the full decode runs.
//
// Plan: _plans/2026-06-22-r2-media-migration-and-avatar-upload.md.

import "server-only";
import sharp from "sharp";

/** Max accepted upload size. Kept under Vercel's ~4.5 MB function body cap so
 *  the avatar POSTs straight through the route without a presigned detour. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Reject anything whose header claims more than this many pixels — a tiny file
 *  can still claim huge dimensions (the bomb). 8000x8000 is far above any real
 *  avatar yet bounds decode work. */
const MAX_INPUT_PIXELS = 8000 * 8000;

/** Output is a square; avatars render small, 512 is crisp on retina without
 *  bloating storage. */
const OUTPUT_SIZE = 512;
const WEBP_QUALITY = 82;

/** Thrown for user-correctable problems (wrong type, too big, unreadable). The
 *  message is safe to show the user verbatim. */
export class AvatarValidationError extends Error {}

type AllowedType = "image/jpeg" | "image/png" | "image/webp";

/** Sniff the real image type from magic bytes. Returns null for anything off
 *  the allowlist — which inherently rejects SVG, GIF, BMP, and spoofed types. */
export function sniffImageType(bytes: Uint8Array): AllowedType | null {
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
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // WebP: "RIFF" <4 bytes size> "WEBP"
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
  return null;
}

export interface ProcessedAvatar {
  webp: Buffer;
  contentType: "image/webp";
}

/** Validate size + magic bytes, then re-encode to a square, metadata-stripped
 *  WebP. Throws AvatarValidationError (user-safe message) on bad input. */
export async function processAvatar(bytes: Uint8Array): Promise<ProcessedAvatar> {
  if (bytes.length === 0) throw new AvatarValidationError("That file is empty.");
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new AvatarValidationError("That image is too large. Max 4 MB.");
  }
  if (!sniffImageType(bytes)) {
    throw new AvatarValidationError("Please upload a JPG, PNG, or WebP image.");
  }
  try {
    const webp = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      // Bake EXIF orientation into the pixels; the WebP re-encode then drops all
      // metadata. `animated` defaults to false, so only the first frame decodes.
      .rotate()
      .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "cover", position: "centre" })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    return { webp, contentType: "image/webp" };
  } catch {
    // A failure here means the bytes weren't a real, in-limits image (corrupt,
    // over the pixel cap, or mislabeled past the magic-byte check). Surface a
    // safe message; the route logs the underlying error.
    throw new AvatarValidationError(
      "That image couldn't be processed. Try a different JPG, PNG, or WebP.",
    );
  }
}
