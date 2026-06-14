"""Local worker that drains the story_jobs queue.

The admin's "Process N selected" action inserts one queued row per
reddit_source. This worker polls for those rows, claims the oldest, builds
a `post` dict from the reddit_source row (skipping the live Decodo scrape
since we already have full_text), runs the existing pipeline stages
(idea → research → article → branded title/synopsis → media → video),
upserts a `stories` row with status='review', then flips the
reddit_source row to status='used'. On any failure, story_jobs.status
flips to 'error' with the message; reddit_source stays in 'queued' so the
admin can re-trigger.

Run with:

    python -m pipeline.story_jobs_worker                 # loop forever, poll every 5s
    python -m pipeline.story_jobs_worker --once          # process one job and exit
    python -m pipeline.story_jobs_worker --reddit r1     # bypass queue, process one row

The `--reddit` mode is the manual escape hatch matching how the
render_worker exposes `--story`: useful for debugging without enqueueing
through the admin.

Designed for testability: `run_one_tick(process_fn=...)` accepts an
injected process callable so unit tests exercise the claim → finish and
claim → fail paths without burning real LLM / kie credits.
"""
from __future__ import annotations

import argparse
import datetime
import json
import time
import traceback
from pathlib import Path
from typing import Callable

from pipeline import llm, media, stages, store, video

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_POLL_SECONDS = 5
# Long enough that a normal media+video run (LLM + kie + ElevenLabs + Remotion
# easily ~5-10 min on a healthy network) doesn't get reaped mid-flight, but
# short enough to clean up a crashed worker within a useful window.
STALE_AFTER_SECONDS = 30 * 60

ProcessFn = Callable[[dict, dict], dict]


# Subreddit -> category mapping is owned by stages.SUBREDDIT_CATEGORY. We
# mirror its lookup here so reddit_source rows with subreddits the static
# table doesn't know about still get a sensible default.
def _category_for(subreddit: str) -> str:
    return stages.SUBREDDIT_CATEGORY.get((subreddit or "").lower(), "Drama")


def reddit_source_to_post(row: dict) -> dict:
    """Convert a reddit_source row into the `post` dict shape that
    stages.make_idea / stages.research / stages.write_article expect.

    Matches the shape stages._scrape_subreddit returns: id, category,
    subreddit, title, selftext, score, num_comments, url. The pipeline's
    real-scrape path and this queue-driven path go through identical
    downstream stages from make_idea onward — the only difference is the
    origin of the dict.
    """
    return {
        "id": row["reddit_id"],
        "category": _category_for(row["subreddit"]),
        "subreddit": row["subreddit"],
        "title": row["title"] or "",
        "selftext": row["full_text"] or "",
        "score": 0,
        "num_comments": int(row.get("comments") or 0),
        "url": row.get("url") or "",
    }


def _default_process(claimed_job: dict, reddit_row: dict) -> dict:
    """Real process path: run the existing pipeline stages against the
    source row. Returns the story dict that was upserted into `stories`
    so the worker can extract `story_id` for finish_story_job."""
    post = reddit_source_to_post(reddit_row)
    with_media = bool(claimed_job.get("with_media", 1))

    before_tokens = llm.totals["total_tokens"]
    idea = stages.make_idea(post, dry_run=False)
    print(f"[story-jobs idea] reddit_id={post['id']} category={idea['category']}")
    store.update_story_job_progress(claimed_job["id"], 15)

    research = stages.research(idea, post, dry_run=False)
    store.update_story_job_progress(claimed_job["id"], 30)

    body = stages.write_article(idea, research, dry_run=False)
    store.update_story_job_progress(claimed_job["id"], 50)

    branded_title, branded_syn = stages.make_title_and_synopsis(
        idea, body, dry_run=False
    )
    store.update_story_job_progress(claimed_job["id"], 60)

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    row = {
        "id": idea["reddit_id"],
        "reddit_id": idea["reddit_id"],
        "slug": idea["reddit_id"],
        "category": idea["category"],
        "title": branded_title or idea["headline"],
        "summary": branded_syn or post.get("selftext", "")[:160],
        "body": body,
        # Fresh from the worker lands in review, never published — the
        # publish gate (Phase 4) is the only writer of status='published'.
        "status": "review",
        "source_url": post.get("url", ""),
        "tokens": llm.totals["total_tokens"] - before_tokens,
        "created_at": now,
        "updated_at": now,
        "payload": {"idea": idea, "research": research},
    }

    if with_media:
        media_cols = media.generate_media(
            idea["reddit_id"],
            idea,
            body,
            branded_title or idea["headline"],
            False,
            repo_root=REPO_ROOT,
        )
        row.update(media_cols)
        row["tokens"] = llm.totals["total_tokens"] - before_tokens
        store.update_story_job_progress(claimed_job["id"], 80)

        # Video render mirrors run.py's --media --video flow.
        hero = row.get("hero_image")
        scenes_raw = row.get("images") or "[]"
        try:
            scenes = (
                json.loads(scenes_raw)
                if isinstance(scenes_raw, str)
                else scenes_raw
            )
        except json.JSONDecodeError:
            scenes = []
        image_urls = ([hero] if hero else []) + list(scenes)

        alignment_raw = row.get("alignment") or "[]"
        try:
            alignment = (
                json.loads(alignment_raw)
                if isinstance(alignment_raw, str)
                else alignment_raw
            )
        except json.JSONDecodeError:
            alignment = []

        props_raw = row.get("props") or "[]"
        try:
            props_list = (
                json.loads(props_raw)
                if isinstance(props_raw, str)
                else props_raw
            )
        except json.JSONDecodeError:
            props_list = []

        video_cols = video.generate_video(
            idea["reddit_id"],
            idea["headline"],
            image_urls,
            row.get("audio_url") or "",
            alignment,
            repo_root=REPO_ROOT,
            category=idea.get("category"),
            props_list=props_list,
            character_image_mouth_removed=row.get("character_image_mouth_removed"),
            story_row=row,
        )
        row.update(video_cols)
        store.update_story_job_progress(claimed_job["id"], 95)

    store.upsert_story(row)
    return row


def run_one_tick(process_fn: ProcessFn | None = None) -> bool:
    """Claim and process one story_job. Returns True if a row was handled
    (success OR failure), False if the queue is empty.

    Any exception in the process path is caught and recorded as a failed
    job so a single bad row doesn't crash the worker loop.
    """
    pfn = process_fn if process_fn is not None else _default_process

    # Clean up any crash-orphaned 'processing' rows BEFORE claiming so a
    # reaped row can be re-claimed on this same tick.
    reaped = store.reap_stale_story_jobs(STALE_AFTER_SECONDS)
    if reaped:
        print(f"[story-jobs reap] reset_stale={reaped}")

    claimed = store.claim_next_story_job()
    if claimed is None:
        return False

    job_id = claimed["id"]
    reddit_id = claimed["reddit_id"]
    with_media = bool(claimed.get("with_media", 1))
    print(
        f"[story-jobs claim] job={job_id} reddit_id={reddit_id} "
        f"with_media={with_media}"
    )

    reddit_row = store.fetch_reddit_source(reddit_id)
    if reddit_row is None:
        store.fail_story_job(job_id, f"reddit_source row {reddit_id} not found")
        print(f"[story-jobs error] job={job_id} missing reddit_source row")
        return True

    # Flip the source row to 'processing' so the admin list status chip
    # reflects what's happening. The job table carries the per-attempt
    # detail; the source row is the row-level lifecycle pointer.
    store.set_reddit_source_status(reddit_id, "processing")

    try:
        result_row = pfn(claimed, reddit_row)
    except Exception as e:  # noqa: BLE001 — worker catches everything per-row
        traceback.print_exc()
        store.fail_story_job(job_id, f"{type(e).__name__}: {e}")
        # Leave the source row in 'queued' so a future Process re-pick is
        # possible without an admin "Reset" affordance.
        store.set_reddit_source_status(reddit_id, "queued")
        print(f"[story-jobs error] job={job_id} {type(e).__name__}: {e}")
        return True

    story_id = result_row.get("id") if isinstance(result_row, dict) else None
    if not story_id:
        store.fail_story_job(job_id, "process returned no story id")
        store.set_reddit_source_status(reddit_id, "queued")
        print(f"[story-jobs error] job={job_id} no story id returned")
        return True

    store.finish_story_job(job_id, story_id)
    store.set_reddit_source_status(reddit_id, "used", story_id=story_id)
    print(
        f"[story-jobs done] job={job_id} reddit_id={reddit_id} "
        f"story_id={story_id}"
    )
    return True


def run_loop(poll_seconds: int = DEFAULT_POLL_SECONDS) -> None:
    """Drain the queue indefinitely. Sleeps `poll_seconds` between empty
    ticks so an idle worker doesn't hammer the DB."""
    print(
        f"[story-jobs worker] started "
        f"(poll={poll_seconds}s, stale_after={STALE_AFTER_SECONDS}s, "
        f"repo={REPO_ROOT})"
    )
    while True:
        did_work = run_one_tick()
        if not did_work:
            time.sleep(poll_seconds)


def _cli() -> int:
    parser = argparse.ArgumentParser(
        description="Drain the story_jobs queue.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Process one job (or exit if the queue is empty), then stop.",
    )
    parser.add_argument(
        "--reddit",
        help=(
            "Bypass the queue and process this reddit_source row directly. "
            "Use for ad-hoc testing without enqueueing through the admin."
        ),
    )
    parser.add_argument(
        "--no-media",
        action="store_true",
        help="Skip the media + video stage when using --reddit.",
    )
    parser.add_argument(
        "--poll-seconds",
        type=int,
        default=DEFAULT_POLL_SECONDS,
        help="Idle poll interval in seconds. Ignored under --once / --reddit.",
    )
    args = parser.parse_args()
    store.init()

    if args.reddit:
        # Synthesize a queue row, mark it processing immediately, and run.
        # Skips the DB round-trip for claim while still hitting the same
        # process path so the result is identical to a queue-driven run.
        reddit_row = store.fetch_reddit_source(args.reddit)
        if reddit_row is None:
            print(f"[story-jobs adhoc] reddit_source {args.reddit!r} not found")
            return 1
        synthetic_job = {
            "id": "adhoc",
            "reddit_id": args.reddit,
            "with_media": 0 if args.no_media else 1,
        }
        try:
            result = _default_process(synthetic_job, reddit_row)
            print(f"[story-jobs adhoc done] story_id={result.get('id')}")
            return 0
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            print(f"[story-jobs adhoc error] {type(e).__name__}: {e}")
            return 1

    if args.once:
        ran = run_one_tick()
        if not ran:
            print("[story-jobs worker] queue empty — nothing to do")
        return 0

    try:
        run_loop(args.poll_seconds)
    except KeyboardInterrupt:
        print("[story-jobs worker] stopping on interrupt")
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
