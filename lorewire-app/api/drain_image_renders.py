"""Vercel Cron-invoked drain for the image_renders queue.

Phase 1 of `_plans/2026-06-13-worker-host-stop-button-observability.md`.
Replaces "Yoav's laptop happens to be on" with a deterministic, hosted
worker that fires every minute via Vercel Cron and consumes queued
rows through the same pipeline code path the local worker uses.

Hardened per LLM Council review:

  1. CRON_SECRET Bearer auth on every request — without it, the
     endpoint is a free DoS vector that burns kie.ai credits.
  2. Postgres advisory lock so two cron ticks landing in the same minute
     can't both run the drain loop.
  3. Stale-claim reaper at the top of every tick so a function that
     died mid-flight doesn't leave a row pinned at "generating" forever.
  4. Per-tick row cap + deadline so the function finishes inside
     Vercel's maxDuration ceiling and the next tick never overlaps.
  5. Structured logger.info at every meaningful step (claim, done, err,
     reaped, idle, tick summary). Stands in for the deferred
     `image_render_events` table — grep on Vercel logs is the event log
     until / unless we ship that table in Phase 3.

The pipeline package is vendored into `_lib/pipeline/` by the npm
prebuild step (`scripts/vendor_pipeline.mjs`). The handler injects
`_lib/` onto sys.path so the existing `from pipeline import ...`
imports inside the worker keep resolving untouched.
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
from pipeline import image_render_worker, store  # noqa: E402

LOG = logging.getLogger("drain")
LOG.setLevel(logging.INFO)
if not LOG.handlers:
    # Vercel captures stdout, so a plain StreamHandler is enough. Format
    # keeps the namespace prefix readable in grep results.
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("%(message)s"))
    LOG.addHandler(_h)

# Per-tick budget. Vercel cron fires every minute, maxDuration is 60s
# in vercel.ts, so the drain has to leave headroom for the response
# write + Python finalizers. 55s is the largest value that doesn't
# risk the platform killing us mid-write.
DEADLINE_S = 55
# Rows older than this at status='generating' get reset to queued. Long
# enough that a real nano-banana-pro polling loop (~30s) finishes
# untouched even with slack, short enough that a dead row gets retried
# inside two cron ticks.
STALE_AFTER_S = 600
# Soft cap on how many rows one tick will drain. Each row is up to ~7s
# average wall time, so 6 rows × 7s = 42s, comfortably under DEADLINE_S.
# Override via the DRAIN_MAX_ROWS_PER_TICK env var if needed.
DEFAULT_MAX_ROWS = 6


def _log(event: str, **fields) -> None:
    """One-line bracketed-namespace log per CLAUDE.md rule 14. Payload
    is JSON for grep + jq friendliness in Vercel logs."""
    LOG.info(f"[drain {event}] {json.dumps(fields, default=str)}")


def _is_authorized(authorization_header: str | None) -> bool:
    """Constant-time-ish bearer check against the CRON_SECRET env. We
    don't actually need crypto-timing safety here (the secret isn't
    used for crypto) but a simple equality check is fine because the
    only attacker model is "found the URL"."""
    expected = os.environ.get("CRON_SECRET")
    if not expected:
        # If CRON_SECRET isn't set, every request is unauthorized.
        # Better to bail than to silently allow.
        return False
    if not authorization_header:
        return False
    return authorization_header == f"Bearer {expected}"


def _max_rows_per_tick() -> int:
    raw = os.environ.get("DRAIN_MAX_ROWS_PER_TICK")
    if not raw:
        return DEFAULT_MAX_ROWS
    try:
        n = int(raw)
    except ValueError:
        return DEFAULT_MAX_ROWS
    return max(1, min(n, 60))


def run_drain() -> dict:
    """Pure-Python entry point. Returns the JSON-serializable result body
    the handler echoes back. Split out so tests can call it directly
    without a fake HTTP request."""
    start = time.monotonic()

    with store.image_render_drain_lock() as acquired:
        if not acquired:
            # Another tick is already draining — bail fast so we don't
            # block on contention. The next minute's tick will try
            # again.
            _log("lock_busy")
            return {"drained": 0, "remaining": None, "lock_busy": True}

        reaped = store.reap_stale_image_render_claims(
            stale_after_s=STALE_AFTER_S,
        )
        if reaped:
            _log("reaped", count=reaped)

        if store.count_pending_image_renders() == 0:
            _log("idle")
            return {"drained": 0, "remaining": 0}

        cap = _max_rows_per_tick()
        drained = 0
        while drained < cap and (time.monotonic() - start) < DEADLINE_S:
            row = store.claim_next_image_render()
            if row is None:
                break
            _log(
                "claim",
                id=row["id"],
                owner=f"{row['owner_kind']}/{row['owner_id']}",
                asset=row["asset"],
            )
            try:
                output_url, cost_cents = image_render_worker._default_regen(row)
                store.finish_image_render(row["id"], output_url, cost_cents)
                _log(
                    "done",
                    id=row["id"],
                    cost_cents=cost_cents,
                    output_url=output_url,
                )
            except NotImplementedError as nie:
                store.fail_image_render(row["id"], str(nie))
                _log("not_implemented", id=row["id"], error=str(nie))
            except Exception as exc:  # noqa: BLE001 — surface to row
                store.fail_image_render(row["id"], str(exc))
                _log("err", id=row["id"], error=str(exc))
            drained += 1

    elapsed = round(time.monotonic() - start, 2)
    remaining = store.count_pending_image_renders()
    _log("tick", drained=drained, remaining=remaining, elapsed_s=elapsed)
    return {"drained": drained, "remaining": remaining, "elapsed_s": elapsed}


# Vercel's Python runtime calls a top-level `handler` BaseHTTPRequestHandler
# subclass for each request. We support GET (cron pings) and POST (manual
# kick from the admin) with identical behavior.
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

    # Silence the default BaseHTTPRequestHandler stdout logging —
    # we have our own structured logger above.
    def log_message(self, format, *args) -> None:  # noqa: A002
        return
