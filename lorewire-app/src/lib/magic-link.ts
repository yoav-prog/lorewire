// Email magic-link sign-in. The user submits an email; we generate a
// random one-time token, store its hash + a 15-minute expiry in
// magic_link_tokens, email the raw token in the link URL via Brevo, and
// verify on the click.
//
// Why we hash and not store the raw token: same reason we hash passwords.
// If the database leaks, the leaked rows can't be used to sign in as
// anyone — an attacker would still need the raw token from the email,
// which never lives on our infrastructure.
//
// Why a DB-backed token and not a signed JWT: revocability + single-use.
// A signed JWT is stateless and can't be invalidated once issued; if a
// user requests a link, then requests a second one because the first
// felt slow, we want the first link to stop working. DB row's used_at
// makes that trivial.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md.

import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { all, one, run } from "@/lib/db";

export const MAGIC_LINK_TTL_MIN = 15;

interface MagicLinkRow {
  id: string;
  email: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string | null;
}

/** Hex-encoded 256-bit random token. Returned to the caller so the
 *  email-send path can put it in the link URL; never persisted. */
export function newMagicLinkToken(): string {
  return randomBytes(32).toString("hex");
}

/** SHA-256 of the raw token. Stable; lookup-friendly. */
export function hashMagicLinkToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Create a new token row and return the raw token. The raw token MUST
 *  immediately be placed in the email URL and otherwise discarded —
 *  logging it or persisting it elsewhere defeats the purpose. */
export async function issueMagicLink(email: string): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const token = newMagicLinkToken();
  const tokenHash = hashMagicLinkToken(token);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MIN * 60 * 1000);
  const id = randomUUID();
  await run(
    `INSERT INTO magic_link_tokens
        (id, email, token_hash, expires_at, used_at, created_at)
      VALUES (?, ?, ?, ?, NULL, ?)`,
    [id, email, tokenHash, expiresAt.toISOString(), new Date().toISOString()],
  );
  return { token, expiresAt };
}

export interface MagicLinkClaim {
  email: string;
}

/** Verify + consume a magic-link token. Returns the email on success or
 *  null on any failure (expired, unknown, already used). Single SQL
 *  UPDATE for the consume step so two concurrent verify clicks can't
 *  both succeed — the second one's `used_at IS NULL` clause fails and
 *  the row count comes back zero. */
export async function consumeMagicLink(
  token: string,
): Promise<MagicLinkClaim | null> {
  if (!token) return null;
  const tokenHash = hashMagicLinkToken(token);
  const row = await one<MagicLinkRow>(
    `SELECT * FROM magic_link_tokens WHERE token_hash = ?`,
    [tokenHash],
  );
  if (!row) return null;
  if (row.used_at !== null) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  // Atomic consume. SQLite + Postgres both honor the WHERE clause on
  // UPDATE, so two concurrent clicks race for the row and the loser
  // updates 0 rows. The portable affected-row count isn't exposed by
  // every driver, so we re-read used_at and confirm it carries the
  // marker WE wrote. The marker is the timestamp PLUS a UUID — using
  // the timestamp alone races at sub-ms (two consumes that fire in the
  // same JS event tick produce the same ISO string and both think they
  // won).
  const marker = `${new Date().toISOString()}#${randomUUID()}`;
  await run(
    `UPDATE magic_link_tokens SET used_at = ?
      WHERE id = ? AND used_at IS NULL`,
    [marker, row.id],
  );
  const reread = await one<MagicLinkRow>(
    `SELECT used_at FROM magic_link_tokens WHERE id = ?`,
    [row.id],
  );
  if (!reread || reread.used_at !== marker) return null;
  return { email: row.email };
}

/** Periodic cleanup. Not called automatically yet — we'll wire it to a
 *  Vercel cron in Phase 6 polish. Idempotent and bounded so it's safe to
 *  run on a tight schedule. */
export async function pruneExpiredMagicLinks(): Promise<number> {
  const now = new Date().toISOString();
  const stale = await all<{ id: string }>(
    `SELECT id FROM magic_link_tokens
      WHERE expires_at < ? OR used_at IS NOT NULL`,
    [now],
  );
  if (stale.length === 0) return 0;
  await run(
    `DELETE FROM magic_link_tokens
      WHERE expires_at < ? OR used_at IS NOT NULL`,
    [now],
  );
  return stale.length;
}

/* ----------------------------- Brevo email send ----------------------------- */
//
// Direct REST call instead of pulling in the Brevo SDK (~500 KB). The
// endpoint is well-documented and stable:
//   POST https://api.brevo.com/v3/smtp/email
// Auth header: `api-key: <BREVO_API_KEY>`.
//
// We don't want this to be the kind of code that's chatty under load —
// one fetch, fail fast, log enough to debug. Mail deliverability is
// outside our scope; if the user doesn't see the email, the UI offers
// "resend".

interface BrevoSendResponse {
  messageId?: string;
}

export async function sendMagicLinkEmail(
  toEmail: string,
  linkUrl: string,
): Promise<{ ok: boolean; messageId: string | null; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      messageId: null,
      error: "BREVO_API_KEY not configured",
    };
  }
  const fromEmail = process.env.BREVO_FROM_EMAIL?.trim() || "noreply@lorewire.com";
  const fromName = process.env.BREVO_FROM_NAME?.trim() || "LoreWire";

  const subject = "Sign in to LoreWire";
  // Plain copy keeps both Hebrew and English readers comfortable in v1.
  // Phase 6 can branch on the user's preferred language; for now, the
  // link text speaks for itself.
  const htmlContent = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#111;">
<p>Click the link below to sign in to LoreWire. It expires in ${MAGIC_LINK_TTL_MIN} minutes and works once.</p>
<p><a href="${linkUrl}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">Sign in to LoreWire</a></p>
<p style="color:#666;font-size:13px;">If you didn't ask for this, ignore the email — your account stays untouched.</p>
</body></html>`;
  const textContent = `Sign in to LoreWire — expires in ${MAGIC_LINK_TTL_MIN} minutes, works once:\n${linkUrl}\n\nDidn't ask for this? Ignore it.`;

  let res: Response;
  try {
    res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify({
        sender: { email: fromEmail, name: fromName },
        to: [{ email: toEmail }],
        subject,
        htmlContent,
        textContent,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      messageId: null,
      error: `brevo-network: ${(err as Error).message}`,
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      messageId: null,
      error: `brevo-${res.status}: ${body.slice(0, 120)}`,
    };
  }
  const parsed = (await res.json().catch(() => null)) as BrevoSendResponse | null;
  return {
    ok: true,
    messageId: parsed?.messageId ?? null,
  };
}
