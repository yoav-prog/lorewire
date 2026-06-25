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

/** Tabs that render inside the shared client wrapper
 *  (StoryShortTabsClient). All 7 non-overview tabs go through it so they
 *  share the EditSessionBanner / RenderAfterEditsBanner / RenderStatusPanel
 *  chrome and the foreign-session heartbeat — the render banner needs
 *  configKey from ShortConfig, and the in-progress render indicator should
 *  stay visible to a user who switches over to Publish or Render. Page
 *  uses this predicate to gate the lazy server-side load of short state. */
const SHORT_CLIENT_TABS = new Set<StoryTabId>([
  "scenes",
  "captions",
  "style",
  "script",
  "voice",
  "publish",
  "render",
]);

export function isShortClientTab(tab: StoryTabId): boolean {
  return SHORT_CLIENT_TABS.has(tab);
}

/** Tabs that ARE the per-short editing canvas. On these, the right
 *  rail is hidden so the main column gets full width (cut 7 fix for
 *  the squeezed scene grid). Granular regen + live preview move
 *  inline. */
const EDITING_TABS = new Set<StoryTabId>([
  "scenes",
  "captions",
  "style",
  "script",
  "voice",
]);

export function isEditingTab(tab: StoryTabId): boolean {
  return EDITING_TABS.has(tab);
}

/** Tabs that should render the right rail. Complement of EDITING_TABS:
 *  Overview / Publish & SEO / Render. Page uses this to decide whether
 *  to wrap content in the [1fr_320px] grid. */
export function isRailTab(tab: StoryTabId): boolean {
  return !EDITING_TABS.has(tab);
}

/** The 7 short-client tabs as a narrowed type. Lives next to the
 *  predicate so the server page can narrow + the client wrapper can
 *  consume the type, without either side reaching into the other's
 *  module. (StoryShortTabsClient.tsx has "use client", which makes
 *  every value export client-only and uncallable from server code —
 *  the narrowing helper must live in a server-safe module like this
 *  one to be callable from page.tsx.) */
export type ShortClientTabId = Exclude<StoryTabId, "overview">;

/** Narrowing helper for callers that only have a StoryTabId. Lets
 *  page.tsx gate on isShortClientTab() and then safely cast to the
 *  narrow ShortClientTabId without a raw `as`. */
export function asShortClientTab(tab: StoryTabId): ShortClientTabId | null {
  switch (tab) {
    case "scenes":
    case "captions":
    case "style":
    case "script":
    case "voice":
    case "publish":
    case "render":
      return tab;
    default:
      return null;
  }
}
