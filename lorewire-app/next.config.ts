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
