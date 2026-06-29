// User-facing Settings page. Anonymous-friendly — no session redirect.
// Most settings are localStorage-backed via the same consent-gated
// useSyncExternalStore stores Wires + Stories already use. The page
// server-renders a static shell + reads the session ONLY to decide
// whether to surface the cross-link to /auth/account (which IS
// authenticated-only).
//
// Layout mirrors /auth/account: mx-auto max-w-xl px-6 py-10 centered
// card, with a back-to-home link at the top.
//
// Plan: _plans/2026-06-25-user-settings-page.md.

import Link from "next/link";

import { readUserSession } from "@/lib/user-session";

import SettingsClient from "./SettingsClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Settings · LoreWire",
  description: "Playback and privacy controls for LoreWire.",
};

export default async function SettingsPage() {
  // Session is informational here — used only to gate the Account
  // cross-link. Anonymous visitors still get the full page; their
  // settings persist in localStorage exactly like for signed-in users
  // (a server-side sync ships later when registered-user prefs land).
  const session = await readUserSession();
  return (
    <div className="mx-auto max-w-xl px-6 py-10">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-[12px] font-mono uppercase tracking-[.2em] text-muted hover:text-ink"
      >
        ← Back
      </Link>
      <h1 className="mt-4 font-display text-2xl font-bold uppercase tracking-tight text-ink">
        Settings
      </h1>
      <p className="mt-2 text-sm text-muted">
        Playback preferences and privacy controls. Changes save to this
        browser and apply across the site.
      </p>

      <SettingsClient hasSession={Boolean(session)} />
    </div>
  );
}
