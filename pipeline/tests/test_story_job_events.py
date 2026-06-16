"""Tests for pipeline.store.log_story_job_event +
list_story_job_events* — the per-row event timeline that powers the admin
StoryJobEventTimeline.

Mirrors the test pattern used by test_story_jobs.py (_IsolatedDB with a
temp SQLite + reload pipeline modules). The TS-side helpers in
lib/story-jobs.ts are tested separately under
src/lib/story-jobs-events.test.ts.

Plan: _plans/2026-06-16-story-job-event-timeline.md.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from importlib import reload
from pathlib import Path
from unittest import mock


class _IsolatedDB(unittest.TestCase):
    def setUp(self):
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


class LogAndReadTests(_IsolatedDB):
    def test_single_event_round_trips(self):
        self.store.log_story_job_event(
            "job-1", "abc", "claimed",
            message="Worker claimed",
            payload={"with_media": True, "subreddit": "AITAH"},
        )
        rows = self.store.list_story_job_events("job-1")
        self.assertEqual(len(rows), 1)
        ev = rows[0]
        self.assertEqual(ev["job_id"], "job-1")
        self.assertEqual(ev["reddit_id"], "abc")
        self.assertEqual(ev["event"], "claimed")
        self.assertEqual(ev["message"], "Worker claimed")
        self.assertEqual(ev["level"], "info")
        self.assertEqual(json.loads(ev["payload"]), {
            "with_media": True, "subreddit": "AITAH",
        })

    def test_level_defaults_to_info(self):
        self.store.log_story_job_event("job-1", "abc", "claimed")
        rows = self.store.list_story_job_events("job-1")
        self.assertEqual(rows[0]["level"], "info")

    def test_level_warn_and_error_persist(self):
        self.store.log_story_job_event(
            "job-1", "abc", "auto_short_error",
            level="warn", message="skipped",
        )
        self.store.log_story_job_event(
            "job-1", "abc", "failed", level="error", message="boom",
        )
        rows = self.store.list_story_job_events("job-1")
        levels = [r["level"] for r in rows]
        self.assertIn("warn", levels)
        self.assertIn("error", levels)

    def test_events_are_ordered_oldest_first(self):
        # Same job, several events. Order must be insertion order via the
        # ts ASC, id ASC composite key.
        for i, event in enumerate(["claimed", "idea_done", "finished"]):
            self.store.log_story_job_event(
                "job-1", "abc", event,
                message=f"step {i}",
            )
        rows = self.store.list_story_job_events("job-1")
        events = [r["event"] for r in rows]
        self.assertEqual(events, ["claimed", "idea_done", "finished"])

    def test_list_for_reddit_returns_only_matching_rows(self):
        self.store.log_story_job_event("job-1", "abc", "claimed")
        self.store.log_story_job_event("job-2", "xyz", "claimed")
        rows_abc = self.store.list_story_job_events_for_reddit("abc")
        rows_xyz = self.store.list_story_job_events_for_reddit("xyz")
        self.assertEqual(len(rows_abc), 1)
        self.assertEqual(rows_abc[0]["job_id"], "job-1")
        self.assertEqual(len(rows_xyz), 1)
        self.assertEqual(rows_xyz[0]["job_id"], "job-2")

    def test_list_returns_empty_for_unknown_job(self):
        self.assertEqual(self.store.list_story_job_events("never-ran"), [])
        self.assertEqual(self.store.list_story_job_events_for_reddit("unknown"), [])

    def test_payload_is_optional(self):
        self.store.log_story_job_event("job-1", "abc", "claimed")
        ev = self.store.list_story_job_events("job-1")[0]
        self.assertIsNone(ev["payload"])

    def test_message_capped_at_2k(self):
        long_msg = "x" * 5000
        self.store.log_story_job_event("job-1", "abc", "info", message=long_msg)
        ev = self.store.list_story_job_events("job-1")[0]
        self.assertLessEqual(len(ev["message"]), 2000)

    def test_oversize_payload_truncated_marker(self):
        # An accidental 10KB payload would burn storage in a hot worker
        # loop. The helper truncates and writes a {"truncated": true} marker
        # so the timeline UI can show the row but not the bloat.
        big_payload = {"data": "x" * 20000}
        self.store.log_story_job_event(
            "job-1", "abc", "media_done", payload=big_payload,
        )
        ev = self.store.list_story_job_events("job-1")[0]
        parsed = json.loads(ev["payload"])
        self.assertTrue(parsed.get("truncated"))
        self.assertGreater(parsed.get("size", 0), 2000)


class FailureSafetyTests(_IsolatedDB):
    def test_log_never_raises_even_when_table_missing(self):
        # Drop the events table to simulate a botched migration. The helper
        # must catch + swallow; the worker's main path keeps going.
        import sqlite3
        with sqlite3.connect(str(self.db_path)) as c:
            c.execute("DROP TABLE story_job_events")
            c.commit()

        # Should not raise.
        self.store.log_story_job_event("job-1", "abc", "claimed")

        # Sanity: the original list_story_job_events call WOULD raise on the
        # missing table; that's expected (the read path is not in the worker
        # hot loop). We only guarantee the write path is safe.
        with self.assertRaises(sqlite3.OperationalError):
            self.store.list_story_job_events("job-1")


if __name__ == "__main__":
    unittest.main()
