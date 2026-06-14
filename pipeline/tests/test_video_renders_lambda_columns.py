"""Tests for the video_renders Lambda-bookkeeping columns (Phase 2 of
_plans/2026-06-14-remotion-lambda-render.md).

What we lock here:
  - Schema migration is idempotent and the three new columns exist on
    a fresh DB (`store.init()`) AND on an already-initialized DB
    (re-running `store.init()` doesn't error).
  - `enqueue_render` writes NULLs into all three Lambda columns by
    design — local-worker renders never touch AWS, and the Vercel
    kick endpoint is the only writer for those fields.
  - `set_render_lambda_ids` stamps the three columns AND only fires
    when status='rendering' (so a settled row can't be retroactively
    bound to a stale Lambda render id).
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


class SchemaMigrationTests(_IsolatedDB):
    def test_lambda_columns_exist_on_fresh_db(self):
        # Drive at the column list rather than introspecting sqlite_master —
        # the latter would tie this test to a specific dialect.
        row = self.store.enqueue_render("r-1", "envelope", "hash1")
        self.assertIn("lambda_render_id", row)
        self.assertIn("lambda_bucket_name", row)
        self.assertIn("lambda_function_name", row)

    def test_init_is_idempotent(self):
        # Re-running init() on an already-initialized DB must not error.
        # The ALTER TABLE ADD COLUMN IF NOT EXISTS idempotency contract.
        self.store.init()
        self.store.init()


class EnqueueWritesNullLambdaColumnsTests(_IsolatedDB):
    def test_enqueue_leaves_lambda_columns_null(self):
        # Local-worker contract: the existing render_worker.py never
        # touches Lambda, so enqueueing must NULL out the three columns.
        # Anything else would mean a Lambda kick path saw a "ready" row
        # with phantom IDs and tried to poll a render that doesn't exist.
        row = self.store.enqueue_render(
            "r-1", "envelope", "hash1", requested_by="user-1",
        )
        self.assertIsNone(row["lambda_render_id"])
        self.assertIsNone(row["lambda_bucket_name"])
        self.assertIsNone(row["lambda_function_name"])

    def test_get_render_round_trips_lambda_columns(self):
        # Roundtrip check — if the SELECT list dropped the new columns
        # the type returned would be missing them and downstream code
        # would silently see undefined. Lock it.
        self.store.enqueue_render("r-1", "envelope", "hash1")
        fetched = self.store.get_render("r-1")
        self.assertIsNotNone(fetched)
        self.assertIn("lambda_render_id", fetched)
        self.assertIn("lambda_bucket_name", fetched)
        self.assertIn("lambda_function_name", fetched)


class SetRenderLambdaIdsTests(_IsolatedDB):
    def test_stamps_all_three_ids_when_rendering(self):
        self.store.enqueue_render("r-1", "envelope", "hash1")
        # Claim flips status to 'rendering' — the only state where the
        # kick endpoint can legitimately stamp the IDs.
        self.store.claim_next_render()
        self.store.set_render_lambda_ids(
            "r-1",
            lambda_render_id="lambda-render-xyz",
            lambda_bucket_name="remotionlambda-us-east-1-abc",
            lambda_function_name="remotion-render-bds9aab",
        )
        row = self.store.get_render("r-1")
        self.assertEqual(row["lambda_render_id"], "lambda-render-xyz")
        self.assertEqual(
            row["lambda_bucket_name"], "remotionlambda-us-east-1-abc",
        )
        self.assertEqual(
            row["lambda_function_name"], "remotion-render-bds9aab",
        )

    def test_does_not_overwrite_a_settled_row(self):
        # Status guard mirrors finish_render: stamp only fires on
        # 'rendering'. A late-arriving kick against a row that already
        # errored or finished MUST NOT silently rewrite history.
        self.store.enqueue_render("r-1", "envelope", "hash1")
        self.store.claim_next_render()
        # Manually settle the row to 'done' to simulate a race where
        # the drain finished before a duplicate kick fired.
        self.store.finish_render("r-1", "https://gcs/old.mp4")
        self.store.set_render_lambda_ids(
            "r-1",
            lambda_render_id="lambda-render-stale",
            lambda_bucket_name="remotionlambda-stale",
            lambda_function_name="remotion-render-stale",
        )
        row = self.store.get_render("r-1")
        self.assertIsNone(row["lambda_render_id"])
        self.assertIsNone(row["lambda_bucket_name"])
        self.assertIsNone(row["lambda_function_name"])
        self.assertEqual(row["status"], "done")

    def test_does_not_stamp_queued_row(self):
        # Pre-claim a row that's only in 'queued' state — kick MUST
        # claim first (that's claim_next_render's job). A bare
        # set_render_lambda_ids without claim is the wrong order and
        # the guard catches it.
        self.store.enqueue_render("r-1", "envelope", "hash1")
        self.store.set_render_lambda_ids(
            "r-1",
            lambda_render_id="lambda-render-too-soon",
            lambda_bucket_name="remotionlambda-too-soon",
            lambda_function_name="remotion-render-too-soon",
        )
        row = self.store.get_render("r-1")
        self.assertIsNone(row["lambda_render_id"])
        self.assertEqual(row["status"], "queued")


if __name__ == "__main__":
    unittest.main()
