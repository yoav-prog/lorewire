// Client-side share helper — one source of truth for "share this public URL"
// across the Reels feed (ReelCard) and the homepage detail modals (AppShell /
// DesktopShell). Native share sheet first (mobile), clipboard copy as the
// fallback (desktop / browsers without the Web Share API). The caller flips a
// transient "Copied" label only when the outcome is "copied" — a dismissed
// native sheet returns "unavailable" so we never copy-on-dismiss.
//
// SECURITY: only ever pass the PUBLIC canonical reader URL here (/v/[slug]).
// Never an internal story id, a draft URL, or a signed media URL — those must
// not leave the app through a share action.

export type ShareOutcome = "shared" | "copied" | "unavailable";

export interface ShareInput {
  /** The public URL to share. Build it with storyShareUrl(). */
  url: string;
  /** Optional title for the native share sheet. Ignored by clipboard copy. */
  title?: string;
}

/** The public canonical reader URL for a story slug, or the site origin as a
 *  safe fallback when the story has no public slug yet (legacy sample row, or
 *  a story that is visible on the homepage but not yet `published` — those are
 *  not reachable at /v/[slug], so sharing the bare origin beats a 404). */
export function storyShareUrl(
  slug: string | null | undefined,
  origin: string,
): string {
  return slug ? `${origin}/v/${slug}` : origin;
}

/** Share `url` via the native sheet, falling back to a clipboard copy. Mirrors
 *  the original ReelCard semantics: try Web Share first (a thrown/dismissed
 *  sheet is swallowed, NOT copied), else copy to the clipboard. Returns which
 *  path actually ran so the caller can show the right confirmation. */
export async function shareOrCopy({ url, title }: ShareInput): Promise<ShareOutcome> {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      await navigator.share(title ? { title, url } : { url });
      return "shared";
    }
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(url);
      return "copied";
    }
  } catch {
    // Native share dismissed, or clipboard write denied — nothing to do.
  }
  return "unavailable";
}
