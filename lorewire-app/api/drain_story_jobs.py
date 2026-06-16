"""Vercel Cron-invoked drain for the story_jobs queue.

Phase 8 of `_plans/2026-06-14-story-jobs-followups.md`. Mirrors
`drain_image_renders.py` in shape (auth + advisory lock + per-tick
budget + structured logs) but composes `story_jobs_worker.run_one_tick`
instead of a hand-rolled claim loop — the worker already does its own
stale-claim reap and budget-gate check, so the drain doesn't need to
duplicate them.

Hardening matches the image_renders drain:

  1. CRON_SECRET Bearer auth on every request — without it the endpoint
     is a free DoS vector that burns LLM + kie credits.
  2. Distinct Postgres advisory lock so this drain doesn't contend with
     the image_renders drain.
  3. Per-tick row cap + deadline so the function finishes inside Vercel's
     maxDuration ceiling and the next tick never overlaps.
  4. Structured logger.info at every meaningful step (claim, done, err,
     idle, tick summary, lock_busy, budget_block).

Two-queue handoff — `story_jobs_worker._default_process` no longer
calls Remotion directly. It does LLM + media (kie images, voice,
alignment) inline, then enqueues a `video_renders` row that the Cloud
Run cron picks up and renders out of band. That makes EVERY story job
fully completable inside Vercel's Python runtime — no local worker
needed. The video render becomes a separate async step served by the
existing video_renders queue (see _plans/2026-06-14-cloud-run-render.md).

That's why this drain no longer passes `skip_with_media=True` to
run_one_tick: there's nothing about with_media=True jobs the hosted
runtime can't handle now. The local worker still works the same way
for offline-dev convenience.

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
# resolves. Local dev (where pipeline is already on the path) works the
# same way — sys.path.insert is idempotent for an already-present entry.
from pipeline import story_jobs_worker, store  # noqa: E402

LOG = logging.getLogger("drain_story_jobs")
LOG.setLevel(logging.INFO)
if not LOG.handlers:
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("%(message)s"))
    LOG.addHandler(_h)

# 2026-06-16: bumped from 270 to 870 alongside the vercel.json
# maxDuration bump (300 -> 900). 30s headroom under Vercel's new ceiling
# for the response write + Python finalizers. The old 270s deadline
# silently killed every with_media=True row in production because a
# full pipeline run (LLM idea + research + article + title + kie images +
# voice + alignment) takes 5-8 minutes; the cron retried the same row on
# every tick, the row got reaped after 30 min, and the cycle restarted.
# At 870s a normal job has comfortable headroom and outliers still get
# reaped instead of looping forever.
DEADLINE_S = 870
# Soft cap on rows per tick. story_jobs is heavier per-row than
# image_renders (full pipeline) so we cap lower. Override via
# DRAIN_STORY_JOBS_MAX_ROWS_PER_TICK.
DEFAULT_MAX_ROWS = 2


def _log(event: str, **fields) -> None:
    """One-line bracketed-namespace log per CLAUDE.md rule 14. Payload
    is JSON for grep + jq friendliness in Vercel logs."""
    LOG.info(f"[drain_story_jobs {event}] {json.dumps(fields, default=str)}")


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
    raw = os.environ.get("DRAIN_STORY_JOBS_MAX_ROWS_PER_TICK")
    if not raw:
        return DEFAULT_MAX_ROWS
    try:
        n = int(raw)
    except ValueError:
        return DEFAULT_MAX_ROWS
    # Clamp [1, 20] — story_jobs are heavy enough that even 20 in one
    # tick is far past Vercel's deadline; the ceiling exists to catch
    # accidental "999" values, not as a real working number.
    return max(1, min(n, 20))


def run_drain() -> dict:
    """Pure-Python entry point. Returns the JSON-serializable result body
    the handler echoes back. Split out so tests can call it directly
    without faking an HTTP request.

    Loops `run_one_tick` until empty, deadline, cap, or budget gate hits.
    `run_one_tick` returns False on idle queue AND on budget-block, so
    we treat the two the same way (stop draining this tick).
    """
    start = time.monotonic()

    with store.story_jobs_drain_lock() as acquired:
        if not acquired:
            _log("lock_busy")
            return {"drained": 0, "remaining": None, "lock_busy": True}

        if store.count_pending_story_jobs() == 0:
            _log("idle")
            return {"drained": 0, "remaining": 0}

        cap = _max_rows_per_tick()
        drained = 0
        while drained < cap and (time.monotonic() - start) < DEADLINE_S:
            row_started = time.monotonic()
            # No skip_with_media — story_jobs_worker._default_process
            # now does LLM + media inline and enqueues the actual MP4
            # render into video_renders. Vercel handles everything up
            # to the handoff; Cloud Run takes the render from there.
            did_work = story_jobs_worker.run_one_tick()
            if not did_work:
                # Queue empty OR budget-blocked OR all rows in flight.
                # run_one_tick already logged the reason ([story-jobs
                # budget-block] / nothing claimed). Either way, this
                # tick's work is done.
                break
            drained += 1
            elapsed_row = round(time.monotonic() - row_started, 2)
            _log("row_done", drained=drained, elapsed_s=elapsed_row)

    elapsed = round(time.monotonic() - start, 2)
    remaining = store.count_pending_story_jobs()
    _log("tick", drained=drained, remaining=remaining, elapsed_s=elapsed)
    return {"drained": drained, "remaining": remaining, "elapsed_s": elapsed}


# Vercel's Python runtime calls a top-level `handler` BaseHTTPRequestHandler
# subclass for each request. Supports GET (cron pings) and POST (manual
# kick from the admin) with identical behaviour, matching drain_image_renders.
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
