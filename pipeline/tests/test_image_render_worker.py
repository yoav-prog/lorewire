"""Tests for pipeline.image_render_worker.

Same shape as test_render_worker.py — temp SQLite, injected regen function,
no kie calls. We guard the queue → regen → status transition: empty queue
is a no-op, success path writes finish_image_render with the cost, error
path writes fail_image_render with the message, NotImplementedError surfaces
verbatim so the UI can show "scenes regen not yet wired" inline.
"""
from __future__ import annotations

import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from pipeline import image_render_worker, store


class _WorkerTestCase(unittest.TestCase):
    """Mirrors test_render_worker.py's plumbing — temp SQLite, no Postgres."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        db_path = Path(self._tmpdir.name) / "image-regen-worker.db"
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

    def _new_image_render_row(
        self,
        owner_kind: str = "story",
        owner_id: str | None = None,
        asset: str = "hero",
    ) -> str:
        """Insert a queued image_renders row directly. We bypass the TS-side
        enqueue helper here because Python tests don't run the Next.js
        process."""
        render_id = str(uuid.uuid4())
        now = store._now_iso()
        cols = ", ".join(store._IMAGE_RENDER_COLUMNS)
        placeholders = ", ".join(f":{c}" for c in store._IMAGE_RENDER_COLUMNS)
        with store._sqlite_conn() as c:
            c.execute(
                f"INSERT INTO image_renders ({cols}) VALUES ({placeholders})",
                {
                    "id": render_id,
                    "owner_kind": owner_kind,
                    "owner_id": owner_id or str(uuid.uuid4()),
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


class TickTests(_WorkerTestCase):
    def test_empty_queue_returns_false(self):
        called = [False]

        def regen_fn(_row: dict) -> tuple[str, int]:
            called[0] = True
            return ("/x", 1)

        self.assertFalse(image_render_worker.run_one_tick(regen_fn=regen_fn))
        # Regen function must NOT be called when the queue is empty —
        # otherwise the worker is doing pointless work between polls.
        self.assertFalse(called[0])

    def test_happy_path_marks_done_with_url_and_cost(self):
        render_id = self._new_image_render_row()

        def regen_fn(_row: dict) -> tuple[str, int]:
            return ("/generated/test/hero.png", 7)

        self.assertTrue(image_render_worker.run_one_tick(regen_fn=regen_fn))
        row = store.get_image_render(render_id)
        assert row is not None
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["output_url"], "/generated/test/hero.png")
        self.assertEqual(row["cost_cents"], 7)
        self.assertIsNotNone(row["finished_at"])

    def test_failure_path_marks_error_with_message(self):
        render_id = self._new_image_render_row()

        def boom(_row: dict) -> tuple[str, int]:
            raise RuntimeError("kie said no")

        self.assertTrue(image_render_worker.run_one_tick(regen_fn=boom))
        row = store.get_image_render(render_id)
        assert row is not None
        self.assertEqual(row["status"], "error")
        self.assertEqual(row["error"], "kie said no")

    def test_not_implemented_surfaces_message(self):
        render_id = self._new_image_render_row(asset="scenes")

        def stub(_row: dict) -> tuple[str, int]:
            raise NotImplementedError("scenes regen is not yet wired.")

        self.assertTrue(image_render_worker.run_one_tick(regen_fn=stub))
        row = store.get_image_render(render_id)
        assert row is not None
        self.assertEqual(row["status"], "error")
        self.assertIn("scenes regen is not yet wired", row["error"] or "")

    def test_default_dispatcher_rejects_unknown_owner_kind(self):
        render_id = self._new_image_render_row(owner_kind="frog")
        # Use the default dispatcher (no injected regen_fn).
        self.assertTrue(image_render_worker.run_one_tick())
        row = store.get_image_render(render_id)
        assert row is not None
        self.assertEqual(row["status"], "error")
        self.assertIn("unknown owner_kind", row["error"] or "")

    def test_two_ticks_each_handle_one_row(self):
        self._new_image_render_row()
        calls: list[str] = []

        def regen_fn(claimed: dict) -> tuple[str, int]:
            calls.append(claimed["id"])
            return ("/x", 1)

        self.assertTrue(image_render_worker.run_one_tick(regen_fn=regen_fn))
        self.assertFalse(image_render_worker.run_one_tick(regen_fn=regen_fn))
        self.assertEqual(len(calls), 1)


class ClaimTests(_WorkerTestCase):
    def test_claim_flips_status_to_generating(self):
        self._new_image_render_row()
        claimed = store.claim_next_image_render()
        assert claimed is not None
        self.assertEqual(claimed["status"], "generating")
        self.assertIsNotNone(claimed["started_at"])

    def test_claim_returns_none_when_no_queued_rows(self):
        # All rows already done.
        render_id = self._new_image_render_row()
        store.finish_image_render(render_id, "/x", 1)
        self.assertIsNone(store.claim_next_image_render())


if __name__ == "__main__":
    unittest.main()
