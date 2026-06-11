"""Tests for pipeline.media.regen_one — per-asset image regeneration.

Mocks the network surface (_generate_with_retry, images.download,
gcs.publish, stages prompt builders, store.fetch_story / setters) so the
tests exercise the dispatch + DB-update wiring without burning kie credits.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import media


STORY = {
    "id": "abc123",
    "title": "A neighbor with a leaf blower",
    "body": "Once upon a time a neighbor unleashed a leaf blower at 6am.",
    "category": "Entitled",
}


def _patches(extra: dict | None = None) -> dict:
    """Base patch set every regen test reuses. Returns a dict so each test
    can override one entry without re-declaring the whole stack."""
    patches = {
        "fetch_story": mock.patch.object(media.store, "fetch_story", return_value=STORY),
        "generate_with_retry": mock.patch.object(
            media, "_generate_with_retry", return_value="https://kie/img.png",
        ),
        "download": mock.patch.object(media.images, "download"),
        "publish": mock.patch.object(
            media.gcs, "publish", side_effect=lambda local, key, fallback: fallback,
        ),
        "get_selected": mock.patch.object(
            media.models, "get_selected", return_value="kie/gpt-image-2",
        ),
    }
    if extra:
        patches.update(extra)
    return patches


def _apply(patches: dict, stack: unittest.TestCase):
    """Start every patch and stop it on tearDown via addCleanup."""
    started = {}
    for name, p in patches.items():
        started[name] = p.start()
        stack.addCleanup(p.stop)
    return started


class HeroRegenTests(unittest.TestCase):
    def test_hero_writes_hero_image_column(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "update_hero": mock.patch.object(media.store, "update_story_hero"),
                "make_thumb": mock.patch.object(
                    media.stages, "make_thumbnail_prompt",
                    return_value="cinematic prompt",
                ),
            })
            mocks = _apply(patches, self)
            url, cents = media.regen_one("abc123", "hero", Path(tmp))
            self.assertTrue(url.endswith("/hero.png"))
            self.assertEqual(cents, 5)  # 1 image * $0.05
            mocks["update_hero"].assert_called_once()
            mocks["update_hero"].assert_called_with("abc123", url)

    def test_hero_raises_when_kie_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "generate_with_retry": mock.patch.object(
                    media, "_generate_with_retry", return_value=None,
                ),
                "make_thumb": mock.patch.object(
                    media.stages, "make_thumbnail_prompt",
                    return_value="cinematic prompt",
                ),
            })
            _apply(patches, self)
            with self.assertRaises(RuntimeError) as ctx:
                media.regen_one("abc123", "hero", Path(tmp))
            self.assertIn("no URL", str(ctx.exception))


class ScenesRegenTests(unittest.TestCase):
    def test_scenes_writes_images_column_and_returns_first_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            scene_prompts = [
                "hero prompt (discarded)",
                "scene 1 prompt",
                "scene 2 prompt",
                "scene 3 prompt",
            ]
            patches = _patches({
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                    return_value=scene_prompts,
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=3,
                ),
                "update_scenes": mock.patch.object(media.store, "update_story_scenes"),
            })
            mocks = _apply(patches, self)
            url, cents = media.regen_one("abc123", "scenes", Path(tmp))
            # 3 scenes generated.
            self.assertEqual(mocks["update_scenes"].call_count, 1)
            scene_arg = mocks["update_scenes"].call_args.args[1]
            self.assertEqual(len(scene_arg), 3)
            self.assertEqual(url, scene_arg[0])
            self.assertEqual(cents, 15)  # 3 scenes * $0.05

    def test_scenes_raises_when_all_generations_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                    return_value=["hero", "s1", "s2"],
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=2,
                ),
                "generate_with_retry": mock.patch.object(
                    media, "_generate_with_retry", return_value=None,
                ),
                "update_scenes": mock.patch.object(media.store, "update_story_scenes"),
            })
            _apply(patches, self)
            with self.assertRaises(RuntimeError) as ctx:
                media.regen_one("abc123", "scenes", Path(tmp))
            self.assertIn("0 images", str(ctx.exception))


class PropsRegenTests(unittest.TestCase):
    def test_props_blocked_when_setting_off(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "prop_slide_enabled": mock.patch.object(
                    media, "_prop_slide_enabled", return_value=False,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(RuntimeError) as ctx:
                media.regen_one("abc123", "props", Path(tmp))
            self.assertIn("video.prop_slide is off", str(ctx.exception))

    def test_props_writes_props_column_with_url_label_side(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = [
                {"keyword": "leaf blower", "label": "leaf blower", "side": "right"},
                {"keyword": "kite", "label": "kite", "side": "left"},
            ]
            patches = _patches({
                "prop_slide_enabled": mock.patch.object(
                    media, "_prop_slide_enabled", return_value=True,
                ),
                "prop_count": mock.patch.object(
                    media, "_prop_count", return_value=2,
                ),
                "make_prop_plan": mock.patch.object(
                    media.stages, "make_prop_plan", return_value=plan,
                ),
                "make_prop_image_prompt": mock.patch.object(
                    media.stages, "make_prop_image_prompt",
                    side_effect=lambda kw: f"prompt for {kw}",
                ),
                "update_props": mock.patch.object(media.store, "update_story_props"),
            })
            mocks = _apply(patches, self)
            url, cents = media.regen_one("abc123", "props", Path(tmp))
            self.assertEqual(cents, 10)  # 2 props * $0.05
            stored = mocks["update_props"].call_args.args[1]
            self.assertEqual(len(stored), 2)
            self.assertEqual(stored[0]["label"], "leaf blower")
            self.assertEqual(stored[0]["side"], "right")
            self.assertTrue(stored[0]["url"].endswith("/prop-1.png"))


class MouthSwapRegenTests(unittest.TestCase):
    def test_mouth_swap_blocked_when_setting_off(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "mouth_swap_enabled": mock.patch.object(
                    media, "_mouth_swap_enabled", return_value=False,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(RuntimeError) as ctx:
                media.regen_one("abc123", "mouth_swap", Path(tmp))
            self.assertIn("video.mouth_swap is off", str(ctx.exception))

    def test_mouth_swap_writes_both_character_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "mouth_swap_enabled": mock.patch.object(
                    media, "_mouth_swap_enabled", return_value=True,
                ),
                "make_character_prompt": mock.patch.object(
                    media.stages, "make_character_prompt",
                    return_value="character prompt",
                ),
                "mouth_swap_block": mock.patch.object(
                    media, "_mouth_swap_block",
                    return_value=("https://gcs/char.png", "https://gcs/char-no-mouth.png"),
                ),
                "update_char": mock.patch.object(media.store, "update_story_character"),
            })
            mocks = _apply(patches, self)
            url, cents = media.regen_one("abc123", "mouth_swap", Path(tmp))
            self.assertEqual(cents, 10)  # 2 images * $0.05
            mocks["update_char"].assert_called_with(
                "abc123",
                "https://gcs/char.png",
                "https://gcs/char-no-mouth.png",
            )

    def test_mouth_swap_partial_success_records_actual_cost(self):
        """When only one of the two kie calls returns a URL, the row should
        record only that cost so the daily cap stays honest."""
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "mouth_swap_enabled": mock.patch.object(
                    media, "_mouth_swap_enabled", return_value=True,
                ),
                "make_character_prompt": mock.patch.object(
                    media.stages, "make_character_prompt",
                    return_value="character prompt",
                ),
                "mouth_swap_block": mock.patch.object(
                    media, "_mouth_swap_block",
                    return_value=("https://gcs/char.png", None),
                ),
                "update_char": mock.patch.object(media.store, "update_story_character"),
            })
            _apply(patches, self)
            url, cents = media.regen_one("abc123", "mouth_swap", Path(tmp))
            self.assertEqual(cents, 5)  # only one image came back
            self.assertEqual(url, "https://gcs/char.png")


class DispatchTests(unittest.TestCase):
    def test_unknown_asset_raises_not_implemented(self):
        with tempfile.TemporaryDirectory() as tmp:
            _apply(_patches(), self)
            with self.assertRaises(NotImplementedError):
                media.regen_one("abc123", "frog", Path(tmp))

    def test_missing_story_raises_value_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=None,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(ValueError):
                media.regen_one("nope", "hero", Path(tmp))


if __name__ == "__main__":
    unittest.main()
