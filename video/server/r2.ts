// Minimal R2 client for the Cloud Run render service. Mirrors the shape of
// `lorewire-app/src/lib/r2.ts` (the canonical writer) — same env names, same
// flag semantics, same path-style object URLs — but trimmed to just the bits
// Cloud Run needs: an `is active?` guard, a `mediaBucket()` accessor, and a
// `putR2Object` that uploads bytes with the right Content-Length headers.
//
// Plan: _plans/2026-06-23-pipeline-outbound-url-rewriter.md. Until the
// R2_MEDIA_WRITE_ENABLED flag flips, this module is dormant — render.ts
// only calls it when isR2MediaActive() returns true. With the flag flipped
// (plus R2 credentials + MEDIA_PUBLIC_BASE on the Cloud Run env), the
// rendered MP4 lands on R2 instead of GCS so the Next reader's host
// rewrite resolves to a real object.

import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";

function endpoint(): string {
  const explicit = process.env.R2_ENDPOINT?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const account = process.env.R2_ACCOUNT_ID?.trim();
  if (!account) {
    throw new Error("R2 is not configured: set R2_ACCOUNT_ID or R2_ENDPOINT.");
  }
  return `https://${account}.r2.cloudflarestorage.com`;
}

/** True when the credentials + an endpoint source are all present. */
export function isR2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      (process.env.R2_ACCOUNT_ID || process.env.R2_ENDPOINT),
  );
}

/** True when R2 is the ACTIVE media target: fully configured, MEDIA_PUBLIC_BASE
 *  set, and the explicit R2_MEDIA_WRITE_ENABLED cutover flag on. Mirrors the
 *  same gate in `lorewire-app/src/lib/r2.ts:isR2MediaActive` AND
 *  `pipeline/gcs.py:_r2_configured` so all three writers (Node, Python, Cloud
 *  Run) flip together. */
export function isR2MediaActive(): boolean {
  const flag = (process.env.R2_MEDIA_WRITE_ENABLED ?? "").trim().toLowerCase();
  if (!["1", "true", "yes", "on"].includes(flag)) return false;
  return (
    isR2Configured() &&
    Boolean(process.env.R2_MEDIA_BUCKET) &&
    Boolean(process.env.MEDIA_PUBLIC_BASE)
  );
}

/** The media bucket name. Throws if unset. */
export function mediaBucket(): string {
  const b = process.env.R2_MEDIA_BUCKET?.trim();
  if (!b) throw new Error("R2_MEDIA_BUCKET is not set.");
  return b;
}

/** The configured delivery base with any trailing slash removed. Throws if
 *  unset — when the writer is active the base MUST be set so the upload
 *  result has a valid public URL to return. */
export function mediaPublicBase(): string {
  const raw = process.env.MEDIA_PUBLIC_BASE?.trim();
  if (!raw) throw new Error("MEDIA_PUBLIC_BASE is not set.");
  return raw.replace(/\/+$/, "");
}

let cachedClient: AwsClient | undefined;

function client(): AwsClient {
  if (cachedClient) return cachedClient;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 is not configured: set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.",
    );
  }
  // region 'auto' + service 's3' is the R2 contract for SigV4.
  cachedClient = new AwsClient({
    accessKeyId,
    secretAccessKey,
    region: "auto",
    service: "s3",
  });
  return cachedClient;
}

// Path-style object URL: <endpoint>/<bucket>/<key>. Each key segment is
// percent-encoded but slash separators are preserved (matches r2.ts in the
// Next app exactly).
function objectUrl(bucket: string, key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${endpoint()}/${encodeURIComponent(bucket)}/${encodedKey}`;
}

export interface PutObjectOpts {
  contentType: string;
  cacheControl?: string;
}

/** PUT bytes to an R2 object. Throws on any non-2xx so the caller can fail
 *  the render row. */
export async function putR2Object(
  bucket: string,
  key: string,
  body: Uint8Array,
  opts: PutObjectOpts,
): Promise<void> {
  // Send a Blob with an explicit Content-Length header. R2 rejects bare
  // ArrayBuffer / Uint8Array bodies under some fetch implementations with
  // "411 MissingContentLength" — the Blob + explicit header pattern is
  // what `lorewire-app/src/lib/r2.ts:putR2Object` already uses in
  // production.
  const ab = new ArrayBuffer(body.byteLength);
  new Uint8Array(ab).set(body);
  const sha256 = createHash("sha256").update(new Uint8Array(ab)).digest("hex");
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType,
    "Content-Length": String(ab.byteLength),
    "x-amz-content-sha256": sha256,
  };
  if (opts.cacheControl) headers["Cache-Control"] = opts.cacheControl;
  const resp = await client().fetch(objectUrl(bucket, key), {
    method: "PUT",
    headers,
    body: new Blob([ab]),
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`R2 put HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
}

/** Build the public delivery URL for an R2 object key: <MEDIA_PUBLIC_BASE>/<key>. */
export function publicMediaUrl(key: string): string {
  return `${mediaPublicBase()}/${key}`;
}

// Test-only reset of the cached client. Production callers never need this.
export function __resetR2ClientForTests(): void {
  cachedClient = undefined;
}
