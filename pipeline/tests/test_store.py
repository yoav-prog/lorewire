"""Tests for pipeline.store dispatch: SQLite locally, Postgres when
DATABASE_URL is set. We do not hit a real Postgres in unit tests; what we
guard is that the dispatcher reads the env var correctly and that the JSON
serialization path produces the same shape regardless of driver.
"""
from __future__ import annotations

import os
import unittest
from unittest import mock

from pipeline import store


class DispatchTests(unittest.TestCase):
    def test_sqlite_when_database_url_unset(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DATABASE_URL", None)
            self.assertFalse(store._is_postgres())

    def test_postgres_when_database_url_set(self):
        with mock.patch.dict(os.environ, {"DATABASE_URL": "postgresql://x"}, clear=False):
            self.assertTrue(store._is_postgres())

    def test_blank_database_url_treated_as_unset(self):
        with mock.patch.dict(os.environ, {"DATABASE_URL": ""}, clear=False):
            self.assertFalse(store._is_postgres())


class SerializeTests(unittest.TestCase):
    def test_json_columns_become_text(self):
        out = store._serialize({"id": "x", "images": ["a", "b"], "alignment": [{"w": 1}]})
        self.assertEqual(out["images"], '["a", "b"]')
        self.assertEqual(out["alignment"], '[{"w": 1}]')

    def test_already_text_passes_through(self):
        out = store._serialize({"id": "x", "images": '["already"]'})
        self.assertEqual(out["images"], '["already"]')

    def test_unset_columns_become_none(self):
        out = store._serialize({"id": "x"})
        # Every defined column must be present in the row dict; absent inputs
        # come back as None so the named-placeholder upsert doesn't blow up.
        self.assertIn("title", out)
        self.assertIsNone(out["title"])
        self.assertIn("alignment", out)


if __name__ == "__main__":
    unittest.main()
