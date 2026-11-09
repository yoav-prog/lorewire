import type { MetadataRoute } from "next";
import { getSiteSeo, resolveSiteOrigin } from "@/lib/site-seo";

// Sitewide robots policy. Mirrors the per-segment metadata.robots set on
// app/admin/layout.tsx — robots.txt addresses well-behaved crawlers,
// the <meta> tag covers everyone else. The two need to agree, so any
// change here that adds another no-index zone should also land in that
// segment's layout.

// Pure builder, split from the default export so the sitemap-declaration
// logic is unit-testable without settings_kv.
export function buildRobots(origin: string): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/admin/", "/api/"],
      },
    ],
    // Declared so every crawler finds the sitemap without guessing —
    // Google/Bing accept console submission, but AI crawlers only have
    // this line. Omitted when no origin is configured (a relative
    // sitemap URL is invalid in robots.txt).
    sitemap: origin ? `${origin}/sitemap.xml` : undefined,
  };
}

export default async function robots(): Promise<MetadataRoute.Robots> {
  const seo = await getSiteSeo();
  return buildRobots(resolveSiteOrigin(seo.siteUrl));
}
