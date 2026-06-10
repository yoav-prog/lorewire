"""Google Cloud Storage uploader for pipeline-generated media.

When `GCS_BUCKET` is set the pipeline uploads each rendered asset to a public
GCS bucket and stores the `https://storage.googleapis.com/<bucket>/<key>` URL
in the DB. When unset, callers keep the local-file behavior (write to
`lorewire-app/public/generated/<id>/`, store the `/generated/<id>/<file>` URL)
so dev runs work offline.

Auth uses a separate service account (`GOOGLE_GCS_*`) from the TTS/STT one —
clean separation of duties per the security plan. The OAuth2 token flow is
the same JWT bearer dance `pipeline/google_auth.py` uses; we sign with
google-auth's signer and exchange via stdlib urllib.

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
    """True when GCS_BUCKET + all three GOOGLE_GCS_* env vars are set."""
    return bool(config.env("GCS_BUCKET")) and not _missing_credentials()


def _missing_credentials() -> list[str]:
    needed = ("GOOGLE_GCS_PROJECT_ID", "GOOGLE_GCS_CLIENT_EMAIL", "GOOGLE_GCS_PRIVATE_KEY")
    return [k for k in needed if not config.env(k)]


def _service_account_info() -> dict:
    miss = _missing_credentials()
    if miss:
        raise RuntimeError(
            "GCS upload is not configured. Set " + ", ".join(miss) + " in .env.local."
        )
    private_key = (config.env("GOOGLE_GCS_PRIVATE_KEY") or "").replace("\\n", "\n")
    if "BEGIN PRIVATE KEY" not in private_key:
        raise RuntimeError(
            "GOOGLE_GCS_PRIVATE_KEY is set but does not look like a PEM key. Verify the "
            "'-----BEGIN PRIVATE KEY-----' line is intact and newlines are preserved."
        )
    return {
        "type": "service_account",
        "project_id": config.env("GOOGLE_GCS_PROJECT_ID"),
        "private_key": private_key,
        "client_email": config.env("GOOGLE_GCS_CLIENT_EMAIL"),
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


def upload(local_path: Path, key: str) -> str:
    """Upload a local file to `<bucket>/<key>` and return the public URL.

    `key` is the object name (e.g. `envelope/hero.png`); the bucket is taken
    from `GCS_BUCKET`. The bucket is assumed to have `allUsers: objectViewer`
    set at the bucket level so the returned URL serves without signing.
    """
    bucket = config.env("GCS_BUCKET")
    if not bucket:
        raise RuntimeError("GCS_BUCKET is not set; cannot upload.")
    if not local_path.exists():
        raise FileNotFoundError(f"GCS upload source missing: {local_path}")

    payload = local_path.read_bytes()
    mime = _mime_for(local_path.name)
    encoded_key = urllib.parse.quote(key, safe="")
    url = (
        f"{UPLOAD_BASE}/b/{urllib.parse.quote(bucket, safe='')}/o"
        f"?uploadType=media&name={encoded_key}"
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
    if is_configured():
        try:
            return upload(local_path, key)
        except Exception as e:
            print(f"[gcs upload err] {key}: {e}; falling back to local URL")
            return local_url
    return local_url


def _reset_cache_for_tests() -> None:
    _cached["token"] = None
    _cached["expires_at"] = 0.0
