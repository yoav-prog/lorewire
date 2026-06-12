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


class ParseIndexTests(unittest.TestCase):
    def test_parses_valid_indices(self):
        self.assertEqual(media._parse_index("scene:0"), 0)
        self.assertEqual(media._parse_index("scene:12"), 12)
        self.assertEqual(media._parse_index("prop:3"), 3)

    def test_rejects_missing_index(self):
        with self.assertRaises(ValueError):
            media._parse_index("scene:")

    def test_rejects_non_numeric(self):
        with self.assertRaises(ValueError):
            media._parse_index("scene:abc")

    def test_rejects_negative(self):
        with self.assertRaises(ValueError):
            media._parse_index("scene:-1")


class PerSceneRegenTests(unittest.TestCase):
    def _story_with_scenes(self, urls):
        import json as _json
        return {**STORY, "images": _json.dumps(urls)}

    def test_one_scene_splices_only_that_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            existing = [f"https://old/scene-{i + 1}.png" for i in range(5)]
            story = self._story_with_scenes(existing)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                    return_value=["hero"] + [f"scene {i}" for i in range(5)],
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=5,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
            })
            mocks = _apply(patches, self)
            url, cents = media.regen_one("abc123", "scene:2", Path(tmp))
            self.assertEqual(cents, 5)
            # Only index 2 should change; the other four URLs preserved verbatim.
            new_scenes = mocks["update_scenes"].call_args.args[1]
            self.assertEqual(len(new_scenes), 5)
            self.assertEqual(new_scenes[0], existing[0])
            self.assertEqual(new_scenes[1], existing[1])
            self.assertNotEqual(new_scenes[2], existing[2])
            self.assertEqual(new_scenes[2], url)
            self.assertEqual(new_scenes[3], existing[3])
            self.assertEqual(new_scenes[4], existing[4])

    def test_out_of_range_index_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            story = self._story_with_scenes(["a", "b"])
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(ValueError) as ctx:
                media.regen_one("abc123", "scene:99", Path(tmp))
            self.assertIn("out of range", str(ctx.exception))


class PerPropRegenTests(unittest.TestCase):
    def _story_with_props(self, props):
        import json as _json
        return {**STORY, "props": _json.dumps(props)}

    def test_one_prop_splices_url_preserves_label_and_side(self):
        with tempfile.TemporaryDirectory() as tmp:
            existing = [
                {"url": "https://old/p1.png", "label": "leaf blower", "side": "right"},
                {"url": "https://old/p2.png", "label": "kite", "side": "left"},
                {"url": "https://old/p3.png", "label": "flag", "side": "right"},
            ]
            story = self._story_with_props(existing)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "prop_slide_enabled": mock.patch.object(
                    media, "_prop_slide_enabled", return_value=True,
                ),
                "make_prop_image_prompt": mock.patch.object(
                    media.stages, "make_prop_image_prompt",
                    side_effect=lambda kw: f"prompt for {kw}",
                ),
                "update_props": mock.patch.object(
                    media.store, "update_story_props",
                ),
            })
            mocks = _apply(patches, self)
            url, cents = media.regen_one("abc123", "prop:1", Path(tmp))
            self.assertEqual(cents, 5)
            new_props = mocks["update_props"].call_args.args[1]
            # Index 1 swaps url; label + side preserved verbatim.
            self.assertEqual(new_props[0], existing[0])
            self.assertEqual(new_props[1]["label"], "kite")
            self.assertEqual(new_props[1]["side"], "left")
            self.assertNotEqual(new_props[1]["url"], existing[1]["url"])
            self.assertEqual(new_props[1]["url"], url)
            self.assertEqual(new_props[2], existing[2])

    def test_one_prop_blocked_when_setting_off(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "prop_slide_enabled": mock.patch.object(
                    media, "_prop_slide_enabled", return_value=False,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(RuntimeError):
                media.regen_one("abc123", "prop:0", Path(tmp))


class PerFrameRegenTests(unittest.TestCase):
    """Tests for the `frame:<id>` slug — video editor Phase 3 part 2.

    Verifies dispatch, prompt sourcing, sibling preservation, and the
    fail-loud paths (missing config / malformed JSON / unknown id /
    missing image_prompt). Mocks the network surface so no kie credits
    are burned.
    """

    def _story_with_frames(self, frames: list[dict]) -> dict:
        import json as _json
        return {
            **STORY,
            "video_config": _json.dumps({
                "config_version": 2,
                "voiceover_url": "/v.mp3",
                "duration_ms": 10000,
                "doodle_frames": frames,
                "captions": [
                    {"start_ms": 0, "end_ms": 10000, "text": "Hi"}
                ],
            }),
        }

    def test_writes_new_url_into_video_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            frames = [
                {
                    "id": "frame-a",
                    "url": "/old-a.png",
                    "caption_chunk_start_index": 0,
                    "image_prompt": "a doodle of an accountant",
                },
                {
                    "id": "frame-b",
                    "url": "/old-b.png",
                    "caption_chunk_start_index": 0,
                    "image_prompt": "a doodle of a leaf blower",
                },
            ]
            story = self._story_with_frames(frames)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
            })
            mocks = _apply(patches, self)
            url, cents = media.regen_one("abc123", "frame:frame-a", Path(tmp))
            self.assertEqual(cents, 5)
            new_config = mocks["update_video_config"].call_args.args[1]
            new_frames = new_config["doodle_frames"]
            # Only frame-a's url changed; frame-b is preserved verbatim.
            self.assertEqual(new_frames[0]["id"], "frame-a")
            self.assertNotEqual(new_frames[0]["url"], "/old-a.png")
            self.assertEqual(new_frames[0]["url"], url)
            self.assertEqual(new_frames[1], frames[1])

    def test_preserves_image_prompt_and_prev_image_on_target_frame(self):
        # The TS server action owns image_prompt + prev_image. The Python
        # worker must NOT touch them — Revert would lose its snapshot.
        with tempfile.TemporaryDirectory() as tmp:
            frames = [
                {
                    "id": "frame-a",
                    "url": "/old-a.png",
                    "caption_chunk_start_index": 0,
                    "image_prompt": "the new prompt",
                    "prev_image": {
                        "url": "/older.png",
                        "image_prompt": "the older prompt",
                        "replaced_at": "2026-06-12T11:00:00Z",
                    },
                },
            ]
            story = self._story_with_frames(frames)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
            })
            mocks = _apply(patches, self)
            media.regen_one("abc123", "frame:frame-a", Path(tmp))
            new_frames = mocks["update_video_config"].call_args.args[1]["doodle_frames"]
            self.assertEqual(new_frames[0]["image_prompt"], "the new prompt")
            self.assertEqual(
                new_frames[0]["prev_image"],
                frames[0]["prev_image"],
            )

    def test_missing_video_config_raises_value_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            story = {**STORY}  # no video_config field at all
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(ValueError) as ctx:
                media.regen_one("abc123", "frame:frame-a", Path(tmp))
            self.assertIn("video_config", str(ctx.exception))

    def test_malformed_video_config_json_raises_value_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            story = {**STORY, "video_config": "{not valid json"}
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(ValueError) as ctx:
                media.regen_one("abc123", "frame:frame-a", Path(tmp))
            self.assertIn("malformed", str(ctx.exception).lower())

    def test_unknown_frame_id_raises_value_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            frames = [
                {
                    "id": "frame-a",
                    "url": "/old.png",
                    "caption_chunk_start_index": 0,
                    "image_prompt": "p",
                },
            ]
            story = self._story_with_frames(frames)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(ValueError) as ctx:
                media.regen_one("abc123", "frame:does-not-exist", Path(tmp))
            self.assertIn("not found", str(ctx.exception))

    def test_missing_image_prompt_raises_value_error(self):
        # The TS server action validates + writes image_prompt before
        # enqueueing; an empty prompt here means a regression or manual
        # queue insert. Fail loud so the admin sees the cause.
        with tempfile.TemporaryDirectory() as tmp:
            frames = [
                {
                    "id": "frame-a",
                    "url": "/old.png",
                    "caption_chunk_start_index": 0,
                    # no image_prompt
                },
            ]
            story = self._story_with_frames(frames)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(ValueError) as ctx:
                media.regen_one("abc123", "frame:frame-a", Path(tmp))
            self.assertIn("image_prompt", str(ctx.exception))

    def test_empty_frame_id_after_colon_raises_value_error(self):
        # A bare "frame:" slug (no id) is a malformed queue row.
        with tempfile.TemporaryDirectory() as tmp:
            story = self._story_with_frames([])
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(ValueError) as ctx:
                media.regen_one("abc123", "frame:", Path(tmp))
            self.assertIn("missing frame id", str(ctx.exception))

    def test_kie_returning_none_raises_runtime_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            frames = [
                {
                    "id": "frame-a",
                    "url": "/old.png",
                    "caption_chunk_start_index": 0,
                    "image_prompt": "p",
                },
            ]
            story = self._story_with_frames(frames)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "generate_with_retry": mock.patch.object(
                    media, "_generate_with_retry", return_value=None,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(RuntimeError):
                media.regen_one("abc123", "frame:frame-a", Path(tmp))


if __name__ == "__main__":
    unittest.main()
