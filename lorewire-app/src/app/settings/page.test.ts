// Metadata regression coverage for /settings
// (_plans/2026-07-05-seo-crawlability-and-metadata.md):
//
//   1. The title must be BARE ("Settings") — the old hardcoded
//      "Settings · LoreWire" got the root layout's title.template applied
//      on top and rendered "Settings · LoreWire · LoreWire" in the tab.
//   2. The page is a per-device utility surface and must carry noindex
//      (it was fully indexable before), while keeping follow so the
//      back-home link passes crawl.

import { describe, expect, it } from "vitest";

import { metadata } from "./page";

describe("settings page metadata", () => {
  it("returns a bare title for the layout template to brand once", () => {
    expect(metadata.title).toBe("Settings");
  });

  it("is noindex, follow", () => {
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });
});
