"""Cleavage-line tests for the 2026-06-14 pipeline_cache column split.

The bug this guards against: pipeline-owned data (world_bible,
scene_prompts, scene_prompts_built_with, scene_entity_ids,
character_bible) used to live inside `stories.video_config` — the
same JSON column the video editor owns. The editor's parseVideoConfig
strictly drops unknown top-level fields, so every heartbeat write
silently wiped the pipeline cache and forced the first scene worker
in every Rebuild batch to re-pay the ~$0.30 world-bible build cost.
The cron's 270s deadline killed the function before the second scene
completed; the reaper reset the row; next tick re-claimed and
re-burned. See `_plans/2026-06-14-pipeline-cache-column.md`.

The fix moves the five fields into `stories.pipeline_cache`, which
the editor never reads or writes. These tests assert that contract
from the pipeline side:

  - `_persist_world_bible` writes ONLY to pipeline_cache, never
    video_config.
  - `_write_cached_scene_prompts` writes ONLY to pipeline_cache.
  - `_read_cached_*` and `world_bible.read_world_bible` read from
    pipeline_cache (with a video_config fallback for the transition
    period — that legacy path is exercised in test_world_bible.py).
  - The frame-prompt writer (`_persist_frame_prompt`) ONLY touches
    video_config, leaving pipeline_cache alone.
"""
from __future__ import annotations

import json
import unittest
from unittest import mock

from pipeline import media


class PersistWorldBibleClavageTests(unittest.TestCase):
    """`_persist_world_bible` must write into pipeline_cache only."""

    def test_writes_to_pipeline_cache_not_video_config(self):
        story = {
            "id": "abc123",
            "video_config": json.dumps({
                "duration_ms": 30000,
                "captions": [],
                "doodle_frames": [],
            }),
            "pipeline_cache": None,
        }
        bible = {
            "built_with": "world_bible_v1",
            "characters": [{"id": "ab", "name": "Alice"}],
            "sub_characters": [],
            "locations": [],
            "items": [],
        }
        with mock.patch.object(
            media.store, "update_story_pipeline_cache",
        ) as pc, mock.patch.object(
            media.store, "update_story_video_config",
        ) as vc:
            media._persist_world_bible("abc123", story, bible)

        # pipeline_cache was written exactly once with the bible.
        pc.assert_called_once()
        args = pc.call_args.args
        self.assertEqual(args[0], "abc123")
        self.assertEqual(args[1].get("world_bible"), bible)
        # video_config was NOT touched.
        vc.assert_not_called()
        # In-memory mirror reflects the new shape so the next reader
        # in the same regen hits cache without a round-trip.
        self.assertEqual(
            json.loads(story["pipeline_cache"]).get("world_bible"),
            bible,
        )

    def test_preserves_existing_pipeline_cache_keys(self):
        # `_persist_world_bible` MUST merge — a story that already has
        # cached scene_prompts shouldn't lose them when the bible is
        # persisted.
        story = {
            "id": "abc123",
            "video_config": None,
            "pipeline_cache": json.dumps({
                "scene_prompts": ["existing prompt"],
                "scene_prompts_built_with": "world_bible_v1",
            }),
        }
        bible = {
            "built_with": "world_bible_v1",
            "characters": [],
            "sub_characters": [],
            "locations": [],
            "items": [],
        }
        with mock.patch.object(
            media.store, "update_story_pipeline_cache",
        ) as pc:
            media._persist_world_bible("abc123", story, bible)

        merged = pc.call_args.args[1]
        self.assertEqual(merged["world_bible"], bible)
        self.assertEqual(merged["scene_prompts"], ["existing prompt"])
        self.assertEqual(merged["scene_prompts_built_with"], "world_bible_v1")


class WriteCachedScenePromptsClavageTests(unittest.TestCase):
    """`_write_cached_scene_prompts` must write into pipeline_cache only."""

    def test_writes_to_pipeline_cache_not_video_config(self):
        story = {
            "id": "abc123",
            "video_config": json.dumps({"doodle_frames": [], "captions": []}),
            "pipeline_cache": None,
        }
        prompts = ["scene 0", "scene 1", "scene 2"]
        with mock.patch.object(
            media.store, "update_story_pipeline_cache",
        ) as pc, mock.patch.object(
            media.store, "update_story_video_config",
        ) as vc:
            media._write_cached_scene_prompts(
                "abc123", story, prompts,
                marker="world_bible_v1", bible=None,
                entity_ids_per_scene=[["ab"], ["ab"], []],
            )

        pc.assert_called_once()
        payload = pc.call_args.args[1]
        self.assertEqual(payload["scene_prompts"], prompts)
        self.assertEqual(payload["scene_prompts_built_with"], "world_bible_v1")
        self.assertEqual(payload["scene_entity_ids"], [["ab"], ["ab"], []])
        # video_config untouched — the editor's column is sacrosanct.
        vc.assert_not_called()


class ReadHelpersClavageTests(unittest.TestCase):
    """The five read helpers must read pipeline_cache, not video_config.

    The legacy video_config fallback inside read_world_bible is covered
    in test_world_bible.py — these tests assert the *primary* path.
    """

    def test_read_cached_character_bible_reads_pipeline_cache(self):
        bible = {
            "characters": [{"name": "Alice", "visual_cues": "red hat"}],
            "summary": "office story",
        }
        story = {
            "video_config": json.dumps({"character_bible": {
                "characters": [{"name": "Stale", "visual_cues": "ignore me"}],
                "summary": "stale",
            }}),
            "pipeline_cache": json.dumps({"character_bible": bible}),
        }
        out = media._read_cached_character_bible(story)
        self.assertIsNotNone(out)
        self.assertEqual(out["characters"][0]["name"], "Alice")

    def test_read_cached_scene_prompts_with_marker_reads_pipeline_cache(self):
        story = {
            "video_config": json.dumps({
                "scene_prompts": ["video_config legacy"],
                "scene_prompts_built_with": "world_bible_v1",
            }),
            "pipeline_cache": json.dumps({
                "scene_prompts": ["pipeline_cache canonical"],
                "scene_prompts_built_with": "world_bible_v1",
            }),
        }
        prompts, marker = media._read_cached_scene_prompts_with_marker(story)
        self.assertEqual(prompts, ["pipeline_cache canonical"])
        self.assertEqual(marker, "world_bible_v1")

    def test_read_cached_scene_entity_ids_reads_pipeline_cache(self):
        story = {
            "video_config": json.dumps({
                "scene_entity_ids": [["zz"]],
            }),
            "pipeline_cache": json.dumps({
                "scene_entity_ids": [["ab"], ["cd"]],
            }),
        }
        out = media._read_cached_scene_entity_ids(story)
        self.assertEqual(out, [["ab"], ["cd"]])

    def test_read_cached_scene_entity_ids_empty_when_missing(self):
        story = {"video_config": None, "pipeline_cache": None}
        self.assertEqual(media._read_cached_scene_entity_ids(story), [])


class FramePromptPersistDoesNotTouchCacheTests(unittest.TestCase):
    """`_persist_frame_prompt` is editor-data territory (it lives in
    doodle_frames inside video_config). It must NOT touch pipeline_cache."""

    def test_frame_prompt_persist_writes_video_config_only(self):
        story = {
            "id": "abc123",
            "video_config": json.dumps({
                "doodle_frames": [
                    {"id": "f-0", "url": "u0", "image_prompt": ""},
                ],
            }),
            "pipeline_cache": json.dumps({
                "world_bible": {"built_with": "world_bible_v1"},
            }),
        }
        with mock.patch.object(
            media.store, "update_story_video_config",
        ) as vc, mock.patch.object(
            media.store, "update_story_pipeline_cache",
        ) as pc:
            media._persist_frame_prompt(
                "abc123", story, 0, "new prompt", "https://new.png",
            )

        vc.assert_called_once()
        # The frame-prompt persist did NOT touch the pipeline cache —
        # that's the whole point of the column split.
        pc.assert_not_called()


if __name__ == "__main__":
    unittest.main()
