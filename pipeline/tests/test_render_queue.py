"""Tests for the video_renders queue helpers in pipeline.store.

These are the load-bearing functions the pipeline/render_worker.py uses to
pick work off the queue safely. The render itself is not exercised (npx
remotion render is integration-tested elsewhere) — what matters here is
that claim semantics, idempotency, and status transitions hold under the
shapes the Next admin sends.

Uses a per-test temp SQLite file with DB_PATH monkey-patched so the real
pipeline DB at pipeline/lorewire.db is never touched.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import store


class _QueueTestCase(unittest.TestCase):
    """Shared setup: temp SQLite, schema initialised, env clean of
    DATABASE_URL so the SQLite path is taken."""

    def setUp(self) -> None:
        # ignore_cleanup_errors: Windows holds the sqlite3 file handle past
        # the test body even after the connection is GC'd, so the
        # TemporaryDirectory finalizer occasionally races and crashes on
        # tearDown. The temp dir lands in the OS's tmp anyway — let it
        # clean up later.
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        db_path = Path(self._tmpdir.name) / "render-queue.db"
        # Patch both the module-level constant and the env so neither path
        # accidentally reads the production DB during a test run.
        self._db_patch = mock.patch.object(store, "DB_PATH", str(db_path))
        self._db_patch.start()
        # Make sure the Postgres branch is never taken even if a stray
        # DATABASE_URL is set in the host env.
        self._env_patch = mock.patch.dict(os.environ, {}, clear=False)
        self._env_patch.start()
        os.environ.pop("DATABASE_URL", None)
        store.init()

    def tearDown(self) -> None:
        self._db_patch.stop()
        self._env_patch.stop()
        self._tmpdir.cleanup()


class EnqueueTests(_QueueTestCase):
    def test_enqueue_creates_queued_row(self):
        row = store.enqueue_render(
            "r1", "story1", "hash-abc", requested_by="user1",
        )
        self.assertEqual(row["status"], "queued")
        self.assertEqual(row["progress"], 0)
        self.assertIsNone(row["started_at"])
        self.assertIsNotNone(row["requested_at"])

    def test_enqueue_is_idempotent_on_story_plus_hash(self):
        first = store.enqueue_render("r1", "story1", "hash-abc")
        second = store.enqueue_render("r2", "story1", "hash-abc")
        # Both calls return the original row, keyed by (story, hash) — the
        # second call's render_id is silently dropped.
        self.assertEqual(first["id"], "r1")
        self.assertEqual(second["id"], "r1")
        # And only one row exists.
        self.assertEqual(_count_renders(), 1)

    def test_different_hashes_produce_different_rows(self):
        store.enqueue_render("r1", "story1", "hash-a")
        store.enqueue_render("r2", "story1", "hash-b")
        self.assertEqual(_count_renders(), 2)

    def test_different_stories_with_same_hash_coexist(self):
        # Different stories sharing a config hash is a corner case (two
        # stories with identical configs would be unusual) but the UNIQUE
        # constraint must allow it because story_id is half the key.
        store.enqueue_render("r1", "story1", "hash-x")
        store.enqueue_render("r2", "story2", "hash-x")
        self.assertEqual(_count_renders(), 2)


class ClaimTests(_QueueTestCase):
    def test_claim_on_empty_queue_returns_none(self):
        self.assertIsNone(store.claim_next_render())

    def test_claim_flips_status_to_rendering_and_stamps_started_at(self):
        store.enqueue_render("r1", "story1", "hash-a")
        claimed = store.claim_next_render()
        assert claimed is not None
        self.assertEqual(claimed["id"], "r1")
        self.assertEqual(claimed["status"], "rendering")
        self.assertIsNotNone(claimed["started_at"])

    def test_claim_picks_oldest_queued(self):
        # The worker should process in FIFO order so an older render's
        # admin doesn't watch a later one finish first.
        store.enqueue_render("r1", "story1", "hash-a")
        # Force a later requested_at on the second one by stepping the clock.
        with _frozen_clock_offset(60):
            store.enqueue_render("r2", "story2", "hash-b")
        claimed = store.claim_next_render()
        assert claimed is not None
        self.assertEqual(claimed["id"], "r1")

    def test_double_claim_returns_distinct_rows(self):
        store.enqueue_render("r1", "story1", "hash-a")
        store.enqueue_render("r2", "story2", "hash-b")
        first = store.claim_next_render()
        second = store.claim_next_render()
        assert first is not None and second is not None
        self.assertNotEqual(first["id"], second["id"])

    def test_claim_skips_already_rendering(self):
        store.enqueue_render("r1", "story1", "hash-a")
        store.claim_next_render()  # flips r1 → rendering
        self.assertIsNone(store.claim_next_render())


class StatusTransitionTests(_QueueTestCase):
    def test_progress_updates(self):
        store.enqueue_render("r1", "story1", "hash-a")
        store.claim_next_render()
        store.update_render_progress("r1", 0.42)
        row = store.get_render("r1")
        assert row is not None
        self.assertAlmostEqual(row["progress"], 0.42)
        # Still rendering — progress doesn't change status.
        self.assertEqual(row["status"], "rendering")

    def test_finish_marks_done_with_output_url(self):
        store.enqueue_render("r1", "story1", "hash-a")
        store.claim_next_render()
        store.finish_render("r1", "/generated/story1/video.mp4")
        row = store.get_render("r1")
        assert row is not None
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["progress"], 1.0)
        self.assertEqual(row["output_url"], "/generated/story1/video.mp4")
        self.assertIsNotNone(row["finished_at"])

    def test_fail_records_error_and_caps_size(self):
        store.enqueue_render("r1", "story1", "hash-a")
        store.claim_next_render()
        big = "x" * 5000
        store.fail_render("r1", big)
        row = store.get_render("r1")
        assert row is not None
        self.assertEqual(row["status"], "error")
        # Cap is 2000 chars — protects the column from a runaway traceback.
        self.assertEqual(len(row["error"]), 2000)
        self.assertIsNotNone(row["finished_at"])

    def test_fail_with_empty_message_defaults(self):
        store.enqueue_render("r1", "story1", "hash-a")
        store.claim_next_render()
        store.fail_render("r1", "")
        row = store.get_render("r1")
        assert row is not None
        self.assertEqual(row["error"], "unknown error")


class LatestRenderForStoryTests(_QueueTestCase):
    def test_returns_none_when_no_renders(self):
        self.assertIsNone(store.latest_render_for_story("never-rendered"))

    def test_returns_most_recent_by_requested_at(self):
        # Different hashes → both rows persist. We then assert "latest"
        # tracks request time, not insert order, by stepping the clock.
        store.enqueue_render("r1", "story1", "hash-old")
        with _frozen_clock_offset(60):
            store.enqueue_render("r2", "story1", "hash-new")
        latest = store.latest_render_for_story("story1")
        assert latest is not None
        self.assertEqual(latest["id"], "r2")

    def test_scoped_per_story(self):
        store.enqueue_render("r1", "storyA", "hash-x")
        store.enqueue_render("r2", "storyB", "hash-y")
        latest_a = store.latest_render_for_story("storyA")
        latest_b = store.latest_render_for_story("storyB")
        assert latest_a is not None and latest_b is not None
        self.assertEqual(latest_a["id"], "r1")
        self.assertEqual(latest_b["id"], "r2")


# ─── helpers ──────────────────────────────────────────────────────────────────


def _count_renders() -> int:
    import sqlite3
    conn = sqlite3.connect(store.DB_PATH)
    try:
        cur = conn.execute("SELECT COUNT(*) FROM video_renders")
        return int(cur.fetchone()[0])
    finally:
        conn.close()


class _frozen_clock_offset:
    """Tiny context manager that shifts pipeline.store._now_iso forward by N
    seconds for the duration of the block. Lets the FIFO-ordering tests
    create a deterministic gap between rows without sleeping."""

    def __init__(self, seconds: int) -> None:
        self._seconds = seconds
        self._patch: mock._patch | None = None

    def __enter__(self) -> None:
        import datetime
        delta = datetime.timedelta(seconds=self._seconds)
        original = store._now_iso

        def _shifted() -> str:
            # We rebuild the ISO string from a real "now + delta" so the
            # value still parses anywhere the real clock would.
            return (
                datetime.datetime.now(datetime.timezone.utc) + delta
            ).isoformat()

        self._patch = mock.patch.object(store, "_now_iso", _shifted)
        self._patch.start()
        # Reference original to keep linters happy and document that we'll
        # restore on exit.
        del original

    def __exit__(self, *_exc: object) -> None:
        if self._patch is not None:
            self._patch.stop()
            self._patch = None


if __name__ == "__main__":
    unittest.main()
