"""2026-06-24 stage-split cron: run the hero+thumbnail finisher OUT of
band so the worker doesn't have to inline-wait for the short to render.

Production incident 2026-06-24: the `drain_story_jobs` cron's old flow
called `_run_short_and_finisher` which inline-waited for the short and
then ran the finisher's 5 i2i image calls. For fresh sources where the
short rendered from scratch, the wait + finisher chain regularly
exceeded Vercel's 800s function ceiling — the function was SIGKILLed,
the row got stuck at `status='processing'` for 30 min until the stale
reaper reset it, the next cron tick claimed it and started over. A
forever loop with no progress visible in the timeline.

This cron splits the work into independent stages:

  1. drain_story_jobs (existing): claims a queued story, runs LLM +
     media stages, force-enqueues the short, marks
     `finisher_status='pending'` on the job, calls finish_story_job,
     returns. ~1-2 minutes total. Comfortably under 800s.

  2. drain_short_renders (existing): Cloud Run renders the short MP4
     on its own clock.

  3. run_hero_thumbnail_finisher (this file, every 2 min): polls for
     jobs where finisher_status='pending' AND the short_renders row
     is status='done' AND output_url is set. Claims ONE per tick
     (i2i is heavy), runs `generate_hero_and_thumbnail_from_short`,
     sets `finisher_status='done'`, and (when full_pipeline=1) chains
     into the auto-publish lane via `request_story_job_auto_publish`.

  4. auto_publish_full_pipeline (existing): publishes pending rows to
     web + Facebook.

Each stage now has its own 800s budget — no single function has to
fit the whole pipeline in one invocation.

Auth + advisory lock + structured logging mirror `drain_story_jobs.py`.
Per-tick cap of 1 row because the finisher does 5 paid i2i calls
(~5 minutes total); larger batches would push close to the ceiling
without any throughput benefit (one short per cron is plenty).
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

from pipeline import story_jobs_worker, store  # noqa: E402

LOG = logging.getLogger("run_hero_thumbnail_finisher")
LOG.setLevel(logging.INFO)
if not LOG.handlers:
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("%(message)s"))
    LOG.addHandler(_h)

# One row per tick. The finisher does 5x kie i2i (~60s each), so the
# function runtime is ~5 minutes. Multiple rows would push past Vercel's
# 800s ceiling without gaining anything — shorts are produced one per
# story job, so there's no batching win.
DEADLINE_S = 770


def _log(event: str, **fields) -> None:
    LOG.info(
        f"[run_hero_thumbnail_finisher {event}] {json.dumps(fields, default=str)}"
    )


def _is_authorized(authorization_header: str | None) -> bool:
    expected = os.environ.get("CRON_SECRET")
    if not expected:
        return False
    if not authorization_header:
        return False
    return authorization_header == f"Bearer {expected}"


def run_drain() -> dict:
    """Pure-Python entry point — split out so tests can call it without
    faking an HTTP request. Tries to claim and process ONE finisher
    job. Returns a JSON-serializable summary the handler echoes back."""
    start = time.monotonic()

    if store.count_pending_finisher_jobs() == 0:
        _log("idle")
        return {"drained": 0, "remaining": 0}

    claimed = store.claim_finisher_job()
    if claimed is None:
        # Pending rows exist but none have a done short yet — the short
        # renderer is still working. Idle until the next tick.
        _log("waiting", reason="no_finisher_eligible_short_yet")
        remaining = store.count_pending_finisher_jobs()
        return {"drained": 0, "remaining": remaining}

    _log(
        "claimed",
        job_id=claimed["id"],
        reddit_id=claimed.get("reddit_id"),
        story_id=claimed.get("story_id"),
    )
    try:
        story_jobs_worker.run_finisher_for_job(claimed)
    except Exception as exc:  # noqa: BLE001 — top-level safety
        # `run_finisher_for_job` already catches per-call errors and
        # flips finisher_status to 'failed'. This guard only catches
        # something truly unexpected (e.g., an import error) so the
        # cron returns a 500 rather than swallowing silently.
        _log("fatal", job_id=claimed["id"], error=str(exc))
        try:
            store.set_finisher_status(claimed["id"], "failed")
        except Exception:  # noqa: BLE001 — best-effort cleanup
            pass
        raise

    elapsed = round(time.monotonic() - start, 2)
    remaining = store.count_pending_finisher_jobs()
    _log("tick", drained=1, remaining=remaining, elapsed_s=elapsed)
    return {"drained": 1, "remaining": remaining, "elapsed_s": elapsed}


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

    def log_message(self, format, *args) -> None:  # noqa: A002
        return
