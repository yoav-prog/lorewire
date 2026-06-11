"""Tests for pipeline.render_worker.

We don't actually shell out to npx remotion (that's exercised by a real
render in QA). What we guard is the queue → render → status transition:
empty queue is a no-op, success path writes finish_render, error path
writes fail_render, and exceptions inside the render function are caught
so a single bad row doesn't crash the worker loop.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import render_worker, store


class _WorkerTestCase(unittest.TestCase):
    """Same temp-SQLite plumbing as test_render_queue."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        db_path = Path(self._tmpdir.name) / "render-worker.db"
        self._db_patch = mock.patch.object(store, "DB_PATH", str(db_path))
        self._db_patch.start()
        self._env_patch = mock.patch.dict(os.environ, {}, clear=False)
        self._env_patch.start()
        os.environ.pop("DATABASE_URL", None)
        store.init()

    def tearDown(self) -> None:
        self._db_patch.stop()
        self._env_patch.stop()
        self._tmpdir.cleanup()


class TickTests(_WorkerTestCase):
    def test_empty_queue_returns_false(self):
        sentinel_called = [False]

        def render_fn(_row: dict) -> dict:
            sentinel_called[0] = True
            return {}

        self.assertFalse(render_worker.run_one_tick(render_fn=render_fn))
        # Render function must NOT be called when the queue is empty —
        # otherwise the worker is doing pointless work between polls.
        self.assertFalse(sentinel_called[0])

    def test_happy_path_marks_done_with_output_url(self):
        store.enqueue_render("r1", "story1", "hash-a")
        result = render_worker.run_one_tick(
            render_fn=lambda _row: {"video_url": "/generated/story1/video.mp4"},
        )
        self.assertTrue(result)
        row = store.get_render("r1")
        assert row is not None
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["output_url"], "/generated/story1/video.mp4")
        self.assertEqual(row["progress"], 1.0)

    def test_render_returning_empty_dict_is_a_failure(self):
        # generate_video returns {} when the underlying npx render bombed.
        # The worker should record that as an explicit error, not a
        # silent success.
        store.enqueue_render("r1", "story1", "hash-a")
        result = render_worker.run_one_tick(render_fn=lambda _row: {})
        self.assertTrue(result)
        row = store.get_render("r1")
        assert row is not None
        self.assertEqual(row["status"], "error")
        self.assertIn("no video_url", row["error"])

    def test_exception_in_render_is_caught_and_recorded(self):
        store.enqueue_render("r1", "story1", "hash-a")

        def boom(_row: dict) -> dict:
            raise RuntimeError("disk full")

        result = render_worker.run_one_tick(render_fn=boom)
        # Tick returns True because a row was *handled* — the worker
        # should keep looping past a single bad render, not give up.
        self.assertTrue(result)
        row = store.get_render("r1")
        assert row is not None
        self.assertEqual(row["status"], "error")
        self.assertIn("RuntimeError", row["error"])
        self.assertIn("disk full", row["error"])

    def test_claim_is_atomic_across_back_to_back_ticks(self):
        store.enqueue_render("r1", "story1", "hash-a")
        store.enqueue_render("r2", "story2", "hash-b")

        seen_ids: list[str] = []

        def render_fn(row: dict) -> dict:
            seen_ids.append(row["id"])
            return {"video_url": f"/generated/{row['story_id']}/video.mp4"}

        # Two ticks should process both rows in FIFO order without ever
        # double-processing.
        self.assertTrue(render_worker.run_one_tick(render_fn=render_fn))
        self.assertTrue(render_worker.run_one_tick(render_fn=render_fn))
        # Third tick: queue is now empty.
        self.assertFalse(render_worker.run_one_tick(render_fn=render_fn))
        self.assertEqual(seen_ids, ["r1", "r2"])

    def test_render_fn_receives_the_claimed_row(self):
        # The render function may want config_hash to recompute, or
        # requested_by for an audit log. Make sure the worker hands the
        # whole row through unchanged.
        store.enqueue_render(
            "r1", "story1", "hash-a", requested_by="user-xyz",
        )

        captured: dict = {}

        def render_fn(row: dict) -> dict:
            captured.update(row)
            return {"video_url": "/generated/story1/video.mp4"}

        render_worker.run_one_tick(render_fn=render_fn)
        self.assertEqual(captured["id"], "r1")
        self.assertEqual(captured["story_id"], "story1")
        self.assertEqual(captured["config_hash"], "hash-a")
        self.assertEqual(captured["requested_by"], "user-xyz")
        # Claim flipped the row's status before the render fn saw it.
        self.assertEqual(captured["status"], "rendering")


if __name__ == "__main__":
    unittest.main()
