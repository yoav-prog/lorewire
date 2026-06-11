// One-time script: set the GCS bucket's CORS rule using the same service
// account the app already uses. Reads bucket + credentials from .env.local
// at the repo root.
//
// Requires the service account to have `storage.buckets.update` permission
// (roles/storage.admin on the bucket, or a custom role that includes it). The
// app's normal upload scope (objectAdmin) is NOT enough — bucket-level config
// is a separate permission tier.
//
// Run: node scripts/set-gcs-cors.mjs

import { readFileSync } from "node:fs";
// Resolve jose from lorewire-app/node_modules — Node looks up from the script
// location, not the cwd, and scripts/ has no node_modules of its own.
const { SignJWT, importPKCS8 } = await import(
  new URL("../lorewire-app/node_modules/jose/dist/webapi/index.js", import.meta.url).href
);

const TOKEN_URI = "https://oauth2.googleapis.com/token";
// Broader scope than the runtime app uses — covers bucket-level config writes.
const SCOPE = "https://www.googleapis.com/auth/devstorage.full_control";

function loadEnv() {
  const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  return Object.fromEntries(
    text
      .split("\n")
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [
          l.slice(0, i).trim(),
          l.slice(i + 1).trim().replace(/^["']|["']$/g, ""),
        ];
      }),
  );
}

async function getAccessToken(env) {
  const clientEmail = env.GCS_CLIENT_EMAIL;
  const rawKey = env.GCS_PRIVATE_KEY;
  if (!clientEmail || !rawKey) {
    throw new Error("GCS_CLIENT_EMAIL and GCS_PRIVATE_KEY must be set in .env.local");
  }
  const pem = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;
  if (!pem.includes("BEGIN PRIVATE KEY")) {
    throw new Error("GCS_PRIVATE_KEY does not look like a PEM key");
  }
  const key = await importPKCS8(pem, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URI,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
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
    throw new Error(`token exchange HTTP ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  if (!data.access_token) throw new Error("no access_token in response");
  return data.access_token;
}

async function setCors(bucket, token, rule) {
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}?fields=cors`;
  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ cors: rule }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`PATCH bucket cors HTTP ${resp.status}: ${text}`);
  }
  return JSON.parse(text);
}

const env = loadEnv();
if (!env.GCS_BUCKET) throw new Error("GCS_BUCKET not set");

// Same rule as scripts/setup-gcs-cors.json — keep them in sync if you tweak
// either side. This is the JS literal, scripts/setup-gcs-cors.json is the
// gcloud-friendly file form.
const RULE = [
  {
    origin: [
      "https://lorewire.com",
      "https://www.lorewire.com",
      "http://localhost:3000",
    ],
    method: ["GET", "PUT", "POST", "OPTIONS"],
    responseHeader: [
      "Content-Type",
      "Content-Range",
      "Content-Length",
      "Range",
      "X-Goog-Resumable",
      "Authorization",
    ],
    maxAgeSeconds: 3600,
  },
];

console.log(`[gcs cors] bucket=${env.GCS_BUCKET}`);
console.log(`[gcs cors] rule:`, JSON.stringify(RULE, null, 2));
const token = await getAccessToken(env);
console.log(`[gcs cors] auth ok (token len=${token.length})`);
const result = await setCors(env.GCS_BUCKET, token, RULE);
console.log(`[gcs cors] PATCH ok. Current rule:`);
console.log(JSON.stringify(result.cors, null, 2));
