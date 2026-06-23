"""One-shot diagnostic: report what `pipeline/gcs.py:_chosen_publish_target`
sees inside the Vercel Python serverless function runtime.

Why this exists: 2026-06-23 the short renders fell over because
`short_renders.props` was being written with `storage.googleapis.com` URLs
even though every env in the Vercel dashboard for the R2 gate
(`R2_MEDIA_WRITE_ENABLED`, `R2_*` creds, `R2_MEDIA_BUCKET`, `MEDIA_PUBLIC_BASE`)
was set with the correct value. The TS dispatcher then rewrote those legacy
GCS URLs to `media.lorewire.com` URLs on the way to Cloud Run, where most
objects 404'd because no R2 copies exist for the freshly-generated frames.

There is no public Vercel API endpoint that returns runtime env values for a
deployment, and runtime stdout logs require dashboard access. This route is
the smallest possible read-only probe that confirms what the Python runtime
actually sees, so the next render-failure diagnosis doesn't depend on guessing
between "the env value is wrong" and "the env is correct but Vercel isn't
propagating it to the Python lambda."

Auth: CRON_SECRET Bearer (same pattern as the drains). Reports presence + a
4-char prefix of each value plus the boolean each gate returns. Never returns
the full secret. Safe to leave in place; cheap to remove once the root cause
is fixed.
"""
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_LIB = _HERE / "_lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from pipeline import gcs  # noqa: E402


def _is_authorized(authorization_header: str | None) -> bool:
    expected = os.environ.get("CRON_SECRET")
    if not expected or not authorization_header:
        return False
    return authorization_header == f"Bearer {expected}"


def _peek(name: str) -> dict:
    """Reveal whether the env is present and a short, non-secret hint of its
    shape: the first 4 chars and the length. Never returns the full value."""
    raw = os.environ.get(name)
    if raw is None:
        return {"present": False, "len": 0, "prefix": None, "trimmed_lower": None}
    return {
        "present": True,
        "len": len(raw),
        "prefix": raw[:4],
        # Mirror exactly the normalization `_r2_media_enabled` applies, so a
        # value like " True " is visibly distinguishable from a bare "true".
        "trimmed_lower": raw.strip().lower()[:8] if name == "R2_MEDIA_WRITE_ENABLED" else None,
    }


def _safe_call(fn_name: str) -> object:
    """Call gcs.<fn_name>() but tolerate the helper not existing on the
    deployed branch. The shape-fix observability commit (`7453d05`) added
    `_chosen_publish_target` and `_r2_creds_present`; older deploys only have
    `_r2_media_enabled` + `_r2_configured`. We want the diagnostic to still
    work without those — they would otherwise raise AttributeError and the
    whole report 500s."""
    fn = getattr(gcs, fn_name, None)
    if fn is None:
        return "<missing in this build>"
    try:
        return fn()
    except Exception as e:  # noqa: BLE001 — diagnostic must never crash
        return f"<error: {type(e).__name__}: {e}>"


def _report() -> dict:
    return {
        "target_inferred": (
            "r2" if _safe_call("_r2_configured") is True
            else "gcs" if _safe_call("is_configured") is True
            else "local"
        ),
        "target_helper": _safe_call("_chosen_publish_target"),
        "_r2_media_enabled": _safe_call("_r2_media_enabled"),
        "_r2_configured": _safe_call("_r2_configured"),
        "_r2_creds_present": _safe_call("_r2_creds_present"),
        "_is_configured_gcs": _safe_call("is_configured"),
        "envs": {
            "R2_MEDIA_WRITE_ENABLED": _peek("R2_MEDIA_WRITE_ENABLED"),
            "R2_ACCESS_KEY_ID": _peek("R2_ACCESS_KEY_ID"),
            "R2_SECRET_ACCESS_KEY": _peek("R2_SECRET_ACCESS_KEY"),
            "R2_ACCOUNT_ID": _peek("R2_ACCOUNT_ID"),
            "R2_ENDPOINT": _peek("R2_ENDPOINT"),
            "R2_MEDIA_BUCKET": _peek("R2_MEDIA_BUCKET"),
            "MEDIA_PUBLIC_BASE": _peek("MEDIA_PUBLIC_BASE"),
            "GCS_BUCKET": _peek("GCS_BUCKET"),
            "VERCEL": _peek("VERCEL"),
            "VERCEL_ENV": _peek("VERCEL_ENV"),
        },
    }


class handler(BaseHTTPRequestHandler):  # noqa: N801 — Vercel expects this name
    def do_GET(self) -> None:  # noqa: N802
        self._serve()

    def do_POST(self) -> None:  # noqa: N802
        self._serve()

    def _serve(self) -> None:
        auth = self.headers.get("authorization") or self.headers.get("Authorization")
        if not _is_authorized(auth):
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":"unauthorized"}')
            return
        body = _report()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body, indent=2).encode("utf-8"))

    def log_message(self, format, *args) -> None:  # noqa: A002
        return
