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

# 2026-06-19 hero+thumbnail-from-short finisher (plan:
# _plans/2026-06-19-reddit-source-auto-deliver-article-short-hero-thumbnail.md).
# How long the worker will inline-wait for a short to finish before bailing
# on the finisher (the story still ships, just without scene-derived visuals).
# Default 25 min covers a busy shorts queue without holding the worker slot
# forever. Overridable via the `hero_thumbnail.wait_ceiling_seconds` setting.
HERO_THUMB_WAIT_CEILING_SECONDS_DEFAULT = 25 * 60
HERO_THUMB_WAIT_CEILING_SETTING_KEY = "hero_thumbnail.wait_ceiling_seconds"
# Backoff between polls: tight at first (3s, 5s) so a fast short finisher
# is picked up promptly, steady 10s thereafter so a stalled short doesn't
# hammer the DB. Heartbeat event every 30s while waiting so the admin can
# see "still waiting" in the timeline.
HERO_THUMB_POLL_BACKOFF_SECONDS = (3, 5, 10)
HERO_THUMB_HEARTBEAT_SECONDS = 30

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

ProcessFn = Callable[[dict, dict], dict]


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


def _hero_thumb_wait_ceiling_seconds() -> int:
    """Read the admin-configurable wait ceiling for the hero+thumb finisher.
    None or non-positive override falls back to the default. Kept as a
    function (not a module constant) so a settings change is picked up on
    the next tick without restarting the worker."""
    raw = (store.get_setting(HERO_THUMB_WAIT_CEILING_SETTING_KEY) or "").strip()
    if not raw:
        return HERO_THUMB_WAIT_CEILING_SECONDS_DEFAULT
    try:
        v = int(float(raw))
    except ValueError:
        return HERO_THUMB_WAIT_CEILING_SECONDS_DEFAULT
    return v if v > 0 else HERO_THUMB_WAIT_CEILING_SECONDS_DEFAULT


def _wait_for_short_done(
    story_id: str,
    job_id: str,
    reddit_id: str,
    *,
    sleeper: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
) -> str:
    """Inline-poll `short_renders` for `story_id` until the latest render hits
    a terminal state (`done`, `failed`, `error`, or `cancelled`) or the wait
    ceiling fires. Returns the final status string; the caller branches on it.

    The `sleeper` and `now` parameters are injected so unit tests drive the
    loop without real time passing. Heartbeats emit a `waiting_for_short`
    story_job_event every HERO_THUMB_HEARTBEAT_SECONDS so the admin's row
    timeline narrates the wait.
    """
    ceiling = _hero_thumb_wait_ceiling_seconds()
    start = now()
    last_heartbeat = start
    poll_idx = 0
    while True:
        latest = store.latest_short_render_for_story(story_id)
        status = (latest.get("status") if latest else "") or ""
        if status in {"done", "failed", "error", "cancelled"}:
            return status
        elapsed = now() - start
        if elapsed >= ceiling:
            return "timeout"
        if (now() - last_heartbeat) >= HERO_THUMB_HEARTBEAT_SECONDS:
            store.log_story_job_event(
                job_id, reddit_id, "waiting_for_short",
                message=f"Still waiting on short ({int(elapsed)}s elapsed)",
                payload={
                    "elapsed_seconds": int(elapsed),
                    "ceiling_seconds": ceiling,
                    "short_status": status or "missing",
                },
            )
            last_heartbeat = now()
        delay = HERO_THUMB_POLL_BACKOFF_SECONDS[
            min(poll_idx, len(HERO_THUMB_POLL_BACKOFF_SECONDS) - 1)
        ]
        sleeper(delay)
        poll_idx += 1


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
    job_id = claimed_job["id"]
    reddit_id = claimed_job["reddit_id"]

    # 2026-06-16 per-row event timeline. Worker emits one event per
    # meaningful phase so the admin detail page can render a live log.
    # See _plans/2026-06-16-story-job-event-timeline.md. The print() lines
    # below are kept so the worker terminal still narrates locally.
    store.log_story_job_event(
        job_id, reddit_id, "claimed",
        message="Worker claimed the row",
        payload={"with_media": with_media, "subreddit": post.get("subreddit")},
    )

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
    store.log_story_job_event(
        job_id, reddit_id, "idea_done",
        message=f"Generated idea: {idea.get('headline', '')[:80]}",
        payload={"category": idea.get("category"), "headline": idea.get("headline")},
    )

    research = stages.research(idea, post, dry_run=False)
    store.update_story_job_progress(claimed_job["id"], 30)
    store.log_story_job_event(
        job_id, reddit_id, "research_done",
        message="Researched supporting context",
        payload={"keys": list(research.keys()) if isinstance(research, dict) else None},
    )

    body = stages.write_article(idea, research, dry_run=False)
    store.update_story_job_progress(claimed_job["id"], 50)
    store.log_story_job_event(
        job_id, reddit_id, "article_done",
        message=f"Wrote article ({len(body)} chars)",
        payload={"char_count": len(body)},
    )

    branded_title, branded_syn = stages.make_title_and_synopsis(
        idea, body, dry_run=False
    )
    store.update_story_job_progress(claimed_job["id"], 60)
    store.log_story_job_event(
        job_id, reddit_id, "title_done",
        message=f"Title: {(branded_title or idea.get('headline', ''))[:80]}",
        payload={"title": branded_title, "synopsis_chars": len(branded_syn or "")},
    )

    # 2026-06-21 LLM category classifier
    # (_plans/2026-06-21-category-classifier-and-pills.md). Subreddit map
    # is the fallback; the classifier reads the rewritten article body so
    # it tags accurately regardless of which subreddit a CSV row came
    # from. A failed call returns the fallback unchanged — never NULL,
    # never junk — so the downstream upsert stays safe.
    prev_category = idea["category"]
    classified = stages.classify_category(
        branded_title or idea["headline"],
        body,
        fallback_category=prev_category,
    )
    if classified != prev_category:
        print(
            f"[story-jobs classify] reddit_id={post['id']} "
            f"{prev_category} -> {classified}"
        )
        store.log_story_job_event(
            job_id, reddit_id, "category_reclassified",
            message=f"Category {prev_category} -> {classified}",
            payload={"prev": prev_category, "next": classified},
        )
        idea["category"] = classified
    else:
        print(
            f"[story-jobs classify] reddit_id={post['id']} kept {prev_category}"
        )

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
        store.log_story_job_event(
            job_id, reddit_id, "media_started",
            message="Generating scenes + voice + alignment (hero deferred to finisher)",
        )
        # 2026-06-19 (plans:
        # _plans/2026-06-19-reddit-source-auto-deliver-article-short-hero-thumbnail.md
        # _plans/2026-06-19-no-long-form-video-for-reddit-jobs.md):
        # The hero is generated AFTER the short completes — `skip_hero=True`
        # tells `generate_media` to keep narration + alignment and skip
        # only the two t2i hero calls that the finisher will overwrite anyway.
        # `skip_long_form_scenes=True` skips the 27-31 long-form scene images
        # (~$1.35-1.55/story); the finisher writes the short's own scenes into
        # stories.images so the article reader still has inline illustrations.
        # Net: -$1.43/story average vs. the pre-2026-06-19 worker path.
        # 2026-06-24: skip_long_form_motion_beats=True silences the
        # PropSlideIn (~5x kie calls @ 60s each) and MouthSwap (~2x kie
        # calls) blocks. Both feed the long-form video composition, which
        # Reddit jobs no longer render (per 2026-06-19 plan). Production
        # was hitting Vercel's 800s ceiling because one prop's kie task
        # timed out at 240s and the retry took 306s on its own, before
        # even reaching the short handoff. Skipping shaves ~6-7 minutes
        # off a typical media run and keeps the Vercel drain comfortably
        # under the deadline.
        media_cols = media.generate_media(
            idea["reddit_id"],
            idea,
            body,
            branded_title or idea["headline"],
            False,
            repo_root=REPO_ROOT,
            skip_hero=True,
            skip_long_form_scenes=True,
            skip_long_form_motion_beats=True,
        )
        row.update(media_cols)
        row["tokens"] = llm.totals["total_tokens"] - before_tokens
        store.update_story_job_progress(claimed_job["id"], 90)
        store.log_story_job_event(
            job_id, reddit_id, "media_done",
            message="Voice + alignment ready (hero + scenes pending finisher)",
            payload={
                "audio_url": bool(media_cols.get("audio_url")),
                "alignment": bool(media_cols.get("alignment")),
            },
        )
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
    store.log_story_job_event(
        job_id, reddit_id, "story_persisted",
        message=f"Saved story (cost ~${row['cost_cents'] / 100:.2f})",
        payload={
            "story_id": row["id"],
            "cost_cents": row["cost_cents"],
            "tokens": row["tokens"],
        },
    )

    # 2026-06-19 (plan:
    # _plans/2026-06-19-no-long-form-video-for-reddit-jobs.md):
    # The long-form video render is NO LONGER auto-enqueued for Reddit-source
    # jobs. The MP4 render burned Cloud Run compute + worker time on top of
    # an MP4 the public reader never asked for. The publish gate's video_url
    # requirement has been dropped to match. The video editor's "Render"
    # button on /admin/videos/[id] still works as an ad-hoc escape hatch
    # when a specific story genuinely needs the long-form MP4.

    # 2026-06-19 (plan:
    # _plans/2026-06-19-reddit-source-auto-deliver-article-short-hero-thumbnail.md):
    # Reddit-source story jobs now run the short to completion inline so the
    # hero + thumbnail can be derived from the short's character_base_url + a
    # picker-chosen scene. For with_media=False jobs we keep the legacy
    # fire-and-forget shape (no short, no finisher) because the admin
    # explicitly opted out of the visual pipeline.
    if with_media:
        _enqueue_short_and_mark_finisher_pending(row, job_id, reddit_id)

    return row


def _enqueue_short_and_mark_finisher_pending(
    row: dict, job_id: str, reddit_id: str,
) -> None:
    """2026-06-24 stage-split: force-enqueue the short and flip the job's
    `finisher_status` to 'pending' so the /api/run_hero_thumbnail_finisher
    cron can run the hero+thumbnail finisher OUT of band when the short
    eventually reaches status='done'.

    This replaces the old inline wait + finisher (`_run_short_and_finisher`)
    which exceeded Vercel's 800s function ceiling on fresh sources where
    the short hadn't been pre-rendered. The new shape returns in seconds
    after enqueueing the short, leaving the heavy work (short generation
    + 5 i2i finisher calls) to dedicated cron functions that each have
    their own 800s budget.

    Best-effort: failure to enqueue the short is logged as a timeline
    event but never raises — the article still ships even if the visual
    pipeline doesn't (the public reader's fallback chain handles missing
    hero/thumbnail).
    """
    from pipeline import shorts_auto

    story_id = row["id"]
    try:
        enqueued = shorts_auto.maybe_enqueue_short_for_story(
            story_id, row.get("category"),
            requested_by="story_job", force=True,
        )
    except Exception as e:  # noqa: BLE001 — short must not break the job
        print(f"[story-jobs handoff] short enqueue failed: {e}")
        store.log_story_job_event(
            job_id, reddit_id, "short_enqueue_error",
            level="warn",
            message=f"Short enqueue raised: {e}"[:200],
        )
        return

    if not enqueued:
        # Hit the global 24h cost cap. No short to wait for; skip the
        # finisher. The admin sees this in the timeline so they know
        # why the story shipped without scene-derived visuals.
        print(f"[story-jobs handoff] short enqueue refused (cap hit) story_id={story_id}")
        store.log_story_job_event(
            job_id, reddit_id, "short_enqueue_capped",
            level="warn",
            message="Daily shorts cap hit; skipping hero+thumbnail finisher",
            payload={"story_id": story_id},
        )
        return

    print(f"[story-jobs handoff] short force-enqueued story_id={story_id}")
    store.log_story_job_event(
        job_id, reddit_id, "short_enqueued_for_story",
        message=(
            "Short enqueued (force) — finisher will run when the short is done"
        ),
        payload={"story_id": story_id},
    )
    # Stage-split signal: the finisher cron polls for this flag + a
    # short_renders.status='done' join to decide when to claim.
    store.mark_finisher_pending(job_id)


def run_finisher_for_job(claimed: dict) -> None:
    """2026-06-24 stage-split: the body of what used to be the worker's
    inline finisher block, lifted into its own function so the Vercel
    cron at /api/run_hero_thumbnail_finisher can call it after claiming
    one row via `store.claim_finisher_job`.

    Invariants the caller upholds:
      - `claimed['story_id']` exists in stories.
      - The story's short_renders row has status='done' (the claim SQL
        verifies this).
      - `claimed['finisher_status']` is 'running' (the claim flipped it
        from 'pending' atomically).

    On success: sets `finisher_status='done'` and, when the job is
    Full-Pipeline-armed, calls `store.request_story_job_auto_publish`
    so the auto-publish cron picks the row up next.

    On failure: sets `finisher_status='failed'` and logs a structured
    timeline event so the admin sees why. The job's `status='done'`
    flag is left as-is — the article ships even without the visual
    finisher because the public reader has a fallback chain.
    """
    job_id = claimed["id"]
    reddit_id = claimed["reddit_id"]
    story_id = claimed["story_id"]
    if not story_id:
        store.set_finisher_status(job_id, "failed")
        store.log_story_job_event(
            job_id, reddit_id, "hero_thumbnail_skipped",
            level="warn",
            message="Finisher claim had no story_id",
        )
        return

    try:
        result = media.generate_hero_and_thumbnail_from_short(story_id, REPO_ROOT)
    except ValueError as e:
        # Expected setup failures (missing character_base_url, malformed
        # props, etc.) — surfaced verbatim by `_build_hero_and_thumbnail_from_short`.
        store.set_finisher_status(job_id, "failed")
        store.log_story_job_event(
            job_id, reddit_id, "hero_thumbnail_skipped",
            level="warn",
            message=str(e)[:200],
        )
        print(f"[finisher refused] story_id={story_id}: {e}")
        return
    except Exception as e:  # noqa: BLE001 — finisher must not break the cron
        traceback.print_exc()
        store.set_finisher_status(job_id, "failed")
        store.log_story_job_event(
            job_id, reddit_id, "hero_thumbnail_error",
            level="error",
            message=f"Finisher raised: {e}"[:200],
        )
        print(f"[finisher error] story_id={story_id}: {e}")
        return

    # The image columns (hero_image, hero_image_landscape, thumbnail_*)
    # AND stories.video_url were written by the finisher's per-variant
    # store helpers directly. We only need to add the i2i spend to
    # stories.cost_cents so the daily budget bar tracks reality.
    extra_cents = int(result.get("cost_cents") or 0)
    story = store.fetch_story(story_id)
    base_cents = int((story or {}).get("cost_cents") or 0)
    store.update_story_cost_cents(story_id, base_cents + extra_cents)
    store.log_story_job_event(
        job_id, reddit_id, "hero_thumbnail_built",
        message=(
            f"Hero+thumbnail built (+${extra_cents / 100:.2f}, "
            f"hero=#{result.get('hero_index')}, thumb=#{result.get('thumbnail_index')})"
        ),
        payload={
            "story_id": story_id,
            "cost_cents_added": extra_cents,
            "hero_index": result.get("hero_index"),
            "thumbnail_index": result.get("thumbnail_index"),
            "picker_reasoning": result.get("picker_reasoning"),
            "hero_image": result.get("hero_image"),
            "hero_image_landscape": result.get("hero_image_landscape"),
            "thumbnail_image": result.get("thumbnail_image"),
            "thumbnail_image_landscape": result.get("thumbnail_image_landscape"),
            "thumbnail_image_square": result.get("thumbnail_image_square"),
        },
    )
    print(
        f"[finisher done] story_id={story_id} +${extra_cents / 100:.2f}"
    )
    store.set_finisher_status(job_id, "done")

    # Full Pipeline auto-publish handoff. The worker used to do this
    # inline after finish_story_job; with stage-split it must happen
    # HERE so the auto-publish drain only sees rows that have a
    # working hero+thumbnail. Reading from `claimed` is safe because
    # full_pipeline is set at enqueue and never mutates.
    if claimed.get("full_pipeline"):
        store.request_story_job_auto_publish(job_id)
        print(
            f"[finisher auto-publish-requested] job={job_id} "
            f"reddit_id={reddit_id} story_id={story_id}"
        )
        store.log_story_job_event(
            job_id, reddit_id, "auto_publish_requested",
            message="Full Pipeline opt-in: auto-publish queued for TS drain",
            payload={"story_id": story_id},
        )


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
        err_msg = f"{type(e).__name__}: {e}"
        store.fail_story_job(job_id, err_msg)
        # Leave the source row in 'queued' so a future Process re-pick is
        # possible without an admin "Reset" affordance.
        store.set_reddit_source_status(reddit_id, "queued")
        print(f"[story-jobs error] job={job_id} {err_msg}")
        store.log_story_job_event(
            job_id, reddit_id, "failed",
            level="error",
            message=err_msg[:200],
            payload={"exc_type": type(e).__name__},
        )
        return True

    story_id = result_row.get("id") if isinstance(result_row, dict) else None
    if not story_id:
        store.fail_story_job(job_id, "process returned no story id")
        store.set_reddit_source_status(reddit_id, "queued")
        print(f"[story-jobs error] job={job_id} no story id returned")
        store.log_story_job_event(
            job_id, reddit_id, "failed",
            level="error",
            message="Process returned no story id",
        )
        return True

    store.finish_story_job(job_id, story_id)
    store.set_reddit_source_status(reddit_id, "used", story_id=story_id)
    print(
        f"[story-jobs done] job={job_id} reddit_id={reddit_id} "
        f"story_id={story_id}"
    )
    store.log_story_job_event(
        job_id, reddit_id, "finished",
        message=f"Done. Story: {story_id}",
        payload={"story_id": story_id},
    )
    # 2026-06-24 Full Pipeline auto-publish handoff. The stage-split
    # moved this for with_media=True jobs into `run_finisher_for_job`
    # (the cron) because we want the auto-publish to fire ONLY after
    # the hero+thumbnail are in place — otherwise the publish gate
    # would reject for missing visuals. For with_media=False jobs
    # there's no finisher, so the worker still arms auto-publish here
    # directly.
    with_media = bool(claimed.get("with_media", 1))
    if claimed.get("full_pipeline") and not with_media:
        store.request_story_job_auto_publish(job_id)
        print(
            f"[story-jobs auto-publish-requested] job={job_id} "
            f"reddit_id={reddit_id} story_id={story_id}"
        )
        store.log_story_job_event(
            job_id, reddit_id, "auto_publish_requested",
            message="Full Pipeline opt-in: auto-publish queued (no media path)",
            payload={"story_id": story_id},
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
