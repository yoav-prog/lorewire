// GCS upload from Node. Mirrors pipeline/gcs.py — same bucket, same service
// account env vars, same public-read object naming — so anything uploaded
// from either side is interchangeable. Used by the admin to publish raw
// segment uploads and their normalized copies. Auth is the JWT bearer flow
// (RS256 over the assertion payload, exchanged for an OAuth2 access token).

import "server-only";
import { SignJWT, importPKCS8 } from "jose";
import { readFile } from "node:fs/promises";
import {
  MEDIA_CACHE_CONTROL,
  deleteR2Object,
  isR2MediaActive,
  mediaBucket,
  mediaUrlToKey,
  presignR2PutUrl,
  putR2Object,
} from "./r2";
import { mediaPublicBase } from "./media-url";

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";
const UPLOAD_BASE = "https://storage.googleapis.com/upload/storage/v1";
const JSON_API_BASE = "https://storage.googleapis.com/storage/v1";
const PUBLIC_BASE = "https://storage.googleapis.com";

// 50 minutes — the access token lives for 60 minutes; we refresh 10 minutes
// before expiry to never serve a stale token.
const TOKEN_TTL_MS = 50 * 60 * 1000;

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

interface CachedToken {
  token: string;
  expiresAt: number;
}

declare global {
  // Cached across dev HMR reloads — the access token is valid for the whole
  // process lifetime, so re-signing on every request wastes ~200ms.
  var __lwGcsToken: CachedToken | undefined;
}

export function isConfigured(): boolean {
  return Boolean(
    process.env.GCS_BUCKET &&
      process.env.GCS_CLIENT_EMAIL &&
      process.env.GCS_PRIVATE_KEY,
  );
}

function mimeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function normalizePrivateKey(raw: string): string {
  // .env stores the key with literal `\n` sequences; PEM parsing requires
  // real newlines. This is the same massage pipeline/gcs.py does.
  const key = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  if (!key.includes("BEGIN PRIVATE KEY")) {
    throw new Error(
      "GCS_PRIVATE_KEY does not look like a PEM key (no BEGIN PRIVATE KEY line).",
    );
  }
  return key;
}

async function accessToken(): Promise<string> {
  const now = Date.now();
  if (globalThis.__lwGcsToken && now < globalThis.__lwGcsToken.expiresAt) {
    return globalThis.__lwGcsToken.token;
  }
  const clientEmail = process.env.GCS_CLIENT_EMAIL;
  const rawKey = process.env.GCS_PRIVATE_KEY;
  if (!clientEmail || !rawKey) {
    throw new Error(
      "GCS upload is not configured. Set GCS_CLIENT_EMAIL and GCS_PRIVATE_KEY.",
    );
  }
  const pem = normalizePrivateKey(rawKey);
  const key = await importPKCS8(pem, "RS256");
  const issuedAt = Math.floor(now / 1000);
  const assertion = await new SignJWT({
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URI,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3600)
    .sign(key);

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const resp = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `GCS token exchange HTTP ${resp.status}: ${text.slice(0, 200)}`,
    );
  }
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("GCS token exchange returned no access_token.");
  }
  globalThis.__lwGcsToken = {
    token: data.access_token,
    expiresAt: now + TOKEN_TTL_MS,
  };
  return data.access_token;
}

// Upload a local file to <bucket>/<key>. Returns the public URL. The bucket
// is assumed to allow public reads (the existing GCS_BUCKET grants
// allUsers:objectViewer); predefinedAcl=publicRead covers the legacy ACL
// case the Python uploader handles.
export async function uploadFile(
  localPath: string,
  key: string,
): Promise<string> {
  // Media migration: when R2 is the active target, write to the R2 media bucket
  // and return its public URL. Gated + inert until the cutover (lib/r2
  // isR2MediaActive); otherwise the GCS path below runs unchanged.
  if (isR2MediaActive()) {
    const r2Body = await readFile(localPath);
    await putR2Object(mediaBucket(), key, r2Body, {
      contentType: mimeFor(localPath),
      cacheControl: MEDIA_CACHE_CONTROL,
    });
    return `${mediaPublicBase()}/${key}`;
  }
  const bucket = process.env.GCS_BUCKET;
  if (!bucket) {
    throw new Error("GCS_BUCKET is not set; cannot upload.");
  }
  const body = await readFile(localPath);
  const mime = mimeFor(localPath);
  const token = await accessToken();
  const encodedKey = encodeURIComponent(key);
  const url =
    `${UPLOAD_BASE}/b/${encodeURIComponent(bucket)}/o` +
    `?uploadType=media&name=${encodedKey}&predefinedAcl=publicRead`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": mime,
      "Content-Length": String(body.byteLength),
    },
    body,
  });
  if (resp.status !== 200 && resp.status !== 201) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GCS upload HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return `${PUBLIC_BASE}/${bucket}/${key}`;
}

// Upload an in-memory buffer to <bucket>/<key>. Returns the public URL.
// Used by the article CMS image uploader — images are typically <5 MB so the
// browser can POST multipart through a Vercel Function without hitting the
// 4.5 MB body cap that forced the segments uploader to go direct-to-GCS.
// For anything that might exceed that cap, prefer createResumableUploadSession.
export async function uploadBuffer(
  body: ArrayBuffer | Uint8Array | Buffer,
  key: string,
  contentType: string,
): Promise<string> {
  // Media migration target — see uploadFile. Inert until the cutover flag.
  if (isR2MediaActive()) {
    await putR2Object(mediaBucket(), key, body, {
      contentType,
      cacheControl: MEDIA_CACHE_CONTROL,
    });
    return `${mediaPublicBase()}/${key}`;
  }
  const bucket = process.env.GCS_BUCKET;
  if (!bucket) {
    throw new Error("GCS_BUCKET is not set; cannot upload.");
  }
  const token = await accessToken();
  const encodedKey = encodeURIComponent(key);
  const url =
    `${UPLOAD_BASE}/b/${encodeURIComponent(bucket)}/o` +
    `?uploadType=media&name=${encodedKey}&predefinedAcl=publicRead`;
  // Copy bytes into a fresh ArrayBuffer so the Blob is typed cleanly under
  // strict TS. Newer @types/node narrowed BlobPart to ArrayBufferView<
  // ArrayBuffer> (excluding SharedArrayBuffer), and Uint8Array<ArrayBufferLike>
  // — which is what you get from Buffer or a typed-array slice — no longer
  // satisfies that. One small copy buys us a cast-free, robust path.
  const sourceU8 =
    body instanceof Uint8Array ? body : new Uint8Array(body);
  const ab = new ArrayBuffer(sourceU8.byteLength);
  new Uint8Array(ab).set(sourceU8);
  const blob = new Blob([ab], { type: contentType });
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
      "Content-Length": String(blob.size),
    },
    body: blob,
  });
  if (resp.status !== 200 && resp.status !== 201) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GCS upload HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return `${PUBLIC_BASE}/${bucket}/${key}`;
}

// Result of a resumable-upload init: the session URI the browser PUTs bytes
// to, and the public URL the object will resolve to once the upload completes.
// Both are returned at init time because we want to write `source_url` to the
// DB before bytes flow — the worker uses it to discover what to download.
export interface ResumableUploadSession {
  sessionUri: string;
  publicUrl: string;
  /** True when `sessionUri` is a presigned single-PUT URL (R2) rather than a
   *  GCS resumable session — the browser must PUT the whole file in one
   *  request instead of chunking with Content-Range. */
  single: boolean;
}

// Initiate a GCS JSON-API resumable upload and return the session URI plus
// the eventual public URL. Used by /api/admin/segments/sign-upload so the
// browser can PUT video bytes straight to GCS (bypassing Vercel's 4.5 MB
// function body cap). The session URI is unauthenticated but unguessable
// (contains a server-issued `upload_id` token); it expires after one week
// per the GCS contract — well beyond any plausible upload window.
//
// Reference: https://cloud.google.com/storage/docs/performing-resumable-uploads
// Verified 2026-06-11.
//
// Note on CORS: the browser PUTs cross-origin to storage.googleapis.com, so
// the bucket needs a CORS policy allowing PUT from our admin origin. That's
// a one-time bucket-config step, documented in the plan's open questions —
// not something this function can do.
export async function createResumableUploadSession(
  key: string,
  contentType: string,
): Promise<ResumableUploadSession> {
  // Media migration: presign a single-PUT URL to the R2 media bucket. R2 has no
  // GCS-style resumable session — the browser PUTs the whole file to the URL in
  // one request (the bucket needs CORS allowing PUT from the admin origin).
  // Inert until the cutover flag (isR2MediaActive).
  if (isR2MediaActive()) {
    const sessionUri = await presignR2PutUrl(mediaBucket(), key);
    return {
      sessionUri,
      publicUrl: `${mediaPublicBase()}/${key}`,
      single: true,
    };
  }
  const bucket = process.env.GCS_BUCKET;
  if (!bucket) {
    throw new Error("GCS_BUCKET is not set; cannot initiate upload.");
  }
  const token = await accessToken();
  const url =
    `${UPLOAD_BASE}/b/${encodeURIComponent(bucket)}/o` +
    `?uploadType=resumable&name=${encodeURIComponent(key)}` +
    `&predefinedAcl=publicRead`;
  // Body is the object metadata GCS applies after the upload completes.
  // Pinning contentType here means the served object has the right MIME
  // without a follow-up PATCH. `name` is required when omitted from the
  // querystring; we include it in both for defense in depth.
  const meta = JSON.stringify({ name: key, contentType });
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      // X-Upload-Content-Type tells GCS the MIME the *uploaded bytes* will
      // carry, separate from the metadata Content-Type which describes the
      // request body (JSON). Both are required for a clean resumable init.
      "X-Upload-Content-Type": contentType,
    },
    body: meta,
  });
  if (resp.status !== 200) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `GCS resumable init HTTP ${resp.status}: ${text.slice(0, 200)}`,
    );
  }
  const sessionUri = resp.headers.get("Location");
  if (!sessionUri) {
    throw new Error("GCS resumable init response is missing Location header.");
  }
  return {
    sessionUri,
    publicUrl: `${PUBLIC_BASE}/${bucket}/${key}`,
    single: false,
  };
}

// Parsed reference to a GCS object. `bucket` and `key` are decoded — `key`
// may contain forward slashes because GCS object names commonly do.
export interface ParsedGcsUrl {
  bucket: string;
  key: string;
}

// Strictly parse a public GCS URL of the shape
// https://storage.googleapis.com/<bucket>/<key> into its bucket and key.
// Returns null for anything that doesn't match — caller is expected to log
// and skip rather than guess. The bucket is the first path segment; the key
// is the remainder (joined with `/` so nested paths round-trip). Query
// strings and fragments are stripped before the split.
export function parseGcsUrl(url: string | null | undefined): ParsedGcsUrl | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.host !== "storage.googleapis.com") return null;
  // Leading slash trimmed so split lines up with [bucket, ...keyParts].
  const path = parsed.pathname.replace(/^\/+/, "");
  if (!path) return null;
  const slash = path.indexOf("/");
  if (slash < 0) return null;
  const bucket = path.slice(0, slash);
  const keyEncoded = path.slice(slash + 1);
  if (!bucket || !keyEncoded) return null;
  try {
    return { bucket, key: decodeURIComponent(keyEncoded) };
  } catch {
    return null;
  }
}

// Delete a single object from the configured GCS_BUCKET. Treats 404 as a
// no-op so callers can fan out across "expected" media URLs without worrying
// about partial state. Anything else (network error, 403, 5xx) throws so the
// batch action can record the failure and surface it to the operator.
//
// Reference: https://cloud.google.com/storage/docs/json_api/v1/objects/delete
// Verified 2026-06-19.
export async function deleteObject(key: string): Promise<void> {
  const bucket = process.env.GCS_BUCKET;
  if (!bucket) {
    throw new Error("GCS_BUCKET is not set; cannot delete.");
  }
  const token = await accessToken();
  const url = `${JSON_API_BASE}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 204 || resp.status === 404) {
    // eslint-disable-next-line no-console -- rule 14: observability from day one
    console.info("[content gcs delete]", { bucket, key, status: resp.status });
    return;
  }
  const text = await resp.text().catch(() => "");
  throw new Error(`GCS delete HTTP ${resp.status}: ${text.slice(0, 200)}`);
}

// Delete the rendered audio and video objects for a story. Each URL is
// parsed strictly via parseGcsUrl; an unparseable or cross-bucket URL is
// logged and skipped — we never blindly DELETE a key we can't verify owns
// the configured bucket. Returns the number of objects actually deleted (or
// 404'd) so the caller can include it in batch result logs.
export async function deleteStoryMedia(
  audioUrl: string | null | undefined,
  videoUrl: string | null | undefined,
): Promise<{ attempted: number; skipped: number }> {
  const bucket = process.env.GCS_BUCKET;
  let attempted = 0;
  let skipped = 0;
  for (const candidate of [audioUrl, videoUrl]) {
    if (!candidate) continue;
    // R2-hosted media (on the MEDIA_PUBLIC_BASE host) — reap from the R2 media
    // bucket. deleteR2Object treats a 404 as a no-op, same as the GCS path.
    const r2Key = mediaUrlToKey(candidate, mediaPublicBase());
    if (r2Key) {
      await deleteR2Object(mediaBucket(), r2Key);
      attempted += 1;
      continue;
    }
    const parsed = parseGcsUrl(candidate);
    if (!parsed) {
      // eslint-disable-next-line no-console -- rule 14: observability from day one
      console.warn("[content gcs delete] url unparseable", { url: candidate });
      skipped += 1;
      continue;
    }
    if (bucket && parsed.bucket !== bucket) {
      // eslint-disable-next-line no-console -- rule 14: observability from day one
      console.warn("[content gcs delete] cross-bucket url", {
        url: candidate,
        urlBucket: parsed.bucket,
        configuredBucket: bucket,
      });
      skipped += 1;
      continue;
    }
    await deleteObject(parsed.key);
    attempted += 1;
  }
  return { attempted, skipped };
}
