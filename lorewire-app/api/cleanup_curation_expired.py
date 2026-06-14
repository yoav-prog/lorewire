"""Vercel Cron-invoked cleanup for curation_slots.

Phase 6 of `_plans/2026-06-15-curation-system.md`. Daily sweep that
hard-deletes rows whose `expires_at` is older than the grace window
(default 7 days). The active-at filter on the read path already hides
expired rows from users — this just keeps the table from growing
without bound when admins schedule a lot of timed pins.

Shape mirrors the drain handlers in `drain_image_renders.py`:

  - CRON_SECRET Bearer auth on every request.
  - Vendored pipeline on _lib/ sys.path (see prebuild step).
  - Structured one-line bracketed log per CLAUDE.md rule 14.
  - GET and POST supported (cron pings via GET; admin can manually kick
    via POST in the future).
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_LIB = _HERE / "_lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from pipeline import store  # noqa: E402

LOG = logging.getLogger("curation-cleanup")
LOG.setLevel(logging.INFO)
if not LOG.handlers:
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("%(message)s"))
    LOG.addHandler(_h)

# Default grace window. Admin-set expires_at older than this gets purged.
# Overridable via CURATION_CLEANUP_GRACE_DAYS for emergency tuning.
DEFAULT_GRACE_DAYS = 7


def _log(event: str, **fields) -> None:
    LOG.info(f"[curation cleanup-{event}] {json.dumps(fields, default=str)}")


def _is_authorized(authorization_header: str | None) -> bool:
    expected = os.environ.get("CRON_SECRET")
    if not expected:
        return False
    if not authorization_header:
        return False
    return authorization_header == f"Bearer {expected}"


def _grace_days() -> int:
    raw = os.environ.get("CURATION_CLEANUP_GRACE_DAYS")
    if not raw:
        return DEFAULT_GRACE_DAYS
    try:
        n = int(raw)
    except ValueError:
        return DEFAULT_GRACE_DAYS
    return max(0, n)


def run_cleanup() -> dict:
    """Pure-Python entry point so tests can drive the helper without a
    fake HTTP request."""
    start = time.monotonic()
    grace = _grace_days()
    removed = store.delete_expired_curation_slots(grace_days=grace)
    elapsed = round(time.monotonic() - start, 2)
    _log("tick", removed=removed, grace_days=grace, elapsed_s=elapsed)
    return {"removed": removed, "grace_days": grace, "elapsed_s": elapsed}


class handler(BaseHTTPRequestHandler):  # noqa: N801 — Vercel expects this name
    def do_GET(self) -> None:  # noqa: N802
        self._serve()

    def do_POST(self) -> None:  # noqa: N802
        self._serve()

    def _serve(self) -> None:
        auth = self.headers.get("authorization") or self.headers.get(
            "Authorization"
        )
        if not _is_authorized(auth):
            _log(
                "auth_fail",
                ip=self.headers.get("x-forwarded-for", "unknown"),
            )
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":"unauthorized"}')
            return

        try:
            body = run_cleanup()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(body).encode("utf-8"))
        except Exception as exc:  # noqa: BLE001 — top-level guard
            _log("fatal", error=str(exc))
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({"error": str(exc)}).encode("utf-8")
            )

    # Silence the default BaseHTTPRequestHandler stdout logging —
    # we have our own structured logger above.
    def log_message(self, format, *args) -> None:  # noqa: A002
        return
