"""Local worker that drains the short_renders queue.

Mirrors pipeline/render_worker.py for the 40-60s article shorts. The admin
"Generate short" action inserts a queued short_renders row; this worker (and the
Vercel cron in prod) claims the oldest, runs the shorts render assembly, and
writes the result back. The on_progress callback persists per-phase progress so
the editor shows a live bar across the multi-step generation.

    python -m pipeline.short_render_worker            # loop, poll every 3s
    python -m pipeline.short_render_worker --once      # one short, then exit

run_one_tick(render_fn=...) takes an injected render callable so tests can drive
the claim -> finish / claim -> fail paths without shelling out to Remotion.
"""
from __future__ import annotations

import argparse
import time
import traceback
from pathlib import Path
from typing import Callable

from pipeline import shorts_render, store

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_POLL_SECONDS = 3

RenderFn = Callable[[dict], dict]

# Coarse phase -> progress fraction for the UI bar. The `scene` phase reports
# cur/total and animates across 0.15..0.75 (image generation is the bulk of the
# work); the rest are single checkpoints.
_PHASE_FRACTION = {
    "script": 0.05,
    "plan": 0.10,
    "base": 0.15,
    "voice": 0.80,
    "stage": 0.88,
    "render": 0.92,
    "done": 1.0,
}


def _progress_for(render_id: str) -> Callable[[str, int, int], None]:
    """Build an on_progress callback that persists progress for one render row."""
    def cb(phase: str, cur: int = 0, total: int = 0) -> None:
        if phase == "scene" and total > 0:
            frac = 0.15 + 0.60 * (cur / total)
        else:
            frac = _PHASE_FRACTION.get(phase, 0.0)
        store.update_short_render_progress(render_id, round(frac, 3), phase)
    return cb


def _default_render(claimed: dict) -> dict:
    """Real render path: run the shorts assembly for the claimed row."""
    return shorts_render.render_short_from_db(
        claimed["story_id"],
        REPO_ROOT,
        narration_style=claimed.get("narration_style"),
        length_preset=claimed.get("length_preset"),
        on_progress=_progress_for(claimed["id"]),
    )


def run_one_tick(render_fn: RenderFn | None = None) -> bool:
    """Claim and process one short render. Returns True if a row was handled
    (success OR failure), False if the queue is empty. Any exception is recorded
    as a failed render so one bad row never crashes the loop."""
    rfn = render_fn if render_fn is not None else _default_render

    claimed = store.claim_next_short_render()
    if claimed is None:
        return False

    render_id = claimed["id"]
    print(
        f"[short queue claim] story={claimed['story_id']} render={render_id} "
        f"narration={claimed.get('narration_style')} length={claimed.get('length_preset')}"
    )

    try:
        result = rfn(claimed)
    except Exception as e:  # noqa: BLE001 — worker catches everything per-row
        traceback.print_exc()
        store.fail_short_render(render_id, f"{type(e).__name__}: {e}")
        print(f"[short queue error] render={render_id} {type(e).__name__}: {e}")
        return True

    output_url = result.get("video_url") if isinstance(result, dict) else None
    if not output_url:
        store.fail_short_render(render_id, "render returned no video_url")
        print(f"[short queue error] render={render_id} no video_url returned")
        return True

    store.finish_short_render(render_id, output_url)
    print(f"[short queue done] render={render_id} url={output_url}")
    return True


def run_loop(poll_seconds: int = DEFAULT_POLL_SECONDS) -> None:
    """Drain the queue indefinitely, sleeping between empty ticks."""
    print(f"[short queue worker] started (poll={poll_seconds}s, repo={REPO_ROOT})")
    while True:
        if not run_one_tick():
            time.sleep(poll_seconds)


def _cli() -> None:
    parser = argparse.ArgumentParser(description="Drain the short_renders queue.")
    parser.add_argument("--once", action="store_true",
                        help="Process one short (or exit if empty), then stop.")
    parser.add_argument("--poll-seconds", type=int, default=DEFAULT_POLL_SECONDS,
                        help="Idle poll interval in seconds. Ignored under --once.")
    args = parser.parse_args()

    if args.once:
        if not run_one_tick():
            print("[short queue worker] queue empty, nothing to do")
        return
    try:
        run_loop(args.poll_seconds)
    except KeyboardInterrupt:
        print("[short queue worker] stopping on interrupt")


if __name__ == "__main__":
    _cli()
