// Reddit-thread identity helpers for the article reader.
//
// Background: the modal Read tab renders an embed of the original Reddit
// thread an article was sourced from. The URL the embed uses comes from
// the story's `source_url` field, which is written by the pipeline at
// ingest (`post.url` for the scraped Reddit post). Hand-edited catalog
// rows + the static published.ts overlay can drift, though — a wrong
// URL on a story silently shows the wrong thread under the article.
//
// This module exists so the render path can ASSERT the URL belongs to
// the article it's attached to, instead of trusting whatever string is
// in the field. The check is conservative on purpose: when in doubt,
// suppress the embed. A missing embed is fine; a wrong embed mis-leads
// the reader about what the article was based on.

// A Reddit post id is base36 (0-9 + a-z), historically 5+ chars. The
// pipeline normalises everything to lowercase, so the matcher does too.
const REDDIT_ID_RE = /^[a-z0-9]{5,}$/;

// Placeholder strings that show up in fixtures + draft rows. Any URL or
// id that's one of these is "not a real Reddit thread" and the embed
// must not render — Reddit would 404 on the link anyway.
const PLACEHOLDER_IDS = new Set([
  "example",
  "test",
  "placeholder",
  "demo",
  "sample",
]);

/** True when `id` looks like a real Reddit post id (5+ base36 chars and
 *  not a known placeholder string). Lowercased before matching so the
 *  caller doesn't have to normalise. */
export function isRealRedditId(id: string | null | undefined): boolean {
  if (!id || typeof id !== "string") return false;
  const lower = id.toLowerCase();
  if (!REDDIT_ID_RE.test(lower)) return false;
  return !PLACEHOLDER_IDS.has(lower);
}

/** Extract the Reddit post id from a thread URL.
 *  Returns the lowercased id or null when the URL isn't shaped like a
 *  Reddit post (no `/comments/<id>/` segment). The title slug after the
 *  id is ignored — Reddit treats it as decorative. */
export function extractRedditId(
  url: string | null | undefined,
): string | null {
  if (!url || typeof url !== "string") return null;
  const m = url.match(/reddit\.com\/r\/[^/]+\/comments\/([a-z0-9]+)/i);
  return m ? m[1].toLowerCase() : null;
}

export interface RedditEmbedTarget {
  /** The URL the `<RedditEmbed>` component should render. Either the
   *  passed-in `sourceUrl` (when the URL matches the authoritative id)
   *  or a canonical short URL synthesised from the authoritative id. */
  url: string;
  /** The verified Reddit thread id. Always set when this target is
   *  returned — callers can use it for logging. */
  redditId: string;
}

/**
 * Decide whether to render a Reddit embed for an article and which URL
 * the embed should point at.
 *
 * @param sourceUrl - The URL stored on the article (e.g. `story.source_url`).
 * @param authoritativeId - The article's authoritative Reddit thread id —
 *   for pipeline stories this is the `stories.reddit_id` column, which
 *   equals `stories.id`. Pass the story's own id when authoritativeId
 *   isn't separately tracked.
 *
 * Decision rules (the safety invariant is the mismatch case):
 *  - authoritativeId is a real Reddit id + URL parses to the SAME id  → render with `sourceUrl`
 *  - authoritativeId is a real Reddit id + URL parses to a DIFFERENT id → NO embed (wrong thread)
 *  - authoritativeId is a real Reddit id + URL missing/unparseable    → NO embed (can't synthesise blindly)
 *  - authoritativeId not real id + URL parses to a real id            → render with `sourceUrl` (legacy fallback)
 *  - neither side has a real id                                       → NO embed
 *
 * The "URL missing → NO embed" branch is deliberately strict. Synthesising
 * a URL from a synthetic catalog id (like `envelope`) would link to a
 * non-existent thread, so we refuse instead.
 */
export function resolveRedditEmbedTarget(
  sourceUrl: string | null | undefined,
  authoritativeId: string | null | undefined,
): RedditEmbedTarget | null {
  const fromUrl = extractRedditId(sourceUrl);
  const authReal = isRealRedditId(authoritativeId);

  if (authReal) {
    const auth = authoritativeId!.toLowerCase();
    if (!fromUrl) {
      // No parseable URL alongside a real authoritative id. We could
      // synthesise `https://reddit.com/comments/<auth>/` but that risks
      // pointing at a thread that doesn't exist when `auth` came from a
      // synthetic catalog id. Safer to suppress.
      return null;
    }
    if (fromUrl !== auth) {
      // The URL points at a different thread than the article was
      // sourced from. This is the bug the module exists to prevent.
      return null;
    }
    return { url: sourceUrl!, redditId: auth };
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
 *  so older callers that only see a URL keep compiling while we port
 *  them to the stricter `resolveRedditEmbedTarget`. */
export function isRealRedditUrl(url: string | null | undefined): boolean {
  return resolveRedditEmbedTarget(url, null) !== null;
}
