// Tab registry for the unified story + short editor at /admin/stories/[id].
//
// Lives in its own file because both the server page (which reads
// searchParams.tab to decide which tab content to render) and the client
// StoryTabBar (which writes ?tab=… on click) need the same constants.
//
// Plan: _plans/2026-06-24-unified-story-editor.md.

export const STORY_TABS = [
  { id: "overview", label: "Overview" },
  { id: "scenes", label: "Scenes" },
  { id: "captions", label: "Captions" },
  { id: "style", label: "Style" },
  { id: "script", label: "Script" },
  { id: "voice", label: "Voice" },
  { id: "publish", label: "Publish & SEO" },
  { id: "render", label: "Render" },
] as const;

export type StoryTabId = (typeof STORY_TABS)[number]["id"];

export const DEFAULT_STORY_TAB: StoryTabId = "overview";

/** Resolve a raw ?tab=… value (which can be string | string[] | undefined
 *  on Next's searchParams) to a known StoryTabId, falling back to the
 *  default. Unknown / malformed values silently fall back so a typo'd URL
 *  doesn't 404. */
export function resolveStoryTab(raw: unknown): StoryTabId {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (typeof candidate !== "string") return DEFAULT_STORY_TAB;
  const match = STORY_TABS.find((t) => t.id === candidate);
  return match ? match.id : DEFAULT_STORY_TAB;
}
