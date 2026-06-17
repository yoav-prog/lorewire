// @vitest-environment node

// Integration tests for the token-refresh half of the upload engine, against
// the real (temp SQLite) DB with the Google token endpoint mocked. Seals real
// tokens with the same key the engine reads from LOREWIRE_TOKEN_KEY, so the
// cipher round-trips through the DB. The resumable upload itself is exercised
// via the route orchestration test + manual E2E (it needs live YouTube).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "a".repeat(64); // 32-byte test key as hex
process.env.LOREWIRE_TOKEN_KEY = KEY;
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

import { run } from "@/lib/db";
import { createTokenCipher } from "@/lib/token-cipher";
import {
  getSocialAccountById,
  upsertSocialAccount,
  type SocialAccountRow,
} from "./social-accounts";
import { getValidYoutubeAccessToken } from "./youtube-upload";

const cipher = createTokenCipher({ current: KEY });

async function clean() {
  await run("DELETE FROM social_accounts WHERE 1=1", []);
}
beforeEach(clean);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function makeAccount(opts: {
  expiresAt: string | null;
  withRefresh: boolean;
  access?: string;
  refresh?: string;
}): Promise<SocialAccountRow> {
  const id = await upsertSocialAccount({
    platform: "youtube",
    externalId: "chan-1",
    displayName: "Chan",
    scopes: "youtube.upload",
    accessTokenEnc: cipher.encrypt(opts.access ?? "AT-current"),
    refreshTokenEnc: opts.withRefresh ? cipher.encrypt(opts.refresh ?? "RT") : null,
    tokenExpiresAt: opts.expiresAt,
  });
  const row = await getSocialAccountById(id);
  if (!row) throw new Error("setup: account not found");
  return row;
}

describe("getValidYoutubeAccessToken", () => {
  it("returns the stored token when it is not near expiry, with no refresh call", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const acc = await makeAccount({
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      withRefresh: true,
      access: "AT-good",
    });
    expect(await getValidYoutubeAccessToken(acc)).toBe("AT-good");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and persists the resealed token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ access_token: "AT-new", expires_in: 3600 }),
            { status: 200 },
          ),
      ),
    );
    const acc = await makeAccount({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      withRefresh: true,
    });
    expect(await getValidYoutubeAccessToken(acc)).toBe("AT-new");
    const updated = await getSocialAccountById(acc.id);
    expect(cipher.decrypt(updated!.access_token_enc)).toBe("AT-new");
    expect(updated?.status).toBe("active");
  });

  it("marks needs_reauth and returns null when there is no refresh token", async () => {
    const acc = await makeAccount({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      withRefresh: false,
    });
    expect(await getValidYoutubeAccessToken(acc)).toBeNull();
    expect((await getSocialAccountById(acc.id))?.status).toBe("needs_reauth");
  });

  it("marks needs_reauth and returns null when the refresh call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_grant", { status: 400 })),
    );
    const acc = await makeAccount({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      withRefresh: true,
    });
    expect(await getValidYoutubeAccessToken(acc)).toBeNull();
    expect((await getSocialAccountById(acc.id))?.status).toBe("needs_reauth");
  });
});
