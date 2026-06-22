"use client";

// Header sign-in surface. Two visual states + a click-to-open menu:
//
//   - Anonymous: a small "Sign in" pill that navigates to /auth/signin
//     with the current URL captured in ?next so the user lands back
//     where they were after sign-in.
//
//   - Signed in: the user's email initial as a circular avatar button.
//     Click → dropdown with Account / Manage cookies / Sign out. The
//     dropdown closes on outside-click or Escape, follows the page
//     direction (no fixed orientation), and traps the active item via
//     proper aria semantics so keyboard users can tab through.
//
// Why a pill / avatar and not a full button: the header is dense — Search,
// Settings, the mobile tab bar. A pill + avatar stays light visually and
// reads as "optional, not blocking" which matches the anonymous-first
// philosophy.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §UI surfaces.

import { useEffect, useRef, useState } from "react";
import { clearSnooze } from "@/lib/nudge-client";
import { dispatchReopenBanner } from "@/lib/consent-client";
import type { PublicSession } from "@/lib/homepage-data";

interface SignInChipProps {
  session: PublicSession | null;
  /** Tone variant: 'subtle' for in-line spots like the desktop top bar,
   *  'prominent' for the My List header where we deliberately want the
   *  user to notice the offer, 'overlay' for placement on top of hero
   *  imagery (mobile Billboard) — translucent glass pill that reads
   *  cleanly against any image without competing with story typography. */
  tone?: "subtle" | "prominent" | "overlay";
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
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLAnchorElement>(null);

  // Close on outside click / Escape. Wired only while the menu is open
  // so we don't keep a global listener around for no reason.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    // Pull focus into the menu so keyboard navigation just works.
    firstItemRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

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

  function onManageCookies() {
    setOpen(false);
    // Defer to the next tick so the menu close animation (if any) doesn't
    // race with the banner mount.
    setTimeout(() => dispatchReopenBanner(), 0);
  }

  if (!session) {
    const className =
      tone === "prominent"
        ? "inline-flex items-center gap-1 rounded-full border border-ink bg-ink px-3 py-1 text-xs font-semibold uppercase tracking-wider text-bg hover:opacity-90"
        : tone === "overlay"
          ? "inline-flex items-center gap-1 rounded-full border border-white/25 bg-black/35 px-3 py-1 text-xs font-medium text-white backdrop-blur-md hover:bg-black/55 hover:border-white/45 active:scale-[.97] transition"
          : "inline-flex items-center gap-1 rounded-full border border-line bg-bg/70 px-3 py-1 text-xs font-medium text-ink hover:border-ink";
    return (
      <a
        href={buildSignInHref()}
        onClick={() => {
          // Clear snooze: if the user is actively opting in, the nudge
          // shouldn't pop again on their next save while they're mid-flow.
          clearSnooze();
          console.info("[auth ui signin-chip click]", { tone });
        }}
        className={className}
        data-testid="signin-chip-anon"
      >
        Sign in
      </a>
    );
  }

  return (
    <div
      ref={rootRef}
      className="relative inline-flex"
      data-testid="signin-chip-user"
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-accent text-[13px] font-bold uppercase text-bg outline-none ring-offset-2 ring-offset-bg hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink"
        title={session.email}
      >
        {initial(session.email)}
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Account menu"
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-56 overflow-hidden rounded-xl border border-line bg-bg shadow-xl"
        >
          {/* Email header: read-only signal of which account you're on. */}
          <div className="border-b border-line px-3 py-2.5">
            <p className="text-[10px] font-mono uppercase tracking-[.2em] text-muted">
              Signed in as
            </p>
            <p className="truncate text-[13px] text-ink" title={session.email}>
              {session.email}
            </p>
          </div>
          <a
            ref={firstItemRef}
            href="/auth/account"
            role="menuitem"
            className="block px-3 py-2 text-sm text-ink hover:bg-ink/5 focus:bg-ink/5 focus:outline-none"
          >
            Account &amp; preferences
          </a>
          <a
            href="/?tab=mylist"
            role="menuitem"
            className="block px-3 py-2 text-sm text-ink hover:bg-ink/5 focus:bg-ink/5 focus:outline-none"
          >
            My List
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={onManageCookies}
            className="block w-full text-left px-3 py-2 text-sm text-ink hover:bg-ink/5 focus:bg-ink/5 focus:outline-none"
          >
            Manage cookies
          </button>
          <div className="border-t border-line" />
          <button
            type="button"
            role="menuitem"
            onClick={onSignOut}
            disabled={signingOut}
            className="block w-full text-left px-3 py-2 text-sm text-muted hover:bg-ink/5 hover:text-ink focus:bg-ink/5 focus:outline-none disabled:opacity-60"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
