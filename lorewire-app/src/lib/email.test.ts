// Email sender coverage. The contracts that matter: it's best-effort (returns
// ok:false instead of throwing when unconfigured) and the admin-authored
// suspension reason is HTML-escaped before it reaches the message body, so a
// reason can never inject markup into the email.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  sendAccountDeletedEmail,
  sendAccountSuspendedEmail,
  sendBrevoEmail,
} from "./email";

const ORIG_KEY = process.env.BREVO_API_KEY;

function restoreKey(): void {
  if (ORIG_KEY === undefined) delete process.env.BREVO_API_KEY;
  else process.env.BREVO_API_KEY = ORIG_KEY;
}

describe("sendBrevoEmail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreKey();
  });

  it("returns ok:false (never throws) when no API key is configured", async () => {
    delete process.env.BREVO_API_KEY;
    const r = await sendBrevoEmail({
      to: "a@b.com",
      subject: "s",
      html: "<p>x</p>",
      text: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/BREVO_API_KEY/);
  });

  it("POSTs to the Brevo endpoint and returns the messageId", async () => {
    process.env.BREVO_API_KEY = "key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messageId: "msg-1" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await sendBrevoEmail({
      to: "a@b.com",
      subject: "s",
      html: "<p>x</p>",
      text: "x",
    });
    expect(r.ok).toBe(true);
    expect(r.messageId).toBe("msg-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.brevo.com/v3/smtp/email",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("sendAccountSuspendedEmail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreKey();
  });

  function capturePayload(): {
    payload: () => { htmlContent: string; textContent: string };
  } {
    let captured = "";
    const fetchMock = vi
      .fn()
      .mockImplementation((_url: string, init: RequestInit) => {
        captured = String(init.body);
        return Promise.resolve({ ok: true, json: async () => ({ messageId: "m" }) });
      });
    vi.stubGlobal("fetch", fetchMock);
    return { payload: () => JSON.parse(captured) };
  }

  it("HTML-escapes the admin reason in the HTML body — no markup injection", async () => {
    process.env.BREVO_API_KEY = "key";
    const cap = capturePayload();
    await sendAccountSuspendedEmail("a@b.com", "<script>alert(1)</script>");
    // The rendered (HTML) body must escape the reason; the plain-text part
    // carries the raw reason, which is inert in text/plain and would look
    // wrong escaped.
    expect(cap.payload().htmlContent).not.toContain("<script>");
    expect(cap.payload().htmlContent).toContain("&lt;script&gt;");
  });

  it("omits the reason line from both parts when no reason is given", async () => {
    process.env.BREVO_API_KEY = "key";
    const cap = capturePayload();
    await sendAccountSuspendedEmail("a@b.com");
    expect(cap.payload().htmlContent).not.toContain("Reason:");
    expect(cap.payload().textContent).not.toContain("Reason:");
  });
});

describe("sendAccountDeletedEmail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreKey();
  });

  it("sends the deletion notice to the address", async () => {
    process.env.BREVO_API_KEY = "key";
    let captured = "";
    const fetchMock = vi
      .fn()
      .mockImplementation((_url: string, init: RequestInit) => {
        captured = String(init.body);
        return Promise.resolve({ ok: true, json: async () => ({ messageId: "m" }) });
      });
    vi.stubGlobal("fetch", fetchMock);
    const r = await sendAccountDeletedEmail("gone@example.com");
    expect(r.ok).toBe(true);
    const payload = JSON.parse(captured);
    expect(payload.subject).toMatch(/deleted/i);
    expect(payload.to).toEqual([{ email: "gone@example.com" }]);
  });
});
