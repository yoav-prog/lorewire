"""Tests for pipeline.stages.pick_hero_and_thumbnail_scenes.

The picker chooses two scene indexes from a short's scene list — one for
the hero, one for the thumbnail. These tests exercise the JSON-parse
guarantees, the deterministic fallback path, and the distinctness nudge.

The LLM call itself is mocked everywhere so tests don't burn tokens.
Plan: _plans/2026-06-19-reddit-source-auto-deliver-article-short-hero-thumbnail.md.
"""
from __future__ import annotations

import unittest
from unittest import mock

from pipeline import stages


SCENES_FIVE = [
    {"scene": "A neighbor stands holding a leaf blower at dawn.", "url": "https://kie/s0.png"},
    {"scene": "Close-up of frosted breath in cold air.", "url": "https://kie/s1.png"},
    {"scene": "The protagonist throws open a window, furious.", "url": "https://kie/s2.png"},
    {"scene": "Confrontation across the yard, leaves swirling.", "url": "https://kie/s3.png"},
    {"scene": "Quiet aftermath, both men looking at the lawn.", "url": "https://kie/s4.png"},
]


class FallbackPathTests(unittest.TestCase):
    """Picker MUST degrade gracefully — never raise, never block the pipeline."""

    def test_empty_scenes_returns_zero_zero(self):
        # No scenes means no choice; both indexes are 0. The finisher uses
        # this to fail loudly before calling kie, but the picker itself
        # is harmless here.
        out = stages.pick_hero_and_thumbnail_scenes("T", "B", [])
        self.assertEqual(out["hero_index"], 0)
        self.assertEqual(out["thumbnail_index"], 0)
        self.assertIn("no scenes", out["picker_reasoning"])

    def test_single_scene_collapses_indexes(self):
        out = stages.pick_hero_and_thumbnail_scenes(
            "T", "B", [SCENES_FIVE[0]], dry_run=True,
        )
        self.assertEqual(out["hero_index"], 0)
        self.assertEqual(out["thumbnail_index"], 0)

    def test_dry_run_uses_deterministic_fallback(self):
        out = stages.pick_hero_and_thumbnail_scenes(
            "T", "B", SCENES_FIVE, dry_run=True,
        )
        # Fallback: hero=0 (opener), thumb=len/2 (climactic middle).
        self.assertEqual(out["hero_index"], 0)
        self.assertEqual(out["thumbnail_index"], 2)
        self.assertIn("DRY", out["picker_reasoning"])

    def test_picker_disabled_in_settings_uses_fallback(self):
        with mock.patch.object(
            stages, "_parse_scene_picker"
        ) as parse, mock.patch(
            "pipeline.store.get_setting",
            side_effect=lambda k: "off" if k == "hero_thumbnail.scene_picker.enabled" else None,
        ):
            out = stages.pick_hero_and_thumbnail_scenes("T", "B", SCENES_FIVE)
        self.assertEqual(out["hero_index"], 0)
        self.assertEqual(out["thumbnail_index"], 2)
        self.assertIn("disabled", out["picker_reasoning"])
        parse.assert_not_called()

    def test_llm_exception_uses_fallback(self):
        with mock.patch(
            "pipeline.llm.chat", side_effect=RuntimeError("LLM down"),
        ), mock.patch(
            "pipeline.store.get_setting", return_value=None,
        ):
            out = stages.pick_hero_and_thumbnail_scenes("T", "B", SCENES_FIVE)
        self.assertEqual(out["hero_index"], 0)
        self.assertEqual(out["thumbnail_index"], 2)
        self.assertIn("llm error", out["picker_reasoning"])

    def test_unparseable_llm_response_uses_fallback(self):
        with mock.patch(
            "pipeline.llm.chat", return_value="sorry I can't do that",
        ), mock.patch(
            "pipeline.store.get_setting", return_value=None,
        ):
            out = stages.pick_hero_and_thumbnail_scenes("T", "B", SCENES_FIVE)
        self.assertEqual(out["hero_index"], 0)
        self.assertEqual(out["thumbnail_index"], 2)


class LlmPickTests(unittest.TestCase):
    """Happy paths + structural guarantees on the LLM's return."""

    def _pick_with_llm_response(self, raw: str) -> dict:
        with mock.patch(
            "pipeline.llm.chat", return_value=raw,
        ), mock.patch(
            "pipeline.store.get_setting", return_value=None,
        ):
            return stages.pick_hero_and_thumbnail_scenes("T", "B", SCENES_FIVE)

    def test_valid_pick_returns_those_indexes(self):
        out = self._pick_with_llm_response(
            '{"hero_index": 1, "thumbnail_index": 3, "reasoning": "calm vs dramatic"}',
        )
        self.assertEqual(out["hero_index"], 1)
        self.assertEqual(out["thumbnail_index"], 3)
        self.assertEqual(out["picker_reasoning"], "calm vs dramatic")

    def test_fenced_json_response_is_parsed(self):
        out = self._pick_with_llm_response(
            '```json\n{"hero_index": 2, "thumbnail_index": 4, "reasoning": "x"}\n```',
        )
        self.assertEqual(out["hero_index"], 2)
        self.assertEqual(out["thumbnail_index"], 4)

    def test_out_of_range_index_falls_back_per_field(self):
        # Hero index 99 is out of range; falls back to 0. Thumbnail still
        # honored. Each field validated independently.
        out = self._pick_with_llm_response(
            '{"hero_index": 99, "thumbnail_index": 3, "reasoning": "x"}',
        )
        self.assertEqual(out["hero_index"], 0)
        self.assertEqual(out["thumbnail_index"], 3)

    def test_same_index_for_both_nudges_thumbnail(self):
        # With 5 scenes and both indexes = 2, distinctness nudge moves
        # thumbnail to 3 (next slot). Two assets must look different to
        # earn their separate columns.
        out = self._pick_with_llm_response(
            '{"hero_index": 2, "thumbnail_index": 2, "reasoning": "same"}',
        )
        self.assertEqual(out["hero_index"], 2)
        self.assertEqual(out["thumbnail_index"], 3)
        self.assertIn("nudged", out["picker_reasoning"])

    def test_negative_index_falls_back(self):
        out = self._pick_with_llm_response(
            '{"hero_index": -1, "thumbnail_index": -5, "reasoning": "x"}',
        )
        self.assertEqual(out["hero_index"], 0)
        self.assertEqual(out["thumbnail_index"], 2)

    def test_non_integer_index_falls_back(self):
        out = self._pick_with_llm_response(
            '{"hero_index": "first", "thumbnail_index": null, "reasoning": "x"}',
        )
        self.assertEqual(out["hero_index"], 0)
        self.assertEqual(out["thumbnail_index"], 2)


if __name__ == "__main__":
    unittest.main()
