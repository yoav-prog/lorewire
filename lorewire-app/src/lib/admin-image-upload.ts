// Shared validation + key derivation for admin image uploads. Used by
// /api/admin/uploads/image (brand/OG assets picked from a URL field) and
// /api/admin/articles/images (article body + gallery images), plus the
// client-side pickers that pre-check size before POSTing.
//
// Deliberately free of node: imports and "server-only" — the client controls
// import MAX_IMAGE_BYTES and the error-text map, and pulling a node builtin
// through here would drag server code into the client bundle (see
// feedback_use_client_imports_server_only). Hashing lives in the routes.
//
// Plan: _plans/2026-07-05-admin-image-upload-to-r2.md.

/** 4 MB image cap. Vercel Functions reject request bodies over ~4.5 MB; we
 *  leave room for the multipart envelope so a genuine 4 MB image still fits. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/** Magic-byte sniffing — the browser-supplied MIME and filename are advisory;
 *  a hostile (or just confused) client can rename a payload to .png. We
 *  validate the first few bytes against the four formats the admin accepts. */
export function detectImageMime(bytes: Uint8Array): string | null {
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

// ── Upload slots ─────────────────────────────────────────────────────────────
// Closed enum of the admin surfaces that upload an image into a URL field, so
// a tampered client can't write to arbitrary object keys. Brand/OG slots keep
// their original PNG/JPG bytes (no WebP re-encode) because the LinkedIn and
// WhatsApp link crawlers don't render WebP og:image — and GIF is excluded for
// the same reason.

export type AdminImageSlot = "seo-og-default" | "seo-org-logo" | "article-og";

export const ADMIN_IMAGE_SLOTS: readonly AdminImageSlot[] = [
  "seo-og-default",
  "seo-org-logo",
  "article-og",
];

/** Mimes accepted for the URL-field slots (subset of IMAGE_EXT_BY_MIME). */
export const SLOT_ACCEPTED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export function isAdminImageSlot(value: string): value is AdminImageSlot {
  return (ADMIN_IMAGE_SLOTS as readonly string[]).includes(value);
}

export function slotRequiresArticleId(slot: AdminImageSlot): boolean {
  return slot === "article-og";
}

/** Object key for a slot upload. `contentHash` is a hex digest of the bytes —
 *  content-addressed keys bust caches naturally under an immutable
 *  Cache-Control and dedupe identical re-uploads. Throws when the article
 *  slot is missing its id or the extension is unknown, so the route fails
 *  closed instead of writing to a malformed key. */
export function buildSlotKey(
  slot: AdminImageSlot,
  contentHash: string,
  ext: string,
  articleId?: string,
): string {
  if (!/^[0-9a-f]{8,64}$/.test(contentHash)) {
    throw new Error(`bad content hash: ${contentHash.slice(0, 16)}`);
  }
  if (!Object.values(IMAGE_EXT_BY_MIME).includes(ext)) {
    throw new Error(`bad extension: ${ext}`);
  }
  switch (slot) {
    case "seo-og-default":
      return `site/seo/og-default-${contentHash}${ext}`;
    case "seo-org-logo":
      return `site/seo/org-logo-${contentHash}${ext}`;
    case "article-og": {
      if (!articleId) throw new Error("article-og upload requires articleId");
      return `articles/${articleId}/og-${contentHash}${ext}`;
    }
  }
}

/** Plain-words text for the error codes the upload route returns. Shared by
 *  every admin picker so the same failure reads the same everywhere. */
export const UPLOAD_ERROR_TEXT: Record<string, string> = {
  "too-large": "That image is over 4 MB. Resize it and try again.",
  "bad-mime": "That file isn't a PNG, JPG, or WebP image.",
  "not-an-image": "That file isn't a PNG, JPG, or WebP image.",
  "no-file": "No image was selected.",
  "article-not-found": "This article no longer exists — reload the page.",
  "storage-failed": "Upload failed on our side. Try again in a moment.",
};

/** Map a server error code (or transport error) to user-facing text. */
export function uploadErrorText(codeOrMessage: string): string {
  return (
    UPLOAD_ERROR_TEXT[codeOrMessage] ??
    "Upload failed. Check your connection and try again."
  );
}
