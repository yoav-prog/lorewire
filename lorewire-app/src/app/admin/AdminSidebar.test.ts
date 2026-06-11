// Unit tests for the sidebar's active-state contract. The rendering layer is
// covered by manual QA — these tests pin down the active-prefix logic that
// drove most of the bugs in the old top-nav. Pure function, no DOM.

import { describe, it, expect } from "vitest";
import { isItemActive, buildGroups, type SidebarItem } from "./AdminSidebar";

const items = {
  overview: { href: "/admin", label: "Overview", exact: true } satisfies SidebarItem,
  inbox: { href: "/admin/content", label: "Inbox", exact: true } satisfies SidebarItem,
  articles: { href: "/admin/articles", label: "Articles" } satisfies SidebarItem,
  stories: { href: "/admin/stories", label: "Stories" } satisfies SidebarItem,
  videos: {
    href: "/admin/content?kind=video",
    label: "Videos",
    activePrefixes: ["/admin/videos/"],
  } satisfies SidebarItem,
  models: { href: "/admin/models", label: "Models" } satisfies SidebarItem,
  pipeline: { href: "/admin/settings", label: "Pipeline" } satisfies SidebarItem,
  spike: {
    href: "/admin/videos-spike",
    label: "Player spike",
    activePrefixes: ["/admin/videos-spike/"],
  } satisfies SidebarItem,
};

describe("isItemActive", () => {
  it("exact-match Overview only fires on /admin", () => {
    expect(isItemActive("/admin", items.overview)).toBe(true);
    expect(isItemActive("/admin/content", items.overview)).toBe(false);
    expect(isItemActive("/admin/stories", items.overview)).toBe(false);
  });

  it("exact-match Inbox only fires on /admin/content", () => {
    expect(isItemActive("/admin/content", items.inbox)).toBe(true);
    // Even when the Inbox is filtered (search params not in pathname) the
    // pathname is still /admin/content, so Inbox stays active.
    expect(isItemActive("/admin/content", items.inbox)).toBe(true);
    expect(isItemActive("/admin/articles", items.inbox)).toBe(false);
    expect(isItemActive("/admin/articles/abc", items.inbox)).toBe(false);
  });

  it("Articles lights up for the list and any inner editor page", () => {
    expect(isItemActive("/admin/articles", items.articles)).toBe(true);
    expect(isItemActive("/admin/articles/abc123", items.articles)).toBe(true);
    expect(isItemActive("/admin/articles/new", items.articles)).toBe(true);
    expect(isItemActive("/admin/articles/import", items.articles)).toBe(true);
    expect(isItemActive("/admin/stories", items.articles)).toBe(false);
  });

  it("Stories lights up for the list and inner editor pages", () => {
    expect(isItemActive("/admin/stories", items.stories)).toBe(true);
    expect(isItemActive("/admin/stories/abc123", items.stories)).toBe(true);
    expect(isItemActive("/admin/articles", items.stories)).toBe(false);
  });

  it("Videos uses an explicit activePrefix and ignores its own href when matching", () => {
    // Videos links to /admin/content?kind=video; activePrefixes are
    // ['/admin/videos/']. Pathname-level matching never overlaps with Inbox.
    expect(isItemActive("/admin/videos/abc123", items.videos)).toBe(true);
    expect(isItemActive("/admin/content", items.videos)).toBe(false);
    expect(isItemActive("/admin/videos-spike/abc", items.videos)).toBe(false);
  });

  it("Pipeline (formerly Settings) lights up for /admin/settings", () => {
    expect(isItemActive("/admin/settings", items.pipeline)).toBe(true);
    expect(isItemActive("/admin/settings/anything", items.pipeline)).toBe(true);
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
    expect(labels).toEqual([null, "Content", "Configuration"]);
  });

  it("appends the Dev group when isDev is true", () => {
    const groups = buildGroups(true);
    expect(groups[groups.length - 1].label).toBe("Dev");
    expect(groups[groups.length - 1].items.map((i) => i.label)).toContain(
      "Player spike",
    );
  });

  it("never strips the static groups", () => {
    for (const dev of [false, true]) {
      const groups = buildGroups(dev);
      expect(groups[0].items.some((i) => i.label === "Overview")).toBe(true);
      const contentGroup = groups.find((g) => g.label === "Content");
      expect(contentGroup?.items.map((i) => i.label)).toEqual([
        "Inbox",
        "Articles",
        "Stories",
        "Videos",
      ]);
      const configGroup = groups.find((g) => g.label === "Configuration");
      expect(configGroup?.items.map((i) => i.label)).toEqual([
        "Models",
        "Captions",
        "Intros & outros",
        "Pipeline",
      ]);
    }
  });
});
