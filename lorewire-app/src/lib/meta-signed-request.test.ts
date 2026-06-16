// Tests for the Meta signed_request parser/verifier.
//
// Coverage: golden path, tampered signature, wrong secret, missing
// fields, bad algorithm, malformed envelope, length-mismatch
// short-circuit (the timingSafeEqual length guard).

import { describe, expect, it } from "vitest";
import {
  encodeSignedRequestForTesting,
  parseSignedRequest,
} from "./meta-signed-request";

const SECRET = "test-app-secret-1234567890";
const VALID_PAYLOAD = {
  algorithm: "HMAC-SHA256",
  issued_at: 1718500000,
  user_id: "1234567890",
};

describe("parseSignedRequest", () => {
  it("accepts a valid signed_request and returns the payload", () => {
    const sr = encodeSignedRequestForTesting(VALID_PAYLOAD, SECRET);
    const result = parseSignedRequest(sr, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.user_id).toBe("1234567890");
      expect(result.payload.algorithm).toBe("HMAC-SHA256");
    }
  });

  it("rejects when signed_request is missing", () => {
    expect(parseSignedRequest(undefined, SECRET)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(parseSignedRequest("", SECRET)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(parseSignedRequest(null, SECRET)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("rejects when the envelope has no dot or sits at an edge", () => {
    expect(parseSignedRequest("nodothere", SECRET).ok).toBe(false);
    expect(parseSignedRequest(".onlyrhs", SECRET).ok).toBe(false);
    expect(parseSignedRequest("onlylhs.", SECRET).ok).toBe(false);
  });

  it("rejects when the signature is tampered", () => {
    const sr = encodeSignedRequestForTesting(VALID_PAYLOAD, SECRET);
    const dot = sr.indexOf(".");
    // Flip one character of the signature half.
    const broken =
      (sr[0] === "A" ? "B" : "A") +
      sr.slice(1, dot) +
      "." +
      sr.slice(dot + 1);
    expect(parseSignedRequest(broken, SECRET)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects when the secret does not match (forgery)", () => {
    const sr = encodeSignedRequestForTesting(VALID_PAYLOAD, SECRET);
    const result = parseSignedRequest(sr, "different-secret");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad-signature");
  });

  it("rejects a length-mismatched signature without throwing", () => {
    // A signature that's well-formed base64url but shorter than HMAC-256
    // would crash timingSafeEqual without the length guard.
    const payloadPart = Buffer.from(
      JSON.stringify(VALID_PAYLOAD),
      "utf8",
    ).toString("base64url");
    const shortSig = "AAAA"; // 3 bytes vs HMAC-SHA256's 32
    const sr = `${shortSig}.${payloadPart}`;
    expect(parseSignedRequest(sr, SECRET)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects when the payload is not valid JSON", () => {
    const payloadPart = Buffer.from("not-json{{{", "utf8").toString("base64url");
    const { createHmac } = require("node:crypto");
    const sig = createHmac("sha256", SECRET)
      .update(payloadPart)
      .digest()
      .toString("base64url");
    const sr = `${sig}.${payloadPart}`;
    expect(parseSignedRequest(sr, SECRET)).toEqual({
      ok: false,
      reason: "bad-payload",
    });
  });

  it("rejects when user_id is missing", () => {
    const sr = encodeSignedRequestForTesting(
      { algorithm: "HMAC-SHA256" } as never,
      SECRET,
    );
    expect(parseSignedRequest(sr, SECRET)).toEqual({
      ok: false,
      reason: "bad-payload",
    });
  });

  it("rejects when algorithm is not HMAC-SHA256", () => {
    const sr = encodeSignedRequestForTesting(
      { algorithm: "HS256", user_id: "x" } as MetaSignedRequestPayloadLike,
      SECRET,
    );
    expect(parseSignedRequest(sr, SECRET)).toEqual({
      ok: false,
      reason: "bad-algorithm",
    });
  });
});

// Local type loosener so we can encode an out-of-spec payload in a test
// without `as any` everywhere.
type MetaSignedRequestPayloadLike = {
  algorithm: string;
  user_id: string;
  [k: string]: unknown;
};
