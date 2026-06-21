// Avatar presets — the curated DiceBear styles + seeds the account-page
// picker offers users who don't want to upload their own photo.
//
// DiceBear (https://www.dicebear.com) is an MIT-licensed open-source
// avatar library. The HTTP API at api.dicebear.com requires no key, no
// rate limit, and returns deterministic SVGs for any (style, seed) pair.
// We hot-link the SVG URL into `users.picture_url` rather than self-host
// to keep the surface area zero on the server — the cost of that choice
// is that the avatar breaks if DiceBear has an outage; if/when that
// matters we cache the SVG into GCS on selection.
//
// Style choices below were chosen for a young, contemporary feel —
// notionists reads as the modern hand-drawn "Notion sketch" everyone
// knows, fun-emoji is playful, lorelei is warm illustrated portraiture,
// avataaars is the classic cartoon recognizable across the web, and
// pixel-art covers the retro/gaming crowd.

export interface AvatarStyle {
  /** DiceBear style id (URL path segment). */
  id: string;
  /** Human-friendly label shown on the picker tab. */
  label: string;
  /** Short description shown under the tab label — sets expectations
   *  before the user clicks (modern hand-drawn vs cartoon vs pixel art). */
  blurb: string;
}

export const AVATAR_STYLES: readonly AvatarStyle[] = [
  { id: "notionists", label: "Sketch", blurb: "Hand-drawn portraits" },
  { id: "fun-emoji", label: "Emoji", blurb: "Bright, playful faces" },
  { id: "lorelei", label: "Portraits", blurb: "Warm, illustrated" },
  { id: "avataaars", label: "Classic", blurb: "Cartoon characters" },
  { id: "pixel-art", label: "Pixel", blurb: "Retro 8-bit" },
];

// Seeds picked to render attractively across all five styles — DiceBear
// is deterministic per (style, seed), so the same name yields the same
// face every time the picker mounts. 12 seeds × 5 styles = 60 unique
// options; that's a small enough set to feel curated rather than random,
// and big enough that two friends rarely pick identically.
export const AVATAR_SEEDS: readonly string[] = [
  "Nova",
  "Atlas",
  "Echo",
  "Luna",
  "Sage",
  "Kai",
  "Rio",
  "Vega",
  "Zoe",
  "Iris",
  "Onyx",
  "Wren",
];

const DICEBEAR_HOST = "https://api.dicebear.com";
const DICEBEAR_VERSION = "10.x";

/** Build a DiceBear SVG URL for a (style, seed). The URL is stable and
 *  safe to store directly in `users.picture_url`. */
export function buildAvatarUrl(
  style: string,
  seed: string,
  options: { size?: number } = {},
): string {
  const url = new URL(`${DICEBEAR_HOST}/${DICEBEAR_VERSION}/${style}/svg`);
  url.searchParams.set("seed", seed);
  if (options.size) url.searchParams.set("size", String(options.size));
  return url.href;
}

const DICEBEAR_URL_RE = /^https:\/\/api\.dicebear\.com\/\d+\.x\/([^/]+)\/svg/;

/** True when `url` came from DiceBear's HTTP API (any major version). The
 *  account picker uses this to highlight the currently-selected preset
 *  when the page mounts. */
export function isDiceBearAvatarUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== "string") return false;
  return DICEBEAR_URL_RE.test(url);
}

/** Extract the (style, seed) pair from a DiceBear URL so the picker can
 *  show the matching tile as selected. Returns null when the URL isn't a
 *  parseable DiceBear avatar (different host, missing seed param, etc). */
export function parseDiceBearUrl(
  url: string | null | undefined,
): { style: string; seed: string } | null {
  if (!url || typeof url !== "string") return null;
  const m = url.match(DICEBEAR_URL_RE);
  if (!m) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const seed = parsed.searchParams.get("seed");
  if (!seed) return null;
  return { style: m[1], seed };
}
