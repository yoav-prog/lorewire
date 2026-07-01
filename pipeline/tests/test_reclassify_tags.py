"""Tests for the reclassification coverage report (PR3,
_plans/2026-07-01-category-taxonomy-multitag.md). build_reclassification_report
is pure — it takes a stub classify_fn, so no DB and no LLM are involved. We
guard the aggregation: counts, the review-queue routing (empty tags or a
primary below the floor), the confidence buckets, and the floor boundary.
"""
from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from importlib import reload
from pathlib import Path
from unittest import mock

from pipeline.reclassify_tags import apply_plan, build_reclassification_report

CATEGORIES = [
    {"slug": "a", "label": "A", "description": "cat a"},
    {"slug": "b", "label": "B", "description": "cat b"},
]


def _stories(n: int) -> list[dict]:
    return [
        {"id": str(i), "title": "t", "body": "b", "category": "Drama"}
        for i in range(n)
    ]


class BuildReclassificationReportTests(unittest.TestCase):
    def test_aggregates_counts_and_buckets(self):
        def fake(_t, _b, _c):
            return [{"slug": "a", "confidence": 0.9}]

        rep = build_reclassification_report(_stories(2), CATEGORIES, fake)
        self.assertEqual(rep["total"], 2)
        self.assertEqual(rep["auto_tagged"], 2)
        self.assertEqual(rep["review_queue"], 0)
        self.assertEqual(rep["primary_counts"]["a"], 2)
        self.assertEqual(rep["confidence_buckets"][">=0.8"], 2)

    def test_empty_tags_go_to_review(self):
        def fake(_t, _b, _c):
            return []

        rep = build_reclassification_report(_stories(1), CATEGORIES, fake)
        self.assertEqual(rep["review_queue"], 1)
        self.assertEqual(rep["auto_tagged"], 0)
        self.assertTrue(rep["proposals"][0]["needs_review"])
        self.assertIsNone(rep["proposals"][0]["primary"])

    def test_low_confidence_primary_goes_to_review(self):
        def fake(_t, _b, _c):
            return [{"slug": "a", "confidence": 0.4}]

        rep = build_reclassification_report(
            _stories(1), CATEGORIES, fake, confidence_floor=0.6
        )
        self.assertEqual(rep["review_queue"], 1)
        self.assertEqual(rep["primary_counts"], {})
        self.assertTrue(rep["proposals"][0]["needs_review"])

    def test_multi_tag_counts_all_tags_but_primary_once(self):
        def fake(_t, _b, _c):
            return [
                {"slug": "a", "confidence": 0.9},
                {"slug": "b", "confidence": 0.7},
            ]

        rep = build_reclassification_report(_stories(1), CATEGORIES, fake)
        self.assertEqual(rep["primary_counts"], {"a": 1})
        self.assertEqual(rep["tag_counts"], {"a": 1, "b": 1})

    def test_floor_boundary_is_inclusive(self):
        # Exactly at the floor is auto-tagged (not review) and buckets 0.6-0.8.
        def fake(_t, _b, _c):
            return [{"slug": "a", "confidence": 0.6}]

        rep = build_reclassification_report(
            _stories(1), CATEGORIES, fake, confidence_floor=0.6
        )
        self.assertEqual(rep["review_queue"], 0)
        self.assertEqual(rep["confidence_buckets"]["0.6-0.8"], 1)

    def test_mixed_corpus(self):
        def fake(_t, body, _c):
            # deterministic per story via the body sentinel
            if body == "skip":
                return []
            if body == "low":
                return [{"slug": "b", "confidence": 0.3}]
            return [{"slug": "a", "confidence": 0.95}]

        stories = [
            {"id": "1", "title": "t", "body": "ok", "category": "Drama"},
            {"id": "2", "title": "t", "body": "low", "category": "Humor"},
            {"id": "3", "title": "t", "body": "skip", "category": "Dating"},
            {"id": "4", "title": "t", "body": "ok", "category": "Drama"},
        ]
        rep = build_reclassification_report(stories, CATEGORIES, fake)
        self.assertEqual(rep["total"], 4)
        self.assertEqual(rep["auto_tagged"], 2)
        self.assertEqual(rep["review_queue"], 2)
        self.assertEqual(rep["primary_counts"], {"a": 2})


class ApplyPlanTests(unittest.TestCase):
    def test_excludes_review_queue(self):
        report = {
            "proposals": [
                {"id": "1", "tags": [{"slug": "a", "confidence": 0.9}], "needs_review": False},
                {"id": "2", "tags": [], "needs_review": True},
                {"id": "3", "tags": [{"slug": "b", "confidence": 0.7}], "needs_review": False},
            ]
        }
        plan = apply_plan(report)
        self.assertEqual([p["story_id"] for p in plan], ["1", "3"])
        self.assertEqual(plan[0]["tags"], [{"slug": "a", "confidence": 0.9}])


class ReplaceStoryTagsDBTests(unittest.TestCase):
    """Integration test for the write path against a real isolated SQLite DB
    (mirrors the store-test harness: temp PIPELINE_DB + store.init())."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db_path = Path(self.tmpdir.name) / "test.db"
        self._patch = mock.patch.dict(
            os.environ,
            {"PIPELINE_DB": str(self.db_path), "DATABASE_URL": ""},
            clear=False,
        )
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

    def _rows(self, story_id):
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        try:
            return [
                dict(r)
                for r in conn.execute(
                    "SELECT category_slug, is_primary, source, confidence "
                    "FROM story_tags WHERE story_id = ? "
                    "ORDER BY is_primary DESC, category_slug",
                    (story_id,),
                ).fetchall()
            ]
        finally:
            conn.close()

    def test_writes_one_primary_and_extras(self):
        self.store.replace_story_tags(
            "s1", [{"slug": "a", "confidence": 0.9}, {"slug": "b", "confidence": 0.6}]
        )
        rows = self._rows("s1")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["category_slug"], "a")
        self.assertEqual(rows[0]["is_primary"], 1)
        self.assertEqual(rows[0]["source"], "llm")
        self.assertAlmostEqual(rows[0]["confidence"], 0.9)
        self.assertEqual(rows[1]["is_primary"], 0)

    def test_replace_swaps_tags_without_accumulation(self):
        self.store.replace_story_tags("s1", [{"slug": "a", "confidence": 0.9}])
        self.store.replace_story_tags("s1", [{"slug": "c", "confidence": 0.8}])
        rows = self._rows("s1")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["category_slug"], "c")
        self.assertEqual(rows[0]["is_primary"], 1)

    def test_exactly_one_primary_after_rewrite(self):
        self.store.replace_story_tags(
            "s1", [{"slug": "a", "confidence": 0.9}, {"slug": "b", "confidence": 0.5}]
        )
        self.store.replace_story_tags(
            "s1", [{"slug": "b", "confidence": 0.9}, {"slug": "a", "confidence": 0.4}]
        )
        rows = self._rows("s1")
        primaries = [r for r in rows if r["is_primary"] == 1]
        self.assertEqual(len(primaries), 1)
        self.assertEqual(primaries[0]["category_slug"], "b")


if __name__ == "__main__":
    unittest.main()
