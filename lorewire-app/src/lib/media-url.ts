// Resolve a stored media reference to a live delivery URL at READ time.
//
// The root problem this fixes: the DB persists ABSOLUTE
// `https://storage.googleapis.com/<bucket>/<key>` URLs in `video_url`,
// `hero_image`, `audio_url`, `source_url`, scene image lists, etc. That bakes
// the storage host into every row, so moving the delivery backend (GCS -> the
// Cloudflare R2 custom domain) would otherwise mean rewriting every row in
// lockstep with the cutover. Instead we decide the delivery host HERE, when a
// row is read, so the backend can change without touching stored data.
//
// Set `MEDIA_PUBLIC_BASE` to the delivery base (e.g. https://media.lorewire.com)
// to serve everything through it. Leave it unset (dev, and prod pre-cutover)
// and every value passes through exactly as stored, so local `/generated/...`
// paths and existing GCS URLs keep working unchanged.
//
// This is the dual-read shim the migration plan (see
// _plans/2026-06-22-r2-media-migration-and-avatar-upload.md) leans on: with the
// base set, BOTH a legacy absolute GCS URL and a bare object key resolve to the
// same delivery URL, so old rows and new rows coexist during the rollout and
// in-flight renders can land mid-migration without breaking links.
//
// Only LEGACY GCS URLs are rewritten. Avatars hot-linked from DiceBear, OAuth
// provider pictures, and any other external/absolute URL are returned untouched
// — they are not our objects to re-host. Cache-bust query strings (the
// `?v=token` the short renderer appends) are preserved across the rewrite.

/** The host of the legacy public GCS URLs we rewrite. Mirrors the
 *  `storage.googleapis.com` host that lib/gcs.ts (PUBLIC_BASE / parseGcsUrl)
 *  writes and parses — kept as a local constant so this read-path helper does
 *  not import the server-only upload module just for a string. */
export const LEGACY_GCS_HOST = "storage.googleapis.com";

// Any `scheme:` prefix marks an absolute reference (http(s)://, data:, etc.).
// A bare object key (`<id>-short/video.mp4`) never carries one.
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** The configured delivery base, with any trailing slash removed. Null when
 *  `MEDIA_PUBLIC_BASE` is unset or blank — the signal to pass values through
 *  unchanged. */
export function mediaPublicBase(): string | null {
  const raw = process.env.MEDIA_PUBLIC_BASE?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

/** Extract the object key (path after the bucket segment), preserving the
 *  original percent-encoding and any query string, from a legacy public GCS
 *  URL of the shape `https://storage.googleapis.com/<bucket>/<key>`. Returns
 *  null for anything that is not such a URL, so the caller leaves it untouched. */
function gcsUrlToKeyWithQuery(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.host !== LEGACY_GCS_HOST) return null;
  // `pathname` is consistently percent-encoded; drop the leading slash and the
  // first segment (the bucket), keep the rest as the key.
  const path = parsed.pathname.replace(/^\/+/, "");
  const slash = path.indexOf("/");
  if (slash < 0) return null;
  const key = path.slice(slash + 1);
  if (!key) return null;
  return `${key}${parsed.search}`;
}

/** Resolve a stored media reference to the URL the browser should fetch.
 *
 *  - `null`/`undefined`/empty  -> null
 *  - base unset                -> returned unchanged (dev / pre-cutover)
 *  - legacy GCS URL            -> rewritten onto the base (query preserved)
 *  - other absolute URL        -> unchanged (DiceBear, OAuth, external)
 *  - site-relative `/path`     -> unchanged (app-served asset, not an object)
 *  - bare object key           -> base + key
 */
export function resolveMediaUrl(
  stored: string | null | undefined,
  base: string | null = mediaPublicBase(),
): string | null {
  if (!stored) return null;
  if (!base) return stored;
  const b = base.replace(/\/+$/, "");

  if (HAS_SCHEME_RE.test(stored)) {
    const key = gcsUrlToKeyWithQuery(stored);
    return key === null ? stored : `${b}/${key}`;
  }

  // A leading slash means an app-served path (e.g. the dev `/generated/...`
  // fallback), never a storage object key — leave it alone.
  if (stored.startsWith("/")) return stored;

  return `${b}/${stored}`;
}

/** Rewrite a value IF it is a legacy GCS URL, onto the delivery base; any other
 *  string (an already-on-base URL, an external URL, a caption, plain prose) is
 *  returned unchanged. Unlike resolveMediaUrl this NEVER treats a bare string as
 *  an object key, so it is safe to apply blindly to every string in a rich-text
 *  document. Used to flip media URLs embedded in article body JSON at render
 *  time. Inert (returns the value unchanged) when the base is unset. */
export function rewriteStoredMediaUrl(
  value: string,
  base: string | null = mediaPublicBase(),
): string {
  if (!base) return value;
  if (!HAS_SCHEME_RE.test(value)) return value;
  const key = gcsUrlToKeyWithQuery(value);
  return key === null ? value : `${base.replace(/\/+$/, "")}/${key}`;
}
