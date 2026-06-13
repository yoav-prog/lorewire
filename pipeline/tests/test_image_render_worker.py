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


class CountPendingTests(_WorkerTestCase):
    """Cron-drain handler short-circuits when the queue is empty. The
    counter has to see both queued AND generating rows or a single
    in-flight row would let a parallel tick claim nothing and the
    reaper would never fire."""

    def test_empty_queue_counts_zero(self):
        self.assertEqual(store.count_pending_image_renders(), 0)

    def test_queued_row_counts(self):
        self._new_image_render_row()
        self.assertEqual(store.count_pending_image_renders(), 1)

    def test_generating_row_counts(self):
        self._new_image_render_row()
        store.claim_next_image_render()  # flips to generating
        self.assertEqual(store.count_pending_image_renders(), 1)

    def test_done_row_does_not_count(self):
        render_id = self._new_image_render_row()
        store.finish_image_render(render_id, "/x", 1)
        self.assertEqual(store.count_pending_image_renders(), 0)

    def test_error_row_does_not_count(self):
        render_id = self._new_image_render_row()
        store.fail_image_render(render_id, "nope")
        self.assertEqual(store.count_pending_image_renders(), 0)


class ReapStaleClaimsTests(_WorkerTestCase):
    """Crash recovery: if a worker dies mid-claim the row sits at
    'generating' with started_at frozen. Reaper resets it to queued so
    the next tick can re-claim. Threshold chosen by caller, not baked."""

    def test_fresh_claim_is_not_reaped(self):
        self._new_image_render_row()
        store.claim_next_image_render()  # started_at = now
        reset = store.reap_stale_image_render_claims(stale_after_s=600)
        self.assertEqual(reset, 0)

    def test_stale_generating_row_is_reset_to_queued(self):
        render_id = self._new_image_render_row()
        store.claim_next_image_render()
        # Backdate started_at to look like a 20-minute-old crash.
        old_iso = "2020-01-01T00:00:00+00:00"
        with store._sqlite_conn() as c:
            c.execute(
                "UPDATE image_renders SET started_at = ? WHERE id = ?",
                (old_iso, render_id),
            )
        reset = store.reap_stale_image_render_claims(stale_after_s=600)
        self.assertEqual(reset, 1)
        row = store.get_image_render(render_id)
        assert row is not None
        self.assertEqual(row["status"], "queued")
        self.assertIsNone(row["started_at"])

    def test_queued_row_with_no_started_at_is_ignored(self):
        # Brand-new queued rows never have started_at — reaper must not
        # touch them, otherwise it would double-update every tick.
        self._new_image_render_row()
        reset = store.reap_stale_image_render_claims(stale_after_s=600)
        self.assertEqual(reset, 0)

    def test_done_row_is_not_reaped(self):
        render_id = self._new_image_render_row()
        store.claim_next_image_render()
        store.finish_image_render(render_id, "/x", 1)
        # Even with a stale started_at, a done row stays done.
        old_iso = "2020-01-01T00:00:00+00:00"
        with store._sqlite_conn() as c:
            c.execute(
                "UPDATE image_renders SET started_at = ? WHERE id = ?",
                (old_iso, render_id),
            )
        reset = store.reap_stale_image_render_claims(stale_after_s=600)
        self.assertEqual(reset, 0)


class CancelledStatusTests(_WorkerTestCase):
    """A row the admin Stops mid-flight must stay cancelled even when the
    worker eventually calls finish_image_render or fail_image_render. The
    drain handler doesn't check status between regen and finish, so the
    guarantee has to live in store.py's UPDATE WHERE clause."""

    def _set_status(self, render_id: str, status: str) -> None:
        with store._sqlite_conn() as c:
            c.execute(
                "UPDATE image_renders SET status = ? WHERE id = ?",
                (status, render_id),
            )

    def test_claim_does_not_pick_up_cancelled_rows(self):
        render_id = self._new_image_render_row()
        self._set_status(render_id, "cancelled")
        self.assertIsNone(store.claim_next_image_render())

    def test_reap_does_not_touch_cancelled_rows(self):
        # Even with a stale started_at, a cancelled row stays cancelled.
        render_id = self._new_image_render_row()
        store.claim_next_image_render()  # flips to generating
        self._set_status(render_id, "cancelled")
        old_iso = "2020-01-01T00:00:00+00:00"
        with store._sqlite_conn() as c:
            c.execute(
                "UPDATE image_renders SET started_at = ? WHERE id = ?",
                (old_iso, render_id),
            )
        reset = store.reap_stale_image_render_claims(stale_after_s=600)
        self.assertEqual(reset, 0)
        row = store.get_image_render(render_id)
        assert row is not None
        self.assertEqual(row["status"], "cancelled")

    def test_finish_image_render_is_noop_on_cancelled_row(self):
        render_id = self._new_image_render_row()
        store.claim_next_image_render()  # generating
        self._set_status(render_id, "cancelled")
        store.finish_image_render(render_id, "/x", 99)
        row = store.get_image_render(render_id)
        assert row is not None
        self.assertEqual(row["status"], "cancelled")
        # cost / url must NOT be persisted — the admin already cancelled.
        self.assertIsNone(row["output_url"])
        self.assertIsNone(row["cost_cents"])

    def test_fail_image_render_is_noop_on_cancelled_row(self):
        render_id = self._new_image_render_row()
        store.claim_next_image_render()
        self._set_status(render_id, "cancelled")
        store.fail_image_render(render_id, "kie said no")
        row = store.get_image_render(render_id)
        assert row is not None
        # status stays cancelled; error string from cancel action (or
        # whatever the admin wrote) is the source of truth.
        self.assertEqual(row["status"], "cancelled")

    def test_count_pending_excludes_cancelled_rows(self):
        # Drain handler's fast-exit relies on this — a row of cancelled
        # work shouldn't keep the cron tick burning cycles.
        render_id = self._new_image_render_row()
        self._set_status(render_id, "cancelled")
        self.assertEqual(store.count_pending_image_renders(), 0)


class AdvisoryLockTests(_WorkerTestCase):
    """Postgres advisory lock keeps two cron ticks from draining at
    once. On SQLite (this test bed) it must no-op cleanly so the local
    worker path stays unchanged."""

    def test_sqlite_lock_is_a_noop_and_acquires(self):
        with store.image_render_drain_lock() as acquired:
            self.assertTrue(acquired)
        # Re-acquire works because SQLite branch never actually locks.
        with store.image_render_drain_lock() as acquired_again:
            self.assertTrue(acquired_again)


class RenderEventLogTests(_WorkerTestCase):
    """Phase 2 observability: per-row event timeline. The contextvar
    pattern lets pipeline/media.py emit events without every regen
    helper growing a render_id parameter, so we cover both the
    explicit and the implicit (context-bound) call paths plus the
    'no context, no-op' fallback that protects local pipeline runs."""

    def test_event_written_when_render_id_passed_explicitly(self):
        render_id = self._new_image_render_row()
        store.log_render_event(
            "prompt_built", "hi", payload={"x": 1}, render_id=render_id,
        )
        events = store.list_render_events(render_id)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "prompt_built")
        self.assertEqual(events[0]["message"], "hi")
        self.assertEqual(events[0]["level"], "info")
        # payload is JSON-encoded TEXT — caller is responsible for parsing.
        import json as _json
        self.assertEqual(_json.loads(events[0]["payload"]), {"x": 1})

    def test_event_written_when_context_is_bound(self):
        render_id = self._new_image_render_row()
        with store.use_render_context(render_id):
            store.log_render_event("kie_request_sent", "go")
            store.log_render_event(
                "image_saved", "ok", payload={"url": "https://x/y.png"},
            )
        events = store.list_render_events(render_id)
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["event"], "kie_request_sent")
        self.assertEqual(events[1]["event"], "image_saved")

    def test_log_render_event_is_noop_without_context(self):
        # No context, no explicit render_id — must not raise, must not
        # write anywhere. This is what keeps local pipeline runs from
        # blowing up when they import code that emits events.
        store.log_render_event("kie_request_sent", "should be silent")
        # Nothing to assert beyond "no exception" — the absence of a
        # writable target means there's no row to query against.

    def test_events_returned_in_chronological_order(self):
        render_id = self._new_image_render_row()
        with store.use_render_context(render_id):
            for i in range(5):
                store.log_render_event(f"step_{i}", f"step {i}")
        events = store.list_render_events(render_id)
        self.assertEqual(len(events), 5)
        for i, ev in enumerate(events):
            self.assertEqual(ev["event"], f"step_{i}")

    def test_context_pops_when_block_exits(self):
        render_id = self._new_image_render_row()
        with store.use_render_context(render_id):
            store.log_render_event("inside", "captured")
        # Outside the with — must be a no-op again.
        store.log_render_event("outside", "should be lost")
        events = store.list_render_events(render_id)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "inside")

    def test_list_render_events_respects_limit(self):
        render_id = self._new_image_render_row()
        with store.use_render_context(render_id):
            for i in range(10):
                store.log_render_event(f"step_{i}", f"step {i}")
        events = store.list_render_events(render_id, limit=3)
        self.assertEqual(len(events), 3)
        self.assertEqual(events[0]["event"], "step_0")


if __name__ == "__main__":
    unittest.main()
