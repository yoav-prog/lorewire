"""Tests for the Lane B builder (Phase 3 of the short editor plan).

What we lock down: every ValueError surface on lane_inputs validation +
the happy path where the builder reuses baseline frames and only
synthesizes new voice + captions. The actual TTS path is stubbed —
that's exercised by the voice suite — we focus on the merge logic.

Plan: _plans/2026-06-16-short-editor-full-parity.md.
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import shorts_lane_b, store


class _LaneBTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        db_path = Path(self._tmpdir.name) / "lane-b.db"
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

    def _seed_baseline(self, render_id: str, story_id: str, props: dict) -> None:
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "INSERT INTO short_renders "
                "(id, story_id, config_hash, narration_style, length_preset, "
                " status, phase, progress, error, output_url, props, "
                " requested_by, requested_at, started_at, finished_at, "
                " lane, lane_inputs) "
                "VALUES (?, ?, ?, 'suspense', 'standard', 'done', 'done', 1, "
                "        NULL, 'https://gcs/done.mp4', ?, NULL, ?, NULL, ?, "
                "        NULL, NULL)",
                (
                    render_id,
                    story_id,
                    f"hash-{render_id}",
                    json.dumps(props),
                    "2026-06-16T00:00:00.000Z",
                    "2026-06-16T00:01:00.000Z",
                ),
            )


class ValidationTests(_LaneBTestCase):
    def test_missing_lane_inputs_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_b.build_short_props_lane_b(
                {"story_id": "s", "lane_inputs": None}, Path("."),
            )
        self.assertIn("lane_inputs", str(cm.exception))

    def test_malformed_lane_inputs_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_b.build_short_props_lane_b(
                {"story_id": "s", "lane_inputs": "{not json"}, Path("."),
            )
        self.assertIn("malformed", str(cm.exception))

    def test_lane_inputs_must_be_object(self):
        with self.assertRaises(ValueError):
            shorts_lane_b.build_short_props_lane_b(
                {"story_id": "s", "lane_inputs": '"not an object"'}, Path("."),
            )

    def test_missing_source_render_id_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_b.build_short_props_lane_b(
                {
                    "story_id": "s",
                    "lane_inputs": json.dumps({"script": "hi"}),
                },
                Path("."),
            )
        self.assertIn("source_render_id", str(cm.exception))

    def test_missing_script_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_b.build_short_props_lane_b(
                {
                    "story_id": "s",
                    "lane_inputs": json.dumps({"source_render_id": "r"}),
                },
                Path("."),
            )
        self.assertIn("script", str(cm.exception))

    def test_blank_script_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_b.build_short_props_lane_b(
                {
                    "story_id": "s",
                    "lane_inputs": json.dumps(
                        {"source_render_id": "r", "script": "   "},
                    ),
                },
                Path("."),
            )
        self.assertIn("script", str(cm.exception))

    def test_too_short_script_raises_below_floor(self):
        # 2026-06-16 QA fix: a 1-char script burns a TTS call for nothing
        # useful. Floor is 10 chars; below that the builder raises.
        with self.assertRaises(ValueError) as cm:
            shorts_lane_b.build_short_props_lane_b(
                {
                    "story_id": "s",
                    "lane_inputs": json.dumps(
                        {"source_render_id": "r", "script": "hi"},
                    ),
                },
                Path("."),
            )
        self.assertIn("too short", str(cm.exception))

    def test_at_min_length_proceeds_past_validation(self):
        # 10 chars exactly should pass the floor (the rest of the path
        # then fails on the unknown baseline, which is the next gate;
        # we only assert the script-floor doesn't fire).
        with self.assertRaises(ValueError) as cm:
            shorts_lane_b.build_short_props_lane_b(
                {
                    "story_id": "s",
                    "lane_inputs": json.dumps(
                        {
                            "source_render_id": "ghost",
                            "script": "ten chars!",  # 10 chars
                        },
                    ),
                },
                Path("."),
            )
        # Whatever the error is, it should NOT be "too short".
        self.assertNotIn("too short", str(cm.exception))

    def test_unknown_source_render_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_b.build_short_props_lane_b(
                {
                    "story_id": "s",
                    "lane_inputs": json.dumps(
                        {"source_render_id": "ghost", "script": "hi there, this is plenty long"},
                    ),
                },
                Path("."),
            )
        self.assertIn("not found", str(cm.exception))

    def test_baseline_without_props_raises(self):
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "INSERT INTO short_renders "
                "(id, story_id, config_hash, status, progress, props, requested_at) "
                "VALUES ('no-props', 's', 'h', 'done', 1, NULL, "
                "        '2026-06-16T00:00:00.000Z')",
            )
        with self.assertRaises(ValueError) as cm:
            shorts_lane_b.build_short_props_lane_b(
                {
                    "story_id": "s",
                    "lane_inputs": json.dumps(
                        {"source_render_id": "no-props", "script": "hi there, this is plenty long"},
                    ),
                },
                Path("."),
            )
        self.assertIn("no props", str(cm.exception))

    def test_voice_override_wrong_shape_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_b.build_short_props_lane_b(
                {
                    "story_id": "s",
                    "lane_inputs": json.dumps(
                        {
                            "source_render_id": "r",
                            "script": "hi there, this is plenty long",
                            "voice": {"provider": "google"},  # voice_id missing
                        },
                    ),
                },
                Path("."),
            )
        self.assertIn("voice_id", str(cm.exception))


class HappyPathTests(_LaneBTestCase):
    def _baseline_props(self) -> dict:
        return {
            "config_version": 2,
            "voiceover_url": "https://gcs/old-voice.mp3",
            "duration_ms": 30000,
            "aspect": "9:16",
            "title": "Old title",
            "channel_name": "lorewire",
            "doodle_frames": [
                {
                    "id": "frame-00",
                    "url": "https://gcs/00.png",
                    "caption_chunk_start_index": 0,
                },
                {
                    "id": "frame-01",
                    "url": "https://gcs/01.png",
                    "caption_chunk_start_index": 3,
                },
            ],
            "captions": [
                {"start_ms": 0, "end_ms": 2000, "text": "old line"},
            ],
            "character_image_mouth_removed": None,
        }

    def test_reuses_baseline_frames_and_swaps_voice_captions_duration(self):
        self._seed_baseline("baseline-r", "story-1", self._baseline_props())

        claimed = {
            "id": "lane-b-row",
            "story_id": "story-1",
            "lane_inputs": json.dumps(
                {
                    "source_render_id": "baseline-r",
                    "script": "Brand new narration text",
                    "voice": None,
                },
            ),
        }

        fake_words = [
            {"word": "Brand", "start": 0.0, "end": 0.6},
            {"word": "new", "start": 0.6, "end": 1.0},
            {"word": "narration", "start": 1.0, "end": 1.9},
            {"word": "text", "start": 1.9, "end": 2.4},
        ]

        with (
            mock.patch.object(
                shorts_lane_b.voice,
                "synthesize",
                return_value={"words": fake_words, "audio": "voice.mp3", "provider": "g"},
            ) as mock_synth,
            mock.patch.object(
                shorts_lane_b.gcs,
                "publish",
                side_effect=lambda local, key, fallback: f"https://gcs/{key}",
            ),
        ):
            built = shorts_lane_b.build_short_props_lane_b(
                claimed, Path(self._tmpdir.name), remote=True,
            )

        # Voice was synthesized with the new script + no override.
        mock_synth.assert_called_once()
        call_args = mock_synth.call_args
        self.assertEqual(call_args.args[0], "Brand new narration text")
        self.assertIsNone(call_args.kwargs.get("override_provider"))
        self.assertIsNone(call_args.kwargs.get("override_voice_id"))

        # Built props REUSE the baseline frames + meta, REPLACE voice +
        # captions + duration_ms.
        self.assertEqual(
            built.props["doodle_frames"],
            self._baseline_props()["doodle_frames"],
        )
        self.assertEqual(built.props["title"], "Old title")
        # New voice url (under the Lane-B-suffixed key).
        self.assertIn("voice-laneB", built.props["voiceover_url"])
        # New duration matches the alignment's end (2.4s -> ~2400ms).
        self.assertGreater(built.props["duration_ms"], 1000)
        # Captions came from the chunker over the new alignment.
        self.assertGreater(len(built.props["captions"]), 0)

    def test_passes_voice_override_through_to_synthesize(self):
        self._seed_baseline("baseline-v", "story-2", self._baseline_props())
        claimed = {
            "id": "lane-b-vov",
            "story_id": "story-2",
            "lane_inputs": json.dumps(
                {
                    "source_render_id": "baseline-v",
                    "script": "Whatever long enough",
                    "voice": {"provider": "elevenlabs", "voice_id": "abc-123"},
                },
            ),
        }

        with (
            mock.patch.object(
                shorts_lane_b.voice,
                "synthesize",
                return_value={"words": [{"word": "x", "start": 0, "end": 0.3}],
                              "audio": "voice.mp3", "provider": "e"},
            ) as mock_synth,
            mock.patch.object(
                shorts_lane_b.gcs,
                "publish",
                side_effect=lambda local, key, fallback: f"https://gcs/{key}",
            ),
        ):
            shorts_lane_b.build_short_props_lane_b(
                claimed, Path(self._tmpdir.name), remote=True,
            )

        self.assertEqual(
            mock_synth.call_args.kwargs.get("override_provider"), "elevenlabs",
        )
        self.assertEqual(
            mock_synth.call_args.kwargs.get("override_voice_id"), "abc-123",
        )


class ClearLaneTests(_LaneBTestCase):
    def test_clear_lane_nulls_the_column(self):
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "INSERT INTO short_renders "
                "(id, story_id, config_hash, status, progress, requested_at, lane) "
                "VALUES ('rid', 's', 'h', 'queued', 0, '2026-06-16T00:00:00Z', 'B')",
            )
        shorts_lane_b.clear_lane("rid")
        row = store.get_short_render("rid")
        assert row is not None
        self.assertIsNone(row["lane"])


if __name__ == "__main__":
    unittest.main()
