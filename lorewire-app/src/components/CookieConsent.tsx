"use client";

// Non-blocking cookie-consent banner. Bottom of viewport, fixed, doesn't
// cover content. Two equal-weight buttons (Accept / Reject) — no dark
// pattern, no smart-dismiss. Focus moves to Accept on mount so keyboard
// users can press Enter immediately.
//
// Mount logic:
//   1. SSR: render nothing (consent state isn't known server-side).
//   2. First client effect:
//      - Read the `lw_consent` cookie.
//      - If decided ("accepted" | "rejected") → render nothing.
//      - If undecided:
//          - If the browser already has persisted state from before the
//            banner existed (lw.saved.v1 entries, lw.liked.v1 entries,
//            or the lw_vote cookie), silently POST consent=accepted —
//            existing users are de facto consenting and shouldn't see a
//            retroactive banner (plan §Cookie consent · First-run
//            grandfather, decision recorded 2026-06-19).
//          - Otherwise show the banner.
//   3. After Accept / Reject: hide the banner, broadcast the change to
//      every consent subscriber.
//   4. The "Manage cookies" footer link (Phase 6) dispatches a
//      'lw:consent:reopen' custom event that this component listens for
//      to re-display itself even when consent is already decided.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §Cookie consent.

import { useEffect, useRef, useState } from "react";
import {
  hasGrandfatherableState,
  readConsentCookie,
  setConsentClient,
  useConsent,
} from "@/lib/consent-client";

type Copy = {
  body: string;
  accept: string;
  reject: string;
  error: string;
  dir: "ltr" | "rtl";
};

const COPY_EN: Copy = {
  body: "We save your activity (saved stories, progress) on this device so it's still here next time. No tracking, no third parties. Reject also clears anything we've saved so far on this device.",
  accept: "Accept",
  reject: "Reject",
  error: "Couldn't save your choice. Try again in a moment.",
  dir: "ltr",
};

const COPY_HE: Copy = {
  body: "אנחנו שומרים את הפעילות שלך (סיפורים שמורים, התקדמות) במכשיר הזה כדי שתישאר זמינה בפעם הבאה. בלי מעקב, בלי צד שלישי. דחייה גם תמחק כל מה ששמרנו עד עכשיו במכשיר הזה.",
  accept: "אישור",
  reject: "דחייה",
  error: "לא הצלחנו לשמור את הבחירה. נסו שוב בעוד רגע.",
  dir: "rtl",
};

function pickCopy(): Copy {
  if (typeof navigator === "undefined") return COPY_EN;
  const lang = (navigator.language || "en").toLowerCase();
  return lang.startsWith("he") ? COPY_HE : COPY_EN;
}

export default function CookieConsent() {
  const consent = useConsent();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errored, setErrored] = useState(false);
  const [copy, setCopy] = useState<Copy>(COPY_EN);
  const acceptRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setCopy(pickCopy());
    // Resolve consent synchronously: useConsent()'s store seeds its value in a
    // subscribe effect, so on mount it can report null (unread) one render
    // before the real value lands. Reading the cookie directly closes that gap
    // — trusting the transient null is what showed the banner on every reload
    // even seconds after the choice was already saved.
    const decided = consent ?? readConsentCookie();
    if (decided !== null) {
      console.info("[auth ui consent banner skip-decided]", { consent: decided });
      // Decided already — make sure the banner is hidden. The old code
      // returned here without hiding, so a banner shown during the transient
      // null phase stayed stuck on screen.
      setVisible(false);
      return;
    }
    if (hasGrandfatherableState()) {
      console.info("[auth ui consent banner grandfather]");
      void setConsentClient("accepted");
      setVisible(false);
      return;
    }
    console.info("[auth ui consent banner show]");
    setVisible(true);
  }, [consent]);

  useEffect(() => {
    const onReopen = () => {
      console.info("[auth ui consent banner reopen]");
      setVisible(true);
    };
    window.addEventListener("lw:consent:reopen", onReopen);
    return () => window.removeEventListener("lw:consent:reopen", onReopen);
  }, []);

  useEffect(() => {
    if (visible) acceptRef.current?.focus();
  }, [visible]);

  if (!visible) return null;

  async function decide(value: "accepted" | "rejected") {
    if (busy) return;
    setBusy(true);
    setErrored(false);
    const ok = await setConsentClient(value);
    setBusy(false);
    if (ok) {
      setVisible(false);
      return;
    }
    // The POST round-trip failed (origin mismatch, network, or 500).
    // Phase 1 silently swallowed this and the user had no signal —
    // they'd hammer Accept hoping it'd take. Surface a single
    // localized line; the button stays enabled so the next click
    // retries.
    console.warn("[auth ui consent retry-needed]", { value });
    setErrored(true);
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="lw-consent-body"
      dir={copy.dir}
      className="fixed inset-x-2 bottom-2 z-50 mx-auto max-w-3xl rounded-xl border border-line bg-bg/95 p-4 text-sm text-ink shadow-lg backdrop-blur-md sm:inset-x-4 sm:bottom-4 sm:p-5"
    >
      <p id="lw-consent-body" className="leading-relaxed text-muted">
        {copy.body}
      </p>
      {errored ? (
        <p
          role="alert"
          className="mt-2 rounded-md border border-red-400/40 bg-red-500/10 p-2 text-[12px] text-red-300"
        >
          {copy.error}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2 sm:justify-end">
        <button
          type="button"
          onClick={() => decide("rejected")}
          disabled={busy}
          className="rounded-md border border-line bg-bg px-3 py-1.5 text-sm font-medium text-ink hover:border-ink disabled:opacity-60"
        >
          {copy.reject}
        </button>
        <button
          ref={acceptRef}
          type="button"
          onClick={() => decide("accepted")}
          disabled={busy}
          className="rounded-md border border-ink bg-ink px-3 py-1.5 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-60"
        >
          {copy.accept}
        </button>
      </div>
    </div>
  );
}
