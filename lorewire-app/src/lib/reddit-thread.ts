// Reddit-thread identity helpers for the article reader.
//
// Background: the modal Read tab renders an embed of the original Reddit
// thread an article was sourced from. The URL the embed uses USED to come
// from the story's `source_url` field — which is hand-editable in the
// catalog overlay and was caught (June 2026) attaching the wrong thread
// to the envelope story.
//
// The current design: `reddit_id` is the single source of truth. The
// pipeline writes it at story creation from the scraped post's id (see
// pipeline/story_jobs_worker.py); the render path constructs the canonical
// Reddit URL from it (`https://www.reddit.com/comments/<id>/`) and lets
// Reddit canonicalise to the full thread server-side. `source_url` is
// kept for display attribution but is no longer load-bearing for the
// embed — a hand-edited wrong URL can't override the constructed one.
//
// What counts as a "real" Reddit id:
//  - Modern Reddit (post-2018) post ids are base36 (a-z0-9), 5-12 chars,
//    and ALMOST ALWAYS contain at least one digit because they're encoded
//    timestamps. Synthetic catalog ids ("envelope", "fence", "wifi") are
//    pure English words and don't pass the digit check, so they don't
//    get a constructed URL — Reddit would 404 on those.
//  - Known fixture placeholders ("example", "test", "demo", "sample",
//    "placeholder") are rejected outright.

// Allowable id charset: Reddit's base36. Lowercased before matching so
// callers don't have to normalise.
const REDDIT_ID_RE = /^[a-z0-9]{5,}$/;

// Modern Reddit post ids are timestamp-encoded base36 — at least one
// digit is a near-universal signature. Synthetic English-word ids
// ("envelope", "fence", "wifi", "birthday") never pass this. Used as
// the strict signal for "we can trust this id as the truth and build a
// canonical URL from it."
const REDDIT_DIGIT_RE = /\d/;

// Strings that recur in fixtures + dry-run rows. Treated as definitely-
// not-a-real-Reddit-thread regardless of where they appear.
const PLACEHOLDER_IDS = new Set([
  "example",
  "test",
  "placeholder",
  "demo",
  "sample",
]);

/** Shape-checks an id against the Reddit charset + length and rejects
 *  known placeholder strings. Use as the broad "looks roughly like a
 *  Reddit id" gate — does NOT require a digit, so synthetic English-
 *  word ids pass. Pair with `looksLikeRealRedditPostId` when you need
 *  the stricter "this is genuinely a Reddit post id" guarantee.
 *  Kept around because the legacy URL-only fallback path still
 *  validates using this looser definition. */
export function isRealRedditId(id: string | null | undefined): boolean {
  if (!id || typeof id !== "string") return false;
  const lower = id.toLowerCase();
  if (!REDDIT_ID_RE.test(lower)) return false;
  return !PLACEHOLDER_IDS.has(lower);
}

/** Strict variant of `isRealRedditId` — adds the digit-required check
 *  that distinguishes genuine modern Reddit post ids from synthetic
 *  English-word catalog ids. Used to gate the "build a canonical embed
 *  URL from this id" path; without this stricter check we'd happily
 *  construct `https://reddit.com/comments/envelope/` which Reddit
 *  would 404 on. */
export function looksLikeRealRedditPostId(
  id: string | null | undefined,
): boolean {
  if (!isRealRedditId(id)) return false;
  return REDDIT_DIGIT_RE.test(id!);
}

/** Extract the Reddit post id from a thread URL. Returns the lowercased
 *  id or null when the URL isn't shaped like a Reddit post (no
 *  `/comments/<id>/` segment). The title slug after the id is ignored —
 *  Reddit treats it as decorative. */
export function extractRedditId(
  url: string | null | undefined,
): string | null {
  if (!url || typeof url !== "string") return null;
  const m = url.match(/reddit\.com\/r\/[^/]+\/comments\/([a-z0-9]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/** Build the canonical short-form Reddit URL for a post id. Reddit's web
 *  layer 301-redirects this to the full `/r/<sub>/comments/<id>/<slug>/`
 *  URL, and the embed widget at `embed.reddit.com/widgets.js` follows
 *  the redirect to hydrate. Used as the embed target whenever we have
 *  a trustworthy id — guarantees the URL points at the right thread
 *  even if the stored `source_url` got hand-edited to something wrong. */
export function buildRedditEmbedUrl(redditId: string): string {
  return `https://www.reddit.com/comments/${redditId.toLowerCase()}/`;
}

export interface RedditEmbedTarget {
  /** The URL the `<RedditEmbed>` component should render. Either the
   *  caller's `sourceUrl` (when it agrees with the authoritative id —
   *  preserves the post-title slug for display) or a canonical short
   *  URL synthesised from the authoritative id. */
  url: string;
  /** The verified Reddit thread id. Always set when this target is
   *  returned — callers can use it for logging + diagnostics. */
  redditId: string;
}

/**
 * Decide whether to render a Reddit embed for an article and which URL
 * the embed should point at. The safety invariant: a mismatch between
 * the stored URL and the authoritative id means SOMETHING is wrong with
 * the data — refuse to embed rather than show the wrong thread.
 *
 * @param sourceUrl - The URL stored on the article (e.g. `story.source_url`).
 * @param authoritativeId - The article's authoritative Reddit thread id.
 *   For pipeline rows this is `stories.reddit_id` which equals `stories.id`.
 *   Pass the story's own id when authoritativeId isn't separately tracked.
 *
 * Resolution branches (in order):
 *  - authoritative id strong (passes `looksLikeRealRedditPostId`):
 *    - URL parses to the SAME id  → use `sourceUrl` (keeps title slug)
 *    - URL parses to a DIFFERENT id → NO embed (mismatch = wrong thread)
 *    - URL missing / unparseable   → use CONSTRUCTED `buildRedditEmbedUrl(id)`
 *  - authoritative id loose (passes `isRealRedditId` but no digit, e.g.
 *    a synthetic catalog id like 'envelope'):
 *    - URL parses to the SAME id  → use `sourceUrl`
 *    - URL parses to a DIFFERENT id → NO embed
 *    - URL missing → NO embed (refuses to construct from a synthetic id)
 *  - authoritative id missing or fails even the loose check:
 *    - URL parses to a real id → use `sourceUrl` (legacy fallback)
 *    - otherwise              → NO embed
 *
 * The "URL missing + strong id → construct" branch is the new robustness
 * win: even if `source_url` got dropped or mangled in a future schema
 * change, pipeline stories still get the correct embed because the
 * URL is derived from the id at render time.
 */
export function resolveRedditEmbedTarget(
  sourceUrl: string | null | undefined,
  authoritativeId: string | null | undefined,
): RedditEmbedTarget | null {
  const fromUrl = extractRedditId(sourceUrl);
  const authLoose = isRealRedditId(authoritativeId);
  const authStrong = looksLikeRealRedditPostId(authoritativeId);

  if (authLoose) {
    const auth = authoritativeId!.toLowerCase();
    if (fromUrl) {
      if (fromUrl !== auth) {
        // Stored URL points at a DIFFERENT thread than the article was
        // sourced from. This is the envelope bug — refuse to embed.
        return null;
      }
      return { url: sourceUrl!, redditId: auth };
    }
    // No parseable URL alongside the authoritative id. Construct ONLY
    // when the id has a strong reddit-id signature (digit). Synthetic
    // catalog ids without a URL get null because the constructed link
    // would 404 on Reddit.
    if (authStrong) {
      return { url: buildRedditEmbedUrl(auth), redditId: auth };
    }
    return null;
  }

  // No authoritative id worth trusting. Fall back to URL-only validation
  // so legacy catalog entries that still rely on hand-attached source
  // URLs keep working — but only when the URL itself looks real.
  if (fromUrl && isRealRedditId(fromUrl)) {
    return { url: sourceUrl!, redditId: fromUrl };
  }
  return null;
}

/** Back-compat shim. Equivalent to passing a null authoritativeId — kept
 *  so callers that only see a URL keep compiling while everything else
 *  migrates to the stricter `resolveRedditEmbedTarget`. */
export function isRealRedditUrl(url: string | null | undefined): boolean {
  return resolveRedditEmbedTarget(url, null) !== null;
}
