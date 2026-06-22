"""Google Cloud Storage uploader for pipeline-generated media.

When `GCS_BUCKET` is set the pipeline uploads each rendered asset to a public
GCS bucket and stores the `https://storage.googleapis.com/<bucket>/<key>` URL
in the DB. When unset, callers keep the local-file behavior (write to
`lorewire-app/public/generated/<id>/`, store the `/generated/<id>/<file>` URL)
so dev runs work offline.

Auth uses a separate service account (`GCS_CLIENT_EMAIL` / `GCS_PRIVATE_KEY`)
from the TTS/STT one — clean separation of duties per the security plan. The
OAuth2 token flow is the same JWT bearer dance `pipeline/google_auth.py` uses;
we sign with google-auth's signer and exchange via stdlib urllib.

The bucket itself must already grant `roles/storage.objectViewer` to
`allUsers` (uniform bucket-level access). That makes every uploaded object
publicly readable through the canonical URL without per-object ACL writes.
"""
from __future__ import annotations

import json
import mimetypes
import time
import urllib.parse
import urllib.request
from pathlib import Path

from google.auth import jwt as gauth_jwt
from google.oauth2 import service_account

from pipeline import config

TOKEN_URI = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/devstorage.read_write"
UPLOAD_BASE = "https://storage.googleapis.com/upload/storage/v1"
PUBLIC_BASE = "https://storage.googleapis.com"
TOKEN_TTL_SECONDS = 3000

_cached: dict = {"token": None, "expires_at": 0.0}

# Small explicit map so we don't depend on the host's mimetypes registry being
# populated with every codec we emit. Anything unknown falls through to
# application/octet-stream which browsers handle but won't try to inline.
_MIME = {
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp3":  "audio/mpeg",
    ".wav":  "audio/wav",
    ".mp4":  "video/mp4",
    ".webm": "video/webm",
}


def is_configured() -> bool:
    """True when GCS_BUCKET + the two required GCS_* credential vars are set."""
    return bool(config.env("GCS_BUCKET")) and not _missing_credentials()


def _missing_credentials() -> list[str]:
    # client_id is the service account's numeric id, useful for telemetry but
    # not required by google-auth's JWT bearer flow — client_email + private_key
    # are the two that actually sign the token.
    needed = ("GCS_CLIENT_EMAIL", "GCS_PRIVATE_KEY")
    return [k for k in needed if not config.env(k)]


def _service_account_info() -> dict:
    miss = _missing_credentials()
    if miss:
        raise RuntimeError(
            "GCS upload is not configured. Set " + ", ".join(miss) + " in .env.local."
        )
    private_key = (config.env("GCS_PRIVATE_KEY") or "").replace("\\n", "\n")
    if "BEGIN PRIVATE KEY" not in private_key:
        raise RuntimeError(
            "GCS_PRIVATE_KEY is set but does not look like a PEM key. Verify the "
            "'-----BEGIN PRIVATE KEY-----' line is intact and newlines are preserved."
        )
    return {
        "type": "service_account",
        "private_key": private_key,
        "client_email": config.env("GCS_CLIENT_EMAIL"),
        "token_uri": TOKEN_URI,
    }


def _access_token() -> str:
    now = time.time()
    if _cached["token"] and now < _cached["expires_at"]:
        return _cached["token"]

    info = _service_account_info()
    creds = service_account.Credentials.from_service_account_info(info, scopes=[SCOPE])
    issued_at = int(now)
    assertion = gauth_jwt.encode(
        creds._signer,
        {
            "iss": info["client_email"],
            "scope": SCOPE,
            "aud": TOKEN_URI,
            "iat": issued_at,
            "exp": issued_at + 3600,
        },
    ).decode("utf-8")

    body = urllib.parse.urlencode(
        {
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        TOKEN_URI,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    token = data.get("access_token")
    if not token:
        raise RuntimeError(f"GCS OAuth2 response missing access_token: {str(data)[:200]}")
    _cached["token"] = token
    _cached["expires_at"] = now + TOKEN_TTL_SECONDS
    return token


def _mime_for(name: str) -> str:
    suffix = Path(name).suffix.lower()
    if suffix in _MIME:
        return _MIME[suffix]
    detected, _ = mimetypes.guess_type(name)
    return detected or "application/octet-stream"


# Raster images we re-encode to WebP on the way out. WebP at q82/method6 is
# visually lossless for flat-color doodle art and roughly 10-20x smaller than the
# source PNG, which is the single biggest media-size win. Plan:
# _plans/2026-06-22-media-compression.md.
_IMAGE_EXTS = {".png", ".jpg", ".jpeg"}
WEBP_QUALITY = 82


def _swap_ext_to_webp(key: str) -> str:
    """Replace the key's filename extension with `.webp`, leaving the path."""
    slash = key.rfind("/")
    name = key[slash + 1 :]
    dot = name.rfind(".")
    new_name = (name[:dot] if dot > 0 else name) + ".webp"
    return (key[: slash + 1] + new_name) if slash >= 0 else new_name


def _maybe_compress_image(local_path: Path, key: str) -> tuple[Path, str]:
    """If `local_path` is a compressible raster image, re-encode it to WebP and
    return the new (path, key) with a `.webp` extension. Non-images, or any
    encode failure, pass through unchanged so a bad image never blocks a publish.
    Already-WebP inputs are left alone."""
    if local_path.suffix.lower() not in _IMAGE_EXTS:
        return local_path, key
    try:
        from PIL import Image

        out_path = local_path.with_suffix(".webp")
        with Image.open(local_path) as im:
            im.save(out_path, format="WEBP", quality=WEBP_QUALITY, method=6)
        return out_path, _swap_ext_to_webp(key)
    except Exception as e:  # never let compression block a publish
        print(f"[gcs compress] {key}: {e}; uploading original")
        return local_path, key


# ── Cloudflare R2 (S3 API) target ──────────────────────────────────────────
# The media migration moves viewer-facing media off GCS to R2 to kill egress
# cost. R2 speaks the S3 API; we sign with boto3 (imported lazily so the
# pipeline still imports cleanly before boto3 is installed). R2 is the upload
# target ONLY when every R2_* var AND MEDIA_PUBLIC_BASE are set — the same flag
# the Node read-resolver keys on — so it stays inert until the GCS->R2 copy has
# run and the base is deliberately flipped.
# Plan: _plans/2026-06-22-r2-media-migration-and-avatar-upload.md.

_r2_cached: dict = {"client": None}


def _r2_endpoint() -> str:
    explicit = config.env("R2_ENDPOINT")
    if explicit:
        return explicit.rstrip("/")
    account = config.env("R2_ACCOUNT_ID")
    if not account:
        raise RuntimeError("R2 is not configured: set R2_ACCOUNT_ID or R2_ENDPOINT.")
    return f"https://{account}.r2.cloudflarestorage.com"


def _r2_media_enabled() -> bool:
    return (config.env("R2_MEDIA_WRITE_ENABLED") or "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _r2_configured() -> bool:
    """True only when R2 is the ACTIVE media target: fully wired (credentials,
    endpoint, media bucket, public base) AND explicitly switched on via
    R2_MEDIA_WRITE_ENABLED. The explicit flag is the cutover switch — merely
    having the R2 vars present (they're shared with the avatar path) must NOT
    silently redirect pipeline media. Flip the flag on only AFTER the one-time
    GCS->R2 copy, so new and existing media never split across backends."""
    if not _r2_media_enabled():
        return False
    return bool(
        config.env("R2_ACCESS_KEY_ID")
        and config.env("R2_SECRET_ACCESS_KEY")
        and (config.env("R2_ACCOUNT_ID") or config.env("R2_ENDPOINT"))
        and config.env("R2_MEDIA_BUCKET")
        and config.env("MEDIA_PUBLIC_BASE")
    )


def _r2_client():
    if _r2_cached["client"] is not None:
        return _r2_cached["client"]
    import boto3  # lazy: keep the pipeline importable without boto3 until R2 is on
    from botocore.config import Config as BotoConfig

    client = boto3.client(
        "s3",
        endpoint_url=_r2_endpoint(),
        aws_access_key_id=config.env("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=config.env("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
        config=BotoConfig(signature_version="s3v4"),
    )
    _r2_cached["client"] = client
    return client


def _r2_upload(local_path: Path, key: str) -> str:
    """Upload to the R2 media bucket and return the public delivery URL. The
    long immutable Cache-Control means the edge cache (not the bucket) serves
    the bytes — that caching is what makes R2 delivery essentially free."""
    bucket = config.env("R2_MEDIA_BUCKET")
    base = (config.env("MEDIA_PUBLIC_BASE") or "").rstrip("/")
    with local_path.open("rb") as fh:
        _r2_client().put_object(
            Bucket=bucket,
            Key=key,
            Body=fh,
            ContentType=_mime_for(local_path.name),
            CacheControl="public, max-age=31536000, immutable",
        )
    return f"{base}/{key}"


def upload(local_path: Path, key: str) -> str:
    """Upload a local file to `<bucket>/<key>` and return the public URL.

    `key` is the object name (e.g. `envelope/hero.png`); the bucket is taken
    from `GCS_BUCKET`. The bucket is assumed to have `allUsers: objectViewer`
    set at the bucket level so the returned URL serves without signing.
    """
    if not local_path.exists():
        raise FileNotFoundError(f"upload source missing: {local_path}")
    # Compress raster images to WebP first (keeps quality, ~10-20x smaller for the
    # doodle frames). Non-images / failures pass through unchanged. The returned
    # URL therefore ends in .webp for images, and callers store that.
    local_path, key = _maybe_compress_image(local_path, key)
    # Media migration: when R2 is the configured target (R2_* + MEDIA_PUBLIC_BASE
    # all set) new media goes to R2; otherwise we keep writing to GCS. Inert in
    # any environment that hasn't set MEDIA_PUBLIC_BASE.
    if _r2_configured():
        return _r2_upload(local_path, key)

    bucket = config.env("GCS_BUCKET")
    if not bucket:
        raise RuntimeError("GCS_BUCKET is not set; cannot upload.")

    payload = local_path.read_bytes()
    mime = _mime_for(local_path.name)
    encoded_key = urllib.parse.quote(key, safe="")
    # predefinedAcl=publicRead grants allUsers:READER on the object so it
    # serves through https://storage.googleapis.com/<bucket>/<key> without
    # signing. Required on buckets using legacy per-object ACLs (the
    # default for buckets created before uniform bucket-level access was
    # standard). Buckets with uniform bucket-level access reject this
    # flag — we handle that in publish() with a retry.
    url = (
        f"{UPLOAD_BASE}/b/{urllib.parse.quote(bucket, safe='')}/o"
        f"?uploadType=media&name={encoded_key}&predefinedAcl=publicRead"
    )
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {_access_token()}",
            "Content-Type": mime,
            "Content-Length": str(len(payload)),
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        body = resp.read()
        if resp.status not in (200, 201):
            raise RuntimeError(f"GCS upload HTTP {resp.status}: {body[:200]!r}")
    return f"{PUBLIC_BASE}/{bucket}/{key}"


def publish(local_path: Path, key: str, local_url: str) -> str:
    """Return the URL the DB should store for this asset.

    Uploads to GCS when configured, otherwise returns the local `/generated/...`
    URL (the file already lives there since callers write locally first). This
    keeps the dev workflow unchanged while prod stories migrate to GCS without
    a code branch at every call site.
    """
    if is_configured() or _r2_configured():
        try:
            return upload(local_path, key)
        except Exception as e:
            print(f"[gcs upload err] {key}: {e}; falling back to local URL")
            return local_url
    return local_url


def exists(key: str) -> bool:
    """Return True when `<bucket>/<key>` already exists in GCS.

    Anonymous HEAD against the public URL — the bucket is configured
    public-read so no auth is needed for an existence probe. Used by
    the voice-preview bake script to make re-runs idempotent:
    `scripts/bake_voice_previews.py` skips objects already present
    instead of paying for the TTS call + upload twice.

    Returns False on any non-200 (including 404, 403, and transport
    errors) — treating "I can't tell" as "doesn't exist" means the
    caller re-uploads, which is the safe fallback (uploads overwrite
    cleanly on GCS).
    """
    if _r2_configured():
        base = (config.env("MEDIA_PUBLIC_BASE") or "").rstrip("/")
        url = f"{base}/{urllib.parse.quote(key, safe='/')}"
    else:
        bucket = config.env("GCS_BUCKET")
        if not bucket:
            return False
        url = (
            f"{PUBLIC_BASE}/{urllib.parse.quote(bucket, safe='')}"
            f"/{urllib.parse.quote(key, safe='/')}"
        )
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except urllib.error.HTTPError:
        return False
    except urllib.error.URLError:
        return False


def _reset_cache_for_tests() -> None:
    _cached["token"] = None
    _cached["expires_at"] = 0.0
    _r2_cached["client"] = None
