import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Force fresh fetches for the service worker and the web manifest.
  // The PWA shell rotates per deploy; if Vercel's CDN holds onto an
  // old sw.js the previous broken caching SW survives an update and
  // keeps showing visitors "this page couldn't load". Browsers cap
  // SW max-age at 24h anyway, but stating it explicitly closes the
  // window AND prevents intermediary caches from holding the file.
  async headers() {
    return [
      // Baseline security headers on every route. HSTS is intentionally
      // absent: Vercel already serves Strict-Transport-Security at the
      // edge, and stating it here too would just shadow that value.
      // SAMEORIGIN (not DENY) so future self-framing (admin previews)
      // keeps working; cross-origin clickjacking is blocked either way.
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
