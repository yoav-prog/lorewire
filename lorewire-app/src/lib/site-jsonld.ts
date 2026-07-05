// Sitewide Organization + WebSite JSON-LD, embedded once in the root
// layout (_plans/2026-07-05-seo-structured-data.md). The Organization
// block is what Google's knowledge panel and brand verification read;
// it is built from the existing admin settings (Settings -> SEO ->
// Organization), so the admin surface stays the single source of truth.
//
// Deliberately no SearchAction on WebSite: the site has no crawlable
// search-results URL (search is a client-side tab), and declaring a
// fake one is worse than omitting it.
//
// Pure module: takes the resolved settings + origin so tests never
// touch the DB. `import type` keeps the server-only site-seo module
// out of any client bundle.

import { maybe } from "@/lib/jsonld";
import type { SiteSeoSettings } from "@/lib/site-seo";

export function buildSiteJsonLd(
  seo: SiteSeoSettings,
  origin: string,
): Record<string, unknown>[] {
  const organization = maybe({
    "@context": "https://schema.org",
    "@type": "Organization",
    name: seo.organizationName || seo.siteName,
    url: origin || undefined,
    logo: seo.organizationLogoUrl || undefined,
    sameAs: seo.organizationSameAs.length
      ? seo.organizationSameAs
      : undefined,
  });

  const website = maybe({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: seo.siteName,
    url: origin || undefined,
  });

  return [organization, website];
}
