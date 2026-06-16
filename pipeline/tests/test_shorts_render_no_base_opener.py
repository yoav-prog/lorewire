"""Tests for the base-image-as-opener removal in `build_short_props`.

What we lock down:
  - The base image (character on plain white) no longer appears in
    `doodle_frames` — it lives only in `props.character_base_url` for
    the editor's i2i regen surface.
  - The first surviving scene frame is pinned to caption 0 so the
    opener always has a visual during the hook line.
  - The zero-scenes fallback path: when every scene fails staging, the
    base falls back as `frame-00` so the short still renders rather
    than aborting.

The function is integration-heavy (calls voice + images + gcs + store +
shorts.generate_short_assets) so each test mocks the I/O dependencies
and inspects the props dict the builder returns.
"""
from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import shorts, shorts_render, store


class _BuildShortPropsTestCase(unittest.TestCase):
    """Sets up an empty sqlite store + a single seeded story row so
    `build_short_props` can fetch_story without exploding, then patches
    out every upstream + downstream I/O surface."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        db_path = Path(self._tmpdir.name) / "short-render.db"
        self._db_patch = mock.patch.object(store, "DB_PATH", str(db_path))
        self._db_patch.start()
        self._env_patch = mock.patch.dict(os.environ, {}, clear=False)
        self._env_patch.start()
        os.environ.pop("DATABASE_URL", None)
        store.init()
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "INSERT INTO stories (id, title, body, summary, status) "
                "VALUES (?, ?, ?, ?, ?)",
                ("s1", "Story One", "The body of story one.", "Summary.", "draft"),
            )

    def tearDown(self) -> None:
        self._db_patch.stop()
        self._env_patch.stop()
        self._tmpdir.cleanup()

    def _mock_assets(self, scene_count: int = 3) -> shorts.ShortAssets:
        return shorts.ShortAssets(
            narration_style="suspense",
            length_preset="standard",
            script={
                "title": "Story One",
                "hook": "Hook line.",
                "short_script": "Hook line. Beat two. Payoff line.",
                "payoff": "Payoff line.",
                "word_count": 6,
            },
            character="A character",
            base_url="https://kie/base.png",
            base_prompt="character standing pose",
            scenes=[
                {
                    "caption_chunk_start_index": i,
                    "scene": f"scene {i}",
                    "url": f"https://kie/scene-{i}.png",
                    "image_prompt": f"prompt {i}",
                }
                for i in range(scene_count)
            ],
            cost_credits=0.0,
        )


class NoBaseOpenerTests(_BuildShortPropsTestCase):
    def test_base_is_not_in_doodle_frames(self) -> None:
        """The base image is uploaded but lives only in
        `props.character_base_url`. Every entry in `doodle_frames` is a
        scene URL — none of them point at the base."""
        assets = self._mock_assets(scene_count=3)
        with (
            mock.patch.object(shorts, "generate_short_assets", return_value=assets),
            mock.patch.object(
                shorts_render.voice,
                "synthesize",
                return_value={
                    "words": [
                        {"word": "hook", "start": 0.0, "end": 0.5},
                        {"word": "beat", "start": 0.5, "end": 1.0},
                        {"word": "payoff.", "start": 1.0, "end": 1.5},
                    ],
                },
            ),
            mock.patch.object(shorts_render.images, "download"),
            mock.patch.object(
                shorts_render.gcs,
                "publish",
                side_effect=lambda local, key, fallback: f"https://gcs/{key}",
            ),
        ):
            result = shorts_render.build_short_props(
                "s1", Path(self._tmpdir.name), remote=True,
            )

        self.assertIsNotNone(result)
        assert result is not None  # for type-checker
        props = result.props

        # Base lives only in character_base_url, NOT in doodle_frames.
        self.assertEqual(
            props["character_base_url"],
            "https://gcs/s1-short/base.png",
        )
        urls = [f["url"] for f in props["doodle_frames"]]
        self.assertNotIn(
            props["character_base_url"], urls,
            "base image should not appear as a doodle frame",
        )
        # Staging renames each source to frame-NN.png so doodle URLs all
        # live under the staged path, and none of them collide with the
        # base. Scene count matches the mocked assets.scenes (3).
        self.assertEqual(len(urls), 3)
        for u in urls:
            self.assertIn("/frame-", u)
            self.assertNotIn("/base.png", u)

    def test_first_frame_pinned_to_caption_zero(self) -> None:
        """Even if the LLM placed scene-1 at a later caption index, the
        builder pins the first surviving frame to caption 0 so the
        opener always has a visual during the hook line."""
        assets = self._mock_assets(scene_count=2)
        # Off-spec LLM response: first scene starts at chunk 2, not 0.
        assets.scenes[0]["caption_chunk_start_index"] = 2
        assets.scenes[1]["caption_chunk_start_index"] = 3

        with (
            mock.patch.object(shorts, "generate_short_assets", return_value=assets),
            mock.patch.object(
                shorts_render.voice,
                "synthesize",
                return_value={
                    "words": [
                        {"word": f"w{i}", "start": i * 0.5, "end": i * 0.5 + 0.4}
                        for i in range(6)
                    ],
                },
            ),
            mock.patch.object(shorts_render.images, "download"),
            mock.patch.object(
                shorts_render.gcs,
                "publish",
                side_effect=lambda local, key, fallback: f"https://gcs/{key}",
            ),
        ):
            result = shorts_render.build_short_props(
                "s1", Path(self._tmpdir.name), remote=True,
            )

        self.assertIsNotNone(result)
        assert result is not None
        frames = result.props["doodle_frames"]
        self.assertGreater(len(frames), 0)
        self.assertEqual(
            frames[0]["caption_chunk_start_index"], 0,
            "first frame must land at caption 0 so the hook has a visual",
        )

    def test_zero_scenes_falls_back_to_base_as_frame_00(self) -> None:
        """When every scene fails staging, the base image is promoted
        to a single doodle frame so the short still renders rather than
        aborting the whole pipeline."""
        assets = self._mock_assets(scene_count=2)

        # images.download raises for scenes (the kie URLs) but succeeds
        # for the base. Branching on the URL keeps the mock honest —
        # we're not silently treating "no scenes" as "no assets".
        def _download(url: str, dest: Path) -> None:
            if "/base.png" in url:
                return
            raise RuntimeError(f"scene fetch failed for {url}")

        with (
            mock.patch.object(shorts, "generate_short_assets", return_value=assets),
            mock.patch.object(
                shorts_render.voice,
                "synthesize",
                return_value={
                    "words": [
                        {"word": "hook", "start": 0.0, "end": 0.5},
                    ],
                },
            ),
            mock.patch.object(shorts_render.images, "download", side_effect=_download),
            mock.patch.object(
                shorts_render.gcs,
                "publish",
                side_effect=lambda local, key, fallback: f"https://gcs/{key}",
            ),
        ):
            result = shorts_render.build_short_props(
                "s1", Path(self._tmpdir.name), remote=True,
            )

        self.assertIsNotNone(result)
        assert result is not None
        frames = result.props["doodle_frames"]
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]["id"], "frame-00")
        self.assertEqual(frames[0]["url"], result.props["character_base_url"])


if __name__ == "__main__":
    unittest.main()
