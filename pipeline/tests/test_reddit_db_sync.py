"""Tests for pipeline.reddit_db_sync.

We exercise the parser against small in-tree fixtures and the actual export
under ref/ (smoke test only — the count is a moving target so we just
assert "lots of rows"). The upsert path is tested on an isolated SQLite DB
spun up per-test by pointing DB_PATH at a tmpfile.
"""
from __future__ import annotations

import csv
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _write_csv(path: Path, rows: list[dict]) -> None:
    """Write a CSV with the canonical 9 headers and the rows provided.
    Missing keys in a row dict are written as empty cells (matches what
    a real export looks like for empty source cells)."""
    from pipeline.reddit_db_sync import EXPECTED_HEADERS
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=EXPECTED_HEADERS)
        w.writeheader()
        for r in rows:
            w.writerow({h: r.get(h, "") for h in EXPECTED_HEADERS})


class ParserTests(unittest.TestCase):
    def test_happy_path(self):
        from pipeline.reddit_db_sync import parse_csv
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "tiny.csv"
            _write_csv(p, [{
                "Reddit ID": "abc123",
                "Subreddit": "AITAH",
                "Date Written": "2026-03-06 00:02",
                "Title": "test title",
                "Full Text": "body of the post",
                "Comments": "42",
                "URL": "https://reddit.com/r/AITAH/abc123",
                "Summary": "short summary",
                "How Long it Is": "16",
            }])
            rows, warnings = parse_csv(p)
        self.assertEqual(len(rows), 1)
        self.assertEqual(warnings, [])
        r = rows[0]
        self.assertEqual(r["reddit_id"], "abc123")
        self.assertEqual(r["subreddit"], "AITAH")
        self.assertEqual(r["title"], "test title")
        self.assertEqual(r["full_text"], "body of the post")
        self.assertEqual(r["comments"], 42)
        self.assertEqual(r["length_chars"], 16)
        self.assertEqual(r["status"], "imported")
        self.assertIsNone(r["story_id"])
        self.assertIsNone(r["notes"])
        self.assertTrue(r["date_written"].startswith("2026-03-06T00:02"))

    def test_missing_required_field_skipped_with_warning(self):
        from pipeline.reddit_db_sync import parse_csv
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "bad.csv"
            _write_csv(p, [
                {"Reddit ID": "ok", "Subreddit": "AITAH",
                 "Date Written": "2026-01-01 00:00", "Title": "t",
                 "Full Text": "body", "Comments": "1", "URL": "",
                 "Summary": "", "How Long it Is": "4"},
                {"Reddit ID": "", "Subreddit": "AITAH",
                 "Date Written": "2026-01-01 00:00", "Title": "t",
                 "Full Text": "body", "Comments": "1", "URL": "",
                 "Summary": "", "How Long it Is": "4"},
                {"Reddit ID": "nosub", "Subreddit": "",
                 "Date Written": "2026-01-01 00:00", "Title": "t",
                 "Full Text": "body", "Comments": "1", "URL": "",
                 "Summary": "", "How Long it Is": "4"},
            ])
            rows, warnings = parse_csv(p)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["reddit_id"], "ok")
        self.assertEqual(len(warnings), 2)
        self.assertTrue(any("blank Reddit ID" in w for w in warnings))
        self.assertTrue(any("missing required field" in w for w in warnings))

    def test_duplicate_id_within_file_warns_and_keeps_latest(self):
        from pipeline.reddit_db_sync import parse_csv
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dupe.csv"
            _write_csv(p, [
                {"Reddit ID": "dup", "Subreddit": "AITAH",
                 "Date Written": "2026-01-01 00:00", "Title": "first",
                 "Full Text": "body1", "Comments": "5", "URL": "",
                 "Summary": "", "How Long it Is": "5"},
                {"Reddit ID": "dup", "Subreddit": "AITAH",
                 "Date Written": "2026-01-02 00:00", "Title": "second",
                 "Full Text": "body2", "Comments": "10", "URL": "",
                 "Summary": "", "How Long it Is": "5"},
            ])
            rows, warnings = parse_csv(p)
        # Both rows are kept (parser is honest); the upsert path is the
        # one that collapses by reddit_id. Warning must surface the dup.
        self.assertEqual(len(rows), 2)
        self.assertTrue(any("duplicate Reddit ID" in w for w in warnings))

    def test_missing_header_is_hard_error(self):
        from pipeline.reddit_db_sync import parse_csv
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "wrong.csv"
            with p.open("w", encoding="utf-8", newline="") as f:
                w = csv.writer(f)
                w.writerow(["Reddit ID", "Subreddit", "Title"])  # missing 6 columns
                w.writerow(["x", "y", "z"])
            with self.assertRaises(ValueError) as cm:
                parse_csv(p)
        self.assertIn("missing required header columns", str(cm.exception))

    def test_unparseable_date_passes_through_with_warning(self):
        from pipeline.reddit_db_sync import parse_csv
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "baddate.csv"
            _write_csv(p, [{
                "Reddit ID": "x", "Subreddit": "AITAH",
                "Date Written": "yesterday-ish", "Title": "t",
                "Full Text": "b", "Comments": "1", "URL": "",
                "Summary": "", "How Long it Is": "1",
            }])
            rows, warnings = parse_csv(p)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["date_written"], "yesterday-ish")
        self.assertTrue(any("not in YYYY-MM-DD HH:MM" in w for w in warnings))

    def test_length_falls_back_to_full_text_len(self):
        from pipeline.reddit_db_sync import parse_csv
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "nolen.csv"
            _write_csv(p, [{
                "Reddit ID": "x", "Subreddit": "AITAH",
                "Date Written": "2026-01-01 00:00", "Title": "t",
                "Full Text": "hello world",  # 11 chars
                "Comments": "1", "URL": "",
                "Summary": "", "How Long it Is": "",
            }])
            rows, _ = parse_csv(p)
        self.assertEqual(rows[0]["length_chars"], 11)

    def test_real_export_smoke(self):
        """Smoke test: parse the actual export the user dropped under ref/.
        Count is loose (the sheet keeps growing); we just want to confirm
        the parser doesn't blow up on the real corpus."""
        from pipeline.reddit_db_sync import parse_csv
        candidates = list(
            (REPO_ROOT / "ref").glob("MSN-RSS-Researcher-Reddit*RedditDB*.csv")
        )
        if not candidates:
            self.skipTest("no real export present under ref/")
        rows, _ = parse_csv(candidates[0])
        self.assertGreater(len(rows), 1000)
        for r in rows[:5]:
            self.assertTrue(r["reddit_id"])
            self.assertTrue(r["subreddit"])
            self.assertTrue(r["title"])


class ApplyTests(unittest.TestCase):
    """End-to-end against a throwaway SQLite DB. We point DB_PATH at a
    tmpfile per test so the sync's upsert path runs through the real
    store helpers — the diff counts are then meaningful."""

    def setUp(self):
        # ignore_cleanup_errors: Windows holds the sqlite3 file handle past the
        # tempdir finalizer occasionally (matches the codebase convention in
        # test_render_queue.py and friends). The leak is benign in tests.
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db_path = Path(self.tmpdir.name) / "test.db"
        self._patch = mock.patch.dict(os.environ, {
            "PIPELINE_DB": str(self.db_path),
            "DATABASE_URL": "",
        }, clear=False)
        self._patch.start()
        # The store module captures DB_PATH at import time, so reload after
        # patching so its module-level constant picks up the env override.
        from pipeline import config, store
        from importlib import reload
        reload(config)
        reload(store)
        store.init()

    def tearDown(self):
        self._patch.stop()
        self.tmpdir.cleanup()
        # Reload back to the default so other tests see the original DB_PATH.
        from pipeline import config, store
        from importlib import reload
        reload(config)
        reload(store)

    def _fixture_rows(self) -> list[dict]:
        from pipeline.reddit_db_sync import parse_csv
        p = Path(self.tmpdir.name) / "fixture.csv"
        _write_csv(p, [
            {"Reddit ID": "a1", "Subreddit": "AITAH",
             "Date Written": "2026-01-01 00:00", "Title": "First",
             "Full Text": "body one", "Comments": "10", "URL": "",
             "Summary": "summary one", "How Long it Is": "8"},
            {"Reddit ID": "b2", "Subreddit": "relationships",
             "Date Written": "2026-01-02 00:00", "Title": "Second",
             "Full Text": "body two with more chars", "Comments": "20",
             "URL": "", "Summary": "summary two", "How Long it Is": "24"},
        ])
        rows, _ = parse_csv(p)
        return rows

    def test_fresh_sync_counts_as_new(self):
        from pipeline.reddit_db_sync import apply
        diff = apply(self._fixture_rows())
        self.assertEqual(diff["new"], 2)
        self.assertEqual(diff["updated"], 0)
        self.assertEqual(diff["unchanged"], 0)
        self.assertEqual(diff["errors"], 0)

    def test_resync_unchanged_is_noop(self):
        from pipeline.reddit_db_sync import apply
        apply(self._fixture_rows())
        diff = apply(self._fixture_rows())
        self.assertEqual(diff["new"], 0)
        self.assertEqual(diff["updated"], 0)
        self.assertEqual(diff["unchanged"], 2)

    def test_resync_with_content_change_counts_as_updated(self):
        from pipeline.reddit_db_sync import apply
        rows = self._fixture_rows()
        apply(rows)
        rows[0]["comments"] = 999  # simulate a more recent export with grown comments
        diff = apply(rows)
        self.assertEqual(diff["updated"], 1)
        self.assertEqual(diff["unchanged"], 1)

    def test_admin_state_preserved_across_resync(self):
        from pipeline import store
        from pipeline.reddit_db_sync import apply
        apply(self._fixture_rows())
        store.set_reddit_source_status("a1", "queued", story_id="story-abc", notes="picked")
        # Mutate content and re-sync — admin state must survive.
        rows = self._fixture_rows()
        rows[0]["title"] = "First (edited upstream)"
        rows[0]["comments"] = 50
        apply(rows)
        row = store.fetch_reddit_source("a1")
        self.assertEqual(row["status"], "queued")
        self.assertEqual(row["story_id"], "story-abc")
        self.assertEqual(row["notes"], "picked")
        self.assertEqual(row["title"], "First (edited upstream)")
        self.assertEqual(row["comments"], 50)

    def test_dry_run_writes_nothing(self):
        from pipeline import store
        from pipeline.reddit_db_sync import apply
        diff = apply(self._fixture_rows(), dry_run=True)
        self.assertEqual(diff["new"], 2)
        self.assertIsNone(store.fetch_reddit_source("a1"))
        self.assertIsNone(store.fetch_reddit_source("b2"))


if __name__ == "__main__":
    unittest.main()
