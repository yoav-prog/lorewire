"use client";

// Email + password signup form. Validates client-side first (the server
// re-validates regardless — see lib/users.ts:createPasswordUser) so the
// user gets fast feedback on "passwords don't match" / "password too
// short" without a round trip.

import { useState } from "react";

interface SignupFormProps {
  next: string | undefined;
}

const PASSWORD_MIN = 8;

export default function SignupForm({ next }: SignupFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function clientValidate(): string | null {
    if (!email.includes("@")) return "Enter a valid email address.";
    if (password.length < PASSWORD_MIN) {
      return `Password must be at least ${PASSWORD_MIN} characters.`;
    }
    if (password !== confirm) return "Passwords don't match.";
    return null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const localErr = clientValidate();
    if (localErr) {
      setErr(localErr);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, password, next }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; next?: string }
        | null;
      if (!res.ok || !data?.ok) {
        setErr(data?.error ?? "Couldn't create your account. Try again.");
        setBusy(false);
        return;
      }
      // Hard navigation so the server re-renders with the new lw_user
      // cookie picked up by initial.session.
      window.location.assign(data.next ?? "/");
    } catch (err) {
      console.warn("[auth signup network]", { err: String(err) });
      setErr("Network problem. Try again.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-5 space-y-3" noValidate>
      <label htmlFor="lw-signup-email" className="block">
        <span className="block text-[12px] font-mono uppercase tracking-[.2em] text-muted">
          Email
        </span>
        <input
          id="lw-signup-email"
          type="email"
          inputMode="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          placeholder="you@example.com"
          className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2.5 text-[14px] text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
        />
      </label>

      <label htmlFor="lw-signup-password" className="block">
        <span className="block text-[12px] font-mono uppercase tracking-[.2em] text-muted">
          Password
        </span>
        <input
          id="lw-signup-password"
          type="password"
          required
          minLength={PASSWORD_MIN}
          maxLength={128}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          placeholder={`At least ${PASSWORD_MIN} characters`}
          className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2.5 text-[14px] text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
        />
      </label>

      <label htmlFor="lw-signup-confirm" className="block">
        <span className="block text-[12px] font-mono uppercase tracking-[.2em] text-muted">
          Confirm password
        </span>
        <input
          id="lw-signup-confirm"
          type="password"
          required
          minLength={PASSWORD_MIN}
          maxLength={128}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={busy}
          placeholder="Type it again"
          className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2.5 text-[14px] text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
        />
      </label>

      <button
        type="submit"
        disabled={busy || !email || !password || !confirm}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Creating your account…" : "Create account"}
      </button>

      {err ? (
        <p
          role="alert"
          className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        >
          {err}
        </p>
      ) : null}
    </form>
  );
}
