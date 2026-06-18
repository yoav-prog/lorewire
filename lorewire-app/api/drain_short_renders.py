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
from typing import Callable

_HERE = Path(__file__).resolve().parent
_LIB = _HERE / "_lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from pipeline import shorts_lane_b, shorts_lane_c, shorts_render, store  # noqa: E402

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

# Crash-recovery thresholds for the reaper. A 'generating' row past ~15 min means
# the drain died (generation is bounded by the drain budget). A 'rendering' row
# past ~30 min means the render cron / Cloud Run died; kept well above the cron's
# 800s cap so a slow-but-live render is never reset (and re-rendered for nothing)
# out from under itself. The reaper's attempts ceiling stops a genuinely stuck
# row from looping paid retries once it does cross the threshold.
GENERATING_STALE_S = 900
RENDERING_STALE_S = 1800

# Phase -> progress fraction across the generation half (0..0.5; store_short_props
# stamps 0.5 when props land). The render cron drives 0.5..1.0.
_PHASE_FRACTION = {"script": 0.03, "plan": 0.06, "base": 0.10, "voice": 0.42, "stage": 0.46}

# Human-readable labels for the timeline. Mirrors short_render_worker._PHASE_MESSAGE
# so the gen-half phases read the same as the render-half phases. The ShortRenderEventTimeline
# UI displays this string verbatim next to the [phase_<name>] event tag.
_PHASE_MESSAGE = {
    "script": "Writing script…",
    "plan": "Planning scenes…",
    "base": "Drawing character…",
    "scene": "Drawing scenes…",
    "voice": "Recording voiceover…",
    "stage": "Assembling…",
}


def _frac(phase: str, cur: int, total: int) -> float:
    if phase == "scene" and total > 0:
        return round(0.10 + 0.32 * (cur / total), 3)
    return _PHASE_FRACTION.get(phase, 0.0)


def _progress_for(render_id: str) -> Callable[[str, int, int], None]:
    """Build an on_progress callback that mirrors short_render_worker._progress_for:
    persists progress AND emits a short_render_events row on each PHASE TRANSITION
    so the admin timeline surfaces generation progress in real time (not only after
    the render cron picks up the row). Scene events fire per scene because the
    timelapse value is "scene 3/12 done" not "scene". log_short_render_event is
    fire-and-swallow so a logging failure can never break the generation."""
    last_phase = {"name": None}

    def cb(phase: str, cur: int = 0, total: int = 0) -> None:
        frac = _frac(phase, cur, total)
        try:
            store.update_short_render_progress(render_id, frac, phase)
        except Exception:
            pass  # progress is observability, never fail the run on it
        try:
            if phase == "scene" and total > 0:
                store.log_short_render_event(
                    render_id,
                    "scene_generated",
                    message=f"Scene {cur}/{total} generated",
                    payload={"scene_index": cur, "scene_total": total},
                )
            elif phase != last_phase["name"]:
                store.log_short_render_event(
                    render_id,
                    f"phase_{phase}",
                    message=_PHASE_MESSAGE.get(phase, phase),
                    payload={"phase": phase, "progress": round(frac, 3)},
                )
        except Exception:
            pass
        last_phase["name"] = phase

    return cb


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
    reaped = store.reap_stale_short_renders(GENERATING_STALE_S, RENDERING_STALE_S)
    if reaped:
        _log("reaped", count=reaped)
    claimed = store.claim_next_short_for_generation()
    if claimed is None:
        _log("idle")
        return {"generated": 0}

    render_id = claimed["id"]
    _log("claim", id=render_id, story=claimed["story_id"],
         narration=claimed.get("narration_style"), length=claimed.get("length_preset"))
    # Emit a timeline event so the admin sees the drain pick up the row.
    # Until this landed, the timeline went silent between `forced_done_reset`
    # and the render cron's later `claimed` event — and a drain failure mid-way
    # was completely invisible. Fire-and-swallow so a logging issue can't
    # poison the generation run itself.
    try:
        store.log_short_render_event(
            render_id,
            "generation_started",
            message="Drain claimed the row for generation",
            payload={
                "story_id": claimed["story_id"],
                "narration_style": claimed.get("narration_style"),
                "length_preset": claimed.get("length_preset"),
                "lane": claimed.get("lane"),
            },
        )
    except Exception:
        pass

    on_progress = _progress_for(render_id)

    lane = claimed.get("lane")
    try:
        if lane == "B":
            # Lane B (Phase 3 of the short editor plan): reuse the baseline
            # frames + character; resynthesize voice + captions only. The
            # baseline render id, the new script, and the optional voice
            # override come from lane_inputs.
            laneB = shorts_lane_b.build_short_props_lane_b(
                claimed, REPO_ROOT, remote=True, on_progress=on_progress,
            )
            store.store_short_props(render_id, json.dumps(laneB.props))
            # Mirror the new voice-driven captions (+ audio + duration) back
            # into the editor's short_config so its live preview + Captions tab
            # stop showing the stale baseline captions. Best-effort: the MP4 is
            # already correct from props, so a sync miss must not fail the run.
            try:
                if shorts_lane_b.sync_short_config_captions(
                    claimed["story_id"], laneB.props
                ):
                    _log("config_caption_sync", id=render_id, story=claimed["story_id"])
            except Exception as e:  # noqa: BLE001 — editor sync is non-critical
                _log("config_caption_sync_skip", id=render_id, error=str(e))
            # Clear the lane so the render drain claims this row (filter
            # `props IS NOT NULL`); we deliberately keep lane_inputs around
            # for audit even after the build succeeds.
            shorts_lane_b.clear_lane(render_id)
            elapsed = round(time.monotonic() - start, 2)
            _log("ready", id=render_id, elapsed_s=elapsed, lane="B")
            try:
                store.log_short_render_event(
                    render_id,
                    "generation_ready",
                    message="Generation complete, awaiting render cron",
                    payload={"elapsed_s": elapsed, "lane": "B"},
                )
            except Exception:
                pass
            return {"generated": 1, "render_id": render_id, "elapsed_s": elapsed, "lane": "B"}

        if lane == "C":
            # Lane C (Phase 4): per-scene partial re-render. Regenerates each
            # touched_frame_ids[i] via kie i2i (preserving identity via the
            # character_base_url stored on short_config), then assembles props
            # by merging the freshly-regen'd urls into the baseline frame
            # order. Voice + captions + character + duration come from the
            # baseline untouched.
            laneC = shorts_lane_c.build_short_props_lane_c(
                claimed, REPO_ROOT, remote=True, on_progress=on_progress,
            )
            store.store_short_props(render_id, json.dumps(laneC.props))
            shorts_lane_c.clear_lane(render_id)
            elapsed = round(time.monotonic() - start, 2)
            _log("ready", id=render_id, elapsed_s=elapsed, lane="C",
                 regen_count=laneC.regen_count)
            try:
                store.log_short_render_event(
                    render_id,
                    "generation_ready",
                    message="Generation complete, awaiting render cron",
                    payload={"elapsed_s": elapsed, "lane": "C", "regen_count": laneC.regen_count},
                )
            except Exception:
                pass
            return {
                "generated": 1,
                "render_id": render_id,
                "elapsed_s": elapsed,
                "lane": "C",
                "regen_count": laneC.regen_count,
            }

        built = shorts_render.build_short_props(
            claimed["story_id"], REPO_ROOT,
            narration_style=claimed.get("narration_style"),
            length_preset=claimed.get("length_preset"),
            remote=True,
            on_progress=on_progress,
        )
    except Exception as exc:  # noqa: BLE001 — surface to the row
        store.fail_short_render(render_id, f"{type(exc).__name__}: {exc}")
        # Mirror short_render_worker's `failed` timeline event so a generation
        # crash is no longer invisible. Truncate the error to keep one bad row
        # from blowing out the timeline payload size.
        try:
            store.log_short_render_event(
                render_id,
                "generation_failed",
                level="error",
                message="Generation failed",
                payload={"error": f"{type(exc).__name__}: {str(exc)[:500]}", "lane": lane},
            )
        except Exception:
            pass
        _log("err", id=render_id, error=str(exc), lane=lane)
        return {"generated": 0, "error": str(exc)}

    if not built:
        store.fail_short_render(render_id, "generation produced no assets")
        try:
            store.log_short_render_event(
                render_id,
                "generation_failed",
                level="error",
                message="Generation produced no assets",
                payload={"lane": lane},
            )
        except Exception:
            pass
        _log("err", id=render_id, error="no assets")
        return {"generated": 0, "error": "no-assets"}

    store.store_short_props(render_id, json.dumps(built.props))
    # Mirror Lane A's fresh frames + character base + voice back into the
    # editor's short_config so the Scenes / Captions tabs and live preview
    # stop showing the stale baseline after a full re-render. Best-effort:
    # the MP4 is already correct from props, so a sync miss must not fail
    # the run. Mirrors the Lane B caption sync above.
    try:
        if shorts_render.sync_short_config_from_lane_a(
            claimed["story_id"], built.props
        ):
            _log("config_lane_a_sync", id=render_id, story=claimed["story_id"])
    except Exception as e:  # noqa: BLE001 — editor sync is non-critical
        _log("config_lane_a_sync_skip", id=render_id, error=str(e))
    elapsed = round(time.monotonic() - start, 2)
    _log("ready", id=render_id, elapsed_s=elapsed)
    try:
        store.log_short_render_event(
            render_id,
            "generation_ready",
            message="Generation complete, awaiting render cron",
            payload={"elapsed_s": elapsed, "lane": "A"},
        )
    except Exception:
        pass
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
