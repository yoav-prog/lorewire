"""Google Cloud OAuth2 access tokens from a service account.

The Google Cloud REST APIs (Text-to-Speech, Speech-to-Text) need a Bearer
access token minted from a service account. We use google-auth ONLY for the
RSA-SHA256 signer + JWT encode helper — Python stdlib has no asymmetric
primitives — and exchange the assertion at oauth2.googleapis.com with stdlib
urllib so the rest of the pipeline stays consistent.

Credentials come from three env vars, matching the yt-studio convention:
    GOOGLE_TTS_PROJECT_ID
    GOOGLE_TTS_CLIENT_EMAIL
    GOOGLE_TTS_PRIVATE_KEY

The same service account drives both TTS synthesis and STT alignment; there is
one env trio, not two. PEM newlines pasted into Vercel as the two-character
sequence "\\n" are normalized at read time (Vercel footgun fix from yt-studio).
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from typing import Optional

from google.auth import jwt as gauth_jwt
from google.oauth2 import service_account

from pipeline import config

TOKEN_URI = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/cloud-platform"
# Google access tokens last 1h; refresh ~10 min early so requests in flight
# never race the boundary.
TOKEN_TTL_SECONDS = 3000

_cached: dict = {"token": None, "expires_at": 0.0}


def _missing() -> list[str]:
    needed = ("GOOGLE_TTS_PROJECT_ID", "GOOGLE_TTS_CLIENT_EMAIL", "GOOGLE_TTS_PRIVATE_KEY")
    return [k for k in needed if not config.env(k)]


def is_configured() -> bool:
    """True when all three GOOGLE_TTS_* env vars are set."""
    return not _missing()


def _service_account_info() -> dict:
    miss = _missing()
    if miss:
        raise RuntimeError(
            "Google TTS is not configured. Set " + ", ".join(miss) + " in .env.local."
        )
    private_key = (config.env("GOOGLE_TTS_PRIVATE_KEY") or "").replace("\\n", "\n")
    if "BEGIN PRIVATE KEY" not in private_key:
        raise RuntimeError(
            "GOOGLE_TTS_PRIVATE_KEY is set but does not look like a PEM key. Verify the "
            "'-----BEGIN PRIVATE KEY-----' line is intact and newlines are preserved."
        )
    return {
        "type": "service_account",
        "project_id": config.env("GOOGLE_TTS_PROJECT_ID"),
        "private_key": private_key,
        "client_email": config.env("GOOGLE_TTS_CLIENT_EMAIL"),
        "token_uri": TOKEN_URI,
    }


def project_id() -> Optional[str]:
    return config.env("GOOGLE_TTS_PROJECT_ID")


def access_token() -> str:
    """Return a cached Bearer token, refreshing it when within 10 min of expiry."""
    now = time.time()
    if _cached["token"] and now < _cached["expires_at"]:
        return _cached["token"]

    info = _service_account_info()
    creds = service_account.Credentials.from_service_account_info(info, scopes=[SCOPE])

    # The OAuth2 JWT bearer flow: sign an assertion with the service account
    # private key, exchange it at the token endpoint for an access token.
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
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        raise RuntimeError(f"Google OAuth2 token exchange failed: {e}") from e

    token = data.get("access_token")
    if not token:
        raise RuntimeError(f"Google OAuth2 response missing access_token: {str(data)[:200]}")
    _cached["token"] = token
    _cached["expires_at"] = now + TOKEN_TTL_SECONDS
    return token


def _reset_cache_for_tests() -> None:
    _cached["token"] = None
    _cached["expires_at"] = 0.0
