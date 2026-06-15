"""Tests for the short_render observability + cancellation seam.

Covers the two halves that the TS suite can't reach: the Python
log_short_render_event helper writes to the table, and the worker's
on_progress callback raises ShortRenderCancelled when the row is moved
to 'cancelled' status. Plan:
_plans/2026-06-15-short-render-events-and-cancel.md.
"""
from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import short_render_worker, store


class _ShortEventsTestCase(unittest.TestCase):
    """Per-test temp SQLite, same pattern as test_render_worker."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        db_path = Path(self._tmpdir.name) / "short-events.db"
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

    def _seed_short(self, render_id: str, story_id: str, status: str) -> None:
        # Direct INSERT — bypass enqueue_short_render so we control status.
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "INSERT INTO short_renders "
                "(id, story_id, config_hash, narration_style, length_preset, status, "
                " phase, progress, error, output_url, props, requested_by, requested_at, "
                " started_at, finished_at) "
                "VALUES (?, ?, ?, 'suspense', 'standard', ?, NULL, 0, NULL, NULL, NULL, "
                "        NULL, '2026-06-15T00:00:00.000Z', NULL, NULL)",
                (render_id, story_id, f"hash-{render_id}", status),
            )

    def _list_events(self, render_id: str) -> list[dict]:
        with sqlite3.connect(store.DB_PATH) as c:
            c.row_factory = sqlite3.Row
            rows = c.execute(
                "SELECT event, message, level, payload FROM short_render_events "
                "WHERE render_id = ? ORDER BY ts ASC",
                (render_id,),
            ).fetchall()
        return [dict(r) for r in rows]


class LogShortRenderEventTests(_ShortEventsTestCase):
    def test_writes_a_row_with_supplied_fields(self):
        store.log_short_render_event(
            "r1", "queued",
            message="Hi", payload={"k": "v"},
        )
        events = self._list_events("r1")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "queued")
        self.assertEqual(events[0]["message"], "Hi")
        self.assertIn("v", events[0]["payload"])
        # level defaults to 'info'.
        self.assertEqual(events[0]["level"], "info")

    def test_swallows_errors_when_table_is_missing(self):
        # Drop the events table to force an INSERT failure. The helper must
        # NOT raise — observability never breaks the render path.
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute("DROP TABLE short_render_events")
        # No exception should escape.
        store.log_short_render_event("r1", "queued", message="x")

    def test_supports_warn_and_error_levels(self):
        store.log_short_render_event("r2", "failed", level="error", message="bad")
        store.log_short_render_event("r2", "stalled", level="warn", message="slow")
        events = self._list_events("r2")
        levels = {e["level"] for e in events}
        self.assertEqual(levels, {"error", "warn"})


class WorkerCancellationTests(_ShortEventsTestCase):
    def test_progress_callback_raises_when_row_is_cancelled(self):
        # Seed a row, then flip it to 'cancelled' AFTER building the callback —
        # mirrors the real flow where the admin clicks Stop between phases.
        self._seed_short("r-cancel", "story-a", "generating")
        cb = short_render_worker._progress_for("r-cancel")
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "UPDATE short_renders SET status = 'cancelled' WHERE id = ?",
                ("r-cancel",),
            )
        with self.assertRaises(short_render_worker.ShortRenderCancelled):
            cb("scene", 5, 12)

    def test_progress_callback_continues_when_row_is_not_cancelled(self):
        self._seed_short("r-ok", "story-b", "generating")
        cb = short_render_worker._progress_for("r-ok")
        # No exception; the call updates progress + emits an event.
        cb("scene", 3, 12)
        events = self._list_events("r-ok")
        self.assertTrue(any(e["event"] == "scene_generated" for e in events))

    def test_phase_transitions_emit_one_event_each(self):
        self._seed_short("r-phases", "story-c", "generating")
        cb = short_render_worker._progress_for("r-phases")
        cb("script", 0, 0)
        cb("script", 0, 0)  # second call same phase — no new event
        cb("plan", 0, 0)
        cb("base", 0, 0)
        events = self._list_events("r-phases")
        phase_events = [e for e in events if e["event"].startswith("phase_")]
        self.assertEqual(
            [e["event"] for e in phase_events],
            ["phase_script", "phase_plan", "phase_base"],
        )

    def test_worker_run_one_tick_catches_cancellation_cleanly(self):
        # The worker's run_one_tick must catch ShortRenderCancelled separately
        # from generic exceptions: no fail_short_render call, no 'failed'
        # event written. The row stays at whatever status the TS Stop action
        # set ('cancelled'). We stub claim_next_short_render to skip the
        # claim DB path (props/UNIQUE constraints) and force the rfn branch.
        self._seed_short("r-tick", "story-d", "rendering")
        claimed_row = {
            "id": "r-tick",
            "story_id": "story-d",
            "narration_style": "suspense",
            "length_preset": "standard",
        }

        def boom(_row: dict) -> dict:
            raise short_render_worker.ShortRenderCancelled("admin cancelled")

        with mock.patch.object(
            store, "claim_next_short_render", return_value=claimed_row,
        ):
            result = short_render_worker.run_one_tick(render_fn=boom)

        self.assertTrue(result)
        # Worker writes a 'render_started' event up front, but NOT a 'failed'
        # event for a cancellation — that's the load-bearing assertion.
        events = self._list_events("r-tick")
        self.assertFalse(any(e["event"] == "failed" for e in events))


if __name__ == "__main__":
    unittest.main()
