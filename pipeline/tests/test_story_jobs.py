"""Tests for the story_jobs queue: store helpers + worker tick paths.

The worker's process_fn is the real pipeline (LLM + kie + voice + video);
we don't exercise it here. Tests inject a stub that returns a synthetic
story row, so the claim → finish / claim → fail paths are covered without
burning real credits.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from importlib import reload
from pathlib import Path
from unittest import mock


class _IsolatedDB(unittest.TestCase):
    def setUp(self):
        # ignore_cleanup_errors: matches the codebase convention for
        # tempdir + sqlite on Windows.
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db_path = Path(self.tmpdir.name) / "test.db"
        self._patch = mock.patch.dict(os.environ, {
            "PIPELINE_DB": str(self.db_path),
            "DATABASE_URL": "",
        }, clear=False)
        self._patch.start()
        from pipeline import config, store
        reload(config)
        reload(store)
        store.init()
        self.store = store

    def tearDown(self):
        self._patch.stop()
        self.tmpdir.cleanup()
        from pipeline import config, store
        reload(config)
        reload(store)


def _seed_reddit_source(store_mod, reddit_id: str = "abc"):
    store_mod.upsert_reddit_source({
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


class EnqueueTests(_IsolatedDB):
    def test_first_enqueue_inserts_row(self):
        _seed_reddit_source(self.store)
        row = self.store.enqueue_story_job("job-1", "abc")
        self.assertIsNotNone(row)
        self.assertEqual(row["status"], "queued")
        self.assertEqual(row["reddit_id"], "abc")
        self.assertEqual(row["with_media"], 1)

    def test_second_enqueue_is_noop_while_active(self):
        _seed_reddit_source(self.store)
        first = self.store.enqueue_story_job("job-1", "abc")
        second = self.store.enqueue_story_job("job-2", "abc")
        self.assertIsNotNone(first)
        self.assertIsNone(second, "duplicate enqueue should no-op")

    def test_enqueue_after_done_is_allowed(self):
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        # Worker claims and finishes.
        claimed = self.store.claim_next_story_job()
        self.store.finish_story_job(claimed["id"], "story-1")
        # A re-process attempt is allowed (previous job is done, not active).
        second = self.store.enqueue_story_job("job-2", "abc")
        self.assertIsNotNone(second)

    def test_with_media_flag_round_trips(self):
        _seed_reddit_source(self.store)
        row = self.store.enqueue_story_job("job-1", "abc", with_media=False)
        self.assertEqual(row["with_media"], 0)
        # DB-side too.
        claimed = self.store.claim_next_story_job()
        self.assertEqual(claimed["with_media"], 0)


class ClaimAndTransitionTests(_IsolatedDB):
    def test_claim_returns_none_on_empty(self):
        self.assertIsNone(self.store.claim_next_story_job())

    def test_claim_flips_status_and_sets_started_at(self):
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        claimed = self.store.claim_next_story_job()
        self.assertEqual(claimed["status"], "processing")
        self.assertIsNotNone(claimed["started_at"])

    def test_claim_does_not_re_claim(self):
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        a = self.store.claim_next_story_job()
        b = self.store.claim_next_story_job()
        self.assertIsNotNone(a)
        self.assertIsNone(b, "second claim on same row should return None")

    def test_finish_marks_done(self):
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        claimed = self.store.claim_next_story_job()
        self.store.finish_story_job(claimed["id"], "story-1")
        row = self.store.get_story_job(claimed["id"])
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["story_id"], "story-1")
        self.assertEqual(row["progress"], 100)
        self.assertIsNotNone(row["finished_at"])

    def test_fail_marks_error_with_message(self):
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        claimed = self.store.claim_next_story_job()
        self.store.fail_story_job(claimed["id"], "kie down")
        row = self.store.get_story_job(claimed["id"])
        self.assertEqual(row["status"], "error")
        self.assertEqual(row["error"], "kie down")
        self.assertIsNotNone(row["finished_at"])

    def test_finish_after_cancellation_is_noop(self):
        # We don't have a cancellation surface yet, but the conditional
        # UPDATE in finish_story_job guards against future cancel paths
        # the same way finish_image_render does. Force the row out of
        # 'processing' to simulate cancellation.
        _seed_reddit_source(self.store)
        self.store.enqueue_story_job("job-1", "abc")
        claimed = self.store.claim_next_story_job()
        # Bypass status helpers to force 'cancelled' shape.
        import sqlite3
        with sqlite3.connect(self.store.DB_PATH) as c:
            c.execute(
                "UPDATE story_jobs SET status='cancelled' WHERE id=?",
                (claimed["id"],),
            )
        self.store.finish_story_job(claimed["id"], "story-1")
        row = self.store.get_story_job(claimed["id"])
        self.assertEqual(row["status"], "cancelled", "cancelled wins over done")

    def test_latest_for_reddit_returns_newest(self):
        _seed_reddit_source(self.store, "x")
        self.store.enqueue_story_job("j1", "x")
        claimed = self.store.claim_next_story_job()
        self.store.fail_story_job(claimed["id"], "first fail")
        # New attempt — slightly later requested_at via the natural clock.
        import time as _t
        _t.sleep(0.01)
        self.store.enqueue_story_job("j2", "x")
        latest = self.store.latest_story_job_for_reddit("x")
        self.assertEqual(latest["id"], "j2")
        self.assertEqual(latest["status"], "queued")

    def test_count_pending_only_counts_active(self):
        _seed_reddit_source(self.store, "a")
        _seed_reddit_source(self.store, "b")
        self.store.enqueue_story_job("j1", "a")
        self.store.enqueue_story_job("j2", "b")
        self.assertEqual(self.store.count_pending_story_jobs(), 2)
        claimed = self.store.claim_next_story_job()
        self.store.finish_story_job(claimed["id"], "s1")
        self.assertEqual(self.store.count_pending_story_jobs(), 1)


class PartialUniqueIndexTests(_IsolatedDB):
    """Phase 5: the partial unique index `idx_story_jobs_one_active`
    enforces "at most one active job per reddit_id" at the DB level.
    These tests verify both that the index actually rejects duplicates
    AND that the enqueue helper's ON CONFLICT clause turns a rejection
    into a clean no-op (instead of an exception that would crash the
    bulk-enqueue action)."""

    def test_index_rejects_raw_duplicate_insert(self):
        """Bypass the helper and insert two rows directly. The second
        must fail with a UNIQUE / IntegrityError, proving the index is
        in force. This is the load-bearing safety net — the rest of the
        defenses are convenience."""
        import sqlite3
        _seed_reddit_source(self.store, "abc")
        # Use the helper for row 1 so we get a valid shape.
        self.store.enqueue_story_job("job-1", "abc")
        # Second raw insert with status='queued' must violate the index.
        with sqlite3.connect(self.store.DB_PATH) as c:
            with self.assertRaises(sqlite3.IntegrityError):
                c.execute(
                    "INSERT INTO story_jobs "
                    "(id, reddit_id, status, progress, with_media, requested_at) "
                    "VALUES ('job-2', 'abc', 'queued', 0, 1, '2026-06-14T00:00:00+00:00')"
                )

    def test_index_allows_done_and_error_rows(self):
        """The index's WHERE is 'queued OR processing' — once a job
        settles to done or error, a new active job for the same
        reddit_id is allowed (and is exactly the re-process path)."""
        import sqlite3
        _seed_reddit_source(self.store, "abc")
        self.store.enqueue_story_job("job-1", "abc")
        claimed = self.store.claim_next_story_job()
        self.store.finish_story_job(claimed["id"], "story-1")
        # Now a fresh raw insert with status='queued' must succeed —
        # the prior 'done' row is outside the partial-index predicate.
        with sqlite3.connect(self.store.DB_PATH) as c:
            c.execute(
                "INSERT INTO story_jobs "
                "(id, reddit_id, status, progress, with_media, requested_at) "
                "VALUES ('job-2', 'abc', 'queued', 0, 1, '2026-06-14T00:00:00+00:00')"
            )
        # Sanity: the count of active jobs for 'abc' is now 1.
        with sqlite3.connect(self.store.DB_PATH) as c:
            row = c.execute(
                "SELECT count(*) FROM story_jobs WHERE reddit_id='abc' "
                "AND status IN ('queued', 'processing')"
            ).fetchone()
            self.assertEqual(row[0], 1)

    def test_enqueue_helper_returns_none_on_race_loss(self):
        """Simulate the race: bypass has_active_story_job (pretend it
        returned False for both callers) and call the INSERT path
        twice. The second call's ON CONFLICT DO NOTHING must catch
        the index rejection and return None — NOT raise."""
        _seed_reddit_source(self.store, "abc")
        # First enqueue is normal.
        first = self.store.enqueue_story_job("job-1", "abc")
        self.assertIsNotNone(first)

        # Now monkey-patch has_active_story_job to lie (return False),
        # so the second enqueue tries the INSERT path. Without ON
        # CONFLICT this would crash with IntegrityError; with it, we
        # expect a clean None.
        original = self.store.has_active_story_job
        try:
            self.store.has_active_story_job = lambda _rid: False
            second = self.store.enqueue_story_job("job-2", "abc")
            self.assertIsNone(second, "race-loser must return None, not raise")
        finally:
            self.store.has_active_story_job = original

        # And the DB still has exactly one active job for 'abc'.
        self.assertEqual(self.store.count_pending_story_jobs(), 1)


class StaleReapTests(_IsolatedDB):
    def test_reap_moves_old_processing_back_to_queued(self):
        _seed_reddit_source(self.store, "a")
        self.store.enqueue_story_job("j1", "a")
        claimed = self.store.claim_next_story_job()
        # Backdate started_at well past the stale window.
        import sqlite3
        with sqlite3.connect(self.store.DB_PATH) as c:
            c.execute(
                "UPDATE story_jobs SET started_at=? WHERE id=?",
                ("2020-01-01T00:00:00+00:00", claimed["id"]),
            )
        reaped = self.store.reap_stale_story_jobs(60)
        self.assertEqual(reaped, 1)
        row = self.store.get_story_job(claimed["id"])
        self.assertEqual(row["status"], "queued")
        self.assertIsNone(row["started_at"])

    def test_reap_leaves_fresh_in_flight_alone(self):
        _seed_reddit_source(self.store, "a")
        self.store.enqueue_story_job("j1", "a")
        self.store.claim_next_story_job()  # started_at = now
        reaped = self.store.reap_stale_story_jobs(60)
        self.assertEqual(reaped, 0)


class WorkerTickTests(_IsolatedDB):
    def test_happy_path_calls_process_and_finishes(self):
        from pipeline import story_jobs_worker
        _seed_reddit_source(self.store, "abc")
        self.store.enqueue_story_job("job-1", "abc")

        def stub_process(job, row):
            self.assertEqual(job["reddit_id"], "abc")
            self.assertEqual(row["reddit_id"], "abc")
            return {"id": "abc"}  # the stories.id matches reddit_id by convention

        ran = story_jobs_worker.run_one_tick(process_fn=stub_process)
        self.assertTrue(ran)
        row = self.store.get_story_job("job-1")
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["story_id"], "abc")
        src = self.store.fetch_reddit_source("abc")
        self.assertEqual(src["status"], "used")
        self.assertEqual(src["story_id"], "abc")

    def test_failure_records_error_and_resets_source_row(self):
        from pipeline import story_jobs_worker
        _seed_reddit_source(self.store, "abc")
        self.store.enqueue_story_job("job-1", "abc")

        def stub_process(job, row):
            raise RuntimeError("kie down")

        ran = story_jobs_worker.run_one_tick(process_fn=stub_process)
        self.assertTrue(ran)
        row = self.store.get_story_job("job-1")
        self.assertEqual(row["status"], "error")
        self.assertIn("kie down", row["error"])
        src = self.store.fetch_reddit_source("abc")
        # Source row resets to 'queued' so a future Process re-pick works.
        self.assertEqual(src["status"], "queued")

    def test_empty_queue_returns_false(self):
        from pipeline import story_jobs_worker
        ran = story_jobs_worker.run_one_tick(process_fn=lambda j, r: {"id": "x"})
        self.assertFalse(ran)

    def test_missing_source_row_fails_job_cleanly(self):
        from pipeline import story_jobs_worker
        # Enqueue a job pointing at a non-existent reddit_source row.
        # We bypass the active-check by writing the row directly.
        import sqlite3
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        with sqlite3.connect(self.store.DB_PATH) as c:
            c.execute(
                "INSERT INTO story_jobs (id, reddit_id, status, progress, "
                "with_media, requested_at) VALUES (?, ?, 'queued', 0, 1, ?)",
                ("job-1", "missing", now),
            )

        ran = story_jobs_worker.run_one_tick(
            process_fn=lambda j, r: {"id": "x"},
        )
        self.assertTrue(ran)
        row = self.store.get_story_job("job-1")
        self.assertEqual(row["status"], "error")
        self.assertIn("not found", row["error"])


class HelpersTests(_IsolatedDB):
    def test_category_for_known_subreddit(self):
        from pipeline.story_jobs_worker import _category_for
        self.assertEqual(_category_for("AmItheAsshole"), "Entitled")
        self.assertEqual(_category_for("relationships"), "Dating")

    def test_category_for_unknown_subreddit_defaults_to_drama(self):
        from pipeline.story_jobs_worker import _category_for
        self.assertEqual(_category_for("WeirdNicheNewSub"), "Drama")
        self.assertEqual(_category_for(""), "Drama")

    def test_reddit_source_to_post_shape(self):
        from pipeline.story_jobs_worker import reddit_source_to_post
        row = {
            "reddit_id": "rid",
            "subreddit": "AmItheAsshole",
            "title": "T",
            "full_text": "Body",
            "comments": 42,
            "url": "https://example",
        }
        post = reddit_source_to_post(row)
        self.assertEqual(post["id"], "rid")
        self.assertEqual(post["selftext"], "Body")
        self.assertEqual(post["num_comments"], 42)
        # Category is derived (case-insensitive lookup), not parroted.
        self.assertEqual(post["category"], "Entitled")


if __name__ == "__main__":
    unittest.main()
