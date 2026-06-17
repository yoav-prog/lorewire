// Tests for the pure pieces of the Google OAuth helper: PKCE generation, the
// authorization URL builder, and the state (CSRF) validator. The network
// helpers (token exchange, channel fetch) are covered by route integration
// tests in Slice 4.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  YOUTUBE_OAUTH_SCOPES,
  buildYoutubeAuthUrl,
  generatePkce,
  validateOAuthState,
  type OAuthFlowRecord,
} from "./social-oauth";

describe("generatePkce", () => {
  it("produces a base64url verifier with a matching S256 challenge", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
  });

  it("is random per call", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });
});

describe("buildYoutubeAuthUrl", () => {
  const url = new URL(
    buildYoutubeAuthUrl({
      clientId: "cid.apps.googleusercontent.com",
      redirectUri: "https://lorewire.com/api/social/oauth/youtube/callback",
      state: "the-state",
      codeChallenge: "the-challenge",
    }),
  );

  it("targets Google's consent endpoint with the required params", () => {
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    const p = url.searchParams;
    expect(p.get("client_id")).toBe("cid.apps.googleusercontent.com");
    expect(p.get("redirect_uri")).toBe(
      "https://lorewire.com/api/social/oauth/youtube/callback",
    );
    expect(p.get("response_type")).toBe("code");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("state")).toBe("the-state");
    expect(p.get("code_challenge")).toBe("the-challenge");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("scope")).toBe(YOUTUBE_OAUTH_SCOPES.join(" "));
  });

  it("requests upload but never Sheets/Drive (brand-account consent trap)", () => {
    expect(YOUTUBE_OAUTH_SCOPES).toContain(
      "https://www.googleapis.com/auth/youtube.upload",
    );
    expect(
      YOUTUBE_OAUTH_SCOPES.some(
        (s) => s.includes("drive") || s.includes("spreadsheets"),
      ),
    ).toBe(false);
  });
});

describe("validateOAuthState", () => {
  const base: OAuthFlowRecord = {
    state: "s1",
    platform: "youtube",
    session_ref: "user-1",
    expires_at: new Date(10_000).toISOString(),
  };
  const args = {
    expectedState: "s1",
    expectedPlatform: "youtube" as const,
    sessionRef: "user-1",
    now: 5_000,
  };

  it("accepts a valid, unexpired, session-matched flow", () => {
    expect(validateOAuthState({ flow: base, ...args })).toEqual({ ok: true });
  });

  it("rejects a missing flow", () => {
    expect(validateOAuthState({ flow: null, ...args })).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("rejects a state mismatch", () => {
    expect(
      validateOAuthState({ flow: { ...base, state: "other" }, ...args }),
    ).toEqual({ ok: false, reason: "state-mismatch" });
  });

  it("rejects a platform mismatch", () => {
    expect(
      validateOAuthState({ flow: { ...base, platform: "tiktok" }, ...args }),
    ).toEqual({ ok: false, reason: "platform-mismatch" });
  });

  it("rejects a session mismatch (stolen state replayed elsewhere)", () => {
    expect(
      validateOAuthState({ flow: { ...base, session_ref: "attacker" }, ...args }),
    ).toEqual({ ok: false, reason: "session-mismatch" });
  });

  it("rejects an expired flow", () => {
    expect(validateOAuthState({ flow: base, ...args, now: 20_000 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});
