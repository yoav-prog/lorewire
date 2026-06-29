"""Tests for the story_jobs_worker -> short -> finisher orchestration.

Covers the parts of `pipeline.story_jobs_worker` that the 2026-06-19 plan
added or changed: _wait_for_short_done's polling + timeout behaviour, and
_run_short_and_finisher's success / cap-hit / short-failed / setup-failed
branches.

The wider _default_process pipeline (idea, research, article, media,
video enqueue) is already covered by test_story_jobs.py; here we focus
on the new orchestration only.

Plan: _plans/2026-06-19-reddit-source-auto-deliver-article-short-hero-thumbnail.md.
"""
from __future__ import annotations

import unittest
from unittest import mock

from pipeline import story_jobs_worker


def _patch_event_logger(stack: unittest.TestCase) -> mock.MagicMock:
    """Stub out store.log_story_job_event so tests don't touch the DB
    and can assert on which timeline events the worker emitted."""
    patcher = mock.patch.object(story_jobs_worker.store, "log_story_job_event")
    m = patcher.start()
    stack.addCleanup(patcher.stop)
    return m


class WaitForShortDoneTests(unittest.TestCase):
    """`_wait_for_short_done` polls latest_short_render_for_story until a
    terminal status or the ceiling fires. Injected sleeper + clock so the
    test runs in microseconds."""

    def _run_with_status_sequence(
        self, statuses: list[str | None], *, ceiling: int = 60,
    ) -> str:
        """Drive the loop through `statuses` one poll at a time, return
        the final status. Each `None` simulates the short row not existing
        yet, each string is the short's status at that poll."""
        log = _patch_event_logger(self)
        ticks = {"now": 0.0}
        sleeps: list[float] = []

        def fake_sleep(secs: float) -> None:
            sleeps.append(secs)
            ticks["now"] += secs

        def fake_now() -> float:
            return ticks["now"]

        rows = iter(
            None if s is None else {"status": s}
            for s in statuses
        )
        with mock.patch.object(
            story_jobs_worker.store, "latest_short_render_for_story",
            side_effect=lambda story_id: next(rows),
        ), mock.patch.object(
            story_jobs_worker.store, "get_setting",
            return_value=str(ceiling),
        ):
            return story_jobs_worker._wait_for_short_done(
                "story1", "job1", "r1",
                sleeper=fake_sleep, now=fake_now,
            )

    def test_returns_done_immediately_when_short_already_done(self):
        result = self._run_with_status_sequence(["done"])
        self.assertEqual(result, "done")

    def test_polls_through_queued_and_rendering_until_done(self):
        result = self._run_with_status_sequence(
            ["queued", "rendering", "rendering", "done"],
        )
        self.assertEqual(result, "done")

    def test_returns_failed_on_terminal_failed(self):
        result = self._run_with_status_sequence(["rendering", "failed"])
        self.assertEqual(result, "failed")

    def test_returns_cancelled_on_terminal_cancelled(self):
        result = self._run_with_status_sequence(["queued", "cancelled"])
        self.assertEqual(result, "cancelled")

    def test_returns_timeout_when_ceiling_hits(self):
        # 3 + 5 + 10 + 10 ... > 20 ceiling, so 4 polls in.
        result = self._run_with_status_sequence(
            ["queued"] * 50, ceiling=20,
        )
        self.assertEqual(result, "timeout")

    def test_handles_missing_row_then_appears(self):
        result = self._run_with_status_sequence(
            [None, None, "queued", "done"],
        )
        self.assertEqual(result, "done")


class EnqueueShortAndMarkFinisherPendingTests(unittest.TestCase):
    """2026-06-24 stage-split: the worker now enqueues the short and
    returns IMMEDIATELY after marking finisher_status='pending'. The
    inline-wait + finisher block moved to `run_finisher_for_job` which a
    separate Vercel cron drives. Tests pin the new shape so a future
    refactor can't silently re-introduce the 800s-timeout path."""

    ROW = {
        "id": "story1",
        "category": "Drama",
        "cost_cents": 12,
    }

    def setUp(self) -> None:
        self._log = _patch_event_logger(self)
        p_enqueue = mock.patch(
            "pipeline.shorts_auto.maybe_enqueue_short_for_story",
            return_value=True,
        )
        self.mock_enqueue = p_enqueue.start()
        self.addCleanup(p_enqueue.stop)
        p_mark = mock.patch.object(
            story_jobs_worker.store, "mark_finisher_pending",
        )
        self.mock_mark = p_mark.start()
        self.addCleanup(p_mark.stop)
        # Anything from the OLD inline path must not be touched. Patch
        # the wait + finisher + upsert + cost helpers so a regression
        # that re-introduces the old call shape is asserted out.
        p_wait = mock.patch.object(story_jobs_worker, "_wait_for_short_done")
        self.mock_wait = p_wait.start()
        self.addCleanup(p_wait.stop)
        p_finisher = mock.patch.object(
            story_jobs_worker.media,
            "generate_hero_and_thumbnail_from_short",
        )
        self.mock_finisher = p_finisher.start()
        self.addCleanup(p_finisher.stop)

    def test_force_true_passed_to_enqueue(self):
        story_jobs_worker._enqueue_short_and_mark_finisher_pending(
            dict(self.ROW), "job1", "r1",
        )
        self.mock_enqueue.assert_called_once()
        kwargs = self.mock_enqueue.call_args.kwargs
        self.assertTrue(kwargs["force"])
        self.assertEqual(kwargs["requested_by"], "story_job")

    def test_happy_path_marks_finisher_pending_and_returns(self):
        story_jobs_worker._enqueue_short_and_mark_finisher_pending(
            dict(self.ROW), "job1", "r1",
        )
        # NEW shape: enqueue + mark_finisher_pending, NOTHING ELSE.
        self.mock_mark.assert_called_once_with("job1")
        # OLD path must stay quiet.
        self.mock_wait.assert_not_called()
        self.mock_finisher.assert_not_called()
        events = [c.args[2] for c in self._log.call_args_list]
        self.assertIn("short_enqueued_for_story", events)

    def test_cap_hit_does_not_mark_finisher_pending(self):
        # enqueue returns False = global 24h cap hit. There's no short
        # for the finisher to wait on, so the flag stays NULL.
        self.mock_enqueue.return_value = False
        story_jobs_worker._enqueue_short_and_mark_finisher_pending(
            dict(self.ROW), "job1", "r1",
        )
        self.mock_mark.assert_not_called()
        events = [c.args[2] for c in self._log.call_args_list]
        self.assertIn("short_enqueue_capped", events)

    def test_enqueue_exception_is_swallowed(self):
        self.mock_enqueue.side_effect = RuntimeError("locked")
        story_jobs_worker._enqueue_short_and_mark_finisher_pending(
            dict(self.ROW), "job1", "r1",
        )
        self.mock_mark.assert_not_called()
        events = [c.args[2] for c in self._log.call_args_list]
        self.assertIn("short_enqueue_error", events)


class RunFinisherForJobTests(unittest.TestCase):
    """2026-06-24 stage-split: `run_finisher_for_job` is the body of
    work the new /api/run_hero_thumbnail_finisher cron runs after
    claiming one finisher-pending job. Covers the happy path (writes
    cost, sets finisher_status='done', chains into auto-publish for
    full-pipeline rows) and every failure mode."""

    CLAIMED = {
        "id": "job1",
        "reddit_id": "r1",
        "story_id": "story1",
        "full_pipeline": 0,
    }

    def setUp(self) -> None:
        self._log = _patch_event_logger(self)
        p_finisher = mock.patch.object(
            story_jobs_worker.media,
            "generate_hero_and_thumbnail_from_short",
            return_value={
                "hero_image": "https://gcs/hero.png",
                "hero_image_landscape": "https://gcs/hero-l.png",
                "thumbnail_image": "https://gcs/thumb.png",
                "thumbnail_image_landscape": "https://gcs/thumb-l.png",
                "thumbnail_image_square": "https://gcs/thumb-s.png",
                "cost_cents": 25,
                "hero_index": 0,
                "thumbnail_index": 3,
                "picker_reasoning": "calm vs dramatic",
            },
        )
        self.mock_finisher = p_finisher.start()
        self.addCleanup(p_finisher.stop)
        p_story = mock.patch.object(
            story_jobs_worker.store, "fetch_story",
            return_value={"id": "story1", "cost_cents": 12},
        )
        self.mock_fetch = p_story.start()
        self.addCleanup(p_story.stop)
        p_cost = mock.patch.object(
            story_jobs_worker.store, "update_story_cost_cents",
        )
        self.mock_cost = p_cost.start()
        self.addCleanup(p_cost.stop)
        p_status = mock.patch.object(
            story_jobs_worker.store, "set_finisher_status",
        )
        self.mock_status = p_status.start()
        self.addCleanup(p_status.stop)
        p_autopub = mock.patch.object(
            story_jobs_worker.store, "request_story_job_auto_publish",
        )
        self.mock_autopub = p_autopub.start()
        self.addCleanup(p_autopub.stop)

    def test_happy_path_writes_cost_and_marks_done(self):
        story_jobs_worker.run_finisher_for_job(dict(self.CLAIMED))
        self.mock_finisher.assert_called_once_with("story1", story_jobs_worker.REPO_ROOT)
        # Existing story's cost (12) plus the finisher's i2i spend (25).
        self.mock_cost.assert_called_once_with("story1", 12 + 25)
        self.mock_status.assert_called_once_with("job1", "done")
        # Not Full-Pipeline-armed → no auto-publish call.
        self.mock_autopub.assert_not_called()
        events = [c.args[2] for c in self._log.call_args_list]
        self.assertIn("hero_thumbnail_built", events)

    def test_full_pipeline_armed_requests_auto_publish(self):
        claimed = dict(self.CLAIMED, full_pipeline=1)
        story_jobs_worker.run_finisher_for_job(claimed)
        # On success, the cron now arms the auto-publish drain because
        # the worker no longer does (it returned before the finisher ran).
        self.mock_autopub.assert_called_once_with("job1")
        events = [c.args[2] for c in self._log.call_args_list]
        self.assertIn("auto_publish_requested", events)

    def test_missing_story_id_marks_failed(self):
        claimed = dict(self.CLAIMED, story_id=None)
        story_jobs_worker.run_finisher_for_job(claimed)
        self.mock_finisher.assert_not_called()
        self.mock_status.assert_called_once_with("job1", "failed")
        events = [c.args[2] for c in self._log.call_args_list]
        self.assertIn("hero_thumbnail_skipped", events)

    def test_value_error_marks_failed_and_swallows(self):
        self.mock_finisher.side_effect = ValueError(
            "story story1 short render has no character_base_url",
        )
        story_jobs_worker.run_finisher_for_job(dict(self.CLAIMED))
        self.mock_status.assert_called_once_with("job1", "failed")
        events = [c.args[2] for c in self._log.call_args_list]
        self.assertIn("hero_thumbnail_skipped", events)
        # No auto-publish on a failed finisher (the auto-publish gate
        # would reject for missing visuals anyway).
        self.mock_autopub.assert_not_called()

    def test_unexpected_exception_marks_failed_and_swallows(self):
        self.mock_finisher.side_effect = RuntimeError("kie 503")
        story_jobs_worker.run_finisher_for_job(dict(self.CLAIMED))
        self.mock_status.assert_called_once_with("job1", "failed")
        events = [c.args[2] for c in self._log.call_args_list]
        self.assertIn("hero_thumbnail_error", events)
        self.mock_autopub.assert_not_called()


if __name__ == "__main__":
    unittest.main()
