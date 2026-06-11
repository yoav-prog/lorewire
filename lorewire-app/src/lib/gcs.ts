// GCS upload from Node. Mirrors pipeline/gcs.py — same bucket, same service
// account env vars, same public-read object naming — so anything uploaded
// from either side is interchangeable. Used by the admin to publish raw
// segment uploads and their normalized copies. Auth is the JWT bearer flow
// (RS256 over the assertion payload, exchanged for an OAuth2 access token).

import "server-only";
import { SignJWT, importPKCS8 } from "jose";
import { readFile } from "node:fs/promises";

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";
const UPLOAD_BASE = "https://storage.googleapis.com/upload/storage/v1";
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
