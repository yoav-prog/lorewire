// Public reader path for a story. Server-safe and client-safe (no
// "server-only", no DB) — shared by the card link components and tests.
//
// A story is reachable at /v/[slug] exactly when it carries a slug:
// liveRowToStory sets it for published DB stories; the baked sample
// catalog (lib/stories.STORIES seeds) has none, so those cards keep
// their button behavior and never emit a dead href.

import type { Story } from "@/lib/stories";

export function storyReaderPath(story: Pick<Story, "slug">): string | null {
  return story.slug ? `/v/${story.slug}` : null;
}
