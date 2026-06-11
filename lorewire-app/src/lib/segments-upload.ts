// Shared upload validators for the segment library — pure, no I/O, no ffmpeg.
// Used by /api/admin/segments/sign-upload to vet a request shape before we
// initiate the GCS resumable session, and by the segments admin server
// action helpers (sanitizeLabel) that the rename / delete actions still use.

import { randomBytes } from "node:crypto";

// 500 MB hard ceiling. Matches the plan; larger uploads are almost certainly
// a misclick (intros are typically 5-30 MB). Enforced server-side in the
// sign-upload route so the client can't lie its way past it.
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

// MIME and extension allow-lists. Both must pass — the browser-supplied MIME
// is advisory; the ext we keep so the GCS object name stays meaningful when
// pipeline/segments_worker.py downloads it.
export const ACCEPTED_MIME = new Set(["video/mp4", "video/quicktime"]);
export const ACCEPTED_EXT = new Set([".mp4", ".mov"]);

export type SegmentExt = ".mp4" | ".mov";

export function isAcceptedKind(kind: unknown): kind is "intro" | "outro" {
  return kind === "intro" || kind === "outro";
}

export function extFromFilename(filename: string): SegmentExt | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filename.slice(dot).toLowerCase();
  if (ext === ".mp4" || ext === ".mov") return ext;
  return null;
}

export function newSegmentId(): string {
  // 16 random hex chars — short enough to type, long enough that collisions
  // are not a concern at our scale (admins upload a handful of intros total).
  return randomBytes(8).toString("hex");
}

export function sanitizeLabel(raw: string): string {
  // Drop ASCII control bytes (and DEL) so an accidental newline or escape
  // can't smuggle markup. Hebrew, emoji, punctuation are fine — labels
  // render as text, not HTML.
  let cleaned = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 32 || code === 127) continue;
    cleaned += raw[i];
  }
  return cleaned.trim().slice(0, 80);
}
