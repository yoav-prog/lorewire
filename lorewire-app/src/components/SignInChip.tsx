"use client";

// Header sign-in surface. Two visual states:
//
//   - Anonymous: a small "Sign in" pill that navigates to /auth/signin
//     with the current URL captured in ?next so the user lands back
//     where they were after sign-in.
//
//   - Signed in: the user's email initial + a sign-out button. The full
//     name / picture round-trip is Phase 6 polish; the initial is enough
//     to communicate "this is who you are."
//
// Why a pill and not a full button: the header is dense — Search,
// Settings, the mobile tab bar. A pill stays light visually and reads
// as "optional, not blocking" which matches the anonymous-first
// philosophy.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §UI surfaces.

import { useState } from "react";
import { clearSnooze } from "@/lib/nudge-client";
import type { PublicSession } from "@/lib/homepage-data";

interface SignInChipProps {
  session: PublicSession | null;
  /** Tone variant: 'subtle' for in-line spots like the desktop top bar,
   *  'prominent' for the My List header where we deliberately want the
   *  user to notice the offer. */
  tone?: "subtle" | "prominent";
}

function buildSignInHref(): string {
  // We construct ?next at click time, not on render, so navigating
  // away and coming back uses the current URL not the URL at mount.
  if (typeof window === "undefined") return "/auth/signin";
  const path = window.location.pathname + window.location.search;
  const next = encodeURIComponent(path === "/auth/signin" ? "/" : path);
  return `/auth/signin?next=${next}`;
}

function initial(email: string): string {
  return email.trim().charAt(0).toUpperCase() || "?";
}

export default function SignInChip({
  session,
  tone = "subtle",
}: SignInChipProps) {
  const [signingOut, setSigningOut] = useState(false);

  async function onSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const res = await fetch("/auth/signout", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) {
        console.warn("[auth ui signout failed]", { status: res.status });
        setSigningOut(false);
        return;
      }
      console.info("[auth ui signout ok]");
      // Hard reload so the server re-renders with the cleared
      // session. RSC dependents (initial.session) need a fresh
      // request to pick up the new state.
      window.location.assign(window.location.pathname);
    } catch (err) {
      console.warn("[auth ui signout network-error]", { err: String(err) });
      setSigningOut(false);
    }
  }

  if (!session) {
    const className =
      tone === "prominent"
        ? "inline-flex items-center gap-1 rounded-full border border-ink bg-ink px-3 py-1 text-xs font-semibold uppercase tracking-wider text-bg hover:opacity-90"
        : "inline-flex items-center gap-1 rounded-full border border-line bg-bg/70 px-3 py-1 text-xs font-medium text-ink hover:border-ink";
    return (
      <a
        href={buildSignInHref()}
        onClick={() => {
          // Clear snooze: if the user is actively opting in, the nudge
          // shouldn't pop again on their next save while they're mid-flow.
          clearSnooze();
        }}
        className={className}
        data-testid="signin-chip-anon"
      >
        Sign in
      </a>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-2"
      data-testid="signin-chip-user"
    >
      <span
        aria-hidden
        className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-accent text-[12px] font-bold uppercase text-bg"
        title={session.email}
      >
        {initial(session.email)}
      </span>
      <button
        type="button"
        onClick={onSignOut}
        disabled={signingOut}
        className="rounded-full border border-line bg-bg/70 px-3 py-1 text-xs font-medium text-muted hover:border-ink hover:text-ink disabled:opacity-60"
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </span>
  );
}
