// Coverage for the sitewide Organization + WebSite JSON-LD builder
// (_plans/2026-07-05-seo-structured-data.md). Built from admin settings;
// empty settings must drop fields, never emit empty strings.

import { describe, expect, it } from "vitest";

import { buildSiteJsonLd } from "@/lib/site-jsonld";
import type { SiteSeoSettings } from "@/lib/site-seo";

function seo(overrides: Partial<SiteSeoSettings> = {}): SiteSeoSettings {
  return {
    siteName: "LoreWire",
    siteUrl: "https://www.lorewire.com",
    titleTemplate: "%s · LoreWire",
    homeTitle: "LoreWire · True Internet Stories, Animated & Voted On",
    defaultMetaDescription: "desc",
    themeColor: "#0A0A0C",
    defaultOgImage: "",
    twitterCardType: "summary_large_image",
    twitterHandle: "",
    organizationName: "LoreWire",
    organizationLogoUrl: "https://www.lorewire.com/logo.png",
    organizationSameAs: [
      "https://twitter.com/LoreWire",
      "https://www.youtube.com/@LoreWire",
    ],
    googleVerification: "",
    bingVerification: "",
    sitemapMaxAgeDays: 0,
    ...overrides,
  };
}

describe("buildSiteJsonLd", () => {
  it("emits Organization and WebSite from the admin settings", () => {
    const [org, site] = buildSiteJsonLd(seo(), "https://www.lorewire.com");
    expect(org["@type"]).toBe("Organization");
    expect(org.name).toBe("LoreWire");
    expect(org.url).toBe("https://www.lorewire.com");
    expect(org.logo).toBe("https://www.lorewire.com/logo.png");
    expect(org.sameAs).toEqual([
      "https://twitter.com/LoreWire",
      "https://www.youtube.com/@LoreWire",
    ]);
    expect(site["@type"]).toBe("WebSite");
    expect(site.name).toBe("LoreWire");
    expect(site.url).toBe("https://www.lorewire.com");
  });

  it("falls back to the site name when no organization name is set", () => {
    const [org] = buildSiteJsonLd(
      seo({ organizationName: "" }),
      "https://www.lorewire.com",
    );
    expect(org.name).toBe("LoreWire");
  });

  it("falls back to the built-in /logo.png when no logo URL is set", () => {
    const [org] = buildSiteJsonLd(
      seo({ organizationLogoUrl: "" }),
      "https://www.lorewire.com",
    );
    expect(org.logo).toBe("https://www.lorewire.com/logo.png");
  });

  it("drops url/logo/sameAs when unset instead of emitting empties", () => {
    // No origin -> even the built-in logo fallback is skipped (JSON-LD
    // needs absolute URLs).
    const [org, site] = buildSiteJsonLd(
      seo({ organizationLogoUrl: "", organizationSameAs: [] }),
      "",
    );
    expect(org).not.toHaveProperty("url");
    expect(org).not.toHaveProperty("logo");
    expect(org).not.toHaveProperty("sameAs");
    expect(site).not.toHaveProperty("url");
  });

  it("never declares a SearchAction (no crawlable search URL exists)", () => {
    const [, site] = buildSiteJsonLd(seo(), "https://www.lorewire.com");
    expect(site).not.toHaveProperty("potentialAction");
  });
});
