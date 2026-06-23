// Unit tests for the sidebar's active-state contract. The rendering layer is
// covered by manual QA — these tests pin down the active-prefix logic that
// drove most of the bugs in the old top-nav. Pure function, no DOM.

import { describe, it, expect } from "vitest";
import { isItemActive, buildGroups, type SidebarItem } from "./AdminSidebar";

const items = {
  overview: { href: "/admin", label: "Overview", exact: true } satisfies SidebarItem,
  content: {
    href: "/admin/content",
    label: "Content",
    activePrefixes: [
      "/admin/content",
      "/admin/articles",
      "/admin/videos",
      "/admin/stories",
    ],
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
    expect(isItemActive("/admin/content", items.overview)).toBe(false);
    expect(isItemActive("/admin/settings", items.overview)).toBe(false);
  });

  it("Content lights up for the unified URL and the legacy per-kind URLs", () => {
    expect(isItemActive("/admin/content", items.content)).toBe(true);
    expect(isItemActive("/admin/articles", items.content)).toBe(true);
    expect(isItemActive("/admin/articles/abc", items.content)).toBe(true);
    expect(isItemActive("/admin/articles/new", items.content)).toBe(true);
    expect(isItemActive("/admin/articles/import", items.content)).toBe(true);
    expect(isItemActive("/admin/videos", items.content)).toBe(true);
    expect(isItemActive("/admin/videos/abc", items.content)).toBe(true);
    expect(isItemActive("/admin/stories", items.content)).toBe(true);
    expect(isItemActive("/admin/stories/abc", items.content)).toBe(true);
  });

  it("Content does NOT light up for Settings or unrelated routes", () => {
    expect(isItemActive("/admin", items.content)).toBe(false);
    expect(isItemActive("/admin/settings", items.content)).toBe(false);
    expect(isItemActive("/admin/models", items.content)).toBe(false);
  });

  it("Content lights up for /admin/videos-spike (prefix collision)", () => {
    // `"/admin/videos"` prefix-matches `"/admin/videos-spike/abc"`. We accept
    // this — the Dev group's Player spike still lights up its own entry
    // when active. If the lit Content entry becomes a problem we can move
    // to a stricter prefix check, but this asserts current behavior.
    expect(isItemActive("/admin/videos-spike/abc", items.content)).toBe(true);
  });

  it("Settings lights up for all four config URLs", () => {
    expect(isItemActive("/admin/settings", items.settings)).toBe(true);
    expect(isItemActive("/admin/models", items.settings)).toBe(true);
    expect(isItemActive("/admin/templates", items.settings)).toBe(true);
    expect(isItemActive("/admin/segments", items.settings)).toBe(true);
  });

  it("Settings does NOT light up for unrelated routes", () => {
    expect(isItemActive("/admin", items.settings)).toBe(false);
    expect(isItemActive("/admin/content", items.settings)).toBe(false);
    expect(isItemActive("/admin/articles", items.settings)).toBe(false);
    expect(isItemActive("/admin/videos", items.settings)).toBe(false);
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

  it("produces the top-level entries in stable order", () => {
    for (const dev of [false, true]) {
      const groups = buildGroups(dev);
      expect(groups[0].label).toBeNull();
      expect(groups[0].items.map((i) => i.label)).toEqual([
        "Overview",
        "Content",
        "Reddit Sources",
        "Homepage",
        "Comments",
        "Settings",
      ]);
    }
  });
});
