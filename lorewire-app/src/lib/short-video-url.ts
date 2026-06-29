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
