"""Resolve a stored media reference to a live delivery URL at READ time.

Python port of `lorewire-app/src/lib/media-url.ts`. The two sides must agree
exactly so a URL rewritten by the Next reader and a URL rewritten here resolve
to the same delivery URL. Tests in `pipeline/tests/test_media_url.py` mirror
the TS test suite branch-for-branch so the two cannot drift silently.

The root problem this fixes: the DB persists ABSOLUTE
`https://storage.googleapis.com/<bucket>/<key>` URLs in `video_url`,
`hero_image`, `audio_url`, scene URL lists, and props blobs. Pipeline code that
ships those URLs to external services (kie.ai i2i, Cloud Run dispatch) needs
the same dual-read rewrite the Next reader applies, otherwise a post-migration
host change (GCS public read disabled, bucket retired) breaks every outbound
call silently. Plan: _plans/2026-06-23-pipeline-outbound-url-rewriter.md.

Set `MEDIA_PUBLIC_BASE` to the delivery base (e.g. https://media.lorewire.com)
to serve everything through it. Leave it unset (dev) and every value passes
through exactly as stored.

Only LEGACY GCS URLs (host == `storage.googleapis.com`) are rewritten. Avatars
hot-linked from DiceBear, OAuth provider pictures, kie's tempfile host, and
URLs already on the delivery base pass through untouched. Cache-bust query
strings (the `?v=token` the short renderer appends) are preserved.
"""
from __future__ import annotations

import re
import urllib.parse

from pipeline import config

# Host of the legacy public GCS URLs we rewrite. Mirrors PUBLIC_BASE in
# `pipeline/gcs.py` (the writer) and `LEGACY_GCS_HOST` in `media-url.ts` (the
# Next reader) — kept as a local constant so this read-path helper does not
# import the heavy gcs.py module (with its google-auth deps) just for a string.
LEGACY_GCS_HOST = "storage.googleapis.com"

# Any `scheme:` prefix marks an absolute reference (http(s)://, data:, etc.).
# A bare object key (`<id>-short/video.mp4`) never carries one.
_HAS_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.\-]*:", re.IGNORECASE)


def media_public_base() -> str | None:
    """The configured delivery base, with any trailing slash removed.

    `None` when `MEDIA_PUBLIC_BASE` is unset or blank — the signal to pass
    values through unchanged. Read on every call (not cached) so test harnesses
    can flip it mid-process via `monkeypatch.setenv`.
    """
    raw = config.env("MEDIA_PUBLIC_BASE")
    if raw is None:
        return None
    raw = raw.strip()
    if not raw:
        return None
    return raw.rstrip("/")


def _gcs_url_to_key_with_query(url: str) -> str | None:
    """Extract the object key (path after the bucket segment), preserving
    the original percent-encoding and any query string, from a legacy public
    GCS URL of the shape `https://storage.googleapis.com/<bucket>/<key>`.

    Returns `None` for anything that is not such a URL so the caller leaves
    it untouched.
    """
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return None
    if parsed.hostname != LEGACY_GCS_HOST:
        return None
    # urlsplit's `path` is consistently percent-encoded; drop the leading
    # slash and the first segment (the bucket), keep the rest as the key.
    path = parsed.path.lstrip("/")
    slash = path.find("/")
    if slash < 0:
        return None
    key = path[slash + 1 :]
    if not key:
        return None
    if parsed.query:
        return f"{key}?{parsed.query}"
    return key


def resolve_media_url(
    stored: str | None,
    base: str | None | object = ...,  # type: ignore[assignment]
) -> str | None:
    """Resolve a stored media reference to the URL a fetcher should use.

    - `None` / empty                     -> `None`
    - base unset                          -> returned unchanged (dev / pre-cutover)
    - legacy GCS URL                      -> rewritten onto the base (query preserved)
    - other absolute URL (DiceBear, OAuth, R2-on-base, kie tempfile) -> unchanged
    - site-relative `/path`               -> unchanged
    - bare object key (`abc/hero.png`)    -> `<base>/<key>`

    `base` defaults to `media_public_base()` when omitted. Pass an explicit
    `None` to force pass-through (useful in tests). The sentinel
    `Ellipsis`-as-default lets tests assert "no base configured" without
    mocking the env reader.
    """
    if base is ...:  # sentinel: use the env-derived base
        base_str: str | None = media_public_base()
    else:
        base_str = base  # type: ignore[assignment]
    if not stored:
        return None
    if not base_str:
        return stored
    b = base_str.rstrip("/")

    if _HAS_SCHEME_RE.match(stored):
        key = _gcs_url_to_key_with_query(stored)
        return stored if key is None else f"{b}/{key}"

    # A leading slash means an app-served path (e.g. the dev `/generated/...`
    # fallback), never a storage object key — leave it alone.
    if stored.startswith("/"):
        return stored

    return f"{b}/{stored}"


def rewrite_stored_media_url(
    value: str,
    base: str | None | object = ...,  # type: ignore[assignment]
) -> str:
    """Rewrite a value IF it is a legacy GCS URL, onto the delivery base; any
    other string (an already-on-base URL, an external URL, a caption, plain
    prose) is returned unchanged.

    Unlike `resolve_media_url` this NEVER treats a bare string as an object
    key, so it is safe to apply blindly to every string in a rich-text
    document or props blob. Inert (returns the value unchanged) when the
    base is unset.
    """
    if base is ...:
        base_str: str | None = media_public_base()
    else:
        base_str = base  # type: ignore[assignment]
    if not base_str:
        return value
    if not _HAS_SCHEME_RE.match(value):
        return value
    key = _gcs_url_to_key_with_query(value)
    if key is None:
        return value
    return f"{base_str.rstrip('/')}/{key}"


def resolve_outbound_urls(urls: list[str]) -> tuple[list[str], int]:
    """Apply `resolve_media_url` to every URL in a list, counting how many
    were actually rewritten.

    Used by `pipeline/images.py:generate` and similar chokepoints to log
    `[media url resolve] count=<n> rewrote=<n>` without each caller
    re-implementing the count. None / empty entries are dropped from the
    output (mirrors how `images.generate` already filters `image_input`).
    """
    base = media_public_base()
    out: list[str] = []
    rewrote = 0
    for u in urls:
        if not u:
            continue
        resolved = resolve_media_url(u, base)
        if resolved is None:
            continue
        if resolved != u:
            rewrote += 1
            print(
                f"[media url resolve] from={u[:80]!r} to={resolved[:80]!r}"
            )
        out.append(resolved)
    return out, rewrote
