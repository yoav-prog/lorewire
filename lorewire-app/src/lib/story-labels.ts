// Reader-facing origin labels (CONTENT_POLICY.md rule 5). Stories generated
// through the clean-room pipeline carry content_origin='original'; every older
// story and every reader submission keeps the catalog label.

export const CATALOG_STORY_LABEL = "True stories from the internet";
export const ORIGINAL_STORY_LABEL =
  "Fictionalized story, inspired by real-life situations";

export function storyOriginLabel(contentOrigin: string | null | undefined): string {
  return contentOrigin === "original" ? ORIGINAL_STORY_LABEL : CATALOG_STORY_LABEL;
}

export function isStoryOriginLabel(tag: string): boolean {
  return tag === CATALOG_STORY_LABEL || tag === ORIGINAL_STORY_LABEL;
}
