"""Tests for pipeline.backfill_video_config.

The derive logic mirrors the editor's defaultVideoConfig in TS, so the
shapes need to stay consistent. These tests pin the Python side:
edge cases (missing audio, malformed JSON, empty alignment) and the
idempotency guard (rows with existing video_config are skipped).
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import backfill_video_config, store


class DeriveTests(unittest.TestCase):
    def test_returns_none_without_audio(self):
        self.assertIsNone(backfill_video_config.derive_video_config({}))
        self.assertIsNone(
            backfill_video_config.derive_video_config({"audio_url": ""}),
        )

    def test_minimal_row_produces_valid_shape(self):
        cfg = backfill_video_config.derive_video_config({
            "audio_url": "/v.mp3",
            "title": "Hi",
        })
        assert cfg is not None
        self.assertEqual(cfg["voiceover_url"], "/v.mp3")
        self.assertEqual(cfg["title"], "Hi")
        self.assertEqual(cfg["doodle_frames"], [])
        self.assertEqual(cfg["captions"], [])
        self.assertEqual(cfg["duration_ms"], 0)
        self.assertEqual(cfg["config_version"], 2)
        self.assertEqual(cfg["channel_name"], "lorewire")

    def test_alignment_drives_duration(self):
        cfg = backfill_video_config.derive_video_config({
            "audio_url": "/v.mp3",
            "alignment": json.dumps([
                {"start_ms": 0, "end_ms": 2000, "text": "one"},
                {"start_ms": 2000, "end_ms": 6500, "text": "two"},
            ]),
        })
        assert cfg is not None
        self.assertEqual(cfg["duration_ms"], 6500)
        self.assertEqual(len(cfg["captions"]), 2)

    def test_images_distributed_across_captions(self):
        cfg = backfill_video_config.derive_video_config({
            "audio_url": "/v.mp3",
            "images": json.dumps(["/a.png", "/b.png", "/c.png"]),
            "alignment": json.dumps([
                {"start_ms": 0, "end_ms": 1000, "text": "1"},
                {"start_ms": 1000, "end_ms": 2000, "text": "2"},
                {"start_ms": 2000, "end_ms": 3000, "text": "3"},
                {"start_ms": 3000, "end_ms": 4000, "text": "4"},
                {"start_ms": 4000, "end_ms": 5000, "text": "5"},
                {"start_ms": 5000, "end_ms": 6000, "text": "6"},
            ]),
        })
        assert cfg is not None
        # 3 images across 6 captions: indices land at 0, 2, 4.
        self.assertEqual(len(cfg["doodle_frames"]), 3)
        idxs = [f["caption_chunk_start_index"] for f in cfg["doodle_frames"]]
        self.assertEqual(idxs, [0, 2, 4])

    def test_malformed_json_treated_as_empty(self):
        cfg = backfill_video_config.derive_video_config({
            "audio_url": "/v.mp3",
            "images": "{not json",
            "alignment": "}also bad",
        })
        assert cfg is not None
        self.assertEqual(cfg["doodle_frames"], [])
        self.assertEqual(cfg["captions"], [])

    def test_non_string_image_entries_skipped(self):
        # If the column got corrupted somehow, don't crash — just skip
        # the bad entries.
        cfg = backfill_video_config.derive_video_config({
            "audio_url": "/v.mp3",
            "images": json.dumps(["/ok.png", 42, None, "/also-ok.png"]),
            "alignment": json.dumps([
                {"start_ms": 0, "end_ms": 1000, "text": "x"},
            ]),
        })
        assert cfg is not None
        self.assertEqual(len(cfg["doodle_frames"]), 2)


# ─── End-to-end against a temp SQLite ────────────────────────────────────────


class BackfillCommandTests(unittest.TestCase):
    """Same temp-SQLite plumbing as test_render_queue. We seed a few rows
    and assert the backfill action picks up the right ones."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        db_path = Path(self._tmpdir.name) / "backfill.db"
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

    def _insert_story(self, **fields):
        # upsert_story handles serialization but expects every column key.
        # We pass through whatever the test gives us — store handles defaults.
        defaults = {"id": fields.get("id", "x")}
        defaults.update(fields)
        store.upsert_story(defaults)

    def test_dry_run_does_not_write(self):
        self._insert_story(
            id="a",
            audio_url="/v.mp3",
            alignment=json.dumps([
                {"start_ms": 0, "end_ms": 2000, "text": "hi"},
            ]),
        )
        summary = backfill_video_config.backfill_all(dry_run=True)
        self.assertEqual(summary["candidates"], 1)
        self.assertEqual(summary["written"], 1)
        # But the row is still NULL in the DB.
        row = store.fetch_story("a")
        assert row is not None
        self.assertFalse(row.get("video_config"))

    def test_full_run_writes_config(self):
        self._insert_story(
            id="a",
            audio_url="/v.mp3",
            title="Hi",
        )
        summary = backfill_video_config.backfill_all(dry_run=False)
        self.assertEqual(summary["written"], 1)
        row = store.fetch_story("a")
        assert row is not None
        cfg = json.loads(row["video_config"])
        self.assertEqual(cfg["title"], "Hi")
        self.assertEqual(cfg["voiceover_url"], "/v.mp3")

    def test_rows_without_audio_are_skipped(self):
        self._insert_story(id="no-audio", title="No audio")
        summary = backfill_video_config.backfill_all(dry_run=False)
        # `_list_unconfigured_story_ids` filters on audio_url IS NOT NULL,
        # so this row never reaches `derive_video_config` and the
        # candidates count is 0.
        self.assertEqual(summary["candidates"], 0)
        self.assertEqual(summary["written"], 0)

    def test_rows_with_existing_config_are_skipped(self):
        self._insert_story(
            id="a",
            audio_url="/v.mp3",
            video_config=json.dumps({
                "config_version": 2,
                "voiceover_url": "/v.mp3",
                "duration_ms": 1000,
                "doodle_frames": [],
                "captions": [],
            }),
        )
        summary = backfill_video_config.backfill_all(dry_run=False)
        # The list query excludes rows with non-empty video_config.
        self.assertEqual(summary["candidates"], 0)

    def test_single_story_mode(self):
        self._insert_story(id="a", audio_url="/v.mp3")
        result = backfill_video_config.backfill_one("a")
        self.assertEqual(result["status"], "written")
        row = store.fetch_story("a")
        assert row is not None
        self.assertTrue(row["video_config"])

    def test_single_story_not_found(self):
        result = backfill_video_config.backfill_one("nope")
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "not-found")


if __name__ == "__main__":
    unittest.main()
