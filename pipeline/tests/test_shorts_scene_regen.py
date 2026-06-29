"""Tests for the per-scene regen handler that the image_render_worker
dispatches to when owner_kind = 'short_scene'. Phase 1 of
_plans/2026-06-16-short-editor-full-parity.md.

We don't actually hit kie here — the network path is exercised by the
worker integration suite. What we lock down is the validation surface:
malformed config / missing frame / missing prompt / missing character
base all raise ValueError so the queue's failed-row error column
surfaces a useful message in the UI.
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import shorts_scene_regen, store


class _ShortsSceneRegenTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        db_path = Path(self._tmpdir.name) / "shorts-scene-regen.db"
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

    def _seed_story(self, story_id: str, short_config: dict | None) -> None:
        cfg_json = json.dumps(short_config) if short_config else None
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "INSERT INTO stories (id, slug, title, status, short_config) "
                "VALUES (?, ?, ?, 'ready', ?)",
                (story_id, f"slug-{story_id}", f"Title {story_id}", cfg_json),
            )


class ValidationTests(_ShortsSceneRegenTestCase):
    def test_unknown_asset_slug_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_scene_regen.regen_short_scene("s-1", "hero", Path("."))
        self.assertIn("frame:", str(cm.exception))

    def test_empty_frame_id_after_colon_raises(self):
        self._seed_story("s-2", {"doodle_frames": []})
        with self.assertRaises(ValueError) as cm:
            shorts_scene_regen.regen_short_scene("s-2", "frame:", Path("."))
        self.assertIn("missing frame id", str(cm.exception))

    def test_missing_story_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_scene_regen.regen_short_scene(
                "ghost", "frame:frame-00", Path("."),
            )
        self.assertIn("not found", str(cm.exception))

    def test_missing_short_config_raises(self):
        self._seed_story("s-3", None)
        with self.assertRaises(ValueError) as cm:
            shorts_scene_regen.regen_short_scene(
                "s-3", "frame:frame-00", Path("."),
            )
        self.assertIn("no short_config", str(cm.exception))

    def test_malformed_short_config_json_raises(self):
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "INSERT INTO stories (id, slug, title, status, short_config) "
                "VALUES (?, ?, ?, 'ready', ?)",
                ("s-malformed", "s", "t", "{not json}"),
            )
        with self.assertRaises(ValueError) as cm:
            shorts_scene_regen.regen_short_scene(
                "s-malformed", "frame:frame-00", Path("."),
            )
        self.assertIn("malformed JSON", str(cm.exception))

    def test_unknown_frame_id_raises(self):
        self._seed_story(
            "s-4",
            {
                "doodle_frames": [
                    {
                        "id": "frame-00",
                        "url": "https://gcs/00.png",
                        "image_prompt": "hi",
                    },
                ],
                "character_base_url": "https://gcs/base.png",
            },
        )
        with self.assertRaises(ValueError) as cm:
            shorts_scene_regen.regen_short_scene(
                "s-4", "frame:nope", Path("."),
            )
        self.assertIn("not found", str(cm.exception))

    def test_missing_image_prompt_raises(self):
        self._seed_story(
            "s-5",
            {
                "doodle_frames": [
                    {"id": "frame-00", "url": "https://gcs/00.png"},
                ],
                "character_base_url": "https://gcs/base.png",
            },
        )
        with self.assertRaises(ValueError) as cm:
            shorts_scene_regen.regen_short_scene(
                "s-5", "frame:frame-00", Path("."),
            )
        self.assertIn("image_prompt", str(cm.exception))

    def test_missing_character_base_url_raises(self):
        self._seed_story(
            "s-6",
            {
                "doodle_frames": [
                    {
                        "id": "frame-00",
                        "url": "https://gcs/00.png",
                        "image_prompt": "a scene",
                    },
                ],
            },
        )
        with self.assertRaises(ValueError) as cm:
            shorts_scene_regen.regen_short_scene(
                "s-6", "frame:frame-00", Path("."),
            )
        self.assertIn("character_base_url", str(cm.exception))


class HappyPathTests(_ShortsSceneRegenTestCase):
    def test_writes_new_url_and_prev_image_and_pins(self):
        # Stub out the network + GCS sides so the test is fast + offline.
        self._seed_story(
            "s-happy",
            {
                "doodle_frames": [
                    {
                        "id": "frame-00",
                        "url": "https://gcs/old.png",
                        "image_prompt": "a forest",
                    },
                    {
                        "id": "frame-01",
                        "url": "https://gcs/other.png",
                        "image_prompt": "a meadow",
                    },
                ],
                "character_base_url": "https://gcs/base.png",
            },
        )

        with (
            mock.patch.object(
                shorts_scene_regen.media,
                "_generate_with_retry",
                return_value="https://kie.example/output.png",
            ),
            mock.patch.object(
                shorts_scene_regen.images, "download", return_value=None,
            ),
            mock.patch.object(
                shorts_scene_regen.gcs,
                "publish",
                return_value="https://gcs/new.png",
            ),
            mock.patch.object(
                shorts_scene_regen.media,
                "_per_image_cost_cents",
                return_value=5,
            ),
            mock.patch.object(
                shorts_scene_regen.media,
                "_regen_out_dir",
                return_value=Path(self._tmpdir.name),
            ),
        ):
            url, cents = shorts_scene_regen.regen_short_scene(
                "s-happy", "frame:frame-00", Path("."),
            )

        self.assertEqual(url, "https://gcs/new.png")
        self.assertEqual(cents, 5)

        # Re-read from the DB and confirm: frame-00 got the new url + pinned +
        # prev_image; frame-01 is untouched.
        story = store.fetch_story("s-happy")
        assert story is not None
        config = json.loads(story["short_config"])
        frames = config["doodle_frames"]
        f0 = next(f for f in frames if f["id"] == "frame-00")
        f1 = next(f for f in frames if f["id"] == "frame-01")
        self.assertEqual(f0["url"], "https://gcs/new.png")
        self.assertEqual(f0["is_pinned"], True)
        self.assertEqual(f0["prev_image"]["url"], "https://gcs/old.png")
        self.assertEqual(f0["prev_image"]["image_prompt"], "a forest")
        # Untouched frame stays unpinned.
        self.assertEqual(f1["url"], "https://gcs/other.png")
        self.assertNotIn("is_pinned", f1)

    def test_passes_persisted_multi_ref_input_to_i2i(self):
        # When a frame carries `image_input_urls` (base + world-bible refs),
        # the regen must replay that same multi-ref list. Otherwise per-scene
        # regen would lose the wife / kitchen / envelope consistency the
        # initial render established.
        self._seed_story(
            "s-multi",
            {
                "doodle_frames": [
                    {
                        "id": "frame-00",
                        "url": "https://gcs/old.png",
                        "image_prompt": "wife in the kitchen",
                        "image_input_urls": [
                            "https://gcs/base.png",
                            "https://gcs/wife-ref.png",
                            "https://gcs/kitchen-ref.png",
                        ],
                    },
                ],
                "character_base_url": "https://gcs/base.png",
            },
        )
        captured: dict = {}

        def _capture_kie(prompt, label, **kwargs):
            captured["image_input"] = kwargs.get("image_input")
            return "https://kie.example/output.png"

        with (
            mock.patch.object(
                shorts_scene_regen.media, "_generate_with_retry",
                side_effect=_capture_kie,
            ),
            mock.patch.object(shorts_scene_regen.images, "download", return_value=None),
            mock.patch.object(
                shorts_scene_regen.gcs, "publish", return_value="https://gcs/new.png",
            ),
            mock.patch.object(
                shorts_scene_regen.media, "_per_image_cost_cents", return_value=5,
            ),
            mock.patch.object(
                shorts_scene_regen.media, "_regen_out_dir",
                return_value=Path(self._tmpdir.name),
            ),
        ):
            shorts_scene_regen.regen_short_scene(
                "s-multi", "frame:frame-00", Path("."),
            )

        # The exact ordered list the initial render used must reach kie.
        self.assertEqual(
            captured["image_input"],
            [
                "https://gcs/base.png",
                "https://gcs/wife-ref.png",
                "https://gcs/kitchen-ref.png",
            ],
        )

    def test_forces_base_first_when_persisted_list_is_out_of_order(self):
        # Defensive: if a malformed config has the base elsewhere (or missing),
        # the regen must still anchor identity by putting the base char URL
        # first in input_urls.
        self._seed_story(
            "s-broken",
            {
                "doodle_frames": [
                    {
                        "id": "frame-00",
                        "url": "https://gcs/old.png",
                        "image_prompt": "wife in the kitchen",
                        # base url is NOT in the list at all
                        "image_input_urls": [
                            "https://gcs/wife-ref.png",
                            "https://gcs/kitchen-ref.png",
                        ],
                    },
                ],
                "character_base_url": "https://gcs/base.png",
            },
        )
        captured: dict = {}

        def _capture_kie(prompt, label, **kwargs):
            captured["image_input"] = kwargs.get("image_input")
            return "https://kie.example/output.png"

        with (
            mock.patch.object(
                shorts_scene_regen.media, "_generate_with_retry",
                side_effect=_capture_kie,
            ),
            mock.patch.object(shorts_scene_regen.images, "download", return_value=None),
            mock.patch.object(
                shorts_scene_regen.gcs, "publish", return_value="https://gcs/new.png",
            ),
            mock.patch.object(
                shorts_scene_regen.media, "_per_image_cost_cents", return_value=5,
            ),
            mock.patch.object(
                shorts_scene_regen.media, "_regen_out_dir",
                return_value=Path(self._tmpdir.name),
            ),
        ):
            shorts_scene_regen.regen_short_scene(
                "s-broken", "frame:frame-00", Path("."),
            )

        # Base char URL pushed to the front.
        self.assertEqual(captured["image_input"][0], "https://gcs/base.png")
        # World-bible refs preserved behind it.
        self.assertIn("https://gcs/wife-ref.png", captured["image_input"])
        self.assertIn("https://gcs/kitchen-ref.png", captured["image_input"])

    def test_legacy_frame_without_input_urls_falls_back_to_base_only(self):
        # Frames generated before the world-bible feature have no
        # `image_input_urls` field. The regen must still work — just with
        # single-ref input — so old shorts can be re-edited.
        self._seed_story(
            "s-legacy",
            {
                "doodle_frames": [
                    {
                        "id": "frame-00",
                        "url": "https://gcs/old.png",
                        "image_prompt": "a forest",
                    },
                ],
                "character_base_url": "https://gcs/base.png",
            },
        )
        captured: dict = {}

        def _capture_kie(prompt, label, **kwargs):
            captured["image_input"] = kwargs.get("image_input")
            return "https://kie.example/output.png"

        with (
            mock.patch.object(
                shorts_scene_regen.media, "_generate_with_retry",
                side_effect=_capture_kie,
            ),
            mock.patch.object(shorts_scene_regen.images, "download", return_value=None),
            mock.patch.object(
                shorts_scene_regen.gcs, "publish", return_value="https://gcs/new.png",
            ),
            mock.patch.object(
                shorts_scene_regen.media, "_per_image_cost_cents", return_value=5,
            ),
            mock.patch.object(
                shorts_scene_regen.media, "_regen_out_dir",
                return_value=Path(self._tmpdir.name),
            ),
        ):
            shorts_scene_regen.regen_short_scene(
                "s-legacy", "frame:frame-00", Path("."),
            )

        self.assertEqual(captured["image_input"], ["https://gcs/base.png"])


if __name__ == "__main__":
    unittest.main()
