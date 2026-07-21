"use client";

// Bridges CCM19 (the consent banner + record layer) into the in-app
// consent plumbing. Mounted from AppShell INSTEAD of CookieConsent when
// NEXT_PUBLIC_CCM19_SRC is set; renders nothing — CCM19's own widget is
// the UI.
//
// What it does:
//   1. On mount and on every CCM19 lifecycle event, derive the in-app
//      consent value from window.CCM and POST it through
//      setConsentClient() when it differs from the current lw_consent
//      cookie. Downstream (ConditionalAnalytics, engagement stores,
//      lw_anon issuance, reject-clears-localStorage) is untouched.
//   2. Re-route the footer "Manage cookies" event (lw:consent:reopen,
//      previously handled by CookieConsent) to CCM.openWidget().
//
// Event coverage: ccm19WidgetLoaded fires when CCM19 finishes
// initializing — listeners are registered BEFORE the mount-time sync so a
// script that initializes between the two can't slip through unseen.
// ccm19WidgetClosed fires after the visitor saves a choice (including
// reject, which fires no accept event). ccm19EmbeddingAccepted fires per
// accepted embedding on every pageload; the differs-from-cookie guard
// keeps that from turning into repeated POSTs.
//
// Fail-closed: if app.js is blocked (adblock) or breaks, window.CCM never
// appears, every derive returns null, lw_consent stays unset, and
// analytics never load.
//
// Plan: _plans/2026-07-02-gdpr-ccm19-consent.md.

import { useEffect } from "react";
import { CCM19_EMBEDDING, deriveConsentFromCcm } from "@/lib/ccm19";
import {
  readConsentCookie,
  setConsentClient,
  type ConsentValue,
} from "@/lib/consent-client";

const CCM_EVENTS = [
  "ccm19WidgetLoaded",
  "ccm19WidgetClosed",
  "ccm19EmbeddingAccepted",
] as const;

export default function Ccm19Bridge() {
  useEffect(() => {
    let cancelled = false;
    // Value currently being POSTed. ccm19EmbeddingAccepted and
    // ccm19WidgetClosed fire back-to-back after a save; without this, the
    // second sync would re-POST before the first response set the cookie.
    let inFlight: ConsentValue | null = null;

    const sync = async (trigger: string) => {
      if (cancelled) return;
      const derived = deriveConsentFromCcm(window.CCM, CCM19_EMBEDDING);
      const current = readConsentCookie();
      console.info("[consent ccm19] sync", {
        trigger,
        derived,
        current,
        ccmPresent: !!window.CCM,
      });
      if (derived === null || derived === current || derived === inFlight) {
        return;
      }
      inFlight = derived;
      const ok = await setConsentClient(derived);
      inFlight = null;
      if (!ok) console.warn("[consent ccm19] sync-failed", { derived });
    };

    const handlers = CCM_EVENTS.map((name) => {
      const handler = () => void sync(name);
      window.addEventListener(name, handler);
      return [name, handler] as const;
    });
    void sync("mount");

    return () => {
      cancelled = true;
      handlers.forEach(([name, handler]) =>
        window.removeEventListener(name, handler),
      );
    };
  }, []);

  useEffect(() => {
    const onReopen = () => {
      const ccm = window.CCM;
      console.info("[consent ccm19] reopen", { ccmPresent: !!ccm });
      if (ccm?.openWidget) {
        ccm.openWidget();
        return;
      }
      // CCM19 blocked or not yet loaded — the footer button can't open
      // anything. Surface it instead of failing silently.
      console.warn("[consent ccm19] reopen-unavailable", {
        reason: "window.CCM.openWidget missing",
      });
    };
    window.addEventListener("lw:consent:reopen", onReopen);
    return () => window.removeEventListener("lw:consent:reopen", onReopen);
  }, []);

  return null;
}
