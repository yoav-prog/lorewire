// @vitest-environment node

// Integration tests for the social-accounts query layer against the real
// (temp SQLite) DB. Validates the schema + SQL: the oauth_flows single-use
// lifecycle and expiry sweep, and the social_accounts upsert / one-active-per-
// platform / reconnect-keeps-refresh / revoke / token-update behavior.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "@/lib/db";
import {
  createOAuthFlow,
  deleteOAuthFlow,
  getActiveSocialAccount,
  getActiveSocialAccountSummary,
  getOAuthFlow,
  getSocialAccountById,
  markSocialAccountNeedsReauth,
  revokeSocialAccount,
  updateSocialAccountAccessToken,
  upsertSocialAccount,
  type UpsertSocialAccountInput,
} from "./social-accounts";

async function clean() {
  await run("DELETE FROM social_accounts WHERE 1=1", []);
  await run("DELETE FROM oauth_flows WHERE 1=1", []);
}
beforeEach(clean);
afterEach(clean);

function upsertInput(
  overrides: Partial<UpsertSocialAccountInput> = {},
): UpsertSocialAccountInput {
  return {
    platform: "youtube",
    externalId: "chan-1",
    displayName: "Lorewire Stories",
    scopes: "youtube.upload youtube.readonly",
    accessTokenEnc: "enc-access-1",
    refreshTokenEnc: "enc-refresh-1",
    tokenExpiresAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("oauth_flows lifecycle", () => {
  it("creates, reads, and single-use deletes a flow", async () => {
    await createOAuthFlow({
      state: "s1",
      platform: "youtube",
      codeVerifier: "verifier-1",
      sessionRef: "user-1",
    });
    const flow = await getOAuthFlow("s1");
    expect(flow?.platform).toBe("youtube");
    expect(flow?.code_verifier).toBe("verifier-1");
    expect(flow?.session_ref).toBe("user-1");

    await deleteOAuthFlow("s1");
    expect(await getOAuthFlow("s1")).toBeNull();
  });

  it("sweeps expired flows when a new one is created", async () => {
    await createOAuthFlow({
      state: "stale",
      platform: "youtube",
      codeVerifier: "v",
      sessionRef: "u",
      ttlMs: -1000, // already expired
    });
    await createOAuthFlow({
      state: "fresh",
      platform: "youtube",
      codeVerifier: "v",
      sessionRef: "u",
    });
    expect(await getOAuthFlow("stale")).toBeNull();
    expect(await getOAuthFlow("fresh")).not.toBeNull();
  });
});

describe("social_accounts", () => {
  it("inserts a new connection and reads it back as active", async () => {
    const id = await upsertSocialAccount(upsertInput());
    const active = await getActiveSocialAccount("youtube");
    expect(active?.id).toBe(id);
    expect(active?.status).toBe("active");
    expect(active?.refresh_token_enc).toBe("enc-refresh-1");
  });

  it("reconnecting the same channel updates in place and keeps the old refresh token", async () => {
    const id1 = await upsertSocialAccount(upsertInput());
    const id2 = await upsertSocialAccount(
      upsertInput({
        displayName: "Renamed",
        accessTokenEnc: "enc-access-2",
        refreshTokenEnc: null, // Google omits it on re-consent
        tokenExpiresAt: "2026-02-01T00:00:00.000Z",
      }),
    );
    expect(id2).toBe(id1);
    const row = await getSocialAccountById(id1);
    expect(row?.display_name).toBe("Renamed");
    expect(row?.access_token_enc).toBe("enc-access-2");
    expect(row?.refresh_token_enc).toBe("enc-refresh-1"); // preserved via COALESCE
  });

  it("keeps exactly one active account per platform (a second channel revokes the first)", async () => {
    const id1 = await upsertSocialAccount(upsertInput({ externalId: "chan-1" }));
    const id2 = await upsertSocialAccount(upsertInput({ externalId: "chan-2" }));
    expect(id2).not.toBe(id1);
    expect((await getActiveSocialAccount("youtube"))?.id).toBe(id2);
    expect((await getSocialAccountById(id1))?.status).toBe("revoked");
  });

  it("the summary projection omits the token columns", async () => {
    await upsertSocialAccount(upsertInput());
    const summary = await getActiveSocialAccountSummary("youtube");
    expect(summary?.external_id).toBe("chan-1");
    expect(summary).not.toHaveProperty("access_token_enc");
    expect(summary).not.toHaveProperty("refresh_token_enc");
  });

  it("revoke nulls the tokens, marks revoked, and drops it from active", async () => {
    const id = await upsertSocialAccount(upsertInput());
    await revokeSocialAccount(id);
    const row = await getSocialAccountById(id);
    expect(row?.status).toBe("revoked");
    expect(row?.access_token_enc).toBe("");
    expect(row?.refresh_token_enc).toBeNull();
    expect(await getActiveSocialAccount("youtube")).toBeNull();
  });

  it("updateSocialAccountAccessToken swaps the token + expiry but leaves it active", async () => {
    const id = await upsertSocialAccount(upsertInput());
    await updateSocialAccountAccessToken(id, "enc-access-refreshed", "2026-09-09T00:00:00.000Z");
    const row = await getSocialAccountById(id);
    expect(row?.access_token_enc).toBe("enc-access-refreshed");
    expect(row?.token_expires_at).toBe("2026-09-09T00:00:00.000Z");
    expect(row?.status).toBe("active");
  });

  it("needs_reauth drops the account from active", async () => {
    const id = await upsertSocialAccount(upsertInput());
    await markSocialAccountNeedsReauth(id);
    expect(await getActiveSocialAccount("youtube")).toBeNull();
    expect((await getSocialAccountById(id))?.status).toBe("needs_reauth");
  });
});
