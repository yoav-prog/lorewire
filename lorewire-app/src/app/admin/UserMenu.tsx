"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useTheme, type ThemeChoice } from "@/components/ThemeProvider";

// Header-right user menu. Replaces the bare email + sign-out button that lived
// in the panel header. Dropdown opens on click, closes on outside click or
// Escape. Theme cycles dark / light / system and persists per-browser;
// Account links to /admin/account.
//
// The Sign out form is passed in as a server-rendered slot so the server
// action stays out of the client bundle and React's component-boundary
// guarantees are preserved.

export default function UserMenu({
  email,
  signOutSlot,
}: {
  email: string;
  signOutSlot: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const initial = (email.trim().charAt(0) || "?").toUpperCase();
  const { choice: themeChoice, setChoice: setThemeChoice } = useTheme();

  function cycleTheme() {
    const order: ThemeChoice[] = ["dark", "light", "system"];
    const idx = order.indexOf(themeChoice);
    const next = order[(idx + 1) % order.length];
    setThemeChoice(next);
  }

  // Esc closes the menu. Outside-click handled by a separate transparent
  // backdrop element so we don't need a global document listener.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    console.info("[admin user-menu] opened", { email });
  }, [open, email]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 rounded-md border border-line bg-bg px-2 py-1 transition-colors hover:border-accent"
      >
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-accent text-[12px] font-bold text-bg">
          {initial}
        </span>
        <span className="hidden font-mono text-[11px] text-muted sm:inline">
          {email}
        </span>
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default"
          />
          <div
            role="menu"
            aria-label="Account"
            className="absolute right-0 top-[calc(100%+4px)] z-40 w-[240px] rounded-lg border border-line bg-surface p-2 shadow-lg"
          >
            <div className="px-3 py-2">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
                Signed in as
              </div>
              <div className="mt-0.5 break-all font-mono text-[12px] text-ink">
                {email}
              </div>
            </div>
            <div className="my-1 h-px bg-line" />
            <button
              type="button"
              role="menuitem"
              onClick={cycleTheme}
              title="Cycle dark / light / system"
              className="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left font-mono text-[12px] text-ink transition-colors hover:bg-surface2"
            >
              <span>Theme</span>
              <span className="text-[10px] uppercase tracking-wider text-muted">
                {themeChoice}
              </span>
            </button>
            <Link
              role="menuitem"
              href="/admin/account"
              onClick={() => setOpen(false)}
              className="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left font-mono text-[12px] text-ink transition-colors hover:bg-surface2"
            >
              <span>Account</span>
              <span className="text-[10px] uppercase tracking-wider text-muted">
                →
              </span>
            </Link>
            <div className="my-1 h-px bg-line" />
            <div role="menuitem">{signOutSlot}</div>
          </div>
        </>
      )}
    </div>
  );
}
