// Client-side cookie-consent store. Pairs with src/lib/consent.ts (the
// server source of truth). The browser reads the `lw_consent` cookie
// directly (it's non-HttpOnly) so consent state is available
// synchronously on every render — no useEffect flash, no fetch.
//
// Why expose a store and not just a single read helper: multiple components
// react to consent changes (the banner shows/hides, engagement-store
// branches its writes, the future cookie-settings dialog re-opens the
// banner). useSyncExternalStore gives us O(1) re-renders on every
// consumer when the value flips, with no prop drilling and no global
// state library — matching the existing engagement-store pattern.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §Cookie consent.

import { useSyncExternalStore } from "react";

export type ConsentValue = "accepted" | "rejected";
type Listener = () => void;

const CONSENT_COOKIE = "lw_consent";

/** Parse a single cookie value out of document.cookie. Returns null when
 *  the cookie is unset, empty, or the value isn't a known consent state.
 *  Defense: a malformed cookie shouldn't trip the client into thinking
 *  consent has been decided.
 *
 *  Exported so the banner can read consent SYNCHRONOUSLY on mount: the
 *  useConsent() store seeds its value in a subscribe effect, so it reports
 *  null (unread) for one render before the real value lands, and trusting
 *  that transient null left the banner stuck on screen after a reload. */
export function readConsentCookie(): ConsentValue | null {
  if (typeof document === "undefined") return null;
  const cookies = document.cookie.split("; ");
  for (const pair of cookies) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name !== CONSENT_COOKIE) continue;
    const raw = decodeURIComponent(pair.slice(eq + 1));
    if (raw === "accepted" || raw === "rejected") return raw;
    return null;
  }
  return null;
}

/** True when the user has done at least one thing that wrote persistent
 *  state under the old (pre-banner) regime. The grandfather branch in the
 *  banner mount uses this to skip the banner for existing users — they've
 *  already de facto consented by saving / liking / voting. New visitors
 *  (no prior state) see the banner normally. */
function hasPriorPersistedState(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const saved = window.localStorage.getItem("lw.saved.v1");
    if (saved && saved !== "[]" && saved !== "null") return true;
    const liked = window.localStorage.getItem("lw.liked.v1");
    if (liked && liked !== "[]" && liked !== "null") return true;
  } catch {
    // private mode / quota — fall through to cookie check
  }
  if (typeof document !== "undefined") {
    const c = document.cookie;
    if (c.includes("lw_vote=")) return true;
  }
  return false;
}

interface ConsentStore {
  subscribe: (cb: Listener) => () => void;
  getSnapshot: () => ConsentValue | null;
  getServerSnapshot: () => ConsentValue | null;
}

function createConsentStore(): ConsentStore {
  let cached: ConsentValue | null = null;
  const listeners = new Set<Listener>();
  let started = false;

  const refresh = () => {
    const next = readConsentCookie();
    if (next !== cached) {
      cached = next;
      listeners.forEach((l) => l());
    }
  };

  const start = () => {
    if (started || typeof window === "undefined") return;
    started = true;
    cached = readConsentCookie();
    // Other tabs setting consent → re-read here. document.cookie has no
    // change event, but localStorage events fire cross-tab so we mirror
    // a marker in localStorage on every server-acknowledged change.
    window.addEventListener("storage", (e) => {
      if (e.key === "lw.consent.ping") refresh();
    });
    // Same-tab updates dispatch this custom event after a successful POST
    // /api/consent — see setConsentClient below.
    window.addEventListener("lw:consent:change", refresh);
  };

  return {
    subscribe(cb) {
      start();
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot() {
      return cached;
    },
    getServerSnapshot() {
      // Server-render: we don't know consent. Returning null is correct —
      // the banner mount logic doesn't reveal until the client effect
      // runs, so SSR sees "undecided" and doesn't flash.
      return null;
    },
  };
}

const consentStore = createConsentStore();

/** Subscribe to consent state. Returns null until the client cookie has
 *  been read (effectively first render in the browser). */
export function useConsent(): ConsentValue | null {
  return useSyncExternalStore(
    consentStore.subscribe,
    consentStore.getSnapshot,
    consentStore.getServerSnapshot,
  );
}

/** Synchronously check whether the client already has persisted state from
 *  before the banner existed. Used by the banner mount to decide between
 *  "show banner" and "grandfather silently". */
export function hasGrandfatherableState(): boolean {
  return hasPriorPersistedState();
}

/** POST /api/consent and broadcast the change to subscribers. The server
 *  sets both `lw_consent` and (on accept) `lw_anon`. We bump
 *  `lw.consent.ping` so other tabs notice via the storage event, and
 *  dispatch the same-tab custom event for instant in-tab re-renders. */
export async function setConsentClient(value: ConsentValue): Promise<boolean> {
  console.info("[auth ui consent set]", { value });
  let res: Response;
  try {
    res = await fetch("/api/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
  } catch (err) {
    console.warn("[auth ui consent network-error]", {
      value,
      err: String(err),
    });
    return false;
  }
  if (!res.ok) {
    console.warn("[auth ui consent rejected]", {
      value,
      status: res.status,
    });
    return false;
  }
  try {
    window.localStorage.setItem("lw.consent.ping", String(Date.now()));
  } catch {
    /* private mode / quota */
  }
  window.dispatchEvent(new CustomEvent("lw:consent:change"));
  if (value === "rejected") {
    // Honor the rejection by clearing persisted state. Avoid silent data
    // loss for users who genuinely want a fresh slate. The banner copy
    // states this explicitly: "Reject also clears anything we've saved
    // so far on this device."
    try {
      window.localStorage.removeItem("lw.saved.v1");
      window.localStorage.removeItem("lw.liked.v1");
    } catch {
      /* ignore */
    }
  }
  return true;
}

/** Re-open the banner — wired to the future "Manage cookies" footer link.
 *  Implemented by clearing the cookie via a POST that the server treats
 *  as a "reset" signal. For Phase 1 we surface this as a stub the banner
 *  component can subscribe to. */
export function dispatchReopenBanner(): void {
  window.dispatchEvent(new CustomEvent("lw:consent:reopen"));
}
