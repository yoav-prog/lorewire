"""Tests for pipeline.aspect — the renderer-aspect resolver + per-asset table.

Phase 2 of `_plans/2026-06-12-video-aspect-ratio.md`. Mirrors the
TypeScript-side `aspect.test.ts`; covers:

  - per-asset mapping (scene branches on aspect; props stay 1:1;
    mouth-swap stays 3:4 regardless of video shape)
  - resolver chain order (per-story override beats global default beats
    legacy 9:16 floor)
  - tolerance to malformed inputs from the wire (None, garbage,
    non-string, missing settings table)
  - back-compat invariant: a story dict with no `aspect` field still
    resolves to 9:16 → scene kie call still asks for 3:4, byte-identical
    to the pre-Phase-2 pipeline

Pure logic. No I/O outside the explicitly-mocked `store.get_setting`.
"""
from __future__ import annotations

import json
import unittest
from unittest import mock

from pipeline import aspect


class ResolveAspectTests(unittest.TestCase):
    def test_per_story_aspect_wins_when_valid(self):
        self.assertEqual(aspect.resolve_aspect("16:9", "9:16"), "16:9")
        self.assertEqual(aspect.resolve_aspect("9:16", "16:9"), "9:16")

    def test_global_default_fills_when_story_missing(self):
        self.assertEqual(aspect.resolve_aspect(None, "16:9"), "16:9")
        self.assertEqual(aspect.resolve_aspect(None, "9:16"), "9:16")

    def test_legacy_floor_fires_when_both_missing(self):
        self.assertEqual(aspect.resolve_aspect(None, None), "9:16")
        self.assertEqual(
            aspect.resolve_aspect(None, None), aspect.LEGACY_DEFAULT_ASPECT
        )

    def test_invalid_values_fall_through(self):
        # Loose inputs from JSON / settings / form data: garbage at either
        # tier must not blow up; the resolver falls through.
        self.assertEqual(aspect.resolve_aspect("garbage", "9:16"), "9:16")
        self.assertEqual(aspect.resolve_aspect("4:3", "16:9"), "16:9")
        self.assertEqual(aspect.resolve_aspect(169, "9:16"), "9:16")
        self.assertEqual(
            aspect.resolve_aspect(None, "16x9"), aspect.LEGACY_DEFAULT_ASPECT
        )


class IsVideoAspectTests(unittest.TestCase):
    def test_accepts_supported_pair(self):
        self.assertTrue(aspect.is_video_aspect("16:9"))
        self.assertTrue(aspect.is_video_aspect("9:16"))

    def test_rejects_everything_else(self):
        for v in (None, "", "4:3", "16x9", 169, 0, {}, [], "16:9 "):
            self.assertFalse(aspect.is_video_aspect(v), msg=f"value={v!r}")


class PerAssetMappingTests(unittest.TestCase):
    def test_scene_follows_video_aspect(self):
        self.assertEqual(aspect.scene_aspect_for("9:16"), "3:4")
        self.assertEqual(aspect.scene_aspect_for("16:9"), "16:9")

    def test_props_are_always_square(self):
        # Same string for both — props are aspect-invariant.
        self.assertEqual(aspect.prop_aspect_for("9:16"), "1:1")
        self.assertEqual(aspect.prop_aspect_for("16:9"), "1:1")

    def test_mouth_swap_stays_portrait(self):
        # The talking-head bust lives in a 3:4 sub-overlay regardless of
        # composition shape; portrait bust avoids objectFit:cover cropping
        # the face on a landscape video.
        self.assertEqual(aspect.mouth_swap_aspect_for("9:16"), "3:4")
        self.assertEqual(aspect.mouth_swap_aspect_for("16:9"), "3:4")


class ResolveAspectForStoryTests(unittest.TestCase):
    def test_per_story_video_config_aspect_wins(self):
        # Story row with a video_config carrying an explicit 16:9 aspect.
        story = {
            "id": "abc",
            "video_config": json.dumps({
                "voiceover_url": "/v.mp3",
                "duration_ms": 10000,
                "doodle_frames": [],
                "captions": [],
                "aspect": "16:9",
            }),
        }
        with mock.patch.object(aspect, "_global_default_aspect", return_value="9:16"):
            self.assertEqual(aspect.resolve_aspect_for_story(story), "16:9")

    def test_falls_back_to_global_default(self):
        story = {
            "id": "abc",
            "video_config": json.dumps({
                "voiceover_url": "/v.mp3",
                "duration_ms": 10000,
                "doodle_frames": [],
                "captions": [],
                # no aspect field
            }),
        }
        with mock.patch.object(aspect, "_global_default_aspect", return_value="16:9"):
            self.assertEqual(aspect.resolve_aspect_for_story(story), "16:9")

    def test_legacy_back_compat_no_aspect_no_setting(self):
        # The byte-identical invariant: a story with no video_config and
        # no global setting still resolves to 9:16. Phase 0/1/2 cannot
        # change the rendered output of any pre-existing story.
        story = {"id": "abc", "video_config": None}
        with mock.patch.object(aspect, "_global_default_aspect", return_value=None):
            self.assertEqual(aspect.resolve_aspect_for_story(story), "9:16")

    def test_none_story_falls_through_to_settings(self):
        with mock.patch.object(aspect, "_global_default_aspect", return_value="16:9"):
            self.assertEqual(aspect.resolve_aspect_for_story(None), "16:9")

    def test_malformed_video_config_doesnt_raise(self):
        # A JSON parse failure or a non-dict shape should fall through to
        # the resolver default — never raise.
        story = {"id": "abc", "video_config": "not json {{{{"}
        with mock.patch.object(aspect, "_global_default_aspect", return_value="16:9"):
            self.assertEqual(aspect.resolve_aspect_for_story(story), "16:9")

    def test_video_config_already_a_dict(self):
        # Tests in test_video_config persist via dict; the helper should
        # also accept that shape so it doesn't matter which path the
        # caller passes us.
        story = {
            "id": "abc",
            "video_config": {
                "voiceover_url": "/v.mp3",
                "duration_ms": 10000,
                "doodle_frames": [],
                "captions": [],
                "aspect": "16:9",
            },
        }
        with mock.patch.object(aspect, "_global_default_aspect", return_value="9:16"):
            self.assertEqual(aspect.resolve_aspect_for_story(story), "16:9")


class ResolveAspectForFreshRunTests(unittest.TestCase):
    def test_uses_global_default(self):
        with mock.patch.object(aspect, "_global_default_aspect", return_value="16:9"):
            self.assertEqual(aspect.resolve_aspect_for_fresh_run(), "16:9")

    def test_falls_back_to_legacy_when_no_setting(self):
        with mock.patch.object(aspect, "_global_default_aspect", return_value=None):
            self.assertEqual(aspect.resolve_aspect_for_fresh_run(), "9:16")


class GlobalDefaultAspectTests(unittest.TestCase):
    def test_reads_setting_when_table_exists(self):
        with mock.patch("pipeline.store.get_setting") as gs:
            gs.return_value = "16:9"
            self.assertEqual(aspect._global_default_aspect(), "16:9")
            gs.assert_called_once_with("video.default_aspect")

    def test_swallows_settings_table_missing(self):
        # First run before init() — settings table doesn't exist. The
        # resolver must NOT crash the pipeline; it should fall through
        # to the legacy default.
        with mock.patch("pipeline.store.get_setting") as gs:
            gs.side_effect = RuntimeError("no settings table")
            self.assertIsNone(aspect._global_default_aspect())


if __name__ == "__main__":
    unittest.main()
