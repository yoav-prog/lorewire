import { describe, expect, it } from "vitest";
import {
  DEFAULT_STORY_TAB,
  isEditingTab,
  isRailTab,
  isShortClientTab,
  resolveStoryTab,
  STORY_TABS,
} from "./tabs";

describe("resolveStoryTab", () => {
  it("returns the default when the value is missing", () => {
    expect(resolveStoryTab(undefined)).toBe(DEFAULT_STORY_TAB);
  });

  it("returns the default when the value is empty", () => {
    expect(resolveStoryTab("")).toBe(DEFAULT_STORY_TAB);
  });

  it("returns the default for an unknown tab id", () => {
    expect(resolveStoryTab("nope")).toBe(DEFAULT_STORY_TAB);
  });

  it("returns the default for a non-string value", () => {
    expect(resolveStoryTab(42 as unknown)).toBe(DEFAULT_STORY_TAB);
    expect(resolveStoryTab(null)).toBe(DEFAULT_STORY_TAB);
  });

  it("returns the first entry when the value comes in as an array", () => {
    // Next.js searchParams normalizes repeated keys to arrays; the resolver
    // honors the first valid entry.
    expect(resolveStoryTab(["scenes", "voice"])).toBe("scenes");
  });

  it("accepts every known tab id verbatim", () => {
    for (const tab of STORY_TABS) {
      expect(resolveStoryTab(tab.id)).toBe(tab.id);
    }
  });
});

describe("isShortClientTab", () => {
  it("returns true for every non-overview tab", () => {
    expect(isShortClientTab("scenes")).toBe(true);
    expect(isShortClientTab("captions")).toBe(true);
    expect(isShortClientTab("style")).toBe(true);
    expect(isShortClientTab("script")).toBe(true);
    expect(isShortClientTab("voice")).toBe(true);
    expect(isShortClientTab("publish")).toBe(true);
    expect(isShortClientTab("render")).toBe(true);
  });

  it("returns false for the overview tab", () => {
    expect(isShortClientTab("overview")).toBe(false);
  });
});

describe("isEditingTab", () => {
  it("returns true for the 5 short-editing tabs", () => {
    expect(isEditingTab("scenes")).toBe(true);
    expect(isEditingTab("captions")).toBe(true);
    expect(isEditingTab("style")).toBe(true);
    expect(isEditingTab("script")).toBe(true);
    expect(isEditingTab("voice")).toBe(true);
  });

  it("returns false for overview / publish / render", () => {
    expect(isEditingTab("overview")).toBe(false);
    expect(isEditingTab("publish")).toBe(false);
    expect(isEditingTab("render")).toBe(false);
  });
});

describe("isRailTab", () => {
  it("is the complement of isEditingTab — true for overview / publish / render", () => {
    expect(isRailTab("overview")).toBe(true);
    expect(isRailTab("publish")).toBe(true);
    expect(isRailTab("render")).toBe(true);
  });

  it("returns false for the editing tabs", () => {
    expect(isRailTab("scenes")).toBe(false);
    expect(isRailTab("captions")).toBe(false);
    expect(isRailTab("style")).toBe(false);
    expect(isRailTab("script")).toBe(false);
    expect(isRailTab("voice")).toBe(false);
  });

  it("partitions every tab", () => {
    for (const tab of STORY_TABS) {
      expect(isRailTab(tab.id)).toBe(!isEditingTab(tab.id));
    }
  });
});
