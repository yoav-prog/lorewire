// Repo coverage for the video_segments helpers — covers the new lifecycle
// columns (status, error, uploaded_at) that the upload-fix added and the
// `markSegmentUploading` finalize helper used by /api/admin/segments/finalize.
//
// Runs against SQLite via tests/setup.ts; Postgres-engine parity arrives
// with the broader repo test layer.

import { beforeAll, describe, expect, it } from "vitest";
import {
  upsertSegment,
  getSegment,
  listSegments,
  markSegmentUploading,
  setSegmentEnabled,
  updateSegmentLabel,
  deleteSegment,
} from "@/lib/repo";

// Lazy schema bootstrap so the first insert lands in a live table — see
// tests/repo/articles.test.ts for the rationale.
beforeAll(async () => {
  await listSegments();
});

function makeId(): string {
  // Random 8 bytes -> 16 hex chars, matches lib/segments-upload.ts:newSegmentId.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("segments repo / upsertSegment", () => {
  it("writes the lifecycle columns the sign-upload action sets", async () => {
    const id = makeId();
    await upsertSegment({
      id,
      kind: "intro",
      label: "Brand opener",
      source_url: "https://example.test/source.mp4",
      normalized_url: null,
      duration_ms: null,
      enabled: 0,
      status: "pending",
      error: null,
      uploaded_at: null,
    });
    const row = await getSegment(id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("pending");
    expect(row?.enabled).toBe(0);
    expect(row?.normalized_url).toBeNull();
    expect(row?.uploaded_at).toBeNull();
  });

  it("defaults status to 'ready' when the caller omits it (legacy upsert path)", async () => {
    const id = makeId();
    await upsertSegment({
      id,
      kind: "outro",
      label: "Outro v1",
      source_url: "https://example.test/o.mp4",
      normalized_url: "https://example.test/o.norm.mp4",
      duration_ms: 1500,
      enabled: 1,
    });
    const row = await getSegment(id);
    expect(row?.status).toBe("ready");
  });

  it("overwrites existing rows on id collision (the on-conflict branch)", async () => {
    const id = makeId();
    await upsertSegment({
      id,
      kind: "intro",
      label: "first",
      status: "pending",
    });
    await upsertSegment({
      id,
      kind: "intro",
      label: "second",
      status: "ready",
      normalized_url: "https://example.test/x.mp4",
      duration_ms: 2200,
      enabled: 1,
    });
    const row = await getSegment(id);
    expect(row?.label).toBe("second");
    expect(row?.status).toBe("ready");
    expect(row?.duration_ms).toBe(2200);
  });
});

describe("segments repo / markSegmentUploading", () => {
  it("flips pending -> uploading and stamps uploaded_at", async () => {
    const id = makeId();
    await upsertSegment({
      id,
      kind: "intro",
      status: "pending",
      source_url: "https://example.test/x.mp4",
      enabled: 0,
    });
    await markSegmentUploading(id);
    const row = await getSegment(id);
    expect(row?.status).toBe("uploading");
    expect(row?.uploaded_at).not.toBeNull();
  });

  it("is a no-op when status is not pending — protects against double-finalize", async () => {
    // Without the WHERE status='pending' guard, a second finalize would push
    // `uploading` back over a row the worker had already moved to
    // `normalizing` or `ready` — losing progress and confusing the admin.
    const id = makeId();
    await upsertSegment({
      id,
      kind: "intro",
      status: "ready",
      normalized_url: "https://example.test/x.mp4",
      enabled: 1,
    });
    await markSegmentUploading(id);
    const row = await getSegment(id);
    expect(row?.status).toBe("ready");
  });

  it("is a no-op on a missing id (no-throw, no row created)", async () => {
    await markSegmentUploading("does-not-exist");
    const row = await getSegment("does-not-exist");
    expect(row).toBeNull();
  });
});

describe("segments repo / other lifecycle helpers (regression net)", () => {
  // These existed before the upload-fix; the test guards against the new
  // columns or the on-conflict change breaking the simple update paths the
  // active/enable/rename/delete actions still rely on.
  it("setSegmentEnabled flips the bit without touching status", async () => {
    const id = makeId();
    await upsertSegment({ id, kind: "intro", status: "ready", enabled: 1 });
    await setSegmentEnabled(id, false);
    const row = await getSegment(id);
    expect(row?.enabled).toBe(0);
    expect(row?.status).toBe("ready");
  });

  it("updateSegmentLabel rewrites the label only", async () => {
    const id = makeId();
    await upsertSegment({ id, kind: "intro", label: "old", status: "ready" });
    await updateSegmentLabel(id, "new");
    const row = await getSegment(id);
    expect(row?.label).toBe("new");
    expect(row?.status).toBe("ready");
  });

  it("deleteSegment removes the row outright", async () => {
    const id = makeId();
    await upsertSegment({ id, kind: "intro", status: "ready" });
    await deleteSegment(id);
    expect(await getSegment(id)).toBeNull();
  });
});
