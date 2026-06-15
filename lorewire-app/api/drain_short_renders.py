"""Vercel Cron-invoked GENERATION drain for the short_renders queue.

Phase 3 (generation half) of the article-shorts build. Two-stage prod flow:
  1. THIS drain (Python, ~300s): claims a queued short that has no props yet,
     runs the heavy generation (script -> gpt-image-2 frames -> voice -> upload
     to GCS -> build DoodleShort props), and stores the props back on the row
     (status flips queued -> generating -> queued, props set).
  2. /api/render_short (TS cron, 800s): claims queued rows that HAVE props and
     POSTs them to the existing Cloud Run /render endpoint.

Splitting generation (this drain) from render (the cron) keeps each inside its
function budget: generation parallelizes the i2i calls to fit ~300s; the render
itself runs on Cloud Run.

The pipeline package is vendored into `_lib/pipeline/` by the prebuild step
(scripts/vendor_pipeline.mjs); we inject `_lib/` onto sys.path so the
`from pipeline import ...` imports resolve. CRON_SECRET Bearer auth.
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

from pipeline import shorts_render, store  # noqa: E402

LOG = logging.getLogger("drain_short")
LOG.setLevel(logging.INFO)
if not LOG.handlers:
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("%(message)s"))
    LOG.addHandler(_h)

# One short's parallelized generation runs ~200s; cap at one per tick so the
# function finishes inside the 300s ceiling and the next minute's tick claims
# the next row. REPO_ROOT is unused in remote mode (assets stage to /tmp + GCS)
# but build_short_props takes it for the local path, so pass the api dir.
REPO_ROOT = _HERE

# Phase -> progress fraction across the generation half (0..0.5; store_short_props
# stamps 0.5 when props land). The render cron drives 0.5..1.0.
_PHASE_FRACTION = {"script": 0.03, "plan": 0.06, "base": 0.10, "voice": 0.42, "stage": 0.46}


def _frac(phase: str, cur: int, total: int) -> float:
    if phase == "scene" and total > 0:
        return round(0.10 + 0.32 * (cur / total), 3)
    return _PHASE_FRACTION.get(phase, 0.0)


def _log(event: str, **fields) -> None:
    LOG.info(f"[drain_short {event}] {json.dumps(fields, default=str)}")


def _is_authorized(authorization_header: str | None) -> bool:
    expected = os.environ.get("CRON_SECRET")
    if not expected or not authorization_header:
        return False
    return authorization_header == f"Bearer {expected}"


def run_drain() -> dict:
    """Claim and generate one short. Returns a JSON-serializable result body."""
    start = time.monotonic()
    claimed = store.claim_next_short_for_generation()
    if claimed is None:
        _log("idle")
        return {"generated": 0}

    render_id = claimed["id"]
    _log("claim", id=render_id, story=claimed["story_id"],
         narration=claimed.get("narration_style"), length=claimed.get("length_preset"))

    def on_progress(phase: str, cur: int = 0, total: int = 0) -> None:
        try:
            store.update_short_render_progress(render_id, _frac(phase, cur, total), phase)
        except Exception:
            pass  # progress is observability, never fail the run on it

    try:
        built = shorts_render.build_short_props(
            claimed["story_id"], REPO_ROOT,
            narration_style=claimed.get("narration_style"),
            length_preset=claimed.get("length_preset"),
            remote=True,
            on_progress=on_progress,
        )
    except Exception as exc:  # noqa: BLE001 — surface to the row
        store.fail_short_render(render_id, f"{type(exc).__name__}: {exc}")
        _log("err", id=render_id, error=str(exc))
        return {"generated": 0, "error": str(exc)}

    if not built:
        store.fail_short_render(render_id, "generation produced no assets")
        _log("err", id=render_id, error="no assets")
        return {"generated": 0, "error": "no-assets"}

    store.store_short_props(render_id, json.dumps(built.props))
    elapsed = round(time.monotonic() - start, 2)
    _log("ready", id=render_id, elapsed_s=elapsed)
    return {"generated": 1, "render_id": render_id, "elapsed_s": elapsed}


class handler(BaseHTTPRequestHandler):  # noqa: N801 — Vercel expects this name
    def do_GET(self) -> None:  # noqa: N802
        self._serve()

    def do_POST(self) -> None:  # noqa: N802
        self._serve()

    def _serve(self) -> None:
        auth = self.headers.get("authorization") or self.headers.get("Authorization")
        if not _is_authorized(auth):
            _log("auth_fail", ip=self.headers.get("x-forwarded-for", "unknown"))
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":"unauthorized"}')
            return
        try:
            body = run_drain()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(body).encode("utf-8"))
        except Exception as exc:  # noqa: BLE001 — top-level guard
            _log("fatal", error=str(exc))
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(exc)}).encode("utf-8"))

    def log_message(self, format, *args) -> None:  # noqa: A002
        return
