"""Tests for pipeline.shorts_render — the short props assembly.

Focus: the base reference frame must NEVER become a visible scene (it is the
i2i character anchor only), it must instead survive as props.character_base_url,
and the opening scene must cover t=0. Plus a guard that the shared doodle style
suffix no longer hard-codes a single character's identity (that made every
short the same glasses-wearing person). See
_plans/2026-06-17-shorts-editor-and-character-bugs.md.

The generation + voice + upload steps are stubbed so the assembly logic is
exercised without burning kie / TTS credits or touching the network.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import shorts, shorts_image_style as sis, shorts_render


class MapFramesTests(unittest.TestCase):
    def test_first_frame_pinned_to_caption_zero(self):
        # Even when every scene was planned against a later beat, the opening
        # frame is pinned to caption 0 so DoodleShort has no blank lead.
        staged = [
            {"id": "frame-00", "url": "u0", "planned": 3, "image_prompt": None},
            {"id": "frame-01", "url": "u1", "planned": 6, "image_prompt": None},
        ]
        frames = shorts_render._map_frames(staged, caption_count=10, planning_count=8)
        self.assertEqual(frames[0]["caption_chunk_start_index"], 0)

    def test_indices_stay_unique_and_sorted(self):
        staged = [
            {"id": "a", "url": "ua", "planned": 0, "image_prompt": None},
            {"id": "b", "url": "ub", "planned": 0, "image_prompt": None},
            {"id": "c", "url": "uc", "planned": 1, "image_prompt": None},
        ]
        frames = shorts_render._map_frames(staged, caption_count=6, planning_count=3)
        idxs = [f["caption_chunk_start_index"] for f in frames]
        self.assertEqual(idxs, sorted(idxs))
        self.assertEqual(len(idxs), len(set(idxs)))


class BuildShortPropsBaseFrameTests(unittest.TestCase):
    """The base reference image is the model's i2i identity anchor — a neutral
    standing pose on a plain background. It must not appear in the rendered
    video; it lives only as props.character_base_url."""

    def _assets(self) -> shorts.ShortAssets:
        return shorts.ShortAssets(
            narration_style="suspense",
            length_preset="standard",
            script={"short_script": "Hello there. This is a short test script."},
            character="a tall man with a red scarf",
            base_url="https://kie/base.png",
            base_prompt="BASE PROMPT",
            scenes=[
                {"caption_chunk_start_index": 0, "scene": "s0", "url": "https://kie/s0.png", "image_prompt": "p0"},
                {"caption_chunk_start_index": 2, "scene": "s1", "url": "https://kie/s1.png", "image_prompt": "p1"},
            ],
            cost_credits=0.0,
        )

    def test_base_excluded_from_frames_but_kept_as_character_base_url(self):
        words = [
            {"word": "Hello", "start": 0.0, "end": 0.4},
            {"word": "there.", "start": 0.4, "end": 0.9},
            {"word": "This", "start": 1.0, "end": 1.3},
            {"word": "is", "start": 1.3, "end": 1.5},
            {"word": "a", "start": 1.5, "end": 1.6},
            {"word": "short.", "start": 1.6, "end": 2.1},
        ]
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(shorts_render.store, "fetch_story",
                              return_value={"id": "s1", "title": "T", "body": "Body text here."}), \
            mock.patch.object(shorts_render.shorts, "generate_short_assets",
                              return_value=self._assets()), \
            mock.patch.object(shorts_render.voice, "synthesize",
                              return_value={"words": words}), \
            mock.patch.object(shorts_render.images, "download", return_value=None), \
            mock.patch.object(shorts_render.store, "get_setting", return_value=None):
            built = shorts_render.build_short_props("s1", Path(tmp), remote=False)

        self.assertIsNotNone(built)
        props = built.props
        # The base reference is preserved for Lane C regen / the editor...
        self.assertEqual(props["character_base_url"], "https://kie/base.png")
        # ...but it is NOT one of the visible frames.
        frame_urls = [f["url"] for f in props["doodle_frames"]]
        self.assertNotIn("https://kie/base.png", frame_urls)
        # Exactly the two scenes became frames (no base prepended).
        self.assertEqual(len(props["doodle_frames"]), 2)
        # And the short still opens at t=0.
        self.assertEqual(props["doodle_frames"][0]["caption_chunk_start_index"], 0)

    def test_duration_floors_at_real_audio_length(self):
        # The last aligned word ends at ~2.1s, but the real MP3 runs 8s (a
        # provider whose word timings undershoot the file). The composition body
        # must cover the FULL audio or the concatenated outro clips the closing
        # words, so duration_ms floors at the probe value.
        words = [
            {"word": "Hello", "start": 0.0, "end": 0.4},
            {"word": "short.", "start": 1.6, "end": 2.1},
        ]
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(shorts_render.store, "fetch_story",
                              return_value={"id": "s1", "title": "T", "body": "Body text here."}), \
            mock.patch.object(shorts_render.shorts, "generate_short_assets",
                              return_value=self._assets()), \
            mock.patch.object(shorts_render.voice, "synthesize",
                              return_value={"words": words}), \
            mock.patch.object(shorts_render.voice, "audio_duration_ms", return_value=8000), \
            mock.patch.object(shorts_render.images, "download", return_value=None), \
            mock.patch.object(shorts_render.store, "get_setting", return_value=None):
            built = shorts_render.build_short_props("s1", Path(tmp), remote=False)
        self.assertEqual(built.props["duration_ms"], 8000)


class DoodleSuffixIdentityGuardTests(unittest.TestCase):
    """Regression guard: the shared doodle style suffix is appended to the base
    AND every scene prompt, so any character-identity token in it forces the
    SAME person into every short. The suffix must describe the ART STYLE only;
    identity comes from the per-story planner character description."""

    def test_no_hardcoded_character_identity_tokens(self):
        suffix = sis.DOODLE_SUFFIX.lower()
        for token in ("round glasses", "lab coats", "ties in blue", "beards / hair"):
            self.assertNotIn(
                token, suffix,
                msg=f"DOODLE_SUFFIX must not hard-code character identity: {token!r}",
            )


if __name__ == "__main__":
    unittest.main()
