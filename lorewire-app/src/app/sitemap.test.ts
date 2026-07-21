// Coverage for the pure sitemap entry builder
// (_plans/2026-07-05-seo-crawlability-and-metadata.md). Regression targets:
// before 2026-07-05 the sitemap omitted every static trust/info page and
// the /c/{category} landing pages, so nothing but content pieces was
// discoverable through it.

import { describe, expect, it } from "vitest";

import { buildSitemapEntries, type SitemapInputs } from "./sitemap";

const ORIGIN = "https://www.lorewire.com";

function inputs(overrides: Partial<SitemapInputs> = {}): SitemapInputs {
  return {
    origin: ORIGIN,
    maxAgeDays: 0,
    articles: [],
    stories: [],
    categorySlugs: [],
    ...overrides,
  };
}

function urls(entries: ReturnType<typeof buildSitemapEntries>): string[] {
  return entries.map((e) => e.url);
}

describe("buildSitemapEntries", () => {
  it("always lists the homepage and the articles index", () => {
    const u = urls(buildSitemapEntries(inputs()));
    expect(u).toContain(`${ORIGIN}/`);
    expect(u).toContain(`${ORIGIN}/articles`);
  });

  it("lists every static trust/info page (regression: all were missing)", () => {
    const u = urls(buildSitemapEntries(inputs()));
    for (const path of [
      "/about",
      "/faq",
      "/contact",
      "/community-guidelines",
      "/accessibility",
      "/privacy",
      "/terms",
      "/dmca",
      "/cookie-policy",
      "/imprint",
    ]) {
      expect(u).toContain(`${ORIGIN}${path}`);
    }
  });

  it("never lists /data-deletion (only /data-deletion/[code] exists)", () => {
    const u = urls(buildSitemapEntries(inputs()));
    expect(u.some((x) => x.includes("/data-deletion"))).toBe(false);
  });

  it("lists /c/{slug} for each active category (regression: orphaned pages)", () => {
    const u = urls(
      buildSitemapEntries(
        inputs({ categorySlugs: ["roommate-hell", "family-feuds"] }),
      ),
    );
    expect(u).toContain(`${ORIGIN}/c/roommate-hell`);
    expect(u).toContain(`${ORIGIN}/c/family-feuds`);
  });

  it("skips empty category slugs instead of emitting /c/", () => {
    const u = urls(buildSitemapEntries(inputs({ categorySlugs: [""] })));
    expect(u).not.toContain(`${ORIGIN}/c/`);
  });

  it("maps stories to /v/{slug} and articles to /articles/{lang}/{slug}", () => {
    const u = urls(
      buildSitemapEntries(
        inputs({
          stories: [
            {
              slug: "the-800-envelope",
              published_at: "2026-07-01T00:00:00Z",
              updated_at: null,
            },
          ],
          articles: [
            {
              slug: "envelope-longform",
              language: "en",
              published_at: "2026-07-01T00:00:00Z",
              updated_at: null,
            },
          ],
        }),
      ),
    );
    expect(u).toContain(`${ORIGIN}/v/the-800-envelope`);
    expect(u).toContain(`${ORIGIN}/articles/en/envelope-longform`);
  });

  it("drops pieces missing a slug or (for articles) a language", () => {
    const u = urls(
      buildSitemapEntries(
        inputs({
          stories: [{ slug: null, published_at: null, updated_at: null }],
          articles: [
            {
              slug: "no-language",
              language: null,
              published_at: null,
              updated_at: null,
            },
          ],
        }),
      ),
    );
    expect(u.some((x) => x.includes("no-language"))).toBe(false);
    expect(u.some((x) => x.startsWith(`${ORIGIN}/v/`))).toBe(false);
  });

  it("honors sitemap_max_age_days, with 0 meaning keep forever", () => {
    const stale = {
      slug: "ancient-story",
      published_at: "2020-01-01T00:00:00Z",
      updated_at: null,
    };
    const withCap = urls(
      buildSitemapEntries(inputs({ stories: [stale], maxAgeDays: 30 })),
    );
    expect(withCap).not.toContain(`${ORIGIN}/v/ancient-story`);

    const noCap = urls(
      buildSitemapEntries(inputs({ stories: [stale], maxAgeDays: 0 })),
    );
    expect(noCap).toContain(`${ORIGIN}/v/ancient-story`);
  });
});
