// Regression coverage for the private-surface noindex policy
// (_plans/2026-07-05-seo-crawlability-and-metadata.md follow-up): every
// segment that has no business in search results must declare robots
// metadata, because robots.txt Disallow only blocks crawling — a
// disallowed URL can still be indexed as a bare link. The admin segment
// carried this since launch; /auth and /submissions had nothing.

import { describe, expect, it } from "vitest";

import { metadata as adminMetadata } from "./admin/layout";
import { metadata as authMetadata } from "./auth/layout";
import { metadata as submissionsMetadata } from "./submissions/layout";

describe("noindex segment layouts", () => {
  it("admin stays noindex, nofollow", () => {
    expect(adminMetadata.robots).toMatchObject({
      index: false,
      follow: false,
    });
  });

  it("auth is noindex, nofollow (signout/OAuth callbacks must not be crawled)", () => {
    expect(authMetadata.robots).toMatchObject({
      index: false,
      follow: false,
    });
  });

  it("submissions is noindex, follow (utility page, links keep passing crawl)", () => {
    expect(submissionsMetadata.robots).toEqual({
      index: false,
      follow: true,
    });
  });
});
