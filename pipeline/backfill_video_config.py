"""One-shot backfill: write a minimal video_config onto every story that
predates the column.

The editor at /admin/videos/[id] derives a default config on first open
when video_config is NULL (see lorewire-app/src/lib/video-config.ts —
`defaultVideoConfig`). That works, but it has two downsides:

  1. The derive-on-open path is invisible to admins and the pipeline —
     until someone *opens* the editor, the column stays NULL and grep on
     `WHERE video_config IS NOT NULL` undercounts.
  2. A pipeline re-run before the editor is opened has no `current` to
     merge against, so any motion / caption settings the admin tweaked
     via the old settings-key path can't ride forward as locks.

This script writes a derived config for every story matching the editor's
default shape, so the column reflects reality post-migration. It is
deliberately additive — never overwrites an existing video_config (use
the editor for that). Run once per environment after deploying the
video editor.

CLI:

    python -m pipeline.backfill_video_config              # full backfill
    python -m pipeline.backfill_video_config --dry-run    # count only
    python -m pipeline.backfill_video_config --story X    # one story
"""
from __future__ import annotations

import argparse
import json
from typing import Any

from pipeline import store


CONFIG_VERSION = 2


def derive_video_config(story: dict) -> dict | None:
    """Best-effort default config from a story row's raw inputs.

    Returns None when the row doesn't have enough to derive a useful
    config — i.e. no audio_url. Without audio_url the renderer can't
    produce a video anyway, so a fresh config would just be ceremony.

    Mirrors the editor's `defaultVideoConfig` so the two derivations
    agree on what an "unconfigured" story looks like.
    """
    audio_url = story.get("audio_url")
    if not audio_url:
        return None

    images_raw = story.get("images") or "[]"
    try:
        images = json.loads(images_raw) if isinstance(images_raw, str) else images_raw
    except json.JSONDecodeError:
        images = []
    if not isinstance(images, list):
        images = []

    alignment_raw = story.get("alignment") or "[]"
    try:
        alignment = json.loads(alignment_raw) if isinstance(alignment_raw, str) else alignment_raw
    except json.JSONDecodeError:
        alignment = []
    if not isinstance(alignment, list):
        alignment = []

    # Each caption chunk's end_ms is the source of truth for duration. If
    # alignment is empty (oldest stories), fall back to whatever the row
    # says — the editor still loads, the Player just shows the wireframe.
    duration_ms = 0
    for c in alignment:
        if isinstance(c, dict):
            end = c.get("end_ms")
            if isinstance(end, (int, float)) and end > duration_ms:
                duration_ms = int(end)

    # Distribute images across the captions the same way the editor does:
    # caption_chunk_start_index = floor(i / N * captions.length).
    doodle_frames: list[dict] = []
    caption_count = max(1, len(alignment))
    for i, url in enumerate(images):
        if not isinstance(url, str):
            continue
        idx = (i * caption_count) // max(1, len(images))
        doodle_frames.append({
            "url": url,
            "caption_chunk_start_index": min(idx, caption_count - 1),
        })

    return {
        "config_version": CONFIG_VERSION,
        "voiceover_url": audio_url,
        "title": story.get("title") or "",
        "channel_name": "lorewire",
        "duration_ms": duration_ms,
        "doodle_frames": doodle_frames,
        "captions": alignment,
    }


def _list_unconfigured_story_ids() -> list[str]:
    """Stories with video_config IS NULL and a usable audio_url."""
    # Read directly via the store's connection — there's no helper for
    # this exact query and the backfill is one-shot, not hot-path.
    if store._is_postgres():
        with store._pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM stories "
                    "WHERE (video_config IS NULL OR video_config = '') "
                    "AND audio_url IS NOT NULL AND audio_url != '' "
                    "ORDER BY id"
                )
                return [r["id"] for r in cur.fetchall()]
    with store._sqlite_conn() as c:
        cur = c.execute(
            "SELECT id FROM stories "
            "WHERE (video_config IS NULL OR video_config = '') "
            "AND audio_url IS NOT NULL AND audio_url != '' "
            "ORDER BY id"
        )
        return [r["id"] for r in cur.fetchall()]


def _write_config(story_id: str, config: dict) -> None:
    """Write video_config to a story row without touching anything else."""
    json_str = json.dumps(config)
    now = _now_iso()
    if store._is_postgres():
        with store._pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE stories SET video_config = %s, updated_at = %s "
                    "WHERE id = %s",
                    (json_str, now, story_id),
                )
            conn.commit()
        return
    with store._sqlite_conn() as c:
        c.execute(
            "UPDATE stories SET video_config = ?, updated_at = ? WHERE id = ?",
            (json_str, now, story_id),
        )


def _now_iso() -> str:
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def backfill_one(story_id: str, dry_run: bool = False) -> dict[str, Any]:
    """Backfill one story by id. Returns a result dict for the CLI."""
    story = store.fetch_story(story_id)
    if not story:
        return {"id": story_id, "status": "skipped", "reason": "not-found"}
    if story.get("video_config"):
        return {"id": story_id, "status": "skipped", "reason": "already-set"}
    config = derive_video_config(story)
    if config is None:
        return {"id": story_id, "status": "skipped", "reason": "no-audio"}
    if not dry_run:
        _write_config(story_id, config)
    return {
        "id": story_id,
        "status": "written" if not dry_run else "would-write",
        "frames": len(config["doodle_frames"]),
        "captions": len(config["captions"]),
        "duration_ms": config["duration_ms"],
    }


def backfill_all(dry_run: bool = False) -> dict[str, Any]:
    """Walk every unconfigured story. Returns aggregated counters."""
    story_ids = _list_unconfigured_story_ids()
    written = 0
    skipped: list[dict] = []
    for sid in story_ids:
        result = backfill_one(sid, dry_run=dry_run)
        if result["status"] in {"written", "would-write"}:
            written += 1
        else:
            skipped.append(result)
        print(f"[backfill {result['status']}] story={sid} {result}")
    return {
        "candidates": len(story_ids),
        "written": written,
        "skipped": skipped,
        "dry_run": dry_run,
    }


def _cli() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Backfill stories.video_config with a derived default for rows "
            "that predate the column. Idempotent — skips rows that already "
            "have a config."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would happen without writing.",
    )
    parser.add_argument(
        "--story",
        help="Backfill a single story by id (otherwise: every candidate).",
    )
    args = parser.parse_args()

    if args.story:
        result = backfill_one(args.story, dry_run=args.dry_run)
        print(f"[backfill] {result}")
        return

    summary = backfill_all(dry_run=args.dry_run)
    print(
        f"[backfill summary] candidates={summary['candidates']} "
        f"written={summary['written']} skipped={len(summary['skipped'])} "
        f"dry_run={summary['dry_run']}"
    )


if __name__ == "__main__":
    _cli()
