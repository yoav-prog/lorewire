"""Tests for the story_jobs Vercel drain handler.

Mirrors test_drain_image_renders.py — auth, max-rows env, idle, drain,
failure-continue, max-rows cap. The drain composes
story_jobs_worker.run_one_tick so the per-row error path is already
covered by test_story_jobs.WorkerTickTests; here we exercise the HTTP
wrapper + the per-tick budget + the advisory-lock path.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from importlib import reload
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DRAIN_DIR = REPO_ROOT / "lorewire-app" / "api"
if str(DRAIN_DIR) not in sys.path:
    sys.path.insert(0, str(DRAIN_DIR))

# Imported here so the sys.path insert is in effect before the module
# resolves `from pipeline import ...` via the local pipeline pkg.
import drain_story_jobs as drain  # noqa: E402


class _DrainTestCase(unittest.TestCase):
    """Per-test isolated SQLite. We reload config + store after env
    patching so the cached module-level DB_PATH picks up the override
    — same pattern as test_story_jobs._IsolatedDB."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self._db_path = Path(self._tmpdir.name) / "drain.db"
        self._env_patch = mock.patch.dict(os.environ, {
            "PIPELINE_DB": str(self._db_path),
            "DATABASE_URL": "",
        }, clear=False)
        self._env_patch.start()
        from pipeline import config, store
        reload(config)
        reload(store)
        store.init()
        self.store = store

    def tearDown(self) -> None:
        self._env_patch.stop()
        self._tmpdir.cleanup()
        from pipeline import config, store
        reload(config)
        reload(store)

    def _seed_source(self, reddit_id: str) -> None:
        self.store.upsert_reddit_source({
            "reddit_id": reddit_id,
            "subreddit": "AITAH",
            "date_written": "2026-01-01T00:00:00+00:00",
            "title": "T",
            "full_text": "F",
            "comments": 1,
            "url": None,
            "summary": None,
            "length_chars": 1,
            "status": "imported",
            "story_id": None,
            "notes": None,
            "first_synced": "2026-06-14T00:00:00+00:00",
            "last_synced": "2026-06-14T00:00:00+00:00",
        })

    def _enqueue(self, job_id: str, reddit_id: str) -> None:
        self._seed_source(reddit_id)
        self.store.enqueue_story_job(job_id, reddit_id)


class AuthTests(_DrainTestCase):
    def test_missing_cron_secret_rejects_everything(self):
        os.environ.pop("CRON_SECRET", None)
        self.assertFalse(drain._is_authorized("Bearer anything"))
        self.assertFalse(drain._is_authorized(None))

    def test_missing_header_rejects_when_secret_set(self):
        os.environ["CRON_SECRET"] = "abc"
        self.assertFalse(drain._is_authorized(None))
        self.assertFalse(drain._is_authorized(""))

    def test_wrong_token_rejects(self):
        os.environ["CRON_SECRET"] = "abc"
        self.assertFalse(drain._is_authorized("Bearer wrong"))
        # Bare token without "Bearer " prefix is also rejected — matches
        # the image_renders drain's contract.
        self.assertFalse(drain._is_authorized("abc"))

    def test_right_token_accepts(self):
        os.environ["CRON_SECRET"] = "abc"
        self.assertTrue(drain._is_authorized("Bearer abc"))


class MaxRowsTests(_DrainTestCase):
    def test_default_when_unset(self):
        os.environ.pop("DRAIN_STORY_JOBS_MAX_ROWS_PER_TICK", None)
        self.assertEqual(drain._max_rows_per_tick(), drain.DEFAULT_MAX_ROWS)

    def test_override_via_env(self):
        os.environ["DRAIN_STORY_JOBS_MAX_ROWS_PER_TICK"] = "5"
        try:
            self.assertEqual(drain._max_rows_per_tick(), 5)
        finally:
            os.environ.pop("DRAIN_STORY_JOBS_MAX_ROWS_PER_TICK", None)

    def test_invalid_falls_back_to_default(self):
        os.environ["DRAIN_STORY_JOBS_MAX_ROWS_PER_TICK"] = "not-a-number"
        try:
            self.assertEqual(drain._max_rows_per_tick(), drain.DEFAULT_MAX_ROWS)
        finally:
            os.environ.pop("DRAIN_STORY_JOBS_MAX_ROWS_PER_TICK", None)

    def test_clamped_to_safe_range(self):
        os.environ["DRAIN_STORY_JOBS_MAX_ROWS_PER_TICK"] = "9999"
        try:
            self.assertEqual(drain._max_rows_per_tick(), 20)
            os.environ["DRAIN_STORY_JOBS_MAX_ROWS_PER_TICK"] = "0"
            self.assertEqual(drain._max_rows_per_tick(), 1)
        finally:
            os.environ.pop("DRAIN_STORY_JOBS_MAX_ROWS_PER_TICK", None)


class RunDrainTests(_DrainTestCase):
    def test_idle_when_queue_empty(self):
        body = drain.run_drain()
        self.assertEqual(body["drained"], 0)
        self.assertEqual(body["remaining"], 0)

    def test_drains_a_queued_row(self):
        from pipeline import story_jobs_worker
        self._enqueue("job-1", "abc")

        def stub_process(job, row):
            return {"id": "abc"}

        with mock.patch.object(
            story_jobs_worker, "_default_process", side_effect=stub_process,
        ):
            body = drain.run_drain()

        self.assertEqual(body["drained"], 1)
        self.assertEqual(body["remaining"], 0)
        job = self.store.get_story_job("job-1")
        self.assertEqual(job["status"], "done")
        self.assertEqual(job["story_id"], "abc")

    def test_failure_marks_row_error_and_continues(self):
        """Two rows; first one bombs, second one succeeds. The drain
        composes run_one_tick which already does per-row try/except —
        we're verifying the composition preserves that contract."""
        from pipeline import story_jobs_worker
        self._enqueue("job-bad", "rid-bad")
        self._enqueue("job-good", "rid-good")

        def stub_process(job, row):
            if job["id"] == "job-bad":
                raise RuntimeError("kie boom")
            return {"id": row["reddit_id"]}

        with mock.patch.object(
            story_jobs_worker, "_default_process", side_effect=stub_process,
        ):
            body = drain.run_drain()

        self.assertEqual(body["drained"], 2)
        bad = self.store.get_story_job("job-bad")
        good = self.store.get_story_job("job-good")
        self.assertEqual(bad["status"], "error")
        self.assertIn("kie boom", bad["error"])
        self.assertEqual(good["status"], "done")

    def test_max_rows_per_tick_caps_the_loop(self):
        """Enqueue more than the cap; drain stops at the cap and leaves
        the rest queued for the next tick."""
        from pipeline import story_jobs_worker
        for i in range(5):
            self._enqueue(f"j{i}", f"rid-{i}")
        os.environ["DRAIN_STORY_JOBS_MAX_ROWS_PER_TICK"] = "2"
        try:
            def stub_process(job, row):
                return {"id": row["reddit_id"]}

            with mock.patch.object(
                story_jobs_worker, "_default_process", side_effect=stub_process,
            ):
                body = drain.run_drain()
        finally:
            os.environ.pop("DRAIN_STORY_JOBS_MAX_ROWS_PER_TICK", None)

        self.assertEqual(body["drained"], 2)
        self.assertEqual(body["remaining"], 3)

    def test_budget_block_stops_the_tick_early(self):
        """A blocked budget gate makes run_one_tick return False on
        every call. The drain treats that the same as an empty queue —
        breaks out of the loop, returns drained=0, remaining=N."""
        from pipeline import story_jobs_worker
        for i in range(3):
            self._enqueue(f"j{i}", f"rid-{i}")
        # Cap of 1 cent — projected spend = 3 active × 50c = 150c. Next
        # job would push to 200c, way over.
        self.store.set_setting(
            story_jobs_worker.DAILY_BUDGET_CAP_SETTING_KEY, "1",
        )

        body = drain.run_drain()
        self.assertEqual(body["drained"], 0)
        self.assertEqual(body["remaining"], 3)
        # All jobs still queued (worker didn't claim any).
        for i in range(3):
            job = self.store.get_story_job(f"j{i}")
            self.assertEqual(job["status"], "queued")


if __name__ == "__main__":
    unittest.main()
