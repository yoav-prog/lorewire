// Tests for the avatar validation + re-encode gate. This is the platform's
// first UGC path, so the security-relevant behavior is pinned hard: magic-byte
// allowlisting (SVG and friends rejected), size cap, and that every accepted
// image comes out as a fresh 512x512 WebP (proving the re-encode ran, which is
// what strips any embedded payload).

import { describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  AvatarValidationError,
  MAX_UPLOAD_BYTES,
  processAvatar,
  sniffImageType,
} from "./avatar-image";

// Pad a magic-byte prefix out to >=12 bytes so the length guard passes.
function withPrefix(prefix: number[]): Uint8Array {
  const out = new Uint8Array(16);
  out.set(prefix);
  return out;
}

describe("sniffImageType", () => {
  it("detects JPEG, PNG, and WebP from magic bytes", () => {
    expect(sniffImageType(withPrefix([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(
      sniffImageType(withPrefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("image/png");
    expect(
      sniffImageType(
        withPrefix([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe("image/webp");
  });

  it("rejects SVG, GIF, and unknown bytes (off the allowlist)", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(sniffImageType(svg)).toBeNull();
    // GIF89a
    expect(sniffImageType(withPrefix([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull();
    expect(sniffImageType(withPrefix([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });

  it("rejects buffers too short to carry a signature", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe("processAvatar", () => {
  it("re-encodes a real PNG into a 512x512 WebP", async () => {
    const png = await sharp({
      create: { width: 40, height: 24, channels: 3, background: { r: 200, g: 30, b: 60 } },
    })
      .png()
      .toBuffer();

    const { webp, contentType } = await processAvatar(new Uint8Array(png));

    expect(contentType).toBe("image/webp");
    // Output really is WebP (the re-encode ran), and square at the target size.
    expect(sniffImageType(new Uint8Array(webp))).toBe("image/webp");
    const meta = await sharp(webp).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });

  it("rejects an empty file", async () => {
    await expect(processAvatar(new Uint8Array(0))).rejects.toBeInstanceOf(
      AvatarValidationError,
    );
  });

  it("rejects an oversize upload before decoding", async () => {
    await expect(
      processAvatar(new Uint8Array(MAX_UPLOAD_BYTES + 1)),
    ).rejects.toBeInstanceOf(AvatarValidationError);
  });

  it("rejects an SVG (the XSS vector) on the magic-byte check", async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    await expect(processAvatar(svg)).rejects.toBeInstanceOf(AvatarValidationError);
  });

  it("rejects bytes that pass the size guard but aren't a decodable image", async () => {
    // Valid PNG magic but garbage body — sniff passes, decode fails.
    const fakePng = withPrefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(processAvatar(fakePng)).rejects.toBeInstanceOf(
      AvatarValidationError,
    );
  });
});
