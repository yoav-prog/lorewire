"""Tests for the Lane A → short_config sync helper.

After a full re-render (Lane A), the editor was showing stale scene frames
because the editor reads stories.short_config (only seeded once via
defaultShortConfig) and Lane A only writes to short_renders.props. This
sync mirrors the new frames + character base + voice fields back, while
preserving pinned frames so the admin's manual scene swaps aren't blown
away.

Symmetric with pipeline/shorts_lane_b's sync_short_config_captions; this
covers the wider Lane A surface.
"""
from __future__ import annotations

import json
import unittest
from unittest import mock

from pipeline import shorts_render


class SyncShortConfigFromLaneATests(unittest.TestCase):
    def _run(self, existing: dict, props: dict) -> dict | None:
        captured: dict = {}

        def _capture(_sid: str, cfg: dict) -> None:
            captured["cfg"] = cfg

        with mock.patch.object(
            shorts_render.store, "fetch_story",
            return_value={"short_config": json.dumps(existing)},
        ), mock.patch.object(
            shorts_render.store, "update_story_short_config",
            side_effect=_capture,
        ):
            ok = shorts_render.sync_short_config_from_lane_a("s1", props)
        return captured.get("cfg") if ok else None

    def test_replaces_unpinned_frames_with_new_urls(self):
        existing = {
            "doodle_frames": [
                {"id": "frame-00", "url": "old0", "caption_chunk_start_index": 0},
                {"id": "frame-01", "url": "old1", "caption_chunk_start_index": 5},
            ],
            "captions": [],
        }
        props = {
            "doodle_frames": [
                {"id": "frame-00", "url": "new0", "caption_chunk_start_index": 0,
                 "image_prompt": "fresh prompt"},
                {"id": "frame-01", "url": "new1", "caption_chunk_start_index": 7},
            ],
            "captions": [],
        }
        cfg = self._run(existing, props)
        assert cfg is not None
        self.assertEqual(cfg["doodle_frames"][0]["url"], "new0")
        self.assertEqual(cfg["doodle_frames"][0]["image_prompt"], "fresh prompt")
        self.assertEqual(cfg["doodle_frames"][1]["url"], "new1")
        # Caption index from the new render wins so a re-mapped beat
        # doesn't desync from narration.
        self.assertEqual(cfg["doodle_frames"][1]["caption_chunk_start_index"], 7)

    def test_preserves_pinned_frame_url_and_prompt(self):
        # A pinned frame in short_config is the admin's manual swap — Lane A
        # must NOT clobber it even on a full regen.
        existing = {
            "doodle_frames": [
                {"id": "frame-00", "url": "pinned-url", "image_prompt": "pinned prompt",
                 "alt": "pinned alt", "is_pinned": True, "caption_chunk_start_index": 0},
                {"id": "frame-01", "url": "old1", "caption_chunk_start_index": 5},
            ],
            "captions": [],
        }
        props = {
            "doodle_frames": [
                {"id": "frame-00", "url": "regen-url", "image_prompt": "regen prompt",
                 "caption_chunk_start_index": 2},
                {"id": "frame-01", "url": "regen1", "caption_chunk_start_index": 7},
            ],
            "captions": [],
        }
        cfg = self._run(existing, props)
        assert cfg is not None
        self.assertEqual(cfg["doodle_frames"][0]["url"], "pinned-url")
        self.assertEqual(cfg["doodle_frames"][0]["image_prompt"], "pinned prompt")
        self.assertEqual(cfg["doodle_frames"][0]["alt"], "pinned alt")
        # Caption index updates even on a pinned frame so re-mapped beats
        # stay aligned with narration.
        self.assertEqual(cfg["doodle_frames"][0]["caption_chunk_start_index"], 2)
        # The non-pinned frame takes the regen url.
        self.assertEqual(cfg["doodle_frames"][1]["url"], "regen1")

    def test_syncs_character_base_and_voice_fields(self):
        existing = {
            "doodle_frames": [],
            "captions": [{"start_ms": 0, "end_ms": 100, "text": "OLD"}],
            "character_base_url": "old-base.png",
            "voiceover_url": "old.mp3",
            "duration_ms": 100,
        }
        props = {
            "doodle_frames": [],
            "captions": [
                {"start_ms": 0, "end_ms": 500, "text": "fresh", "words": [{"x": 1}]},
            ],
            "character_base_url": "new-base.png",
            "voiceover_url": "new.mp3",
            "duration_ms": 1000,
            "script": "fresh narration",
        }
        cfg = self._run(existing, props)
        assert cfg is not None
        self.assertEqual(cfg["character_base_url"], "new-base.png")
        self.assertEqual(cfg["voiceover_url"], "new.mp3")
        self.assertEqual(cfg["duration_ms"], 1000)
        self.assertEqual(cfg["script"], "fresh narration")
        self.assertEqual(cfg["captions"][0]["text"], "fresh")
        # words boundaries are dropped — short_config doesn't store them.
        self.assertNotIn("words", cfg["captions"][0])

    def test_noop_when_no_short_config(self):
        with mock.patch.object(
            shorts_render.store, "fetch_story",
            return_value={"short_config": None},
        ), mock.patch.object(
            shorts_render.store, "update_story_short_config",
        ) as upd:
            self.assertFalse(
                shorts_render.sync_short_config_from_lane_a("s1", {"doodle_frames": []})
            )
            upd.assert_not_called()

    def test_noop_when_story_missing(self):
        with mock.patch.object(
            shorts_render.store, "fetch_story", return_value=None,
        ), mock.patch.object(
            shorts_render.store, "update_story_short_config",
        ) as upd:
            self.assertFalse(
                shorts_render.sync_short_config_from_lane_a("s1", {"doodle_frames": []})
            )
            upd.assert_not_called()

    def test_noop_when_short_config_malformed(self):
        with mock.patch.object(
            shorts_render.store, "fetch_story",
            return_value={"short_config": "{not json"},
        ), mock.patch.object(
            shorts_render.store, "update_story_short_config",
        ) as upd:
            self.assertFalse(
                shorts_render.sync_short_config_from_lane_a("s1", {"doodle_frames": []})
            )
            upd.assert_not_called()


if __name__ == "__main__":
    unittest.main()
