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

Cancellation: the admin Stop button flips short_renders.status to 'cancelled'.
The on_progress callback re-reads the row before each phase and raises
ShortRenderCancelled when it sees the cancel; the worker translates that into a
clean abort (no finish, no fail event, status stays 'cancelled'). Plan:
_plans/2026-06-15-short-render-events-and-cancel.md.
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


class ShortRenderCancelled(Exception):
    """Raised inside the on_progress callback when the row has been moved to
    'cancelled' status by the admin Stop button. The worker catches this
    specifically (separate from generic exceptions) so a cancel never gets
    recorded as a failure — the row stays in 'cancelled' status, a single
    'cancelled' event lands on the timeline, and any partially-uploaded GCS
    objects are kept (they're idempotent inputs to a future restart)."""


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

# Human-readable lines emitted to the timeline on a phase transition. Indexed by
# the same phase slug the callback receives; missing keys fall back to the slug.
_PHASE_MESSAGE = {
    "script": "Wrote narration script",
    "plan": "Planned scene breakdown",
    "base": "Generated base character",
    "scene": "Generating scene",
    "voice": "Synthesizing voiceover",
    "stage": "Staging assets to GCS",
    "render": "Sending to Cloud Run for render",
    "done": "Render complete",
}


def _progress_for(render_id: str) -> Callable[[str, int, int], None]:
    """Build an on_progress callback that:
      1) persists progress (existing behavior, the UI bar)
      2) emits a short_render_events row on each PHASE TRANSITION so the
         timeline gets a timelapse entry rather than 20 identical "scene"
         rows during image generation
      3) checks short_renders.status and raises ShortRenderCancelled when the
         admin has hit Stop — the cancellation seam.
    """
    last_phase = {"name": None}

    def cb(phase: str, cur: int = 0, total: int = 0) -> None:
        # Cancellation check FIRST so even an aborted phase transition doesn't
        # write a misleading event after the user already clicked Stop.
        row = store.get_short_render(render_id)
        if row and row.get("status") == "cancelled":
            raise ShortRenderCancelled(
                f"render {render_id} cancelled by admin at phase {phase}"
            )

        if phase == "scene" and total > 0:
            frac = 0.15 + 0.60 * (cur / total)
        else:
            frac = _PHASE_FRACTION.get(phase, 0.0)
        store.update_short_render_progress(render_id, round(frac, 3), phase)

        # Only emit on transition. Scene is the exception — we emit per-scene
        # because the timelapse value is "scene 3/12 done" not "scene".
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
        last_phase["name"] = phase
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
    store.log_short_render_event(
        render_id,
        "render_started",
        message="Worker claimed the row",
        payload={
            "story_id": claimed["story_id"],
            "narration_style": claimed.get("narration_style"),
            "length_preset": claimed.get("length_preset"),
        },
    )

    try:
        result = rfn(claimed)
    except ShortRenderCancelled as e:
        # Clean abort: the row is already in 'cancelled' status (the TS Stop
        # action flipped it). Don't fail-mark it; just log + return so the
        # admin's intent stands.
        print(f"[short queue cancelled] render={render_id} {e}")
        return True
    except Exception as e:  # noqa: BLE001 — worker catches everything per-row
        traceback.print_exc()
        msg = f"{type(e).__name__}: {e}"
        store.fail_short_render(render_id, msg)
        store.log_short_render_event(
            render_id, "failed", level="error",
            message="Short render failed", payload={"error": msg[:500]},
        )
        print(f"[short queue error] render={render_id} {msg}")
        return True

    output_url = result.get("video_url") if isinstance(result, dict) else None
    if not output_url:
        store.fail_short_render(render_id, "render returned no video_url")
        store.log_short_render_event(
            render_id, "failed", level="error",
            message="Render returned no video_url",
        )
        print(f"[short queue error] render={render_id} no video_url returned")
        return True

    store.finish_short_render(render_id, output_url)
    store.log_short_render_event(
        render_id, "finished",
        message="Short render done", payload={"url": output_url},
    )
    print(f"[short queue done] render={render_id} url={output_url}")

    # 2026-06-16 short-only Reddit-import auto-apply
    # (_plans/2026-06-16-reddit-default-to-shorts.md). The Reddit-import
    # short-only flow skips the long-form video render entirely, so without
    # this call stories.video_url stays NULL forever and the publish gate
    # blocks. Gated on requested_by so the existing auto-short pipeline
    # (which expects long-form to be THE story's video) is untouched: the
    # auto path tags rows with requested_by='auto' and a manual admin
    # click uses the session email, neither of which trip this branch.
    # The IS NULL clause inside the helper is the race guard against a
    # concurrent long-form render winning.
    story_id = claimed.get("story_id")
    if claimed.get("requested_by") == "reddit-import" and story_id:
        flipped = store.set_story_video_url_if_null(story_id, output_url)
        if flipped:
            print(
                f"[short queue auto-apply] story_id={story_id} "
                f"url={output_url} reason=reddit-import-short-only"
            )
        else:
            print(
                f"[short queue auto-apply-skip] story_id={story_id} "
                f"reason=video_url-already-set"
            )

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
