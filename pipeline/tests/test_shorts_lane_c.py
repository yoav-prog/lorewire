"""Tests for the Lane C builder (Phase 4 of the short editor plan).

What we lock down: validation surface on lane_inputs + the happy path
where the builder runs scene regens on the touched ids and assembles new
props by merging the freshly-regen'd urls into the baseline frame order.
The kie + GCS calls are stubbed via shorts_scene_regen's own seam.

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

from pipeline import shorts_lane_c, shorts_scene_regen, store


class _LaneCTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        db_path = Path(self._tmpdir.name) / "lane-c.db"
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

    def _seed_baseline(
        self, render_id: str, story_id: str, props: dict,
    ) -> None:
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

    def _seed_story_with_config(
        self, story_id: str, short_config: dict,
    ) -> None:
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "INSERT INTO stories (id, slug, title, status, short_config) "
                "VALUES (?, ?, ?, 'ready', ?)",
                (story_id, f"slug-{story_id}", f"Title {story_id}",
                 json.dumps(short_config)),
            )


class ValidationTests(_LaneCTestCase):
    def test_missing_lane_inputs_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_c.build_short_props_lane_c(
                {"story_id": "s", "lane_inputs": None}, Path("."),
            )
        self.assertIn("lane_inputs", str(cm.exception))

    def test_malformed_lane_inputs_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_c.build_short_props_lane_c(
                {"story_id": "s", "lane_inputs": "{not json"}, Path("."),
            )
        self.assertIn("malformed", str(cm.exception))

    def test_missing_source_render_id_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_c.build_short_props_lane_c(
                {"story_id": "s",
                 "lane_inputs": json.dumps({"touched_frame_ids": ["f"]})},
                Path("."),
            )
        self.assertIn("source_render_id", str(cm.exception))

    def test_touched_frame_ids_must_be_list_of_strings(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_c.build_short_props_lane_c(
                {"story_id": "s",
                 "lane_inputs": json.dumps(
                     {"source_render_id": "r", "touched_frame_ids": [1, 2]},
                 )},
                Path("."),
            )
        self.assertIn("touched_frame_ids", str(cm.exception))

    def test_empty_touched_list_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_c.build_short_props_lane_c(
                {"story_id": "s",
                 "lane_inputs": json.dumps(
                     {"source_render_id": "r", "touched_frame_ids": []},
                 )},
                Path("."),
            )
        self.assertIn("empty", str(cm.exception))

    def test_unknown_baseline_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_c.build_short_props_lane_c(
                {"story_id": "s",
                 "lane_inputs": json.dumps(
                     {
                         "source_render_id": "ghost",
                         "touched_frame_ids": ["frame-00"],
                     },
                 )},
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
            shorts_lane_c.build_short_props_lane_c(
                {"story_id": "s",
                 "lane_inputs": json.dumps(
                     {
                         "source_render_id": "no-props",
                         "touched_frame_ids": ["frame-00"],
                     },
                 )},
                Path("."),
            )
        self.assertIn("no props", str(cm.exception))


class HappyPathTests(_LaneCTestCase):
    def _baseline_props(self) -> dict:
        return {
            "config_version": 2,
            "voiceover_url": "https://gcs/voice.mp3",
            "duration_ms": 30000,
            "title": "Old title",
            "doodle_frames": [
                {
                    "id": "frame-00",
                    "url": "https://gcs/00-old.png",
                    "caption_chunk_start_index": 0,
                },
                {
                    "id": "frame-01",
                    "url": "https://gcs/01-old.png",
                    "caption_chunk_start_index": 3,
                },
                {
                    "id": "frame-02",
                    "url": "https://gcs/02-old.png",
                    "caption_chunk_start_index": 6,
                },
            ],
            "captions": [
                {"start_ms": 0, "end_ms": 2000, "text": "hello"},
            ],
        }

    def _short_config(self) -> dict:
        # The Scenes tab has already saved the new prompts; the regen call
        # reads them off short_config.
        return {
            "config_version": 1,
            "character_base_url": "https://gcs/base.png",
            "doodle_frames": [
                {
                    "id": "frame-00",
                    "url": "https://gcs/00-old.png",
                    "image_prompt": "a forest",
                },
                {
                    "id": "frame-01",
                    "url": "https://gcs/01-old.png",
                    "image_prompt": "an ocean",
                },
                {
                    "id": "frame-02",
                    "url": "https://gcs/02-old.png",
                    "image_prompt": "a mountain",
                },
            ],
            "captions": [],
        }

    def test_regens_touched_frames_and_merges_urls_into_baseline(self):
        self._seed_baseline("base-1", "story-1", self._baseline_props())
        self._seed_story_with_config("story-1", self._short_config())

        regen_calls: list[tuple[str, str]] = []

        def fake_regen(story_id: str, asset: str, repo_root: Path):
            # Mimic shorts_scene_regen: stamp a new url into short_config so
            # the merge step picks it up.
            regen_calls.append((story_id, asset))
            _, _, frame_id = asset.partition(":")
            story = store.fetch_story(story_id)
            assert story is not None
            cfg = json.loads(story["short_config"])
            for f in cfg["doodle_frames"]:
                if f["id"] == frame_id:
                    f["url"] = f"https://gcs/{frame_id}-NEW.png"
                    f["is_pinned"] = True
            store.update_story_short_config(story_id, cfg)
            return f"https://gcs/{frame_id}-NEW.png", 5

        with mock.patch.object(
            shorts_lane_c.shorts_scene_regen,
            "regen_short_scene",
            side_effect=fake_regen,
        ):
            built = shorts_lane_c.build_short_props_lane_c(
                {
                    "story_id": "story-1",
                    "lane_inputs": json.dumps(
                        {
                            "source_render_id": "base-1",
                            "touched_frame_ids": ["frame-00", "frame-02"],
                        },
                    ),
                },
                Path(self._tmpdir.name),
            )

        # Two scenes touched → two regen calls in input order.
        self.assertEqual(
            regen_calls,
            [
                ("story-1", "frame:frame-00"),
                ("story-1", "frame:frame-02"),
            ],
        )
        self.assertEqual(built.regen_count, 2)

        frames = built.props["doodle_frames"]
        # frame-00 and frame-02 swapped to the new urls; frame-01 untouched.
        self.assertEqual(frames[0]["id"], "frame-00")
        self.assertEqual(frames[0]["url"], "https://gcs/frame-00-NEW.png")
        self.assertEqual(frames[1]["id"], "frame-01")
        self.assertEqual(frames[1]["url"], "https://gcs/01-old.png")
        self.assertEqual(frames[2]["id"], "frame-02")
        self.assertEqual(frames[2]["url"], "https://gcs/frame-02-NEW.png")

        # Voice + captions + title untouched.
        self.assertEqual(
            built.props["voiceover_url"], "https://gcs/voice.mp3",
        )
        self.assertEqual(built.props["captions"], self._baseline_props()["captions"])
        self.assertEqual(built.props["title"], "Old title")
        self.assertEqual(
            built.props["caption_chunk_start_index"]
            if False else frames[0]["caption_chunk_start_index"],
            0,
        )

    def test_progress_callback_fires_per_scene(self):
        self._seed_baseline("base-p", "story-p", self._baseline_props())
        self._seed_story_with_config("story-p", self._short_config())

        progress_calls: list[tuple[str, int, int]] = []

        def on_progress(phase: str, cur: int = 0, total: int = 0) -> None:
            progress_calls.append((phase, cur, total))

        with mock.patch.object(
            shorts_lane_c.shorts_scene_regen,
            "regen_short_scene",
            return_value=("https://gcs/x.png", 5),
        ):
            shorts_lane_c.build_short_props_lane_c(
                {
                    "story_id": "story-p",
                    "lane_inputs": json.dumps(
                        {
                            "source_render_id": "base-p",
                            "touched_frame_ids": ["frame-00", "frame-01"],
                        },
                    ),
                },
                Path(self._tmpdir.name),
                on_progress=on_progress,
            )

        scene_calls = [c for c in progress_calls if c[0] == "scene"]
        self.assertEqual(
            scene_calls, [("scene", 0, 2), ("scene", 1, 2)],
        )
        # stage fires after the regen loop.
        self.assertIn(("stage", 0, 0), progress_calls)


class CaptionStyleOverrideTests(_LaneCTestCase):
    """Lane C merges short_config.caption_style onto baseline.caption_template
    so a bundled Style + per-scene edit lands in the same Lane C MP4."""

    def _baseline_with_template(self, template: dict | None) -> dict:
        props = {
            "config_version": 2,
            "voiceover_url": "https://gcs/voice.mp3",
            "duration_ms": 30000,
            "doodle_frames": [
                {
                    "id": "frame-00",
                    "url": "https://gcs/00-old.png",
                    "caption_chunk_start_index": 0,
                },
            ],
            "captions": [],
        }
        if template is not None:
            props["caption_template"] = template
        return props

    def _short_config_with_style(
        self, caption_style: dict | None,
    ) -> dict:
        cfg = {
            "config_version": 1,
            "character_base_url": "https://gcs/base.png",
            "doodle_frames": [
                {
                    "id": "frame-00",
                    "url": "https://gcs/00-old.png",
                    "image_prompt": "a forest",
                },
            ],
            "captions": [],
        }
        if caption_style is not None:
            cfg["caption_style"] = caption_style
        return cfg

    def _run(self, story_id: str, baseline_id: str):
        with mock.patch.object(
            shorts_lane_c.shorts_scene_regen,
            "regen_short_scene",
            return_value=("https://gcs/new.png", 5),
        ):
            return shorts_lane_c.build_short_props_lane_c(
                {
                    "story_id": story_id,
                    "lane_inputs": json.dumps({
                        "source_render_id": baseline_id,
                        "touched_frame_ids": ["frame-00"],
                    }),
                },
                Path(self._tmpdir.name),
            )

    def test_no_style_override_leaves_caption_template_alone(self):
        self._seed_baseline(
            "base-no-style", "story-no-style",
            self._baseline_with_template({"color": "#facc15"}),
        )
        self._seed_story_with_config(
            "story-no-style", self._short_config_with_style(None),
        )
        built = self._run("story-no-style", "base-no-style")
        self.assertEqual(built.props["caption_template"], {"color": "#facc15"})

    def test_style_override_merges_onto_baseline_template(self):
        self._seed_baseline(
            "base-with-style", "story-with-style",
            self._baseline_with_template({"color": "#facc15", "position_y": "0.6"}),
        )
        self._seed_story_with_config(
            "story-with-style",
            self._short_config_with_style(
                {"color": "#ff0000", "word_highlight": "scale"},
            ),
        )
        built = self._run("story-with-style", "base-with-style")
        self.assertEqual(built.props["caption_template"]["color"], "#ff0000")
        self.assertEqual(
            built.props["caption_template"]["word_highlight"], "scale",
        )
        self.assertEqual(
            built.props["caption_template"]["position_y"], "0.6",
        )

    def test_style_override_with_no_baseline_template(self):
        self._seed_baseline(
            "base-fresh-style", "story-fresh-style",
            self._baseline_with_template(None),
        )
        self._seed_story_with_config(
            "story-fresh-style",
            self._short_config_with_style({"color": "#00ff00"}),
        )
        built = self._run("story-fresh-style", "base-fresh-style")
        self.assertEqual(
            built.props["caption_template"], {"color": "#00ff00"},
        )


class ClearLaneTests(_LaneCTestCase):
    def test_clear_lane_nulls_the_column(self):
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "INSERT INTO short_renders "
                "(id, story_id, config_hash, status, progress, requested_at, lane) "
                "VALUES ('rid', 's', 'h', 'queued', 0, '2026-06-16T00:00:00Z', 'C')",
            )
        shorts_lane_c.clear_lane("rid")
        row = store.get_short_render("rid")
        assert row is not None
        self.assertIsNone(row["lane"])


if __name__ == "__main__":
    unittest.main()
