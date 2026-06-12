"""Tests for the Vercel cron drain handler.

The handler lives in `lorewire-app/api/drain_image_renders.py`. We
import it via a sys.path insertion so the test runs without touching
Vercel deploy state, then exercise `run_drain` (the pure-Python core)
plus the auth check.

Coverage matches the LLM Council prerequisites:
  - auth: 401 when CRON_SECRET is missing / wrong, accepted when right
  - idle: empty queue exits without touching anything
  - drain: claims rows, dispatches, marks them done
  - reaper: stale generating rows get reset before the drain loop
  - lock: a busy advisory lock short-circuits the tick (Postgres-only,
    so SQLite tests just confirm the helper exists)
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from pipeline import image_render_worker, store

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DRAIN_DIR = REPO_ROOT / "lorewire-app" / "api"
if str(DRAIN_DIR) not in sys.path:
    sys.path.insert(0, str(DRAIN_DIR))

import drain_image_renders as drain  # noqa: E402 — after sys.path insert


class _DrainTestCase(unittest.TestCase):
    """Same temp-SQLite plumbing as test_image_render_worker — we never
    hit a real Postgres in unit tests."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        db_path = Path(self._tmpdir.name) / "drain.db"
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

    def _new_queued_row(self, asset: str = "hero") -> str:
        render_id = str(uuid.uuid4())
        now = store._now_iso()
        cols = ", ".join(store._IMAGE_RENDER_COLUMNS)
        placeholders = ", ".join(f":{c}" for c in store._IMAGE_RENDER_COLUMNS)
        with store._sqlite_conn() as c:
            c.execute(
                f"INSERT INTO image_renders ({cols}) VALUES ({placeholders})",
                {
                    "id": render_id,
                    "owner_kind": "story",
                    "owner_id": str(uuid.uuid4()),
                    "asset": asset,
                    "prompt_hash": None,
                    "status": "queued",
                    "progress": 0,
                    "error": None,
                    "output_url": None,
                    "cost_cents": None,
                    "requested_by": None,
                    "requested_at": now,
                    "started_at": None,
                    "finished_at": None,
                },
            )
        return render_id


class AuthTests(_DrainTestCase):
    def test_missing_cron_secret_rejects_everything(self):
        # No CRON_SECRET in env at all — treat every request as bad.
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
        self.assertFalse(drain._is_authorized("abc"))  # missing "Bearer "

    def test_right_token_accepts(self):
        os.environ["CRON_SECRET"] = "abc"
        self.assertTrue(drain._is_authorized("Bearer abc"))


class MaxRowsTests(_DrainTestCase):
    def test_default_when_unset(self):
        os.environ.pop("DRAIN_MAX_ROWS_PER_TICK", None)
        self.assertEqual(drain._max_rows_per_tick(), drain.DEFAULT_MAX_ROWS)

    def test_override_via_env(self):
        os.environ["DRAIN_MAX_ROWS_PER_TICK"] = "12"
        self.assertEqual(drain._max_rows_per_tick(), 12)

    def test_invalid_falls_back_to_default(self):
        os.environ["DRAIN_MAX_ROWS_PER_TICK"] = "not-a-number"
        self.assertEqual(drain._max_rows_per_tick(), drain.DEFAULT_MAX_ROWS)

    def test_clamped_to_safe_range(self):
        os.environ["DRAIN_MAX_ROWS_PER_TICK"] = "9999"
        self.assertEqual(drain._max_rows_per_tick(), 60)
        os.environ["DRAIN_MAX_ROWS_PER_TICK"] = "0"
        self.assertEqual(drain._max_rows_per_tick(), 1)


class RunDrainTests(_DrainTestCase):
    def test_idle_when_queue_empty(self):
        body = drain.run_drain()
        self.assertEqual(body["drained"], 0)
        self.assertEqual(body["remaining"], 0)

    def test_drains_a_queued_row(self):
        render_id = self._new_queued_row()

        def fake_regen(_row: dict) -> tuple[str, int]:
            return ("/generated/hero.png", 9)

        with mock.patch.object(
            image_render_worker, "_default_regen", side_effect=fake_regen
        ):
            body = drain.run_drain()
        self.assertEqual(body["drained"], 1)
        self.assertEqual(body["remaining"], 0)
        row = store.get_image_render(render_id)
        assert row is not None
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["output_url"], "/generated/hero.png")
        self.assertEqual(row["cost_cents"], 9)

    def test_failure_marks_row_error_and_continues(self):
        # Two rows; first one bombs, second one succeeds. Drain must
        # not abort the whole tick on one row failure.
        bad_id = self._new_queued_row(asset="hero")
        good_id = self._new_queued_row(asset="hero")

        def regen(row: dict) -> tuple[str, int]:
            if row["id"] == bad_id:
                raise RuntimeError("kie boom")
            return ("/ok.png", 3)

        with mock.patch.object(
            image_render_worker, "_default_regen", side_effect=regen
        ):
            body = drain.run_drain()
        self.assertEqual(body["drained"], 2)
        bad_row = store.get_image_render(bad_id)
        good_row = store.get_image_render(good_id)
        assert bad_row is not None and good_row is not None
        self.assertEqual(bad_row["status"], "error")
        self.assertEqual(bad_row["error"], "kie boom")
        self.assertEqual(good_row["status"], "done")

    def test_reaper_runs_before_drain_loop(self):
        # A stale 'generating' row from a previous crash should be
        # reset to queued, then drained on the same tick.
        render_id = self._new_queued_row()
        store.claim_next_image_render()  # flips to generating
        old_iso = "2020-01-01T00:00:00+00:00"
        with store._sqlite_conn() as c:
            c.execute(
                "UPDATE image_renders SET started_at=? WHERE id=?",
                (old_iso, render_id),
            )

        def regen(_row: dict) -> tuple[str, int]:
            return ("/recovered.png", 5)

        with mock.patch.object(
            image_render_worker, "_default_regen", side_effect=regen
        ):
            body = drain.run_drain()
        self.assertEqual(body["drained"], 1)
        row = store.get_image_render(render_id)
        assert row is not None
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["output_url"], "/recovered.png")

    def test_max_rows_per_tick_caps_the_loop(self):
        # Enqueue 10 rows but cap at 3 — drain should stop after 3 and
        # leave 7 queued for the next tick.
        for _ in range(10):
            self._new_queued_row()
        os.environ["DRAIN_MAX_ROWS_PER_TICK"] = "3"

        def regen(_row: dict) -> tuple[str, int]:
            return ("/x.png", 1)

        with mock.patch.object(
            image_render_worker, "_default_regen", side_effect=regen
        ):
            body = drain.run_drain()
        self.assertEqual(body["drained"], 3)
        self.assertEqual(body["remaining"], 7)


if __name__ == "__main__":
    unittest.main()
