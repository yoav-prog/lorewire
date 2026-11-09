// Coverage for the robots.txt builder
// (_plans/2026-07-05-seo-crawlability-and-metadata.md). Regression target:
// before 2026-07-05 robots.txt had no Sitemap declaration, so crawlers
// without console submission (every AI crawler) had to guess.

import { describe, expect, it } from "vitest";

import { buildRobots } from "./robots";

describe("buildRobots", () => {
  it("declares the sitemap URL from the configured origin", () => {
    expect(buildRobots("https://www.lorewire.com").sitemap).toBe(
      "https://www.lorewire.com/sitemap.xml",
    );
  });

  it("omits the sitemap line when no origin is configured", () => {
    // A relative sitemap URL is invalid in robots.txt — better absent.
    expect(buildRobots("").sitemap).toBeUndefined();
  });

  it("keeps the admin and API zones disallowed", () => {
    const rules = buildRobots("https://www.lorewire.com").rules;
    const rule = Array.isArray(rules) ? rules[0] : rules;
    expect(rule?.allow).toBe("/");
    expect(rule?.disallow).toEqual(["/admin", "/admin/", "/api/"]);
  });
});
