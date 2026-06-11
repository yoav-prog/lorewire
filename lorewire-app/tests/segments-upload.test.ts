// Pure-helper coverage for lib/segments-upload — no DB, no network. The
// route handlers that build on these are exercised in
// tests/repo/segments.test.ts (repo writes) and via the QA pass for the
// network-touching surfaces (Vitest doesn't ship a clean route-handler
// driver and the auth + GCS mocks dwarf the actual logic).

import { describe, expect, it } from "vitest";
import {
  ACCEPTED_EXT,
  ACCEPTED_MIME,
  MAX_UPLOAD_BYTES,
  extFromFilename,
  isAcceptedKind,
  newSegmentId,
  sanitizeLabel,
} from "@/lib/segments-upload";

describe("segments-upload / constants", () => {
  it("MAX_UPLOAD_BYTES is 500 MB so the sign-upload contract matches the form", () => {
    // The form (SegmentUploadForm.tsx) and the route handler both compare
    // against this number; a divergence would mean the client lies past the
    // server limit or vice versa. Locking the value here is the simplest
    // way to keep the two ends honest.
    expect(MAX_UPLOAD_BYTES).toBe(500 * 1024 * 1024);
  });

  it("MIME allow-list is exactly mp4 + quicktime", () => {
    expect([...ACCEPTED_MIME].sort()).toEqual(["video/mp4", "video/quicktime"]);
  });

  it("extension allow-list is exactly .mp4 + .mov", () => {
    expect([...ACCEPTED_EXT].sort()).toEqual([".mov", ".mp4"]);
  });
});

describe("segments-upload / isAcceptedKind", () => {
  it("accepts 'intro' and 'outro'", () => {
    expect(isAcceptedKind("intro")).toBe(true);
    expect(isAcceptedKind("outro")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isAcceptedKind("INTRO")).toBe(false);
    expect(isAcceptedKind("middle")).toBe(false);
    expect(isAcceptedKind("")).toBe(false);
    expect(isAcceptedKind(null)).toBe(false);
    expect(isAcceptedKind(undefined)).toBe(false);
    expect(isAcceptedKind(42)).toBe(false);
  });
});

describe("segments-upload / extFromFilename", () => {
  it("returns the lowercase extension when present and allowed", () => {
    expect(extFromFilename("brand.mp4")).toBe(".mp4");
    expect(extFromFilename("Brand.MOV")).toBe(".mov");
    expect(extFromFilename("path/to/brand.mp4")).toBe(".mp4");
  });

  it("returns null when there is no dot", () => {
    expect(extFromFilename("noext")).toBeNull();
  });

  it("returns null for disallowed extensions", () => {
    expect(extFromFilename("brand.avi")).toBeNull();
    expect(extFromFilename("brand.webm")).toBeNull();
    expect(extFromFilename("brand.mkv")).toBeNull();
  });
});

describe("segments-upload / sanitizeLabel", () => {
  it("strips ASCII control bytes", () => {
    expect(sanitizeLabel("Brand\nopener\t")).toBe("Brandopener");
    expect(sanitizeLabel("ok\x07bye")).toBe("okbye");
  });

  it("preserves Hebrew, emoji, and punctuation", () => {
    expect(sanitizeLabel("פתיח של המותג 🎬!")).toBe("פתיח של המותג 🎬!");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeLabel("   hello   ")).toBe("hello");
  });

  it("clamps to 80 chars to bound DB storage", () => {
    const long = "a".repeat(200);
    expect(sanitizeLabel(long)).toHaveLength(80);
  });

  it("strips DEL (0x7f)", () => {
    expect(sanitizeLabel("a\x7fb")).toBe("ab");
  });
});

describe("segments-upload / newSegmentId", () => {
  it("returns a 16-char hex string", () => {
    const id = newSegmentId();
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });

  it("returns distinct ids across calls", () => {
    // Birthday-paradox-grade smoke check; 64 bits of entropy means a
    // collision in 5 ids would imply a generator bug, not bad luck.
    const ids = new Set([
      newSegmentId(),
      newSegmentId(),
      newSegmentId(),
      newSegmentId(),
      newSegmentId(),
    ]);
    expect(ids.size).toBe(5);
  });
});
