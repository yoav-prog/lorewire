// CCM19 consent-management platform (CMP) integration: env switches, the
// window.CCM surface we rely on, and the pure mapping from CCM19 state to
// the in-app consent value.
//
// Division of labor: CCM19 is the consent UI and the auditable
// consent-record layer (its banner replaces CookieConsent.tsx when
// enabled). The in-app plumbing — the `lw_consent` cookie, POST
// /api/consent, ConditionalAnalytics' gate, localStorage clearing on
// reject — stays the source of truth the rest of the app reads.
// Ccm19Bridge.tsx syncs CCM19 decisions into that plumbing.
//
// This module deliberately carries neither "use client" nor "server-only":
// the server root layout reads CCM19_SRC/CCM19_ENABLED for the script tag,
// and the client bridge reads the same flags plus the mapping helper. Only
// build-time-inlined NEXT_PUBLIC_ values and pure code live here.
//
// Plan: _plans/2026-07-02-gdpr-ccm19-consent.md.

import type { ConsentValue } from "@/lib/consent-client";

/** Full URL of the CCM19 app.js snippet (host + apiKey + domain params).
 *  Unset → CCM19 is disabled and the first-party CookieConsent banner
 *  keeps running unchanged. This is the rollout AND rollback switch. */
export const CCM19_SRC = process.env.NEXT_PUBLIC_CCM19_SRC ?? "";

/** Require https so a typo'd or tampered env value can't inject a
 *  non-TLS script into every page. */
export const CCM19_ENABLED = CCM19_SRC.startsWith("https://");

/** Name of the CCM19 embedding/purpose that stands for "analytics +
 *  device personalization" in the CCM19 dashboard. Matched
 *  case-insensitively against CCM.acceptedEmbeddings so the bridge keeps
 *  working if more purposes are added later. Optional: when unset, only
 *  fullConsentGiven counts as an accept. */
export const CCM19_EMBEDDING = process.env.NEXT_PUBLIC_CCM19_EMBEDDING ?? "";

/** The slice of CCM19's window.CCM API the bridge consumes. Everything is
 *  optional because the script is third-party: it may be blocked, slow, or
 *  change shape — absent fields must degrade to "undecided", never throw.
 *  API reference: https://docs.ccm19.com/api/javascript-apis/ */
export interface CcmEmbedding {
  name?: string;
}

export interface CcmApi {
  /** True once the visitor has configured and saved consent settings. */
  consent?: boolean;
  /** True when the visitor accepted every option. */
  fullConsentGiven?: boolean;
  /** Embeddings the visitor accepted. */
  acceptedEmbeddings?: CcmEmbedding[];
  /** Opens the consent dialog (wired to the footer "Manage cookies"). */
  openWidget?: () => void;
}

declare global {
  interface Window {
    CCM?: CcmApi;
  }
}

/** Map CCM19 state to the in-app consent value.
 *
 *  - No CCM object / nothing saved yet → null. The bridge must never
 *    overwrite an existing lw_consent with "undecided" — a returning user
 *    who accepted under the old banner keeps that consent until they make
 *    a choice in the CCM19 widget.
 *  - Everything accepted → "accepted".
 *  - The named analytics/personalization embedding accepted → "accepted".
 *  - A choice was saved and our purpose is not in it → "rejected". */
export function deriveConsentFromCcm(
  ccm: CcmApi | undefined,
  embeddingName: string,
): ConsentValue | null {
  if (!ccm || ccm.consent !== true) return null;
  if (ccm.fullConsentGiven === true) return "accepted";
  if (embeddingName) {
    const wanted = embeddingName.toLowerCase();
    const accepted = ccm.acceptedEmbeddings ?? [];
    if (accepted.some((e) => e.name?.toLowerCase() === wanted)) {
      return "accepted";
    }
  }
  return "rejected";
}
