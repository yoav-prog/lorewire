"""Tests for the hero + thumbnail finisher in pipeline.media.

The finisher reads the latest done short_render for a story, pulls its
character_base_url and scene list, asks the scene picker which two scenes
to seed from, then makes 5 i2i calls — hero (3:4 + 16:9) and thumbnail
(3:4 + 16:9 + 1:1). Each call sends image_input=[character, scene] in
THAT order; reversing it breaks character consistency.

Mocks the network surface (_generate_with_retry, images.download,
gcs.publish, the picker, the per-column store helpers) so the wiring is
verified without burning kie credits.

Plan: _plans/2026-06-19-reddit-source-auto-deliver-article-short-hero-thumbnail.md.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import media


STORY = {
    "id": "abc123",
    "title": "The Leaf Blower At Dawn",
    "body": "A neighbor turned a quiet street into an alarm clock at 6am.",
    "category": "Entitled",
}

SCENES = [
    {"scene": "Neighbor with leaf blower at dawn", "url": "https://kie/s0.png"},
    {"scene": "Frosted breath in cold air", "url": "https://kie/s1.png"},
    {"scene": "Window thrown open in fury", "url": "https://kie/s2.png"},
    {"scene": "Confrontation across the yard", "url": "https://kie/s3.png"},
    {"scene": "Quiet aftermath, looking at lawn", "url": "https://kie/s4.png"},
]

CHARACTER_URL = "https://kie/character-base.png"

DONE_SHORT = {
    "status": "done",
    "props": json.dumps({
        "character_base_url": CHARACTER_URL,
        "scenes": SCENES,
    }),
}


def _patch_stack(stack: unittest.TestCase, **overrides):
    """Standard mock surface for the finisher tests. Each test can pass
    overrides for the entries it cares about."""
    base = {
        "fetch_story": mock.patch.object(media.store, "fetch_story", return_value=STORY),
        "latest_short": mock.patch.object(
            media.store, "latest_short_render_for_story", return_value=DONE_SHORT,
        ),
        "picker": mock.patch.object(
            media.stages, "pick_hero_and_thumbnail_scenes",
            return_value={
                "hero_index": 0,
                "thumbnail_index": 3,
                "picker_reasoning": "calm vs dramatic",
            },
        ),
        "make_thumb": mock.patch.object(
            media.stages, "make_thumbnail_prompt",
            side_effect=lambda *a, **k: f"prompt({k.get('aspect_ratio')})",
        ),
        "generate_with_retry": mock.patch.object(
            media, "_generate_with_retry", return_value="https://kie/result.png",
        ),
        "download": mock.patch.object(media.images, "download"),
        "publish": mock.patch.object(
            media.gcs, "publish",
            side_effect=lambda local, key, fallback: f"gs://bucket/{key}",
        ),
        "get_selected": mock.patch.object(
            media.models, "get_selected", return_value="kie/gpt-image-2",
        ),
        "update_hero": mock.patch.object(media.store, "update_story_hero"),
        "update_hero_landscape": mock.patch.object(
            media.store, "update_story_hero_landscape",
        ),
        "update_thumb": mock.patch.object(media.store, "update_story_thumbnail"),
        "update_thumb_landscape": mock.patch.object(
            media.store, "update_story_thumbnail_landscape",
        ),
        "update_thumb_square": mock.patch.object(
            media.store, "update_story_thumbnail_square",
        ),
    }
    base.update(overrides)
    started = {}
    for name, p in base.items():
        started[name] = p.start()
        stack.addCleanup(p.stop)
    return started


class HappyPathTests(unittest.TestCase):
    def test_all_five_variants_called_with_correct_aspect_and_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(self)
            result = media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        # Five calls total: 2 hero + 3 thumbnail. Each kie call receives
        # image_input=[character_base_url, scene_url] in exactly that order
        # (FIRST = identity, SECOND = composition — anything else and the
        # face drifts).
        calls = mocks["generate_with_retry"].call_args_list
        self.assertEqual(len(calls), 5)
        aspects = [c.kwargs["aspect_ratio"] for c in calls]
        self.assertEqual(aspects, ["3:4", "16:9", "3:4", "16:9", "1:1"])
        for c in calls:
            self.assertEqual(c.kwargs["model"], "kie/gpt-image-2-i2i")
            # The character URL must be first, scene URL second.
            inputs = c.kwargs["image_input"]
            self.assertEqual(inputs[0], CHARACTER_URL)
            self.assertIn(inputs[1], {SCENES[0]["url"], SCENES[3]["url"]})

    def test_hero_calls_use_hero_scene_thumbnail_calls_use_thumb_scene(self):
        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(self)
            media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        calls = mocks["generate_with_retry"].call_args_list
        # Order of variants in _HERO_THUMB_VARIANTS: hero portrait, hero
        # landscape, thumb portrait, thumb landscape, thumb square.
        # First two pull the hero scene (index 0 -> SCENES[0].url); last
        # three pull the thumbnail scene (index 3 -> SCENES[3].url).
        self.assertEqual(calls[0].kwargs["image_input"][1], SCENES[0]["url"])
        self.assertEqual(calls[1].kwargs["image_input"][1], SCENES[0]["url"])
        self.assertEqual(calls[2].kwargs["image_input"][1], SCENES[3]["url"])
        self.assertEqual(calls[3].kwargs["image_input"][1], SCENES[3]["url"])
        self.assertEqual(calls[4].kwargs["image_input"][1], SCENES[3]["url"])

    def test_each_landed_variant_writes_its_column(self):
        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(self)
            result = media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        mocks["update_hero"].assert_called_once()
        mocks["update_hero_landscape"].assert_called_once()
        mocks["update_thumb"].assert_called_once()
        mocks["update_thumb_landscape"].assert_called_once()
        mocks["update_thumb_square"].assert_called_once()
        # Result dict carries every URL so the worker can update its row.
        self.assertTrue(result["hero_image"].endswith("hero.png"))
        self.assertTrue(result["hero_image_landscape"].endswith("hero-landscape.png"))
        self.assertTrue(result["thumbnail_image"].endswith("thumbnail.png"))
        self.assertTrue(
            result["thumbnail_image_landscape"].endswith("thumbnail-landscape.png")
        )
        self.assertTrue(
            result["thumbnail_image_square"].endswith("thumbnail-square.png")
        )

    def test_total_cost_counts_only_variants_that_landed(self):
        # 5 variants land at $0.05 each = 25¢ total.
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self)
            result = media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        self.assertEqual(result["cost_cents"], 25)

    def test_picker_metadata_round_trips_into_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self)
            result = media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        self.assertEqual(result["hero_index"], 0)
        self.assertEqual(result["thumbnail_index"], 3)
        self.assertEqual(result["picker_reasoning"], "calm vs dramatic")


class PartialFailureTests(unittest.TestCase):
    def test_one_kie_call_returning_none_does_not_abort_the_others(self):
        # Drop the third call (thumbnail portrait) — kie returns None.
        # The other four variants must still ship, and the cost reflects
        # only the four that landed (20¢).
        sequence = iter([
            "https://kie/h.png",         # hero portrait
            "https://kie/h-land.png",    # hero landscape
            None,                        # thumb portrait FAILS
            "https://kie/t-land.png",    # thumb landscape
            "https://kie/t-sq.png",      # thumb square
        ])
        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(self, generate_with_retry=mock.patch.object(
                media, "_generate_with_retry", side_effect=lambda *a, **k: next(sequence),
            ))
            result = media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        self.assertIsNotNone(result["hero_image"])
        self.assertIsNotNone(result["hero_image_landscape"])
        self.assertIsNone(result["thumbnail_image"])
        self.assertIsNotNone(result["thumbnail_image_landscape"])
        self.assertIsNotNone(result["thumbnail_image_square"])
        self.assertEqual(result["cost_cents"], 20)
        mocks["update_thumb"].assert_not_called()


class SetupFailureTests(unittest.TestCase):
    """Setup failures MUST raise ValueError so the worker can surface a
    clear, admin-readable reason for skipping the finisher."""

    def test_raises_when_no_completed_short(self):
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self, latest_short=mock.patch.object(
                media.store, "latest_short_render_for_story", return_value=None,
            ))
            with self.assertRaisesRegex(ValueError, "no completed short"):
                media.generate_hero_and_thumbnail_from_short(
                    "abc123", Path(tmp),
                )

    def test_raises_when_short_status_not_done(self):
        running_short = {"status": "rendering", "props": DONE_SHORT["props"]}
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self, latest_short=mock.patch.object(
                media.store, "latest_short_render_for_story", return_value=running_short,
            ))
            with self.assertRaisesRegex(ValueError, "no completed short"):
                media.generate_hero_and_thumbnail_from_short(
                    "abc123", Path(tmp),
                )

    def test_raises_when_character_base_url_missing(self):
        short_without_char = {
            "status": "done",
            "props": json.dumps({"scenes": SCENES}),
        }
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self, latest_short=mock.patch.object(
                media.store, "latest_short_render_for_story", return_value=short_without_char,
            ))
            with self.assertRaisesRegex(ValueError, "no character_base_url"):
                media.generate_hero_and_thumbnail_from_short(
                    "abc123", Path(tmp),
                )

    def test_raises_when_scenes_missing(self):
        short_without_scenes = {
            "status": "done",
            "props": json.dumps({"character_base_url": CHARACTER_URL}),
        }
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self, latest_short=mock.patch.object(
                media.store, "latest_short_render_for_story",
                return_value=short_without_scenes,
            ))
            with self.assertRaisesRegex(ValueError, "no usable scene list"):
                media.generate_hero_and_thumbnail_from_short(
                    "abc123", Path(tmp),
                )

    def test_falls_back_to_doodle_frames_when_scenes_key_absent(self):
        # post-render props use `doodle_frames` instead of `scenes`. The
        # finisher accepts either source.
        short_with_doodle_frames = {
            "status": "done",
            "props": json.dumps({
                "character_base_url": CHARACTER_URL,
                "doodle_frames": SCENES,
            }),
        }
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self, latest_short=mock.patch.object(
                media.store, "latest_short_render_for_story",
                return_value=short_with_doodle_frames,
            ))
            result = media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        self.assertIsNotNone(result["hero_image"])

    def test_raises_when_props_blob_is_not_json(self):
        bad_short = {"status": "done", "props": "{this is not json"}
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self, latest_short=mock.patch.object(
                media.store, "latest_short_render_for_story", return_value=bad_short,
            ))
            with self.assertRaisesRegex(ValueError, "not valid JSON"):
                media.generate_hero_and_thumbnail_from_short(
                    "abc123", Path(tmp),
                )


class RegenWrapperTests(unittest.TestCase):
    """The admin "Generate hero + thumbnail from short" button dispatches
    through `regen_one(asset='hero_thumbnail_from_short')`. The wrapper
    must return the (first_url, total_cents) shape the image_renders queue
    expects."""

    def test_regen_one_dispatches_to_wrapper(self):
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self)
            url, cents = media.regen_one(
                "abc123", "hero_thumbnail_from_short", Path(tmp),
            )
        self.assertTrue(url.endswith("hero.png"))
        self.assertEqual(cents, 25)

    def test_regen_one_raises_when_all_five_fail(self):
        # All kie calls return None — the wrapper must raise because the
        # queue contract requires a sample URL for output_url.
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self, generate_with_retry=mock.patch.object(
                media, "_generate_with_retry", return_value=None,
            ))
            with self.assertRaisesRegex(RuntimeError, "all five i2i calls failed"):
                media.regen_one(
                    "abc123", "hero_thumbnail_from_short", Path(tmp),
                )


if __name__ == "__main__":
    unittest.main()
