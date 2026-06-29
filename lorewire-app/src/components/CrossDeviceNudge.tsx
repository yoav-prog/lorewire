"use client";

// First-save sign-in nudge. Slide-up sheet that appears once the user
// transitions from 0 to ≥1 saved stories AND isn't signed in AND
// hasn't snoozed AND hasn't already snoozed in the past (return
// visitors get the persistent "Save across devices" header link
// instead — see SignInChip / shells).
//
// Non-blocking: the save action itself does not wait for the nudge.
// The user sees the save take effect immediately; the nudge appears
// at the bottom as a sheet they can dismiss with one tap.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §Locked decisions §3.

import { useEffect, useRef, useState } from "react";

import { useSavedStories } from "@/lib/engagement-store";
import {
  hasEverSnoozed,
  isNudgeSnoozed,
  snoozeNudge,
} from "@/lib/nudge-client";
import type { PublicSession } from "@/lib/homepage-data";

interface CrossDeviceNudgeProps {
  session: PublicSession | null;
}

function buildSignInHref(): string {
  if (typeof window === "undefined") return "/auth/signin";
  const path = window.location.pathname + window.location.search;
  const next = encodeURIComponent(path === "/auth/signin" ? "/" : path);
  return `/auth/signin?next=${next}`;
}

export default function CrossDeviceNudge({ session }: CrossDeviceNudgeProps) {
  const { saved } = useSavedStories();
  const prevCount = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);
  const fired = useRef(false);

  useEffect(() => {
    // Already signed in → never fire. Persistent header link takes over.
    if (session) return;
    const next = saved.length;
    const prev = prevCount.current;
    // First render: just capture, don't fire — useSyncExternalStore's
    // initial snapshot is what the user had before the page opened,
    // not "they just saved one." A real transition only happens on
    // subsequent renders when prev is non-null.
    if (prev === null) {
      prevCount.current = next;
      return;
    }
    prevCount.current = next;
    if (fired.current) return;
    // The transition we care about: prev was 0, next is ≥1. Anything
    // else (toggling a saved story off, re-saving, etc.) is silent.
    if (prev > 0 || next === 0) return;
    if (isNudgeSnoozed()) {
      console.info("[auth ui nudge skip-snoozed]");
      return;
    }
    if (hasEverSnoozed()) {
      // Don't re-modal a return visitor — they've made the call once
      // already. The persistent header link is their entry point.
      console.info("[auth ui nudge skip-ever-snoozed]");
      return;
    }
    console.info("[auth ui nudge fire]", { saved_count: next });
    fired.current = true;
    setVisible(true);
  }, [saved, session]);

  if (!visible || session) return null;

  function dismiss() {
    snoozeNudge();
    setVisible(false);
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="lw-nudge-title"
      data-testid="cross-device-nudge"
      className="fixed inset-x-2 bottom-2 z-40 mx-auto max-w-md rounded-xl border border-line bg-bg/95 p-4 text-sm text-ink shadow-2xl backdrop-blur-md sm:inset-x-4 sm:bottom-4 sm:p-5"
    >
      <p
        id="lw-nudge-title"
        className="font-display text-base font-bold uppercase tracking-tight text-ink"
      >
        Keep this across devices?
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">
        Sign in so your saved stories show up on every device — phone,
        tablet, laptop. Free, no inbox spam.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a
          href={buildSignInHref()}
          onClick={() => setVisible(false)}
          className="flex-1 rounded-md border border-ink bg-ink px-3 py-2 text-center text-sm font-medium text-bg hover:opacity-90"
        >
          Sign in
        </a>
        <button
          type="button"
          onClick={dismiss}
          className="flex-1 rounded-md border border-line bg-bg px-3 py-2 text-sm font-medium text-muted hover:border-ink hover:text-ink"
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}
