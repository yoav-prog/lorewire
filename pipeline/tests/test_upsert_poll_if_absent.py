"""Tests for store.upsert_poll_if_absent — the Python-side write that the
shorts hook-first pipeline uses to plant a poll draft alongside the script.

What we lock down: the helper writes a new row when no poll exists, does
NOT overwrite an existing poll (admin edits are sacred), rejects unusable
inputs, and survives a missing polls table without raising (the burnt-in
card just skips that render rather than failing the whole short).

Spec: _plans/2026-06-21-shorts-hook-first-restructure.md §5.3.
"""
from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import store


class _PollUpsertTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        db_path = Path(self._tmpdir.name) / "polls.db"
        self._db_patch = mock.patch.object(store, "DB_PATH", str(db_path))
        self._db_patch.start()
        self._env_patch = mock.patch.dict(os.environ, {}, clear=False)
        self._env_patch.start()
        os.environ.pop("DATABASE_URL", None)
        # store.init() doesn't create the polls table (TS-authored); we
        # create the minimal schema we need by hand to mirror the TS shape.
        store.init()
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "CREATE TABLE IF NOT EXISTS polls ("
                "id TEXT PRIMARY KEY, "
                "story_id TEXT, "
                "article_id TEXT, "
                "question TEXT, "
                "option_a_text TEXT, "
                "option_b_text TEXT, "
                "enabled INTEGER, "
                "category TEXT, "
                "created_at TEXT, "
                "updated_at TEXT)"
            )

    def tearDown(self) -> None:
        self._db_patch.stop()
        self._env_patch.stop()
        self._tmpdir.cleanup()

    def _fetch_all(self, story_id: str) -> list[dict]:
        with sqlite3.connect(store.DB_PATH) as c:
            c.row_factory = sqlite3.Row
            rows = c.execute(
                "SELECT * FROM polls WHERE story_id = ?", (story_id,),
            ).fetchall()
            return [dict(r) for r in rows]


class WritesNewPollTests(_PollUpsertTestCase):
    def test_inserts_when_no_existing_poll(self) -> None:
        wrote = store.upsert_poll_if_absent(
            "story-1", "Who's wrong?", "Poster", "Cousin",
            category="entitled", article_id="article-1",
        )
        self.assertTrue(wrote)
        rows = self._fetch_all("story-1")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["question"], "Who's wrong?")
        self.assertEqual(rows[0]["option_a_text"], "Poster")
        self.assertEqual(rows[0]["option_b_text"], "Cousin")
        self.assertEqual(rows[0]["category"], "entitled")
        self.assertEqual(rows[0]["article_id"], "article-1")
        # New drafts default enabled so the burnt-in card fires on the same
        # render — admin doesn't have to do anything to ship a working poll.
        self.assertEqual(rows[0]["enabled"], 1)
        self.assertTrue(rows[0]["id"])
        self.assertTrue(rows[0]["created_at"])
        self.assertEqual(rows[0]["created_at"], rows[0]["updated_at"])


class PreservesExistingPollTests(_PollUpsertTestCase):
    def _seed(self, story_id: str, enabled: int) -> None:
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "INSERT INTO polls "
                "(id, story_id, article_id, question, option_a_text, option_b_text, "
                " enabled, category, created_at, updated_at) "
                "VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "admin-poll-id", story_id, "Admin-edited question?",
                    "Admin A", "Admin B", enabled, "drama",
                    "2026-06-20T00:00:00Z", "2026-06-20T00:00:00Z",
                ),
            )

    def test_skips_when_enabled_poll_exists(self) -> None:
        self._seed("story-2", enabled=1)
        wrote = store.upsert_poll_if_absent(
            "story-2", "Pipeline draft?", "X", "Y", category="drama",
        )
        self.assertFalse(wrote)
        rows = self._fetch_all("story-2")
        self.assertEqual(len(rows), 1)
        # The admin-edited content is untouched.
        self.assertEqual(rows[0]["question"], "Admin-edited question?")
        self.assertEqual(rows[0]["option_a_text"], "Admin A")

    def test_skips_when_disabled_poll_exists(self) -> None:
        # Even a disabled poll counts as "exists" — we never silently
        # promote a disabled poll back to enabled, and we never replace
        # one the admin may have intentionally turned off.
        self._seed("story-3", enabled=0)
        wrote = store.upsert_poll_if_absent(
            "story-3", "Pipeline draft?", "X", "Y",
        )
        self.assertFalse(wrote)
        rows = self._fetch_all("story-3")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["enabled"], 0)


class InputValidationTests(_PollUpsertTestCase):
    def test_empty_story_id_returns_false(self) -> None:
        wrote = store.upsert_poll_if_absent("", "Q?", "A", "B")
        self.assertFalse(wrote)

    def test_empty_question_returns_false(self) -> None:
        wrote = store.upsert_poll_if_absent("story-4", "   ", "A", "B")
        self.assertFalse(wrote)
        self.assertEqual(self._fetch_all("story-4"), [])

    def test_empty_option_returns_false(self) -> None:
        wrote = store.upsert_poll_if_absent("story-5", "Q?", "", "B")
        self.assertFalse(wrote)
        self.assertEqual(self._fetch_all("story-5"), [])


class MissingTableTests(unittest.TestCase):
    """If the polls table doesn't exist (first-boot ordering against a fresh
    DB), the helper must return False rather than raising. The burnt-in card
    skips that render but the short itself still renders."""

    def test_no_table_no_raise(self) -> None:
        tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(tmpdir.cleanup)
        db_path = Path(tmpdir.name) / "no-polls.db"
        # Empty DB — no schema applied.
        with mock.patch.object(store, "DB_PATH", str(db_path)), \
                mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DATABASE_URL", None)
            wrote = store.upsert_poll_if_absent(
                "story-x", "Q?", "A", "B",
            )
            self.assertFalse(wrote)


if __name__ == "__main__":
    unittest.main()
