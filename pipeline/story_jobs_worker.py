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

# Phase 7 daily-budget cap (see _plans/2026-06-14-story-jobs-followups.md).
# Per-job spend estimate used by the worker's pre-claim budget gate.
# The real number varies — a tight text-only run can be ~$0.10, a
# 30-scene + voice + Remotion run can be $0.80. The flat $0.50 is
# deliberately conservative on small runs and slightly optimistic on
# big ones; we'd rather block a tick too early than burn the cap on
# an underestimate. Tune via settings later if it bites.
ESTIMATED_JOB_COST_CENTS = 50
# Admin-managed in settings; unset = no cap = unlimited.
DAILY_BUDGET_CAP_SETTING_KEY = "pipeline.story_jobs.daily_cap_cents"

# Blended LLM token rate for cost capture. gpt-5.4-mini (the model that
# the article-writing and image-prompt stages use) bills roughly
# $0.40 / 1M input + $1.50 / 1M output tokens. We don't separately track
# input vs output here — llm.totals carries the combined `total_tokens`
# counter, and a 60/40 input/output split lands the blended rate around
# 1e-6 USD/token. The micro-phase ships with this number so cost_cents
# stops reading $0 on every text-only job. Revisit when llm.py starts
# tracking input/output separately or when the active model changes.
LLM_USD_PER_TOKEN = 1e-6

# Reason recorded on story_jobs.error when the Vercel drain pre-skips a
# with_media=True job. The hosted Python runtime can't shell out to
# Remotion via npx, so claiming + processing would burn LLM + image spend
# only to crash at the video step. Pre-skipping at claim time lets the
# admin see exactly why the row was rejected and how to recover.
DRAIN_UNSUPPORTED_MEDIA_REASON = (
    "drain runtime cannot generate video (no Node + Remotion); "
    "re-enqueue with with_media=False or run the local worker"
)

# 2026-06-16 Reddit-import output format. Per-batch override on the
# `story_jobs.output_format` column wins; otherwise the
# `reddit.default_output` setting decides; otherwise REDDIT_DEFAULT_OUTPUT.
# Plan: _plans/2026-06-16-reddit-default-to-shorts.md.
REDDIT_DEFAULT_OUTPUT_SETTING_KEY = "reddit.default_output"
REDDIT_DEFAULT_OUTPUT = "short"
_VALID_OUTPUT_FORMATS = ("short", "long")

ProcessFn = Callable[[dict, dict], dict]


def resolve_output_format(
    claimed_job: dict,
    get_setting: Callable[[str], "str | None"] = store.get_setting,
) -> tuple[str, str]:
    """Decide the output format for a claimed story_jobs row.

    Returns `(format, source)` where `format` is 'short' or 'long' and
    `source` is one of 'row' (per-batch override on the row),
    'setting' (the global `reddit.default_output` setting) or
    'default' (the hardcoded REDDIT_DEFAULT_OUTPUT fallback).

    Closed enum on both ends — a malformed row column or setting falls
    through to the next layer rather than crashing the worker. The
    storage layer (pipeline/store.py:enqueue_story_job) normalises bad
    inputs to NULL on write; this resolver is the read-side defence.
    """
    row_raw = (claimed_job.get("output_format") or "").strip().lower()
    if row_raw in _VALID_OUTPUT_FORMATS:
        return row_raw, "row"
    setting_raw = (get_setting(REDDIT_DEFAULT_OUTPUT_SETTING_KEY) or "").strip().lower()
    if setting_raw in _VALID_OUTPUT_FORMATS:
        return setting_raw, "setting"
    return REDDIT_DEFAULT_OUTPUT, "default"


def _daily_budget_cap_cents() -> int | None:
    """Read the admin-managed cap. None when unset or invalid — treated as
    "no cap." Negative or zero is also treated as no cap (admin intent is
    "off"), which avoids a passive-aggressive permanent block."""
    raw = store.get_setting(DAILY_BUDGET_CAP_SETTING_KEY)
    if not raw:
        return None
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def compute_job_cost_cents(
    media_delta_usd: float,
    llm_token_delta: int,
) -> int:
    """Pure-function cost-delta → cents for the story_jobs cost-capture
    path. Extracted from `_default_process` so the math is unit-testable
    without mocking the whole pipeline.

    `media_delta_usd` is the after-minus-before of `media.running_cost_usd()`
    (covers kie images + voice + STT). `llm_token_delta` is the
    after-minus-before of `llm.totals['total_tokens']`. LLM tokens are
    priced at LLM_USD_PER_TOKEN (see constant for the rate).

    Negative deltas are clamped at 0 — they should be impossible (totals
    monotonically grow) but guarding against driver weirdness is cheap.
    """
    llm_delta_usd = max(0, llm_token_delta) * LLM_USD_PER_TOKEN
    return max(0, round((media_delta_usd + llm_delta_usd) * 100))


def _budget_block_reason() -> str | None:
    """Return a human-readable block reason when the next job would push
    today's projected spend past the cap. None when the tick may proceed.

    Pure read — no side effects. The worker calls this BEFORE claim so
    a blocked tick doesn't waste a claim/finish cycle on a row that would
    just sit there.
    """
    cap = _daily_budget_cap_cents()
    if cap is None:
        return None
    projected = store.today_story_job_estimate_cents(ESTIMATED_JOB_COST_CENTS)
    if projected + ESTIMATED_JOB_COST_CENTS > cap:
        return (
            f"projected={projected}c + next~{ESTIMATED_JOB_COST_CENTS}c "
            f"> cap={cap}c"
        )
    return None


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
    so the worker can extract `story_id` for finish_story_job.

    Story-jobs scope: LLM (idea/research/article/title) + optional
    media (kie images + voice + alignment). Video render is NOT done
    here — it's enqueued into the video_renders queue and rendered out
    of band by the Cloud Run service (see
    _plans/2026-06-14-cloud-run-render.md). This split means every
    story job is fully completable on Vercel's runtime; only the MP4
    render needs Node + Remotion, which lives in its own queue.
    """
    post = reddit_source_to_post(reddit_row)
    with_media = bool(claimed_job.get("with_media", 1))

    before_tokens = llm.totals["total_tokens"]
    # Snapshot of running cost so we can compute the per-job delta at the
    # end and persist it to stories.cost_cents. This is what the budget
    # bar's "actual today" line reads — without this write the column
    # stays NULL forever and the bar can only ever show the count-based
    # estimate. The pricing source is pipeline/media.py's IMAGE_COST_USD
    # / TTS_COST_PER_CHAR / STT_COST_PER_SECOND tables.
    before_cost_usd = media.running_cost_usd()

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
        store.update_story_job_progress(claimed_job["id"], 90)
        # Video render is OUT of band — enqueue into video_renders so the
        # Cloud Run service (api/dispatch_video_render -> Cloud Run
        # /render) picks it up. Done after upsert_story below because
        # the video_renders FK is `story_id` and we need the story row
        # to exist first.

    # Wrap up with the per-job spend delta. Three contributors:
    #   - media (kie images + voice + STT) via media.running_cost_usd()
    #   - LLM tokens via llm.totals; rate constant lives at top of file
    # Both snapshotted before/after so the delta isolates THIS job's
    # contribution from any prior jobs in the same worker process. Round
    # to integer cents for the stories.cost_cents INTEGER column.
    #
    # Without the LLM term, text-only jobs (with_media=False) reported
    # cost_cents=0 even though the article-writing LLM calls burned real
    # money. Now they reflect the true spend.
    media_delta_usd = media.running_cost_usd() - before_cost_usd
    llm_token_delta = llm.totals["total_tokens"] - before_tokens
    row["cost_cents"] = compute_job_cost_cents(
        media_delta_usd, llm_token_delta,
    )
    store.upsert_story(row)

    # Resolve the per-row output format BEFORE handing off so the two
    # branches stay symmetric (one enqueues a long-form render, the other
    # force-enqueues a short — never both, never neither).
    output_format, output_source = resolve_output_format(claimed_job)
    print(
        f"[reddit output] resolved reddit_id={post['id']} "
        f"job_id={claimed_job['id']} format={output_format} "
        f"source={output_source}"
    )

    if output_format == "short":
        # Short-only branch (the new default for Reddit imports). Skip the
        # long-form video_renders enqueue entirely — the short pipeline
        # generates its own frames + voice from the story body, lands in
        # the short editor (Scenes + Captions tabs), and is materially
        # cheaper than a Cloud Run remotion render. The shorts.auto.*
        # gate is bypassed because the admin's per-batch / per-setting
        # pick is "make a short" — but the rolling-24h cap still applies
        # as a cost safety net.
        print(
            f"[reddit output] short-only skip-long-form story_id={row['id']}"
        )
        try:
            from pipeline import shorts_auto
            forced = shorts_auto.maybe_enqueue_short_for_story(
                row["id"],
                row.get("category"),
                requested_by="reddit-import",
                force=True,
            )
            if forced:
                print(
                    f"[reddit output] forced-short story_id={row['id']} "
                    f"requested_by=reddit-import"
                )
            else:
                # Cap hit (logged inside shorts_auto). Surface here too so
                # the worker's per-row log tells the whole story without
                # having to grep across two namespaces.
                print(
                    f"[reddit output] forced-short-skipped story_id={row['id']} "
                    f"reason=cap-or-error"
                )
        except Exception as e:  # noqa: BLE001 — handoff must not break the job
            print(f"[reddit output] forced-short error story_id={row['id']}: {e}")
    else:
        # Long-form branch: existing behaviour. Hand off to the video
        # pipeline, then optionally an auto-short alongside if the global
        # setting / per-category override says so. The Cloud Run cron picks
        # the row up within ~1 min and writes back stories.video_url. The
        # publish gate already requires video_url IS NOT NULL, so the story
        # stays at status='review' until then.
        if with_media:
            _enqueue_video_render_for_story(row)

        # Auto-enqueue a short if the admin turned it on (global or per-category).
        # Shorts generate their own frames + voice from the story text, so this is
        # NOT gated on with_media. Off by default; a failure here never blocks story
        # completion.
        try:
            from pipeline import shorts_auto
            if shorts_auto.maybe_enqueue_short_for_story(row["id"], row.get("category")):
                print(f"[story-jobs handoff] short auto-enqueued story_id={row['id']}")
        except Exception as e:  # noqa: BLE001 — auto-short must not break the job
            print(f"[story-jobs handoff] auto-short skipped: {e}")

    return row


def _enqueue_video_render_for_story(story_row: dict) -> None:
    """Auto-enqueue a video_renders row for a freshly-upserted story so
    the Cloud Run cron picks up the render. Idempotency on
    (story_id, config_hash) means re-processing the same story (e.g.
    after Re-process N) coalesces to a single render — UNLESS the
    content changed, in which case the hash differs and a fresh render
    fires. That's the desired behaviour: changed inputs → new MP4.
    """
    import hashlib as _hashlib
    import uuid as _uuid
    story_id = story_row["id"]
    # Content hash covers everything the renderer reads from the
    # story row. If any of these change between re-processes, we want
    # a fresh render — the hash flipping is the signal.
    parts = [
        story_id,
        story_row.get("title") or "",
        story_row.get("body") or "",
        story_row.get("hero_image") or "",
        story_row.get("images") or "",
        story_row.get("audio_url") or "",
        story_row.get("alignment") or "",
    ]
    config_hash = _hashlib.sha256(
        "\x1f".join(parts).encode("utf-8")
    ).hexdigest()
    render_id = str(_uuid.uuid4())
    resulting = store.enqueue_render(
        render_id=render_id,
        story_id=story_id,
        config_hash=config_hash,
        requested_by="story_jobs_worker",
    )
    # enqueue_render's ON CONFLICT DO NOTHING means a row at the same
    # (story_id, config_hash) survives; the returned dict is then the
    # PRE-EXISTING row, whose id is the prior render's. Compare ids to
    # distinguish "we inserted" from "no-op against existing row."
    if resulting and resulting.get("id") == render_id:
        print(
            f"[story-jobs handoff] story_id={story_id} "
            f"video_render={render_id} config_hash={config_hash[:12]}"
        )
    else:
        existing_id = resulting.get("id") if resulting else None
        print(
            f"[story-jobs handoff-skip] story_id={story_id} "
            f"existing_render={existing_id} "
            f"reason=render-already-queued-at-same-hash"
        )


def run_one_tick(
    process_fn: ProcessFn | None = None,
    skip_with_media: bool = False,
) -> bool:
    """Claim and process one story_job. Returns True if a row was handled
    (success OR failure), False if the queue is empty.

    Any exception in the process path is caught and recorded as a failed
    job so a single bad row doesn't crash the worker loop.

    `skip_with_media`: legacy flag from before the video step was
    moved to the video_renders queue. Both branches (Vercel drain +
    local CLI) now process media jobs the same way — the worker writes
    LLM + media output and enqueues an MP4 render that Cloud Run
    handles. The flag is kept for one release in case callers in
    transition still pass it; both pre-claim filter and post-claim
    fail-fast paths are wired so nothing breaks if a stale deploy is
    still passing True.
    """
    pfn = process_fn if process_fn is not None else _default_process

    # Clean up any crash-orphaned 'processing' rows BEFORE claiming so a
    # reaped row can be re-claimed on this same tick.
    reaped = store.reap_stale_story_jobs(STALE_AFTER_SECONDS)
    if reaped:
        print(f"[story-jobs reap] reset_stale={reaped}")

    # Phase 7 budget gate. Check BEFORE claim so a blocked tick doesn't
    # waste a claim/finish cycle. The gate is intentionally conservative —
    # it includes already-active jobs in today's projected spend, so a
    # batch in flight can't squeak under the cap while another row gets
    # picked up. Returning False here puts the loop into its idle sleep.
    block_reason = _budget_block_reason()
    if block_reason is not None:
        print(f"[story-jobs budget-block] {block_reason}")
        return False

    # When skip_with_media is set, push the filter ALL THE WAY DOWN to
    # the claim SQL — we must not claim what we can't process, because
    # claim-then-fail loses the race against the local worker that
    # COULD have processed the row. Without this, the Vercel cron drain
    # killed every with_media=True row the admin enqueued.
    claimed = store.claim_next_story_job(text_only_only=skip_with_media)
    if claimed is None:
        return False

    job_id = claimed["id"]
    reddit_id = claimed["reddit_id"]
    with_media = bool(claimed.get("with_media", 1))
    print(
        f"[story-jobs claim] job={job_id} reddit_id={reddit_id} "
        f"with_media={with_media}"
    )

    if skip_with_media and with_media:
        # Pre-skip the moment we know this is a video job. Failing fast
        # (before fetch_reddit_source / process_fn) means zero LLM + image
        # spend on a row the runtime can't finish. Source row flips back
        # to 'imported' (not 'queued' like the regular error path below)
        # because bulkEnqueueStoryJobs guards re-enqueue on imported — so
        # an admin can immediately re-Process this row with
        # with_media=False and the drain will handle it next tick.
        store.fail_story_job(job_id, DRAIN_UNSUPPORTED_MEDIA_REASON)
        store.set_reddit_source_status(reddit_id, "imported")
        print(
            f"[story-jobs drain-skip] job={job_id} reddit_id={reddit_id} "
            f"reason=with_media-unsupported"
        )
        return True

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
