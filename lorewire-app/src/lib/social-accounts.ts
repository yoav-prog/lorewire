// TS-app-owned query layer for the social publisher (Phase 1).
//
// social_accounts holds the owner's platform connections (Phase 1: at most one
// active per platform); oauth_flows stages the short-lived CSRF/PKCE state
// during a connect. Tokens are stored as AES-256-GCM envelopes
// (lib/token-cipher.ts) and only ever decrypted inside a route or worker.
// Mirrors the per-feature query-module pattern (see lib/voice-render-queue.ts).
// Plan: _plans/2026-06-16-multi-platform-shorts-publisher.md sections 6 and 8.

import "server-only";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";
import type { SocialPlatform } from "@/lib/social-publish";

export type SocialAccountStatus = "active" | "revoked" | "needs_reauth";

export interface SocialAccountRow {
  id: string;
  platform: string;
  display_name: string | null;
  external_id: string;
  scopes: string | null;
  access_token_enc: string;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  status: SocialAccountStatus;
  created_at: string;
  updated_at: string;
}

// Non-secret projection for the settings UI. Never selects the token columns,
// so an accidental log or serialization of a summary cannot leak a cipher blob.
export interface SocialAccountSummary {
  id: string;
  platform: string;
  display_name: string | null;
  external_id: string;
  scopes: string | null;
  token_expires_at: string | null;
  status: SocialAccountStatus;
  updated_at: string;
}

const FULL_COLS =
  "id, platform, display_name, external_id, scopes, access_token_enc, refresh_token_enc, token_expires_at, status, created_at, updated_at";
const SUMMARY_COLS =
  "id, platform, display_name, external_id, scopes, token_expires_at, status, updated_at";

export async function listSocialAccountSummaries(): Promise<SocialAccountSummary[]> {
  return all<SocialAccountSummary>(
    `SELECT ${SUMMARY_COLS} FROM social_accounts ORDER BY platform, updated_at DESC`,
  );
}

// The active connection for a platform (Phase 1: at most one). The publish path
// resolves its upload target through this; never trust a client-supplied id.
export async function getActiveSocialAccount(
  platform: SocialPlatform,
): Promise<SocialAccountRow | null> {
  return one<SocialAccountRow>(
    `SELECT ${FULL_COLS} FROM social_accounts
       WHERE platform = ? AND status = 'active'
       ORDER BY updated_at DESC LIMIT 1`,
    [platform],
  );
}

export async function getActiveSocialAccountSummary(
  platform: SocialPlatform,
): Promise<SocialAccountSummary | null> {
  return one<SocialAccountSummary>(
    `SELECT ${SUMMARY_COLS} FROM social_accounts
       WHERE platform = ? AND status = 'active'
       ORDER BY updated_at DESC LIMIT 1`,
    [platform],
  );
}

export async function getSocialAccountById(
  id: string,
): Promise<SocialAccountRow | null> {
  return one<SocialAccountRow>(
    `SELECT ${FULL_COLS} FROM social_accounts WHERE id = ?`,
    [id],
  );
}

export interface UpsertSocialAccountInput {
  platform: SocialPlatform;
  externalId: string;
  displayName: string | null;
  scopes: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: string | null;
}

// Insert or update the (platform, external_id) connection, then demote any
// other active row for the same platform to 'revoked'. Phase 1 keeps exactly
// one active account per platform (plan section 2). A reconnect that returns no
// new refresh token keeps the previously stored one (Google omits it unless the
// consent is re-granted).
export async function upsertSocialAccount(
  input: UpsertSocialAccountInput,
): Promise<string> {
  const now = new Date().toISOString();
  const existing = await one<{ id: string }>(
    `SELECT id FROM social_accounts WHERE platform = ? AND external_id = ?`,
    [input.platform, input.externalId],
  );

  let id: string;
  if (existing) {
    id = existing.id;
    await run(
      `UPDATE social_accounts SET
         display_name = ?, scopes = ?, access_token_enc = ?,
         refresh_token_enc = COALESCE(?, refresh_token_enc),
         token_expires_at = ?, status = 'active', updated_at = ?
       WHERE id = ?`,
      [
        input.displayName,
        input.scopes,
        input.accessTokenEnc,
        input.refreshTokenEnc,
        input.tokenExpiresAt,
        now,
        id,
      ],
    );
  } else {
    id = randomUUID();
    await run(
      `INSERT INTO social_accounts
         (id, platform, display_name, external_id, scopes, access_token_enc,
          refresh_token_enc, token_expires_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        id,
        input.platform,
        input.displayName,
        input.externalId,
        input.scopes,
        input.accessTokenEnc,
        input.refreshTokenEnc,
        input.tokenExpiresAt,
        now,
        now,
      ],
    );
  }

  // One active account per platform: demote any other still-active rows.
  await run(
    `UPDATE social_accounts SET status = 'revoked', updated_at = ?
       WHERE platform = ? AND id <> ? AND status = 'active'`,
    [now, input.platform, id],
  );
  return id;
}

// Disconnect: drop the cipher fields and mark revoked. The platform-side token
// revoke is the caller's job (it must decrypt the token first).
export async function revokeSocialAccount(id: string): Promise<void> {
  const now = new Date().toISOString();
  await run(
    `UPDATE social_accounts SET
       status = 'revoked', access_token_enc = '', refresh_token_enc = NULL,
       updated_at = ?
     WHERE id = ?`,
    [now, id],
  );
}

export async function markSocialAccountNeedsReauth(id: string): Promise<void> {
  const now = new Date().toISOString();
  await run(
    `UPDATE social_accounts SET status = 'needs_reauth', updated_at = ? WHERE id = ?`,
    [now, id],
  );
}

// --- oauth_flows (CSRF + PKCE staging) ---

export interface OAuthFlowRow {
  state: string;
  platform: string;
  code_verifier: string;
  session_ref: string | null;
  created_at: string;
  expires_at: string;
}

export async function createOAuthFlow(input: {
  state: string;
  platform: SocialPlatform;
  codeVerifier: string;
  sessionRef: string;
  ttlMs?: number;
}): Promise<void> {
  const now = Date.now();
  const ttl = input.ttlMs ?? 10 * 60 * 1000; // 10 minutes
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttl).toISOString();
  // Opportunistic cleanup so the staging table self-trims without a cron.
  await run(`DELETE FROM oauth_flows WHERE expires_at < ?`, [createdAt]);
  await run(
    `INSERT INTO oauth_flows
       (state, platform, code_verifier, session_ref, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.state,
      input.platform,
      input.codeVerifier,
      input.sessionRef,
      createdAt,
      expiresAt,
    ],
  );
}

export async function getOAuthFlow(state: string): Promise<OAuthFlowRow | null> {
  return one<OAuthFlowRow>(
    `SELECT state, platform, code_verifier, session_ref, created_at, expires_at
       FROM oauth_flows WHERE state = ?`,
    [state],
  );
}

export async function deleteOAuthFlow(state: string): Promise<void> {
  await run(`DELETE FROM oauth_flows WHERE state = ?`, [state]);
}
