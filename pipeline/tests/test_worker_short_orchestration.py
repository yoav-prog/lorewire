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


class RunShortAndFinisherTests(unittest.TestCase):
    """`_run_short_and_finisher` is the new finisher orchestrator the
    Reddit-source story-jobs worker calls per row. Tests every branch:
    enqueue + wait + finisher success, cap-hit, short-failed, setup-failed.

    All store-touching helpers are stubbed so the test runs without the
    pipeline DB or any network. The finisher itself is mocked; its
    contract is covered by test_hero_thumbnail_from_short.py."""

    ROW = {
        "id": "story1",
        "category": "Drama",
        "cost_cents": 12,
    }

    def setUp(self) -> None:
        self._log = _patch_event_logger(self)
        # `_run_short_and_finisher` imports shorts_auto lazily, so we
        # patch the module-level name.
        p_enqueue = mock.patch(
            "pipeline.shorts_auto.maybe_enqueue_short_for_story",
            return_value=True,
        )
        self.mock_enqueue = p_enqueue.start()
        self.addCleanup(p_enqueue.stop)
        p_wait = mock.patch.object(
            story_jobs_worker, "_wait_for_short_done", return_value="done",
        )
        self.mock_wait = p_wait.start()
        self.addCleanup(p_wait.stop)
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
        p_upsert = mock.patch.object(story_jobs_worker.store, "upsert_story")
        self.mock_upsert = p_upsert.start()
        self.addCleanup(p_upsert.stop)

    def test_force_true_passed_to_enqueue(self):
        row = dict(self.ROW)
        story_jobs_worker._run_short_and_finisher(row, "job1", "r1")
        self.mock_enqueue.assert_called_once()
        kwargs = self.mock_enqueue.call_args.kwargs
        self.assertTrue(kwargs["force"])
        self.assertEqual(kwargs["requested_by"], "story_job")

    def test_happy_path_runs_finisher_and_updates_row(self):
        row = dict(self.ROW)
        story_jobs_worker._run_short_and_finisher(row, "job1", "r1")
        self.mock_finisher.assert_called_once_with("story1", story_jobs_worker.REPO_ROOT)
        # Cost is incremented by the finisher's spend.
        self.assertEqual(row["cost_cents"], 12 + 25)
        # All five image URLs land on the row dict for downstream consumers.
        self.assertEqual(row["hero_image"], "https://gcs/hero.png")
        self.assertEqual(row["thumbnail_image_square"], "https://gcs/thumb-s.png")
        # The row is upserted once more to capture the URLs + cost.
        self.mock_upsert.assert_called_once_with(row)
        # Timeline event with the build metadata.
        events = [c.args[2] for c in self._log.call_args_list]
        self.assertIn("hero_thumbnail_built", events)

    def test_cap_hit_skips_wait_and_finisher(self):
        # enqueue returns False = global 24h cap hit.
        self.mock_enqueue.return_value = False
        row = dict(self.ROW)
        story_jobs_worker._run_short_and_finisher(row, "job1", "r1")
        self.mock_wait.assert_not_called()
        self.mock_finisher.assert_not_called()
        self.mock_upsert.assert_not_called()
        # Row's cost untouched.
        self.assertEqual(row["cost_cents"], 12)
        events = [c.args[2] for c in self._log.call_args_list]
        self.assertIn("short_enqueue_capped", events)

    def test_short_failed_skips_finisher(self):
        self.mock_wait.return_value = "failed"
        row = dict(self.ROW)
        story_jobs_worker._run_short_and_finisher(row, "job1", "r1")
        self.mock_finisher.assert_not_called()
        self.mock_upsert.assert_not_called()
        events = [c.args[2] for c in self._log.call_args_list]
        self.assertIn("hero_thumbnail_skipped", events)
        # Failed level escalates to error so the admin sees it red.
        skip_call = next(
            c for c in self._log.call_args_list
            if c.args[2] == "hero_thumbnail_skipped"
        )
        self.assertEqual(skip_call.kwargs.get("level"), "error")

    def test_short_timeout_skips_finisher_at_warn_level(self):
        self.mock_wait.return_value = "timeout"
        row = dict(self.ROW)
        story_jobs_worker._run_short_and_finisher(row, "job1", "r1")
        self.mock_finisher.assert_not_called()
        skip_call = next(
            c for c in self._log.call_args_list
            if c.args[2] == "hero_thumbnail_skipped"
        )
        self.assertEqual(skip_call.kwargs.get("level"), "warn")

    def test_finisher_value_error_logs_and_continues(self):
        # Setup failure (e.g. props missing character_base_url) — finisher
        # raises ValueError. Worker MUST swallow it; the story still ships.
        self.mock_finisher.side_effect = ValueError(
            "story story1 short render has no character_base_url",
        )
        row = dict(self.ROW)
        story_jobs_worker._run_short_and_finisher(row, "job1", "r1")
        self.mock_upsert.assert_not_called()
        events = [c.args[2] for c in self._log.call_args_list]
        self.assertIn("hero_thumbnail_skipped", events)

    def test_finisher_unexpected_exception_is_swallowed(self):
        # Any non-ValueError raised by the finisher must NOT take down the
        # story job. The article and the short are already in the DB; we
        # surface an error event and let the worker mark the job done.
        self.mock_finisher.side_effect = RuntimeError("kie 503")
        row = dict(self.ROW)
        story_jobs_worker._run_short_and_finisher(row, "job1", "r1")
        events = [c.args[2] for c in self._log.call_args_list]
        self.assertIn("hero_thumbnail_error", events)
        self.mock_upsert.assert_not_called()

    def test_enqueue_exception_is_swallowed(self):
        # If shorts_auto itself raises (rare but possible — e.g. DB
        # contention), the worker must NOT crash. The article is the
        # primary deliverable.
        self.mock_enqueue.side_effect = RuntimeError("locked")
        row = dict(self.ROW)
        story_jobs_worker._run_short_and_finisher(row, "job1", "r1")
        self.mock_wait.assert_not_called()
        self.mock_finisher.assert_not_called()
        events = [c.args[2] for c in self._log.call_args_list]
        self.assertIn("short_enqueue_error", events)


if __name__ == "__main__":
    unittest.main()
