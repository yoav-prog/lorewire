// LoreWire service worker — network-first with cache fallback.
// Keeps the app installable (a fetch handler is required) and gives
// visited pages basic offline support.
//
// /admin and /api are explicitly skipped: those responses are user-specific
// and short-lived, and caching them in the SW caused stale dashboards plus
// an extra IDB write on every navigation. Version bumped so old clients
// recycle whatever they had cached for /admin under v1.
const CACHE = "lorewire-v2";

function shouldBypass(url) {
  return (
    url.pathname.startsWith("/admin") ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/api"
  );
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (shouldBypass(url)) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || Promise.reject(new Error("offline"))))
  );
});
