"""Local worker that drains the video_renders queue.

The /admin/videos/[id] editor enqueues renders by inserting a row with
status='queued' (see pipeline/store.py:enqueue_render and the corresponding
TS action). This worker polls for those rows, claims the oldest, runs the
existing generate_video pipeline, and writes the result back. One render
at a time — Remotion + ffmpeg already saturate a laptop's CPU, so
serializing is the right default.

Run with:

    python -m pipeline.render_worker             # loop forever, poll every 3s
    python -m pipeline.render_worker --once      # process one render and exit
    python -m pipeline.render_worker --once --story story-id  # bypass queue

The `--story` mode is a manual escape hatch that mirrors the existing
`pipeline.video` CLI: it lets you re-render without going through the
queue, useful when debugging.

Designed for testability: `run_one_tick(render_fn=...)` accepts an
injected render callable so the unit tests can exercise the claim →
finish / claim → fail paths without shelling out to npx.
"""
from __future__ import annotations

import argparse
import time
import traceback
from pathlib import Path
from typing import Callable

from pipeline import store

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_POLL_SECONDS = 3


# A render function returns a dict shaped like generate_video's return
# value: {"video_url": "/generated/<id>/video.mp4", ...} on success, {} on
# failure. We pass the queue row in so the function can use config_hash or
# story_id as it sees fit.
RenderFn = Callable[[dict], dict]


def _default_render(claimed: dict) -> dict:
    """Real render path: re-runs the existing pipeline against the persisted
    story row. The story's video_config is what `pipeline.video` writes from
    on its happy path, so the merge_with_locks guardrail still protects any
    human edits on the row.
    """
    from pipeline import video
    story_id = claimed["story_id"]
    return video.rerender_from_db(story_id, REPO_ROOT)


def run_one_tick(render_fn: RenderFn | None = None) -> bool:
    """Claim and process one render. Returns True if a row was handled
    (success OR failure), False if the queue is empty.

    Any exception in the render path is caught and recorded as a failed
    render so a single bad row doesn't crash the worker loop.
    """
    rfn = render_fn if render_fn is not None else _default_render

    claimed = store.claim_next_render()
    if claimed is None:
        return False

    render_id = claimed["id"]
    story_id = claimed["story_id"]
    print(
        f"[render queue claim] story={story_id} render={render_id} "
        f"hash={claimed['config_hash'][:12]}"
    )

    try:
        result = rfn(claimed)
    except Exception as e:  # noqa: BLE001 — worker catches everything per-row
        # Truncated stack so the column doesn't bloat. Full trace goes to
        # stdout so a real run is debuggable from logs.
        traceback.print_exc()
        store.fail_render(render_id, f"{type(e).__name__}: {e}")
        print(f"[render queue error] render={render_id} {type(e).__name__}: {e}")
        return True

    output_url = result.get("video_url") if isinstance(result, dict) else None
    if not output_url:
        store.fail_render(render_id, "render returned no video_url")
        print(f"[render queue error] render={render_id} no video_url returned")
        return True

    store.finish_render(render_id, output_url)
    print(f"[render queue done] render={render_id} url={output_url}")
    return True


def run_loop(poll_seconds: int = DEFAULT_POLL_SECONDS) -> None:
    """Drain the queue indefinitely. Sleeps `poll_seconds` between empty
    ticks so an idle worker doesn't hammer the DB."""
    print(
        f"[render queue worker] started "
        f"(poll={poll_seconds}s, repo={REPO_ROOT})"
    )
    while True:
        did_work = run_one_tick()
        if not did_work:
            time.sleep(poll_seconds)


def _cli() -> None:
    parser = argparse.ArgumentParser(
        description="Drain the video_renders queue.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Process one render (or exit if the queue is empty), then stop.",
    )
    parser.add_argument(
        "--poll-seconds",
        type=int,
        default=DEFAULT_POLL_SECONDS,
        help="Idle poll interval in seconds. Ignored under --once.",
    )
    args = parser.parse_args()

    if args.once:
        ran = run_one_tick()
        if not ran:
            print("[render queue worker] queue empty — nothing to do")
        return

    try:
        run_loop(args.poll_seconds)
    except KeyboardInterrupt:
        print("[render queue worker] stopping on interrupt")


if __name__ == "__main__":
    _cli()
