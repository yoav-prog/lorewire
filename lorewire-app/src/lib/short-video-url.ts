// Identify a story's "short" render by its GCS object path. The short renderer
// writes the MP4 to `<storyId>-short/video.mp4` (suffix from
// pipeline/shorts_render.SHORT_ID_SUFFIX); the long-form pipeline writes
// elsewhere. Detecting the apply from the URL itself avoids round-tripping a
// separate flag column.
//
// Centralised here so the live-media action (getLiveStoryMedia), the public
// shorts feed query (listPublishedShorts), and their tests share ONE definition
// instead of each re-deriving the suffix and risking drift.

/** Matches a short video URL by its trailing object path, tolerating a query
 *  string or fragment (signed URLs, cache-busters) after the filename. */
export const SHORT_VIDEO_PATH_RE = /-short\/video\.mp4(?:[?#].*)?$/;

/** The literal object-path substring the regex keys on. Exported so the SQL
 *  LIKE pattern and the regex can be pinned together in tests and can't drift. */
export const SHORT_VIDEO_PATH = "-short/video.mp4";

/** SQL `LIKE` pattern for the shorts-only feed query. Wrapped in `%` so it
 *  matches the suffix anywhere in the stored URL (the path may carry a query
 *  string). The pattern itself contains no `%`/`_` wildcards of its own, so it
 *  is safe to pass as a bound parameter on both SQLite and Postgres. */
export const SHORT_VIDEO_URL_LIKE = `%${SHORT_VIDEO_PATH}%`;

/** True when `url` points at an applied short (GCS suffix match). */
export function isShortVideoUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && SHORT_VIDEO_PATH_RE.test(url);
}

/** Append `?v={epochSeconds}` to a short video URL so caches treat each
 *  re-render as a fresh asset. The renderer overwrites the SAME R2 object
 *  key on every re-render and R2 serves with a one-year immutable
 *  Cache-Control, so a byte-identical URL keeps playing the OLD MP4 from
 *  browser/edge caches after a restart (bug observed 2026-07-03 on
 *  1pu6a9n and others: new short done for hours, old video still
 *  playing). Mirror of pipeline/media.py `_cache_bust` for hero art;
 *  the matchers above already tolerate the query suffix. Idempotent: a
 *  URL already carrying `v=` is returned unchanged. */
export function bustShortVideoUrl(url: string): string {
  if (!url || /[?&]v=/.test(url)) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${Math.floor(Date.now() / 1000)}`;
}
