// Small shared constants and helpers for the admin UI.

export const CATEGORIES = [
  "Drama",
  "Entitled",
  "Humor",
  "Wholesome",
  "Dating",
  "Roommate",
] as const;

export const STATUSES = [
  "draft",
  "review",
  "scripted",
  "rendering",
  "ready",
  "published",
  "archived",
] as const;

// Badge styling per workflow status, using the design-system color tokens.
export function statusClass(status: string | null | undefined): string {
  switch (status) {
    case "published":
      return "border-cat-wholesome/40 bg-cat-wholesome/20 text-cat-wholesome";
    case "ready":
      return "border-high/40 bg-high/15 text-high";
    case "review":
    case "scripted":
    case "rendering":
      return "border-cat-entitled/40 bg-cat-entitled/20 text-cat-entitled";
    default:
      return "border-line bg-surface2 text-muted";
  }
}
