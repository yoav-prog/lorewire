"""Tests for pipeline.store.reddit_source helpers — upsert, filter, count,
status patches. SQLite only; the dialect dispatch is covered by
test_store.py and the SQL strings are explicitly mirrored on the Postgres
path inside each helper.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from importlib import reload
from pathlib import Path
from unittest import mock


class _IsolatedDB(unittest.TestCase):
    """Spin up a per-test SQLite DB so the helpers run against a real
    `reddit_source` table without touching the dev DB at
    pipeline/lorewire.db."""

    def setUp(self):
        # ignore_cleanup_errors: Windows holds the sqlite3 file handle past the
        # tempdir finalizer occasionally (matches test_render_queue.py pattern).
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


def _make_row(**overrides) -> dict:
    base = {
        "reddit_id": "abc",
        "subreddit": "AITAH",
        "date_written": "2026-01-01T00:00:00+00:00",
        "title": "title",
        "full_text": "full text",
        "comments": 10,
        "url": "https://reddit.com/r/AITAH/abc",
        "summary": "sum",
        "length_chars": 9,
        "status": "imported",
        "story_id": None,
        "notes": None,
        "first_synced": "2026-06-14T00:00:00+00:00",
        "last_synced": "2026-06-14T00:00:00+00:00",
    }
    base.update(overrides)
    return base


class UpsertTests(_IsolatedDB):
    def test_first_insert_returns_new(self):
        result = self.store.upsert_reddit_source(_make_row())
        self.assertEqual(result, "new")
        row = self.store.fetch_reddit_source("abc")
        self.assertEqual(row["title"], "title")
        self.assertEqual(row["status"], "imported")

    def test_second_insert_with_no_content_change_returns_unchanged(self):
        self.store.upsert_reddit_source(_make_row())
        result = self.store.upsert_reddit_source(_make_row(last_synced="later"))
        self.assertEqual(result, "unchanged")

    def test_content_change_returns_updated(self):
        self.store.upsert_reddit_source(_make_row())
        result = self.store.upsert_reddit_source(_make_row(comments=99))
        self.assertEqual(result, "updated")
        row = self.store.fetch_reddit_source("abc")
        self.assertEqual(row["comments"], 99)

    def test_status_not_clobbered_on_resync(self):
        self.store.upsert_reddit_source(_make_row())
        self.store.set_reddit_source_status("abc", "queued", story_id="s-1")
        # A re-sync row carries status='imported' (default for first-seen),
        # but the upsert path must preserve the admin's flip.
        self.store.upsert_reddit_source(_make_row(comments=500))
        row = self.store.fetch_reddit_source("abc")
        self.assertEqual(row["status"], "queued")
        self.assertEqual(row["story_id"], "s-1")
        self.assertEqual(row["comments"], 500)


class FilterTests(_IsolatedDB):
    def _seed(self):
        self.store.upsert_reddit_source(_make_row(
            reddit_id="r1", subreddit="AITAH", length_chars=1500,
            comments=100, date_written="2026-01-01T00:00:00+00:00",
            title="A short title", summary="short sum",
        ))
        self.store.upsert_reddit_source(_make_row(
            reddit_id="r2", subreddit="relationships", length_chars=3000,
            comments=500, date_written="2026-02-01T00:00:00+00:00",
            title="A relationship saga", summary="rel sum",
        ))
        self.store.upsert_reddit_source(_make_row(
            reddit_id="r3", subreddit="AITAH", length_chars=5000,
            comments=50, date_written="2026-03-01T00:00:00+00:00",
            title="Drama unfolds", summary=None,
        ))

    def test_status_filter(self):
        self._seed()
        self.store.set_reddit_source_status("r2", "skipped")
        rows = self.store.list_reddit_sources({"status": "imported"})
        ids = {r["reddit_id"] for r in rows}
        self.assertEqual(ids, {"r1", "r3"})
        rows = self.store.list_reddit_sources({"status": ["imported", "skipped"]})
        self.assertEqual({r["reddit_id"] for r in rows}, {"r1", "r2", "r3"})

    def test_subreddit_filter(self):
        self._seed()
        rows = self.store.list_reddit_sources({"subreddits": ["AITAH"]})
        self.assertEqual({r["reddit_id"] for r in rows}, {"r1", "r3"})

    def test_length_range(self):
        self._seed()
        rows = self.store.list_reddit_sources(
            {"length_min": 2000, "length_max": 4000}
        )
        self.assertEqual({r["reddit_id"] for r in rows}, {"r2"})

    def test_comments_min(self):
        self._seed()
        rows = self.store.list_reddit_sources({"comments_min": 100})
        self.assertEqual({r["reddit_id"] for r in rows}, {"r1", "r2"})

    def test_date_range(self):
        self._seed()
        rows = self.store.list_reddit_sources(
            {"date_from": "2026-02-01", "date_to": "2026-02-28"}
        )
        self.assertEqual({r["reddit_id"] for r in rows}, {"r2"})

    def test_search_matches_title_and_summary(self):
        self._seed()
        rows = self.store.list_reddit_sources({"search": "rel"})
        # "relationship saga" + "rel sum" both match
        self.assertEqual({r["reddit_id"] for r in rows}, {"r2"})

    def test_combined_filters(self):
        self._seed()
        rows = self.store.list_reddit_sources({
            "subreddits": ["AITAH"],
            "length_min": 2000,
            "comments_min": 1,
        })
        self.assertEqual({r["reddit_id"] for r in rows}, {"r3"})

    def test_count_matches_list_length(self):
        self._seed()
        f = {"subreddits": ["AITAH"]}
        self.assertEqual(self.store.count_reddit_sources(f), len(
            self.store.list_reddit_sources(f, limit=100, offset=0)
        ))

    def test_pagination(self):
        self._seed()
        # default order is comments DESC: r2(500), r1(100), r3(50)
        page1 = self.store.list_reddit_sources({}, limit=2, offset=0)
        page2 = self.store.list_reddit_sources({}, limit=2, offset=2)
        self.assertEqual([r["reddit_id"] for r in page1], ["r2", "r1"])
        self.assertEqual([r["reddit_id"] for r in page2], ["r3"])

    def test_distinct_subreddits(self):
        self._seed()
        subs = self.store.list_reddit_source_subreddits()
        self.assertEqual(subs, ["AITAH", "relationships"])


class StatusPatchTests(_IsolatedDB):
    def test_flip_status_and_set_story_id(self):
        self.store.upsert_reddit_source(_make_row())
        self.store.set_reddit_source_status("abc", "queued", story_id="story-1")
        row = self.store.fetch_reddit_source("abc")
        self.assertEqual(row["status"], "queued")
        self.assertEqual(row["story_id"], "story-1")

    def test_unknown_patch_column_raises(self):
        self.store.upsert_reddit_source(_make_row())
        with self.assertRaises(ValueError):
            self.store.set_reddit_source_status(
                "abc", "queued", title="should_not_be_writable"
            )

    def test_blank_reddit_id_raises(self):
        with self.assertRaises(ValueError):
            self.store.set_reddit_source_status("", "queued")


if __name__ == "__main__":
    unittest.main()
