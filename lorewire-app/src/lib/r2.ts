// Cloudflare R2 client (S3 API) for the Next app. Mirrors lib/gcs.ts in shape —
// an `is configured?` guard plus a thin put/delete surface — but talks to R2
// over its S3-compatible API using aws4fetch (SigV4 signing over the global
// fetch) instead of the GCS JSON API. Reused by the avatar upload route
// (Phase 2) and the media uploader swap (Phase 3).
//
// Credentials come from R2_* env, never code: R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY, and either R2_ACCOUNT_ID (endpoint derived as
// https://<account_id>.r2.cloudflarestorage.com) or an explicit R2_ENDPOINT.
// Bucket names come from R2_MEDIA_BUCKET / R2_USERCONTENT_BUCKET /
// R2_INGEST_BUCKET. The token should be scoped Object Read & Write to those
// buckets only (least privilege).
//
// Plan: _plans/2026-06-22-r2-media-migration-and-avatar-upload.md.

import "server-only";
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

declare global {
  // Cached across dev HMR reloads — the signer holds only the static
  // credentials, so re-constructing it per request is wasteful.
  var __lwR2Client: AwsClient | undefined;
}

function client(): AwsClient {
  if (globalThis.__lwR2Client) return globalThis.__lwR2Client;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 is not configured: set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.",
    );
  }
  // region 'auto' + service 's3' is the R2 contract for SigV4.
  const c = new AwsClient({
    accessKeyId,
    secretAccessKey,
    region: "auto",
    service: "s3",
  });
  globalThis.__lwR2Client = c;
  return c;
}

// Path-style object URL: <endpoint>/<bucket>/<key>. Each key segment is
// percent-encoded but the slash separators are preserved (object names commonly
// contain slashes, e.g. `avatars/<id>.webp`).
function objectUrl(bucket: string, key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${endpoint()}/${encodeURIComponent(bucket)}/${encodedKey}`;
}

export interface PutObjectOpts {
  contentType: string;
  /** Cache-Control stored on the object. The edge cache + a long immutable
   *  header are what keep R2 delivery cheap (see the migration plan). */
  cacheControl?: string;
}

/** PUT an object. Throws on any non-2xx so callers can fail closed. */
export async function putR2Object(
  bucket: string,
  key: string,
  body: Uint8Array | ArrayBuffer | string,
  opts: PutObjectOpts,
): Promise<void> {
  // Send a Blob with an explicit Content-Length header — the pattern lib/gcs.ts
  // already uses in production. Under Next's patched fetch a bare ArrayBuffer /
  // Uint8Array body gets NO Content-Length, and R2 rejects that with
  // "411 MissingContentLength". The precomputed payload hash lets aws4fetch
  // sign without re-reading the body.
  const src =
    typeof body === "string"
      ? new TextEncoder().encode(body)
      : body instanceof Uint8Array
        ? body
        : new Uint8Array(body);
  const ab = new ArrayBuffer(src.byteLength);
  new Uint8Array(ab).set(src);
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
    // Fail a stalled upload fast so a batch can't hang forever.
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`R2 put HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
}

/** DELETE an object. Treats 404 as a no-op so callers can reap "expected" keys
 *  without racing concurrent deletes. Throws on anything else. */
export async function deleteR2Object(bucket: string, key: string): Promise<void> {
  const resp = await client().fetch(objectUrl(bucket, key), { method: "DELETE" });
  if (resp.status === 204 || resp.status === 200 || resp.status === 404) return;
  const text = await resp.text().catch(() => "");
  throw new Error(`R2 delete HTTP ${resp.status}: ${text.slice(0, 200)}`);
}

/** HEAD an object: returns its size in bytes, or null if it does not exist.
 *  Used by the migration tool to skip objects already copied (size match) and
 *  to verify an upload landed at the right size. */
export async function headR2Object(
  bucket: string,
  key: string,
): Promise<number | null> {
  const resp = await client().fetch(objectUrl(bucket, key), {
    method: "HEAD",
    signal: AbortSignal.timeout(20_000),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`R2 head HTTP ${resp.status}`);
  }
  const len = resp.headers.get("content-length");
  return len === null ? 0 : Number(len);
}

/** Presign a single-PUT URL for a direct browser upload (query-string auth).
 *  Used by the segment uploader's R2 path: the browser PUTs the whole file to
 *  this URL, bypassing Vercel's body cap — the role the GCS resumable session
 *  played. Content-Type is intentionally NOT signed, so the browser may send
 *  any; the bucket needs a CORS policy allowing PUT from the admin origin. */
export async function presignR2PutUrl(
  bucket: string,
  key: string,
  expiresSec = 3600,
): Promise<string> {
  const url = new URL(objectUrl(bucket, key));
  url.searchParams.set("X-Amz-Expires", String(expiresSec));
  const signed = await client().sign(url.toString(), {
    method: "PUT",
    aws: { signQuery: true },
  });
  return signed.url;
}

/** The user-content bucket name (untrusted UGC zone). Throws if unset. */
export function userContentBucket(): string {
  const b = process.env.R2_USERCONTENT_BUCKET?.trim();
  if (!b) throw new Error("R2_USERCONTENT_BUCKET is not set.");
  return b;
}

/** Extract the object key from a usercontent delivery URL whose base is `base`,
 *  or null when the URL isn't one of ours (an external DiceBear/OAuth picture,
 *  or unset). Pure + base-injected so it is unit-testable without env. Only
 *  `avatars/` keys are returned, so a crafted picture_url can't make us delete
 *  outside that prefix. */
export function userContentKeyFromUrl(
  url: string | null | undefined,
  base: string | null | undefined,
): string | null {
  if (!url || !base) return null;
  const b = base.replace(/\/+$/, "");
  if (!url.startsWith(`${b}/`)) return null;
  const key = url.slice(b.length + 1).split(/[?#]/)[0];
  return key.startsWith("avatars/") ? key : null;
}

// ── Media target (Phase 3 cutover) ─────────────────────────────────────────

/** Long immutable cache for media objects — the edge cache (not the bucket)
 *  serves the bytes, which is what makes R2 delivery essentially free. */
export const MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** The media bucket name (viewer-facing editorial/pipeline media). Throws if
 *  unset. */
export function mediaBucket(): string {
  const b = process.env.R2_MEDIA_BUCKET?.trim();
  if (!b) throw new Error("R2_MEDIA_BUCKET is not set.");
  return b;
}

/** True when R2 is the ACTIVE media target: fully configured, MEDIA_PUBLIC_BASE
 *  set, and the explicit R2_MEDIA_WRITE_ENABLED cutover flag on. Mirrors the
 *  pipeline's gcs._r2_configured gate so the Node and Python writers flip
 *  together — and stays OFF while the R2 vars are merely present (they're shared
 *  with the avatar path). */
export function isR2MediaActive(): boolean {
  const flag = (process.env.R2_MEDIA_WRITE_ENABLED ?? "").trim().toLowerCase();
  if (!["1", "true", "yes", "on"].includes(flag)) return false;
  return (
    isR2Configured() &&
    Boolean(process.env.R2_MEDIA_BUCKET) &&
    Boolean(process.env.MEDIA_PUBLIC_BASE)
  );
}

/** Extract the object key from a media delivery URL (base = MEDIA_PUBLIC_BASE),
 *  or null when the URL isn't on that base. Used by the delete path to reap R2
 *  media objects. Any key under the base is valid (unlike the avatars/-scoped
 *  user-content helper). */
export function mediaUrlToKey(
  url: string | null | undefined,
  base: string | null | undefined,
): string | null {
  if (!url || !base) return null;
  const b = base.replace(/\/+$/, "");
  if (!url.startsWith(`${b}/`)) return null;
  return url.slice(b.length + 1).split(/[?#]/)[0] || null;
}
