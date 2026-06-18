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


class SyncShortConfigCaptionsTests(unittest.TestCase):
    """After a Lane B voice re-render, the new captions must be mirrored into
    the editor's short_config so the editor preview + Captions tab match the
    new voiceover (the MP4 already reads props and is correct). Only the three
    voice-driven fields sync; everything else in short_config is preserved.
    See _plans/2026-06-17-shorts-editor-and-character-bugs.md."""

    def test_syncs_three_fields_and_preserves_rest(self):
        existing = {
            "doodle_frames": [{"id": "frame-00", "url": "u0", "caption_chunk_start_index": 0}],
            "captions": [{"start_ms": 0, "end_ms": 100, "text": "OLD"}],
            "caption_style": {"highlight": "yellow"},
            "voiceover_url": "old.mp3",
            "duration_ms": 100,
            "character_base_url": "https://gcs/base.png",
        }
        props = {
            "captions": [
                {"start_ms": 0, "end_ms": 500, "text": "new one", "words": [{"word": "new"}]},
                {"start_ms": 500, "end_ms": 1000, "text": "two"},
            ],
            "voiceover_url": "new.mp3",
            "duration_ms": 1000,
        }
        captured: dict = {}
        with mock.patch.object(
            shorts_lane_b.store, "fetch_story",
            return_value={"short_config": json.dumps(existing)},
        ), mock.patch.object(
            shorts_lane_b.store, "update_story_short_config",
            side_effect=lambda sid, cfg: captured.update(cfg=cfg),
        ):
            ok = shorts_lane_b.sync_short_config_captions("s1", props)
        self.assertTrue(ok)
        cfg = captured["cfg"]
        self.assertEqual([c["text"] for c in cfg["captions"]], ["new one", "two"])
        # Per-word boundaries are dropped — short_config doesn't store them.
        self.assertNotIn("words", cfg["captions"][0])
        self.assertEqual(cfg["voiceover_url"], "new.mp3")
        self.assertEqual(cfg["duration_ms"], 1000)
        # Untouched fields survive.
        self.assertEqual(cfg["doodle_frames"], existing["doodle_frames"])
        self.assertEqual(cfg["caption_style"], {"highlight": "yellow"})
        self.assertEqual(cfg["character_base_url"], "https://gcs/base.png")

    def test_noop_when_no_short_config(self):
        with mock.patch.object(
            shorts_lane_b.store, "fetch_story", return_value={"short_config": None},
        ), mock.patch.object(
            shorts_lane_b.store, "update_story_short_config",
        ) as upd:
            self.assertFalse(
                shorts_lane_b.sync_short_config_captions("s1", {"captions": []})
            )
            upd.assert_not_called()

    def test_noop_when_story_missing(self):
        with mock.patch.object(
            shorts_lane_b.store, "fetch_story", return_value=None,
        ), mock.patch.object(
            shorts_lane_b.store, "update_story_short_config",
        ) as upd:
            self.assertFalse(
                shorts_lane_b.sync_short_config_captions("s1", {"captions": []})
            )
            upd.assert_not_called()


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
            mock.patch(
                "pipeline.voice.synthesize",
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
            mock.patch(
                "pipeline.voice.synthesize",
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


class CaptionStyleOverrideTests(_LaneBTestCase):
    """Lane B merges short_config.caption_style onto baseline.caption_template
    so the Style tab's picks roll into a voice-track re-render."""

    def _seed_story_with_style(
        self, story_id: str, caption_style: dict | None,
    ) -> None:
        short_config = {
            "config_version": 1,
            "doodle_frames": [],
            "captions": [],
        }
        if caption_style is not None:
            short_config["caption_style"] = caption_style
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "INSERT INTO stories (id, slug, title, status, short_config) "
                "VALUES (?, ?, ?, 'ready', ?)",
                (story_id, f"slug-{story_id}", f"Title {story_id}",
                 json.dumps(short_config)),
            )

    def _build_with_style(self, story_id: str, baseline_template: dict | None):
        props = {
            "config_version": 2,
            "voiceover_url": "https://gcs/old-voice.mp3",
            "duration_ms": 30000,
            "doodle_frames": [],
            "captions": [],
        }
        if baseline_template is not None:
            props["caption_template"] = baseline_template
        self._seed_baseline("base-style", story_id, props)
        claimed = {
            "id": "lane-b-style",
            "story_id": story_id,
            "lane_inputs": json.dumps({
                "source_render_id": "base-style",
                "script": "Some script that is plenty long enough",
                "voice": None,
            }),
        }
        with (
            mock.patch(
                "pipeline.voice.synthesize",
                return_value={
                    "words": [{"word": "a", "start": 0, "end": 0.5}],
                    "audio": "x", "provider": "g",
                },
            ),
            mock.patch.object(
                shorts_lane_b.gcs, "publish",
                side_effect=lambda local, key, fallback: f"https://gcs/{key}",
            ),
        ):
            return shorts_lane_b.build_short_props_lane_b(
                claimed, Path(self._tmpdir.name), remote=True,
            )

    def test_no_style_override_leaves_caption_template_alone(self):
        self._seed_story_with_style("story-no-style", None)
        built = self._build_with_style(
            "story-no-style",
            baseline_template={"color": "#facc15"},
        )
        # caption_template stays untouched when no editor override exists.
        self.assertEqual(built.props["caption_template"], {"color": "#facc15"})

    def test_style_override_merges_onto_baseline_template(self):
        self._seed_story_with_style(
            "story-with-style",
            {"color": "#ff0000", "word_highlight": "scale"},
        )
        built = self._build_with_style(
            "story-with-style",
            baseline_template={"color": "#facc15", "position_y": "0.6"},
        )
        # Editor's color wins; baseline's position_y is preserved (sparse
        # override).
        self.assertEqual(built.props["caption_template"]["color"], "#ff0000")
        self.assertEqual(
            built.props["caption_template"]["word_highlight"], "scale",
        )
        self.assertEqual(
            built.props["caption_template"]["position_y"], "0.6",
        )

    def test_style_override_with_no_baseline_template(self):
        # Baseline rendered before the caption_template field existed.
        # The override should still land as the entire template.
        self._seed_story_with_style(
            "story-fresh-style",
            {"color": "#00ff00"},
        )
        built = self._build_with_style(
            "story-fresh-style",
            baseline_template=None,
        )
        self.assertEqual(
            built.props["caption_template"], {"color": "#00ff00"},
        )

    def test_non_string_caption_style_values_are_dropped(self):
        # read_short_caption_style filters non-strings, so a malformed
        # override doesn't end up in the render's caption_template.
        self._seed_story_with_style(
            "story-mixed",
            {"color": "#abcdef", "size_scale": 1.4},
        )
        built = self._build_with_style(
            "story-mixed",
            baseline_template={"color": "#facc15"},
        )
        self.assertEqual(built.props["caption_template"]["color"], "#abcdef")
        # size_scale was a number, not a string — should be dropped.
        self.assertNotIn("size_scale", built.props["caption_template"])


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
