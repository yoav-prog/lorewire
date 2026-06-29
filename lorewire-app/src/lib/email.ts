// Transactional email via Brevo's REST API. One generic sender plus the
// account-status notices the admin user-management feature sends. We call the
// REST endpoint directly (no SDK) — the same approach as sendMagicLinkEmail in
// magic-link.ts, which predates this module and can migrate onto sendBrevoEmail
// when convenient.
//
// No new cost: reuses the existing BREVO_API_KEY / BREVO_FROM_* config.
// Best-effort by contract: returns { ok:false, error } instead of throwing, so
// a mail failure never blocks the action that triggered it (a suspension still
// takes effect even if the notice email bounces).
//
// Plan: _plans/2026-06-22-admin-user-management.md (Phase 3).

import "server-only";

interface BrevoSendResponse {
  messageId?: string;
}

export interface EmailResult {
  ok: boolean;
  messageId: string | null;
  error?: string;
}

export async function sendBrevoEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<EmailResult> {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, messageId: null, error: "BREVO_API_KEY not configured" };
  }
  const fromEmail =
    process.env.BREVO_FROM_EMAIL?.trim() || "noreply@lorewire.com";
  const fromName = process.env.BREVO_FROM_NAME?.trim() || "LoreWire";

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
        to: [{ email: opts.to }],
        subject: opts.subject,
        htmlContent: opts.html,
        textContent: opts.text,
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
  return { ok: true, messageId: parsed?.messageId ?? null };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Notify a user that their account was suspended. `reason` is admin-authored
// and optional; it's HTML-escaped before going into the message body so it
// can never inject markup. Best-effort.
export async function sendAccountSuspendedEmail(
  toEmail: string,
  reason?: string | null,
): Promise<EmailResult> {
  const trimmed = reason?.trim();
  const subject = "Your LoreWire account has been suspended";
  const reasonHtml = trimmed
    ? `<p style="color:#444;">Reason: ${escapeHtml(trimmed)}</p>`
    : "";
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#111;">
<p>Your LoreWire account has been suspended. While it's suspended you can't sign in or take part, but your data is kept and the suspension can be lifted.</p>
${reasonHtml}
<p style="color:#666;font-size:13px;">If you think this is a mistake, reply to this email and we'll take a look.</p>
</body></html>`;
  const text =
    `Your LoreWire account has been suspended. While it's suspended you can't sign in or take part, but your data is kept and the suspension can be lifted.` +
    (trimmed ? `\n\nReason: ${trimmed}` : "") +
    `\n\nThink this is a mistake? Reply to this email.`;
  return sendBrevoEmail({ to: toEmail, subject, html, text });
}

// Notify a user that their account + data were permanently deleted. Sent
// best-effort right after the wipe, using the email captured before deletion.
export async function sendAccountDeletedEmail(
  toEmail: string,
): Promise<EmailResult> {
  const subject = "Your LoreWire account has been deleted";
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#111;">
<p>Your LoreWire account and the personal data tied to it have been permanently deleted. This can't be undone.</p>
<p style="color:#666;font-size:13px;">If you didn't expect this, reply to this email and we'll help.</p>
</body></html>`;
  const text = `Your LoreWire account and the personal data tied to it have been permanently deleted. This can't be undone.\n\nDidn't expect this? Reply to this email.`;
  return sendBrevoEmail({ to: toEmail, subject, html, text });
}

// Invite a new staff member. `inviteUrl` carries the one-time token; `roleLabel`
// is the human role name. Best-effort; the Team UI offers re-send.
export async function sendStaffInviteEmail(
  toEmail: string,
  inviteUrl: string,
  roleLabel: string,
): Promise<EmailResult> {
  const subject = "You've been invited to the LoreWire studio";
  const safeRole = escapeHtml(roleLabel);
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#111;">
<p>You've been invited to join the LoreWire studio as <strong>${safeRole}</strong>.</p>
<p>Click below to set your password and finish setting up your account. The link expires soon and works once.</p>
<p><a href="${inviteUrl}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">Accept invite</a></p>
<p style="color:#666;font-size:13px;">If you weren't expecting this, you can ignore the email.</p>
</body></html>`;
  const text =
    `You've been invited to join the LoreWire studio as ${roleLabel}.\n` +
    `Set your password and finish setup (link expires soon, works once):\n${inviteUrl}\n\n` +
    `Not expecting this? Ignore it.`;
  return sendBrevoEmail({ to: toEmail, subject, html, text });
}
