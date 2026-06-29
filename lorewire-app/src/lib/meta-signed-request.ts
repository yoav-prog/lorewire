// Meta's signed_request payload parser and verifier.
//
// Used by /api/social/oauth/meta/data-deletion. Meta posts
// `signed_request=<sig>.<payload>` where:
//   sig     = base64url(HMAC-SHA256(payload, app_secret))
//   payload = base64url(JSON({ algorithm, issued_at, user_id, ... }))
//
// Both halves are base64url-encoded (no padding). The HMAC is computed
// over the encoded payload string, NOT the decoded JSON. Verification
// uses timingSafeEqual.
//
// Spec: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
// Re-verify against Meta's current spec at execution time per rule 1; the
// format has been stable since 2019 but the dashboard URL drifts.

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface MetaSignedRequestPayload {
  algorithm: string;
  issued_at?: number;
  user_id: string;
  // Meta passes through any number of additional fields per flow.
  [key: string]: unknown;
}

export type ParseResult =
  | { ok: true; payload: MetaSignedRequestPayload }
  | { ok: false; reason: ParseFailureReason };

export type ParseFailureReason =
  | "missing"
  | "malformed"
  | "bad-algorithm"
  | "bad-signature"
  | "bad-payload";

// Decode unpadded base64url (Meta uses no padding). Buffer.from with
// 'base64url' tolerates both padded and unpadded since Node 18.
function decodeBase64Url(s: string): Buffer | null {
  try {
    return Buffer.from(s, "base64url");
  } catch {
    return null;
  }
}

export function parseSignedRequest(
  signedRequest: string | null | undefined,
  appSecret: string,
): ParseResult {
  if (!signedRequest || typeof signedRequest !== "string") {
    return { ok: false, reason: "missing" };
  }
  const dot = signedRequest.indexOf(".");
  if (dot < 1 || dot === signedRequest.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const sigPart = signedRequest.slice(0, dot);
  const payloadPart = signedRequest.slice(dot + 1);

  const sigBuf = decodeBase64Url(sigPart);
  if (!sigBuf) return { ok: false, reason: "malformed" };

  const expected = createHmac("sha256", appSecret)
    .update(payloadPart)
    .digest();

  // timingSafeEqual throws if lengths differ — guard first.
  if (expected.length !== sigBuf.length) {
    return { ok: false, reason: "bad-signature" };
  }
  if (!timingSafeEqual(expected, sigBuf)) {
    return { ok: false, reason: "bad-signature" };
  }

  const payloadBuf = decodeBase64Url(payloadPart);
  if (!payloadBuf) return { ok: false, reason: "bad-payload" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBuf.toString("utf8"));
  } catch {
    return { ok: false, reason: "bad-payload" };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).algorithm !== "string" ||
    typeof (parsed as Record<string, unknown>).user_id !== "string"
  ) {
    return { ok: false, reason: "bad-payload" };
  }
  const payload = parsed as MetaSignedRequestPayload;
  // Meta's docs specify HMAC-SHA256. Reject anything else explicitly so
  // a forged payload that claims a different algorithm can't slip
  // through later if this function gets reused for a verification path
  // that switches on algorithm.
  if (payload.algorithm !== "HMAC-SHA256") {
    return { ok: false, reason: "bad-algorithm" };
  }
  return { ok: true, payload };
}

// Test helper: build a valid signed_request for a given payload + secret.
// Lives next to the verifier so tests don't fork their own format and
// silently drift from Meta's spec.
export function encodeSignedRequestForTesting(
  payload: MetaSignedRequestPayload,
  appSecret: string,
): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const sig = createHmac("sha256", appSecret)
    .update(payloadPart)
    .digest()
    .toString("base64url");
  return `${sig}.${payloadPart}`;
}
