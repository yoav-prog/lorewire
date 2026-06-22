// Client-side share helpers — one source of truth for "share this public URL"
// across the Wires feed (WireCard) and the homepage detail modals (AppShell /
// DesktopShell). We deliberately do NOT use the Web Share API: on desktop it
// hands off to the OS share panel (the Windows share flyout), which is off-brand
// and inconsistent. Instead we render our own ShareSheet with explicit
// per-platform deep links plus a clipboard copy.
//
// SECURITY: only ever pass the PUBLIC canonical reader URL here (/v/[slug]).
// Never an internal story id, a draft URL, or a signed media URL — those must
// not leave the app through a share action.

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

/** Copy `text` to the clipboard. Returns true on success, false if the
 *  clipboard is unavailable or the write was denied. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // private mode / permission denied — fall through
  }
  return false;
}

export type ShareTargetId =
  | "whatsapp"
  | "x"
  | "facebook"
  | "telegram"
  | "linkedin"
  | "email";

export interface ShareTarget {
  id: ShareTargetId;
  label: string;
  /** Brand colour for the icon chip. */
  color: string;
  /** The deep link that opens the platform's composer pre-filled. */
  href: string;
}

/** Build the per-platform share links for a public URL + title. Every value is
 *  URL-encoded. These are public web intents — no SDK, no API key, no cost. */
export function shareTargets(url: string, title: string): ShareTarget[] {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(title);
  const tu = encodeURIComponent(`${title} ${url}`);
  return [
    { id: "whatsapp", label: "WhatsApp", color: "#25D366", href: `https://wa.me/?text=${tu}` },
    { id: "x", label: "X", color: "#000000", href: `https://twitter.com/intent/tweet?url=${u}&text=${t}` },
    { id: "facebook", label: "Facebook", color: "#1877F2", href: `https://www.facebook.com/sharer/sharer.php?u=${u}` },
    { id: "telegram", label: "Telegram", color: "#26A5E4", href: `https://t.me/share/url?url=${u}&text=${t}` },
    { id: "linkedin", label: "LinkedIn", color: "#0A66C2", href: `https://www.linkedin.com/sharing/share-offsite/?url=${u}` },
    { id: "email", label: "Email", color: "#5B6470", href: `mailto:?subject=${t}&body=${tu}` },
  ];
}
