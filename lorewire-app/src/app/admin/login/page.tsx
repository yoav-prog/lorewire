"use client";

import { useActionState } from "react";
import { login, type LoginState } from "@/app/admin/actions";

const INITIAL: LoginState = {};

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, INITIAL);

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-[360px]">
        <div className="mb-8 text-center">
          {/* 2026-06-26 slice H follow-up: admin login wordmark
              locked to Archivo. */}
          <div className="text-[26px] font-extrabold tracking-tightest text-ink" style={{ fontFamily: "var(--font-archivo), Arial, sans-serif" }}>
            LORE<span className="text-accent">WIRE</span>
          </div>
          <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            Studio
          </div>
        </div>

        <form
          action={action}
          className="rounded-2xl border border-line bg-surface p-6 shadow-2xl"
        >
          <label className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted">
            Email
          </label>
          <input
            name="email"
            type="email"
            autoComplete="username"
            autoFocus
            className="mb-4 w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-ink outline-none focus:border-accent"
          />

          <label className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted">
            Password
          </label>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            className="mb-5 w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-ink outline-none focus:border-accent"
          />

          {state?.needsMfa && (
            <>
              <label className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted">
                Authentication code
              </label>
              <input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                placeholder="6-digit code or a backup code"
                className="mb-2 w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-ink outline-none focus:border-accent"
              />
              <p className="mb-4 font-mono text-[10px] text-muted">
                From your authenticator app — or use one of your backup codes.
              </p>
            </>
          )}

          {state?.error && (
            <p className="mb-4 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-[13px] text-ink">
              {state.error}
            </p>
          )}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-lg bg-accent py-2.5 font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {pending
              ? "Signing in..."
              : state?.needsMfa
                ? "Verify"
                : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
