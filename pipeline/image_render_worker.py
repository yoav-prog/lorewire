"""Local worker that drains the image_renders queue.

The Next admin enqueues an image regen via enqueueImageRegenAction. This
worker polls for status='queued' rows, claims the oldest, dispatches to the
right generator based on (owner_kind, asset), updates the affected row in
stories / articles, and writes the queue row to done with the actual
cost_cents kie reports.

Run with:

    python -m pipeline.image_render_worker          # loop forever, poll every 3s
    python -m pipeline.image_render_worker --once   # process one row and exit

What's wired today (2026-06-12):

    story / hero     full implementation. Re-runs the cinematic
                     thumbnail prompt and overwrites stories.hero_image.

The other slugs (story/scenes, story/props, story/mouth_swap, every
article slug) raise NotImplementedError. The worker catches it and marks
the row error with a clear message — the admin UI surfaces the text
inline so it's obvious which assets are still TODO.

One row at a time. kie image-gen is bursty (3-30s per image) and the
local worker doesn't need concurrency for v1.
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


# A regen function takes the claimed queue row and returns the resulting
# {output_url, cost_cents} tuple. Raises on any unrecoverable failure.
RegenFn = Callable[[dict], tuple[str, int]]


def _default_regen(claimed: dict) -> tuple[str, int]:
    """Dispatch on (owner_kind, asset). Keeps this module thin — the actual
    generators live in pipeline.media (story side) and a future
    article_media module (article side, not yet built).
    """
    from pipeline import media
    owner_kind = claimed["owner_kind"]
    asset = claimed["asset"]
    if owner_kind == "story":
        return media.regen_one(claimed["owner_id"], asset, REPO_ROOT)
    if owner_kind == "article":
        raise NotImplementedError(
            f"article asset regen for {asset!r} is not yet wired on the "
            "Python side. Story assets are the v1 scope; article image "
            "gen is a follow-up workstream (pipeline currently has no "
            "article media pipeline)."
        )
    raise NotImplementedError(f"unknown owner_kind {owner_kind!r}")


def run_one_tick(regen_fn: RegenFn | None = None) -> bool:
    """Claim and process one image regen. Returns True if a row was handled
    (success OR failure), False if the queue is empty.

    Any exception in the regen path is caught and recorded as a failed
    row so a single bad regen doesn't crash the worker loop. NotImplementedError
    is surfaced verbatim so the UI shows a clear "not wired yet" message.
    """
    fn = regen_fn if regen_fn is not None else _default_regen

    claimed = store.claim_next_image_render()
    if claimed is None:
        return False

    render_id = claimed["id"]
    asset = claimed["asset"]
    owner = f"{claimed['owner_kind']}:{claimed['owner_id']}"
    print(
        f"[image regen claim] render={render_id} owner={owner} asset={asset}"
    )

    try:
        output_url, cost_cents = fn(claimed)
    except NotImplementedError as e:
        # Stub path. Surface the message verbatim so the admin sees what's
        # not yet wired.
        store.fail_image_render(render_id, str(e))
        print(f"[image regen not-wired] render={render_id} asset={asset}: {e}")
        return True
    except Exception as e:  # noqa: BLE001 — worker catches everything per-row
        traceback.print_exc()
        store.fail_image_render(render_id, str(e))
        print(f"[image regen fail] render={render_id} asset={asset}: {e}")
        return True

    store.finish_image_render(render_id, output_url, cost_cents)
    print(
        f"[image regen done] render={render_id} asset={asset} "
        f"url={output_url} cost_cents={cost_cents}"
    )
    return True


def main() -> None:
    ap = argparse.ArgumentParser(description="image_renders queue worker")
    ap.add_argument(
        "--once",
        action="store_true",
        help="process one render and exit (used by tests and CI)",
    )
    ap.add_argument(
        "--poll",
        type=int,
        default=DEFAULT_POLL_SECONDS,
        help="seconds between polls when idle",
    )
    args = ap.parse_args()

    store.init()

    if args.once:
        handled = run_one_tick()
        if not handled:
            print("[image regen worker] queue empty")
        return

    print(f"[image regen worker] starting, poll every {args.poll}s")
    while True:
        handled = run_one_tick()
        if not handled:
            time.sleep(args.poll)


if __name__ == "__main__":
    main()
