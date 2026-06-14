"""Tests for the curation_slots Python helpers.

Phase 1 of _plans/2026-06-15-curation-system.md. Mirrors test_story_jobs
in shape (per-test isolated SQLite, config + store reloaded so DB_PATH
picks up the env override).
"""
from __future__ import annotations

import datetime
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


class SetSlotStoriesTests(_IsolatedDB):
    def test_empty_slot_returns_no_rows(self):
        self.assertEqual(
            self.store.list_curation_slots("rail.top10"), [],
        )

    def test_set_then_list_preserves_order(self):
        n = self.store.set_slot_stories("rail.top10", ["a", "b", "c"])
        self.assertEqual(n, 3)
        rows = self.store.list_curation_slots("rail.top10")
        self.assertEqual([r["story_id"] for r in rows], ["a", "b", "c"])
        self.assertEqual([r["position"] for r in rows], [0, 1, 2])

    def test_set_replaces_atomically(self):
        """A second set wipes the first set entirely (no orphan rows)."""
        self.store.set_slot_stories("rail.top10", ["a", "b", "c"])
        self.store.set_slot_stories("rail.top10", ["x", "y"])
        rows = self.store.list_curation_slots("rail.top10")
        self.assertEqual([r["story_id"] for r in rows], ["x", "y"])
        self.assertEqual(len(rows), 2)

    def test_set_other_slot_does_not_affect_this_one(self):
        self.store.set_slot_stories("rail.top10", ["a", "b"])
        self.store.set_slot_stories("rail.new", ["q", "r"])
        top10 = self.store.list_curation_slots("rail.top10")
        new = self.store.list_curation_slots("rail.new")
        self.assertEqual([r["story_id"] for r in top10], ["a", "b"])
        self.assertEqual([r["story_id"] for r in new], ["q", "r"])

    def test_set_empty_list_clears_slot(self):
        self.store.set_slot_stories("rail.top10", ["a", "b"])
        self.store.set_slot_stories("rail.top10", [])
        self.assertEqual(self.store.list_curation_slots("rail.top10"), [])

    def test_blank_slot_kind_rejected(self):
        with self.assertRaises(ValueError):
            self.store.set_slot_stories("", ["a"])


class AddRemoveTests(_IsolatedDB):
    def test_append_lands_at_max_plus_one(self):
        self.store.set_slot_stories("rail.top10", ["a", "b"])
        self.store.add_to_slot("rail.top10", "c")
        rows = self.store.list_curation_slots("rail.top10")
        self.assertEqual([r["story_id"] for r in rows], ["a", "b", "c"])
        self.assertEqual([r["position"] for r in rows], [0, 1, 2])

    def test_explicit_position(self):
        self.store.add_to_slot("rail.top10", "a", position=5)
        rows = self.store.list_curation_slots("rail.top10")
        self.assertEqual(rows[0]["position"], 5)

    def test_unique_slot_kind_story_id_rejects_duplicate(self):
        import sqlite3
        self.store.add_to_slot("rail.top10", "a")
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.add_to_slot("rail.top10", "a")

    def test_remove_returns_true_on_hit_false_on_miss(self):
        new_id = self.store.add_to_slot("rail.top10", "a")
        self.assertTrue(self.store.remove_from_slot(new_id))
        self.assertFalse(self.store.remove_from_slot(new_id))
        self.assertFalse(self.store.remove_from_slot("does-not-exist"))


class ReorderTests(_IsolatedDB):
    def test_reorder_swaps_positions(self):
        self.store.set_slot_stories("rail.top10", ["a", "b", "c"])
        rows = self.store.list_curation_slots("rail.top10")
        # Send them back in reverse order.
        reversed_ids = [rows[2]["id"], rows[1]["id"], rows[0]["id"]]
        self.store.reorder_slot("rail.top10", reversed_ids)
        after = self.store.list_curation_slots("rail.top10")
        self.assertEqual([r["story_id"] for r in after], ["c", "b", "a"])

    def test_reorder_ignores_ids_from_other_slot(self):
        self.store.set_slot_stories("rail.top10", ["a"])
        self.store.set_slot_stories("rail.new", ["x"])
        new_id = self.store.list_curation_slots("rail.new")[0]["id"]
        top10_id = self.store.list_curation_slots("rail.top10")[0]["id"]
        # Reorder rail.top10 but include the rail.new row's id — guarded
        # by `WHERE slot_kind = ?`, so it's a silent no-op.
        self.store.reorder_slot("rail.top10", [new_id, top10_id])
        # rail.new untouched.
        new_after = self.store.list_curation_slots("rail.new")
        self.assertEqual(new_after[0]["story_id"], "x")


class ActiveAtTests(_IsolatedDB):
    def test_active_at_filters_future_publish(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        future = (now + datetime.timedelta(hours=1)).isoformat()
        past = (now - datetime.timedelta(hours=1)).isoformat()
        self.store.add_to_slot("rail.top10", "future", publish_at=future)
        self.store.add_to_slot("rail.top10", "past", publish_at=past)
        rows = self.store.list_curation_slots(
            "rail.top10", active_at=now.isoformat(),
        )
        self.assertEqual([r["story_id"] for r in rows], ["past"])

    def test_active_at_filters_already_expired(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        future = (now + datetime.timedelta(hours=1)).isoformat()
        past = (now - datetime.timedelta(hours=1)).isoformat()
        self.store.add_to_slot("rail.top10", "live", expires_at=future)
        self.store.add_to_slot("rail.top10", "dead", expires_at=past)
        rows = self.store.list_curation_slots(
            "rail.top10", active_at=now.isoformat(),
        )
        self.assertEqual([r["story_id"] for r in rows], ["live"])

    def test_no_active_at_returns_everything(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        future = (now + datetime.timedelta(hours=1)).isoformat()
        self.store.add_to_slot("rail.top10", "future", publish_at=future)
        self.store.add_to_slot("rail.top10", "now-ish")
        rows = self.store.list_curation_slots("rail.top10")
        self.assertEqual(len(rows), 2)


class ListSlotsForStoryTests(_IsolatedDB):
    def test_returns_every_slot_the_story_is_in(self):
        self.store.add_to_slot("rail.top10", "envelope")
        self.store.add_to_slot("category.Entitled", "envelope")
        self.store.add_to_slot("billboard.featured", "other")
        rows = self.store.list_slots_for_story("envelope")
        self.assertEqual(
            sorted(r["slot_kind"] for r in rows),
            ["category.Entitled", "rail.top10"],
        )

    def test_empty_for_unknown_story(self):
        self.assertEqual(self.store.list_slots_for_story("nope"), [])


class DeleteExpiredCurationSlotsTests(_IsolatedDB):
    """Phase 6 cleanup cron — verifies the grace-window math is right and
    that rows without an expires_at are never touched."""

    def test_deletes_rows_older_than_grace(self):
        now = datetime.datetime(2026, 6, 20, tzinfo=datetime.timezone.utc)
        long_gone = (now - datetime.timedelta(days=14)).isoformat()
        recent = (now - datetime.timedelta(days=2)).isoformat()
        self.store.add_to_slot("rail.top10", "old", expires_at=long_gone)
        self.store.add_to_slot("rail.top10", "recent", expires_at=recent)
        self.store.add_to_slot("rail.top10", "live")
        removed = self.store.delete_expired_curation_slots(
            now_iso=now.isoformat(), grace_days=7,
        )
        self.assertEqual(removed, 1)
        remaining = sorted(
            r["story_id"]
            for r in self.store.list_curation_slots("rail.top10")
        )
        self.assertEqual(remaining, ["live", "recent"])

    def test_preserves_rows_without_expires_at(self):
        self.store.add_to_slot("rail.top10", "a")
        self.store.add_to_slot("rail.top10", "b")
        self.assertEqual(self.store.delete_expired_curation_slots(), 0)

    def test_rejects_negative_grace_days(self):
        with self.assertRaises(ValueError):
            self.store.delete_expired_curation_slots(grace_days=-1)

    def test_grace_window_boundary(self):
        # Exactly at the cutoff: NOT deleted (cutoff is exclusive — we
        # use `<` rather than `<=` so an admin who set expires_at "today
        # minus 7 days" still sees the row for one more tick).
        now = datetime.datetime(2026, 6, 20, tzinfo=datetime.timezone.utc)
        at_cutoff = (now - datetime.timedelta(days=7)).isoformat()
        self.store.add_to_slot("rail.top10", "edge", expires_at=at_cutoff)
        removed = self.store.delete_expired_curation_slots(
            now_iso=now.isoformat(), grace_days=7,
        )
        self.assertEqual(removed, 0)


if __name__ == "__main__":
    unittest.main()
