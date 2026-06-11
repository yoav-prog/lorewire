// Tests for the site-seo resolver. The defaults must hold when no settings
// are persisted; explicit settings must override; the title-template
// substitution must survive malformed templates.

import { beforeEach, describe, expect, it } from "vitest";
import { setSetting } from "@/lib/repo";
import { run } from "@/lib/db";
import { buildPageTitle, getSiteSeo } from "@/lib/site-seo";

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
    await setSetting("seo.theme_color", "#FF0066");
    await setSetting("seo.twitter_card_type", "summary");
    await setSetting("seo.twitter_handle", "@AcmeWire");

    const seo = await getSiteSeo();
    expect(seo.siteName).toBe("Acme Wire");
    expect(seo.titleTemplate).toBe("%s | Acme");
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

describe("buildPageTitle", () => {
  it("substitutes %s with the page title", () => {
    expect(buildPageTitle("My Article", "%s · LoreWire", "LoreWire")).toBe(
      "My Article · LoreWire",
    );
  });

  it("supports multiple separators", () => {
    expect(buildPageTitle("Hello", "%s | Brand", "Brand")).toBe("Hello | Brand");
  });

  it("returns just the site name when page title is empty", () => {
    expect(buildPageTitle("", "%s · LoreWire", "LoreWire")).toBe("LoreWire");
  });

  it("falls back to ' · siteName' when the template lacks %s", () => {
    // Defensive: malformed admin input shouldn't produce an empty title.
    expect(buildPageTitle("My Article", "no placeholder", "Brand")).toBe(
      "My Article · Brand",
    );
  });
});
