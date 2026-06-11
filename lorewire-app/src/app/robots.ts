import type { MetadataRoute } from "next";

// Sitewide robots policy. Mirrors the per-segment metadata.robots set on
// app/admin/layout.tsx — robots.txt addresses well-behaved crawlers,
// the <meta> tag covers everyone else. The two need to agree, so any
// change here that adds another no-index zone should also land in that
// segment's layout.

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/admin/", "/api/"],
      },
    ],
  };
}
