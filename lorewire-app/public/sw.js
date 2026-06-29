// LoreWire service worker — minimal "always passthrough" SW.
//
// History: a previous version (lorewire-v2) cached every GET response
// network-first with a cache fallback. Two failure modes hit prod hard:
//
//   1. After a deploy, the served HTML referenced new _next/static chunk
//      hashes. If the network blipped while fetching one of those chunks,
//      the SW fell back to caches.match(req) — which returned null for
//      the new hashes — and rejected with Error("offline"). The browser
//      then showed "This page couldn't load" on every navigation. Article
//      and story pages were the most visible symptom but every route was
//      at risk.
//
//   2. The SW happily cached HTML responses too. A user who'd loaded the
//      site before a deploy got the OLD shell from cache; the OLD shell
//      requested chunk hashes that no longer existed on Vercel; the page
//      stayed broken until the user manually cleared site data — not an
//      ask we can put on a real visitor.
//
// Fix: stop intercepting. The fetch handler is intentionally empty (a
// fetch handler MUST exist for the PWA install criteria — but it does
// not call event.respondWith, so every request goes through to the
// browser / CDN natively). Vercel's CDN already handles immutable hashed
// chunks correctly and serves fresh HTML on each navigation. Offline
// support is gone for now; for a content app that needs live data anyway
// it was always a thin pretense and the trade was bad even before this.
//
// Cache version bumped to v3 so the activate handler can purge every
// pre-existing cache (including v2's HTML and chunk entries) on each
// installed client's next navigation. This is what auto-heals visitors
// who were stuck on the v2 "page couldn't load" loop without asking
// them to open DevTools.
const CACHE = "lorewire-v3";

self.addEventListener("install", () => {
  // Take over on the very next navigation instead of waiting for every
  // open tab to close — that's what flips a stuck visitor's browser
  // onto the fixed SW within one reload.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Nuke EVERY pre-existing cache, not just non-current ones, so
      // the prior v2 SW's stale HTML and JS chunk entries can't keep
      // redirecting through this SW on the next navigation. New SW =
      // clean slate.
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      // Claim every open client immediately so existing tabs flip onto
      // the fixed SW without needing a manual reload.
      await self.clients.claim();
    })(),
  );
});

// Intentionally a no-op. The handler MUST exist for the PWA install
// criteria but it must NOT call event.respondWith — that way every
// request passes through to the browser / CDN natively and we can't
// reject with "offline" on a transient blip.
self.addEventListener("fetch", () => {
  void CACHE; // retain the constant for future use; no behaviour today.
});
