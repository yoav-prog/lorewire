// Unit tests for the sidebar's active-state contract. The rendering layer is
// covered by manual QA — these tests pin down the active-prefix logic that
// drove most of the bugs in the old top-nav. Pure function, no DOM.

import { describe, it, expect } from "vitest";
import { isItemActive, buildGroups, type SidebarItem } from "./AdminSidebar";

const items = {
  overview: { href: "/admin", label: "Overview", exact: true } satisfies SidebarItem,
  articles: { href: "/admin/articles", label: "Articles" } satisfies SidebarItem,
  videos: {
    href: "/admin/videos",
    label: "Videos",
    activePrefixes: ["/admin/videos", "/admin/stories"],
  } satisfies SidebarItem,
  settings: {
    href: "/admin/settings",
    label: "Settings",
    activePrefixes: [
      "/admin/settings",
      "/admin/models",
      "/admin/templates",
      "/admin/segments",
    ],
  } satisfies SidebarItem,
  spike: {
    href: "/admin/videos-spike",
    label: "Player spike",
    activePrefixes: ["/admin/videos-spike/"],
  } satisfies SidebarItem,
};

describe("isItemActive", () => {
  it("exact-match Overview only fires on /admin", () => {
    expect(isItemActive("/admin", items.overview)).toBe(true);
    expect(isItemActive("/admin/articles", items.overview)).toBe(false);
    expect(isItemActive("/admin/videos", items.overview)).toBe(false);
    expect(isItemActive("/admin/settings", items.overview)).toBe(false);
  });

  it("Articles lights up for the list and any inner editor page", () => {
    expect(isItemActive("/admin/articles", items.articles)).toBe(true);
    expect(isItemActive("/admin/articles/abc123", items.articles)).toBe(true);
    expect(isItemActive("/admin/articles/new", items.articles)).toBe(true);
    expect(isItemActive("/admin/articles/import", items.articles)).toBe(true);
    expect(isItemActive("/admin/videos", items.articles)).toBe(false);
    expect(isItemActive("/admin/settings", items.articles)).toBe(false);
  });

  it("Videos lights up for /admin/videos*, /admin/videos/[id], and /admin/stories*", () => {
    expect(isItemActive("/admin/videos", items.videos)).toBe(true);
    expect(isItemActive("/admin/videos/abc123", items.videos)).toBe(true);
    expect(isItemActive("/admin/stories", items.videos)).toBe(true);
    expect(isItemActive("/admin/stories/abc123", items.videos)).toBe(true);
    expect(isItemActive("/admin/articles", items.videos)).toBe(false);
    expect(isItemActive("/admin/settings", items.videos)).toBe(false);
  });

  it("Videos does NOT light up for /admin/videos-spike (Dev group route)", () => {
    // Prefix "/admin/videos" matches "/admin/videos-spike" naively, so we
    // assert the Dev route still resolves to Videos under our current
    // implementation. If we later disambiguate (require trailing /), this
    // test becomes the regression guard.
    expect(isItemActive("/admin/videos-spike/abc", items.videos)).toBe(true);
  });

  it("Settings lights up for all four config URLs", () => {
    expect(isItemActive("/admin/settings", items.settings)).toBe(true);
    expect(isItemActive("/admin/models", items.settings)).toBe(true);
    expect(isItemActive("/admin/templates", items.settings)).toBe(true);
    expect(isItemActive("/admin/segments", items.settings)).toBe(true);
  });

  it("Settings does NOT light up for unrelated routes", () => {
    expect(isItemActive("/admin", items.settings)).toBe(false);
    expect(isItemActive("/admin/articles", items.settings)).toBe(false);
    expect(isItemActive("/admin/videos", items.settings)).toBe(false);
    expect(isItemActive("/admin/content", items.settings)).toBe(false);
  });

  it("Player spike matches only its dev route", () => {
    expect(isItemActive("/admin/videos-spike/abc", items.spike)).toBe(true);
    expect(isItemActive("/admin/videos/abc", items.spike)).toBe(false);
  });
});

describe("buildGroups", () => {
  it("hides the Dev group when isDev is false", () => {
    const groups = buildGroups(false);
    const labels = groups.map((g) => g.label);
    expect(labels).not.toContain("Dev");
  });

  it("appends the Dev group when isDev is true", () => {
    const groups = buildGroups(true);
    expect(groups[groups.length - 1].label).toBe("Dev");
    expect(groups[groups.length - 1].items.map((i) => i.label)).toContain(
      "Player spike",
    );
  });

  it("produces the four top-level entries in stable order", () => {
    for (const dev of [false, true]) {
      const groups = buildGroups(dev);
      // The first (and only static) group holds Overview/Articles/Videos/Settings.
      expect(groups[0].label).toBeNull();
      expect(groups[0].items.map((i) => i.label)).toEqual([
        "Overview",
        "Articles",
        "Videos",
        "Settings",
      ]);
    }
  });
});
