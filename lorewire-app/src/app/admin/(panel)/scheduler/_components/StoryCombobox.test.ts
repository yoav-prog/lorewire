// Tests for the story-picker search: every typed word must match the
// title, case-insensitively, with a result cap.

import { describe, expect, it } from "vitest";

import { filterStories } from "./StoryCombobox";

const STORIES = [
  { id: "1", title: "DOLLAR TREE SPONSORSHIP" },
  { id: "2", title: "My roommate ate my dollar pizza" },
  { id: "3", title: "Wedding drama at the tree farm" },
];

describe("filterStories", () => {
  it("matches every word, anywhere in the title, any case", () => {
    expect(filterStories(STORIES, "dollar spons").map((s) => s.id)).toEqual(["1"]);
    expect(filterStories(STORIES, "TREE").map((s) => s.id)).toEqual(["1", "3"]);
    expect(filterStories(STORIES, "pizza roommate").map((s) => s.id)).toEqual(["2"]);
  });

  it("returns the head of the list for an empty query", () => {
    expect(filterStories(STORIES, "  ").map((s) => s.id)).toEqual(["1", "2", "3"]);
  });

  it("returns nothing when a word matches no title", () => {
    expect(filterStories(STORIES, "dollar zebra")).toEqual([]);
  });

  it("caps the result count", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      title: `Story ${i}`,
    }));
    expect(filterStories(many, "story")).toHaveLength(12);
    expect(filterStories(many, "story", 5)).toHaveLength(5);
  });
});
