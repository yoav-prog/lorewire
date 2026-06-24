import { describe, expect, it } from "vitest";
import {
  DEFAULT_STORY_TAB,
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
