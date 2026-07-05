// Tests for the site-seo resolver. The defaults must hold when no settings
// are persisted; explicit settings must override; the title-template
// sanitizer must survive malformed templates; the origin resolver must
// back metadataBase / robots / sitemap consistently.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSetting } from "@/lib/repo";
import { run } from "@/lib/db";
import {
  getSiteSeo,
  resolveSiteOrigin,
  safeTitleTemplate,
} from "@/lib/site-seo";

async function clearSeoSettings(): Promise<void> {
  await run("DELETE FROM settings WHERE key LIKE 'seo.%'", []);
}

beforeEach(async () => {
  await clearSeoSettings();
});

describe("getSiteSeo defaults", () => {
  it("returns built-in defaults when nothing is persisted", async () => {
    const seo = await getSiteSeo();
    expect(seo.siteName).toBe("LoreWire");
    expect(seo.titleTemplate).toBe("%s · LoreWire");
    // The homepage default must be more than the bare brand — it's the
    // site's strongest indexed page (2026-07-05 SEO pass).
    expect(seo.homeTitle).toBe(
      "LoreWire · True Internet Stories, Animated & Voted On",
    );
    expect(seo.themeColor).toBe("#0A0A0C");
    expect(seo.twitterCardType).toBe("summary_large_image");
    expect(seo.organizationSameAs).toEqual([]);
    expect(seo.sitemapMaxAgeDays).toBe(0);
  });
});

describe("getSiteSeo with persisted settings", () => {
  it("overrides defaults with whatever the admin set", async () => {
    await setSetting("seo.site_name", "Acme Wire");
    await setSetting("seo.title_template", "%s | Acme");
    await setSetting("seo.home_title", "Acme Wire · Custom Home");
    await setSetting("seo.theme_color", "#FF0066");
    await setSetting("seo.twitter_card_type", "summary");
    await setSetting("seo.twitter_handle", "@AcmeWire");

    const seo = await getSiteSeo();
    expect(seo.siteName).toBe("Acme Wire");
    expect(seo.titleTemplate).toBe("%s | Acme");
    expect(seo.homeTitle).toBe("Acme Wire · Custom Home");
    expect(seo.themeColor).toBe("#FF0066");
    expect(seo.twitterCardType).toBe("summary");
    expect(seo.twitterHandle).toBe("@AcmeWire");
  });

  it("parses sameAs URLs from comma OR newline separators", async () => {
    await setSetting(
      "seo.organization_same_as",
      "https://twitter.com/acme, https://linkedin.com/company/acme\nhttps://github.com/acme",
    );
    const seo = await getSiteSeo();
    expect(seo.organizationSameAs).toEqual([
      "https://twitter.com/acme",
      "https://linkedin.com/company/acme",
      "https://github.com/acme",
    ]);
  });

  it("trims whitespace and drops empty entries in sameAs", async () => {
    await setSetting(
      "seo.organization_same_as",
      "  https://twitter.com/acme  ,, ,https://linkedin.com/x",
    );
    const seo = await getSiteSeo();
    expect(seo.organizationSameAs).toEqual([
      "https://twitter.com/acme",
      "https://linkedin.com/x",
    ]);
  });

  it("coerces non-numeric sitemap max age back to the default", async () => {
    await setSetting("seo.sitemap_max_age_days", "not-a-number");
    const seo = await getSiteSeo();
    expect(seo.sitemapMaxAgeDays).toBe(0);
  });

  it("rejects negative sitemap max age and falls back to default", async () => {
    await setSetting("seo.sitemap_max_age_days", "-5");
    const seo = await getSiteSeo();
    expect(seo.sitemapMaxAgeDays).toBe(0);
  });

  it("defaults twitter_card_type to summary_large_image for unknown values", async () => {
    await setSetting("seo.twitter_card_type", "whatever");
    const seo = await getSiteSeo();
    expect(seo.twitterCardType).toBe("summary_large_image");
  });
});

// safeTitleTemplate replaced buildPageTitle in the 2026-07-05 SEO pass:
// pages now return BARE titles and the root layout's title.template is the
// single branding authority — buildPageTitle pre-branded titles and the
// layout template then appended the brand a second time
// ("Title · LoreWire · LoreWire" in the live crawl).
describe("safeTitleTemplate", () => {
  it("passes through a template that contains the %s token", () => {
    expect(safeTitleTemplate("%s · LoreWire", "LoreWire")).toBe(
      "%s · LoreWire",
    );
    expect(safeTitleTemplate("%s | Acme", "LoreWire")).toBe("%s | Acme");
  });

  it("falls back to '%s · siteName' when the template lacks %s", () => {
    // Defensive: malformed admin input shouldn't swallow page titles.
    expect(safeTitleTemplate("no placeholder", "Brand")).toBe("%s · Brand");
    expect(safeTitleTemplate("", "Brand")).toBe("%s · Brand");
  });
});

describe("resolveSiteOrigin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the admin seo.site_url setting and strips a trailing slash", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://env.example");
    expect(resolveSiteOrigin("https://www.lorewire.com/")).toBe(
      "https://www.lorewire.com",
    );
  });

  it("falls back to NEXT_PUBLIC_SITE_ORIGIN, then empty", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://env.example");
    expect(resolveSiteOrigin("")).toBe("https://env.example");
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    expect(resolveSiteOrigin("")).toBe("");
  });
});
