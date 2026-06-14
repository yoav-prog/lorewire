"""Vercel Cron-invoked drain for the voice_renders queue.

Phase 4.b of `_plans/2026-06-14-voiceover-picker.md`. Mirrors
`drain_story_jobs.py` shape (auth + advisory lock + per-tick budget +
structured logs) but composes `voice_renders_worker.run_one_tick`. The
worker handles its own stale-claim reap + per-job error handling, so
the drain just loops until empty / capped / deadline.

Hardening matches the other drains:

  1. CRON_SECRET Bearer auth on every request — without it the endpoint
     is a free DoS vector that burns TTS credits.
  2. Distinct Postgres advisory lock (VOICE_RENDERS_DRAIN_LOCK_KEY,
     8472303) so this drain doesn't contend with the story_jobs or
     image_renders drains on the same lock — three queues, three
     independent advisory locks.
  3. Per-tick row cap + deadline so the function finishes inside
     Vercel's maxDuration ceiling and the next tick never overlaps.
  4. Structured logger.info at every meaningful step (claim, done,
     err, idle, tick summary, lock_busy).

Runtime note: unlike `drain_story_jobs.py` which had to pre-skip
`with_media=True` jobs (Vercel has no Node/Remotion), voice regen is
purely Python + HTTPS calls (ElevenLabs / Google Cloud TTS) + a single
GCS upload. There's NO equivalent runtime gap here — every queued
voice_renders row can drain end-to-end on Vercel.

Filesystem note: `voice_renders_worker._default_process` writes the
synthesized narration MP3 to a local file before uploading to GCS.
Vercel's filesystem is read-only except for /tmp; the worker detects
the serverless env (VERCEL or VERCEL_ENV set) and writes to a per-
invocation /tmp subdir, then deletes it after the upload completes.

The pipeline package is vendored into `_lib/pipeline/` by the npm
prebuild step (`scripts/vendor_pipeline.mjs`). The handler injects
`_lib/` onto sys.path so the `from pipeline import ...` imports inside
the worker resolve unchanged.
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

# Imported AFTER sys.path injection so the vendored pipeline package
# resolves. Local dev (where pipeline is already on the path) works
# the same way — sys.path.insert is idempotent for an already-present
# entry.
from pipeline import voice_renders_worker, store  # noqa: E402

LOG = logging.getLogger("drain_voice_renders")
LOG.setLevel(logging.INFO)
if not LOG.handlers:
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("%(message)s"))
    LOG.addHandler(_h)

# 270s leaves 30s headroom under Vercel's 300s maxDuration ceiling
# for the response write + Python finalizers. ElevenLabs returns in
# seconds; Google in <30s; GCS upload ~5s for a ~3MB MP3. A typical
# tick fits 3-5 voice regens.
DEADLINE_S = 270
# Soft cap on rows per tick. voice regen is faster than story_jobs
# (just TTS + upload — no LLM + kie + Remotion chain) so we allow a
# higher cap. Override via DRAIN_VOICE_RENDERS_MAX_ROWS_PER_TICK.
DEFAULT_MAX_ROWS = 5


def _log(event: str, **fields) -> None:
    """One-line bracketed-namespace log per CLAUDE.md rule 14. Payload
    is JSON for grep + jq friendliness in Vercel logs."""
    LOG.info(f"[drain_voice_renders {event}] {json.dumps(fields, default=str)}")


def _is_authorized(authorization_header: str | None) -> bool:
    """Bearer check against CRON_SECRET. No CRON_SECRET set = every
    request unauthorized (fail-closed)."""
    expected = os.environ.get("CRON_SECRET")
    if not expected:
        return False
    if not authorization_header:
        return False
    return authorization_header == f"Bearer {expected}"


def _max_rows_per_tick() -> int:
    raw = os.environ.get("DRAIN_VOICE_RENDERS_MAX_ROWS_PER_TICK")
    if not raw:
        return DEFAULT_MAX_ROWS
    try:
        n = int(raw)
    except ValueError:
        return DEFAULT_MAX_ROWS
    # Clamp [1, 30] — voice regens fit ~5/tick comfortably; the
    # ceiling catches accidental "999" values without being a real
    # working number.
    return max(1, min(n, 30))


def run_drain() -> dict:
    """Pure-Python entry point. Returns the JSON-serializable result
    body the handler echoes back. Split out so tests can call it
    directly without faking an HTTP request.

    Loops `run_one_tick` until empty, deadline, or cap. `run_one_tick`
    returns False on idle queue so we break out the moment that fires.
    """
    start = time.monotonic()

    with store.voice_renders_drain_lock() as acquired:
        if not acquired:
            _log("lock_busy")
            return {"drained": 0, "remaining": None, "lock_busy": True}

        if store.count_pending_voice_renders() == 0:
            _log("idle")
            return {"drained": 0, "remaining": 0}

        cap = _max_rows_per_tick()
        drained = 0
        while drained < cap and (time.monotonic() - start) < DEADLINE_S:
            row_started = time.monotonic()
            did_work = voice_renders_worker.run_one_tick()
            if not did_work:
                # Queue empty OR no claimable rows. run_one_tick already
                # logged its own outcome. This tick's work is done.
                break
            drained += 1
            elapsed_row = round(time.monotonic() - row_started, 2)
            _log("row_done", drained=drained, elapsed_s=elapsed_row)

    elapsed = round(time.monotonic() - start, 2)
    remaining = store.count_pending_voice_renders()
    _log("tick", drained=drained, remaining=remaining, elapsed_s=elapsed)
    return {"drained": drained, "remaining": remaining, "elapsed_s": elapsed}


# Vercel's Python runtime calls a top-level `handler`
# BaseHTTPRequestHandler subclass for each request. Supports GET (cron
# pings) and POST (manual kick from the admin) with identical behaviour,
# matching the other drains.
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
            self.wfile.write(
                json.dumps({"error": str(exc)}).encode("utf-8")
            )

    # Silence the default BaseHTTPRequestHandler stdout logging — our
    # structured logger above is the source of truth.
    def log_message(self, format, *args) -> None:  # noqa: A002
        return
