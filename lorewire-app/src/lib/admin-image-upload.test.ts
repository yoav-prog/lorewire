// Locks down the pure validation surface behind the admin image uploads
// (/api/admin/uploads/image and /api/admin/articles/images):
//   - detectImageMime: magic-byte sniffing for the four accepted formats,
//     truncated buffers, and garbage — the security gate against a renamed
//     payload, so every branch is pinned here.
//   - the slot registry: closed enum, articleId requirement, and key shapes.
//     buildSlotKey throwing on a bad hash/extension is the fail-closed
//     contract the route relies on to never write a malformed object key.
//   - uploadErrorText: every server error code has plain-words text, and
//     unknown codes fall back instead of leaking internals.
//
// Plan: _plans/2026-07-05-admin-image-upload-to-r2.md.

import { describe, expect, it } from "vitest";
import {
  ADMIN_IMAGE_SLOTS,
  IMAGE_EXT_BY_MIME,
  MAX_IMAGE_BYTES,
  SLOT_ACCEPTED_MIME,
  UPLOAD_ERROR_TEXT,
  buildSlotKey,
  detectImageMime,
  isAdminImageSlot,
  slotRequiresArticleId,
  uploadErrorText,
} from "@/lib/admin-image-upload";

// Minimal valid headers, padded to the 12-byte sniff window.
function bytesOf(head: number[]): Uint8Array {
  const out = new Uint8Array(Math.max(12, head.length));
  out.set(head);
  return out;
}

describe("detectImageMime", () => {
  it("detects JPEG from FF D8 FF", () => {
    expect(detectImageMime(bytesOf([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
  });

  it("detects PNG from its signature", () => {
    expect(
      detectImageMime(bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("image/png");
  });

  it("detects WebP from RIFF....WEBP", () => {
    expect(
      detectImageMime(
        bytesOf([
          0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42,
          0x50,
        ]),
      ),
    ).toBe("image/webp");
  });

  it("detects GIF from GIF8", () => {
    expect(detectImageMime(bytesOf([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe(
      "image/gif",
    );
  });

  it("rejects a RIFF container that is not WEBP (e.g. WAV)", () => {
    expect(
      detectImageMime(
        bytesOf([
          0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56,
          0x45,
        ]),
      ),
    ).toBeNull();
  });

  it("rejects buffers shorter than the 12-byte sniff window", () => {
    expect(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(detectImageMime(new Uint8Array(0))).toBeNull();
  });

  it("rejects garbage bytes", () => {
    expect(detectImageMime(bytesOf([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });
});

describe("slot registry", () => {
  it("accepts exactly the three known slots", () => {
    for (const slot of ADMIN_IMAGE_SLOTS) {
      expect(isAdminImageSlot(slot)).toBe(true);
    }
    expect(isAdminImageSlot("")).toBe(false);
    expect(isAdminImageSlot("avatars")).toBe(false);
    expect(isAdminImageSlot("seo-og-default ")).toBe(false);
  });

  it("only the article slot requires an articleId", () => {
    expect(slotRequiresArticleId("article-og")).toBe(true);
    expect(slotRequiresArticleId("seo-og-default")).toBe(false);
    expect(slotRequiresArticleId("seo-org-logo")).toBe(false);
  });

  it("accepts only non-animated raster formats for the URL-field slots", () => {
    expect(SLOT_ACCEPTED_MIME.has("image/png")).toBe(true);
    expect(SLOT_ACCEPTED_MIME.has("image/jpeg")).toBe(true);
    expect(SLOT_ACCEPTED_MIME.has("image/webp")).toBe(true);
    // GIF is deliberately excluded — social crawlers can't render it as
    // og:image, unlike the article body uploader which accepts it.
    expect(SLOT_ACCEPTED_MIME.has("image/gif")).toBe(false);
    expect(SLOT_ACCEPTED_MIME.has("image/svg+xml")).toBe(false);
  });
});

describe("buildSlotKey", () => {
  const hash = "0123456789abcdef";

  it("builds the site-scoped keys for the SEO slots", () => {
    expect(buildSlotKey("seo-og-default", hash, ".png")).toBe(
      `site/seo/og-default-${hash}.png`,
    );
    expect(buildSlotKey("seo-org-logo", hash, ".jpg")).toBe(
      `site/seo/org-logo-${hash}.jpg`,
    );
  });

  it("builds the article-scoped key and requires articleId", () => {
    expect(buildSlotKey("article-og", hash, ".webp", "art_123")).toBe(
      `articles/art_123/og-${hash}.webp`,
    );
    expect(() => buildSlotKey("article-og", hash, ".png")).toThrow(
      /articleId/,
    );
  });

  it("is deterministic for the same content hash", () => {
    expect(buildSlotKey("seo-og-default", hash, ".png")).toBe(
      buildSlotKey("seo-og-default", hash, ".png"),
    );
  });

  it("fails closed on a malformed hash", () => {
    expect(() => buildSlotKey("seo-og-default", "short", ".png")).toThrow(
      /hash/,
    );
    expect(() =>
      buildSlotKey("seo-og-default", "../escape/attempt", ".png"),
    ).toThrow(/hash/);
    expect(() =>
      buildSlotKey("seo-og-default", "0123456789ABCDEF", ".png"),
    ).toThrow(/hash/);
  });

  it("fails closed on an unknown extension", () => {
    expect(() => buildSlotKey("seo-og-default", hash, ".svg")).toThrow(
      /extension/,
    );
    expect(() => buildSlotKey("seo-og-default", hash, "png")).toThrow(
      /extension/,
    );
  });

  it("accepts every extension the mime map can produce", () => {
    for (const ext of Object.values(IMAGE_EXT_BY_MIME)) {
      expect(buildSlotKey("seo-og-default", hash, ext)).toContain(ext);
    }
  });
});

describe("uploadErrorText", () => {
  it("maps every known server code to plain words", () => {
    for (const code of Object.keys(UPLOAD_ERROR_TEXT)) {
      expect(uploadErrorText(code)).toBe(UPLOAD_ERROR_TEXT[code]);
    }
  });

  it("falls back to a generic message for unknown codes", () => {
    expect(uploadErrorText("HTTP 500")).toMatch(/try again/i);
    expect(uploadErrorText("")).toMatch(/try again/i);
  });
});

describe("MAX_IMAGE_BYTES", () => {
  it("stays under the ~4.5 MB Vercel Function body cap", () => {
    expect(MAX_IMAGE_BYTES).toBe(4 * 1024 * 1024);
  });
});
