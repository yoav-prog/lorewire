"use client";

// Client island for the sign-in page. Three buttons: Google OAuth start,
// Microsoft OAuth start, magic-link email form. Magic-link posts to
// /auth/magic-link/request and swaps to a "check your inbox" confirmation
// regardless of whether the email exists (no enumeration leak — the
// server handles that).
//
// Phase 5 will replace the visual chrome with the polished slide-up
// nudge; the underlying handlers and request shape stay the same.

import { useState } from "react";

interface SignInFormProps {
  next: string | undefined;
  googleEnabled: boolean;
  microsoftEnabled: boolean;
  redditEnabled: boolean;
  magicLinkEnabled: boolean;
}

function buildStartUrl(
  provider: "google" | "microsoft" | "reddit",
  next?: string,
): string {
  const url = new URL(`/auth/${provider}/start`, window.location.origin);
  if (next) url.searchParams.set("next", next);
  return url.toString();
}

export default function SignInForm({
  next,
  googleEnabled,
  microsoftEnabled,
  redditEnabled,
  magicLinkEnabled,
}: SignInFormProps) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submitMagic(e: React.FormEvent) {
    e.preventDefault();
    if (!email || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/auth/magic-link/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, next }),
      });
      if (!res.ok) {
        setErr("Couldn't send the link. Check the email and try again.");
        setBusy(false);
        return;
      }
      setSent(true);
    } catch (e) {
      setErr("Network problem. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 space-y-4">
      {googleEnabled ? (
        <a
          href={buildStartUrl("google", next)}
          className="block w-full rounded-md border border-line bg-bg px-4 py-2 text-center text-sm font-medium text-ink hover:border-ink"
        >
          Continue with Google
        </a>
      ) : null}

      {microsoftEnabled ? (
        <a
          href={buildStartUrl("microsoft", next)}
          className="block w-full rounded-md border border-line bg-bg px-4 py-2 text-center text-sm font-medium text-ink hover:border-ink"
        >
          Continue with Microsoft
        </a>
      ) : null}

      {redditEnabled ? (
        <a
          href={buildStartUrl("reddit", next)}
          className="block w-full rounded-md border border-line bg-bg px-4 py-2 text-center text-sm font-medium text-ink hover:border-ink"
        >
          Continue with Reddit
        </a>
      ) : null}

      {magicLinkEnabled ? (
        <div className="rounded-md border border-line bg-bg p-4">
          {sent ? (
            <p className="text-sm text-muted">
              If <span className="text-ink">{email}</span> is valid, a sign-in
              link is on the way. It expires in 15 minutes.
            </p>
          ) : (
            <form onSubmit={submitMagic} className="space-y-3">
              <label className="block text-sm font-medium text-ink">
                Email
                <input
                  type="email"
                  inputMode="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                  className="mt-1 block w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none disabled:opacity-60"
                  placeholder="you@example.com"
                />
              </label>
              <button
                type="submit"
                disabled={busy || !email}
                className="block w-full rounded-md border border-ink bg-ink px-4 py-2 text-center text-sm font-medium text-bg hover:opacity-90 disabled:opacity-60"
              >
                {busy ? "Sending..." : "Email me a sign-in link"}
              </button>
              {err ? (
                <p className="text-sm text-red-300" role="alert">
                  {err}
                </p>
              ) : null}
            </form>
          )}
        </div>
      ) : null}

      {!googleEnabled &&
      !microsoftEnabled &&
      !redditEnabled &&
      !magicLinkEnabled ? (
        <p className="text-sm text-muted">
          Sign-in is not configured yet. Check back soon.
        </p>
      ) : null}
    </div>
  );
}
