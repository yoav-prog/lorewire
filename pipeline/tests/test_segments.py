"""Tests for pipeline.segments: pick_segment resolution chain and ffmpeg
command builders.

Pure-logic only. The actual ffmpeg subprocess is exercised by the integration
test in test_segments_ffmpeg.py; running it in CI is opt-in because it
needs ffmpeg + ffprobe on PATH.
"""
from __future__ import annotations

import unittest
from pathlib import Path

from pipeline import segments


class PickSegmentChainTests(unittest.TestCase):
    """The story override beats the global active beats null. Each tier is a
    distinct return; one test per branch so a regression shows the exact step
    that broke."""

    @staticmethod
    def _store(settings: dict, rows: dict):
        """Build a (get_setting, fetch_segment) pair that reads from the given
        in-memory maps. Saves every test from instantiating a fake class."""
        get_setting = lambda k: settings.get(k)  # noqa: E731
        fetch_segment = lambda i: rows.get(i)  # noqa: E731
        return get_setting, fetch_segment

    def test_skip_flag_beats_everything(self):
        # Even a pinned id and a global active are bypassed when the story
        # has explicitly opted out.
        get_setting, fetch_segment = self._store(
            settings={
                "video.intro_outro_enabled": "1",
                "video.active_intro_id": "global",
            },
            rows={
                "pinned": {"id": "pinned", "kind": "intro", "enabled": 1},
                "global": {"id": "global", "kind": "intro", "enabled": 1},
            },
        )
        story = {"skip_intro": 1, "intro_segment_id": "pinned"}
        self.assertIsNone(
            segments.pick_segment("intro", story, get_setting, fetch_segment)
        )

    def test_pinned_id_beats_global_active(self):
        get_setting, fetch_segment = self._store(
            settings={"video.active_intro_id": "global"},
            rows={
                "pinned": {"id": "pinned", "kind": "intro", "enabled": 1},
                "global": {"id": "global", "kind": "intro", "enabled": 1},
            },
        )
        story = {"intro_segment_id": "pinned"}
        result = segments.pick_segment("intro", story, get_setting, fetch_segment)
        self.assertIsNotNone(result)
        self.assertEqual(result["id"], "pinned")

    def test_pinned_id_returned_even_when_disabled(self):
        # The admin explicitly pinned this id — respect the choice even if
        # they later disabled the row globally. Disable = "skip in rotation,"
        # not "never use."
        get_setting, fetch_segment = self._store(
            settings={"video.active_intro_id": "global"},
            rows={
                "pinned": {"id": "pinned", "kind": "intro", "enabled": 0},
                "global": {"id": "global", "kind": "intro", "enabled": 1},
            },
        )
        story = {"intro_segment_id": "pinned"}
        result = segments.pick_segment("intro", story, get_setting, fetch_segment)
        self.assertEqual(result["id"], "pinned")

    def test_pinned_id_missing_returns_none(self):
        # Override mode: a broken pin returns None rather than silently
        # falling through to the global active. Surprising behavior is worse
        # than no behavior.
        get_setting, fetch_segment = self._store(
            settings={"video.active_intro_id": "global"},
            rows={
                "global": {"id": "global", "kind": "intro", "enabled": 1},
            },
        )
        story = {"intro_segment_id": "deleted"}
        self.assertIsNone(
            segments.pick_segment("intro", story, get_setting, fetch_segment)
        )

    def test_master_switch_off_returns_none(self):
        get_setting, fetch_segment = self._store(
            settings={
                "video.intro_outro_enabled": "0",
                "video.active_intro_id": "global",
            },
            rows={
                "global": {"id": "global", "kind": "intro", "enabled": 1},
            },
        )
        self.assertIsNone(
            segments.pick_segment("intro", {}, get_setting, fetch_segment)
        )

    def test_master_switch_unset_defaults_on(self):
        # When the setting is missing entirely the feature still applies. This
        # is the "fresh install — admin just uploaded an intro, expect it to
        # run" path.
        get_setting, fetch_segment = self._store(
            settings={"video.active_intro_id": "global"},
            rows={
                "global": {"id": "global", "kind": "intro", "enabled": 1},
            },
        )
        result = segments.pick_segment("intro", {}, get_setting, fetch_segment)
        self.assertEqual(result["id"], "global")

    def test_global_active_disabled_returns_none(self):
        get_setting, fetch_segment = self._store(
            settings={"video.active_intro_id": "global"},
            rows={
                "global": {"id": "global", "kind": "intro", "enabled": 0},
            },
        )
        self.assertIsNone(
            segments.pick_segment("intro", {}, get_setting, fetch_segment)
        )

    def test_no_active_set_returns_none(self):
        get_setting, fetch_segment = self._store(settings={}, rows={})
        self.assertIsNone(
            segments.pick_segment("intro", {}, get_setting, fetch_segment)
        )

    def test_kind_outro_uses_outro_columns(self):
        # The same chain walks outro_* columns when kind="outro" — i.e. a
        # story's skip_intro shouldn't affect the outro pick.
        get_setting, fetch_segment = self._store(
            settings={"video.active_outro_id": "out"},
            rows={"out": {"id": "out", "kind": "outro", "enabled": 1}},
        )
        story = {"skip_intro": 1, "skip_outro": 0}
        result = segments.pick_segment("outro", story, get_setting, fetch_segment)
        self.assertEqual(result["id"], "out")

    def test_invalid_kind_raises(self):
        get_setting, fetch_segment = self._store({}, {})
        with self.assertRaises(ValueError):
            segments.pick_segment("middle", {}, get_setting, fetch_segment)


class TruthyHelpersTests(unittest.TestCase):
    def test_truthy_accepted_values(self):
        for s in ("1", "true", "TRUE", " on ", "yes", "Yes"):
            self.assertTrue(segments._truthy(s), f"expected truthy: {s!r}")

    def test_truthy_rejects_empty_and_zero(self):
        for s in (None, "", "0", "false", "no", " ", "off"):
            self.assertFalse(segments._truthy(s), f"expected falsy: {s!r}")

    def test_explicitly_off_only_for_known_values(self):
        for s in ("0", "false", "FALSE", "off", "no"):
            self.assertTrue(
                segments._explicitly_off(s), f"expected explicitly off: {s!r}"
            )

    def test_explicitly_off_returns_false_for_unset(self):
        # The master switch defaults to ON; unset must not look like "off."
        for s in (None, "", "1", "true", "on", "anything-else"):
            self.assertFalse(
                segments._explicitly_off(s), f"expected NOT explicitly off: {s!r}"
            )


class FfmpegCmdShapeTests(unittest.TestCase):
    """Lock the ffmpeg argv shape so refactors don't silently change the
    output contract. These don't run ffmpeg — they assert what we'd pass."""

    def test_normalize_cmd_uses_target_resolution_and_fps(self):
        argv = segments._ffmpeg_normalize_cmd(
            Path("src.mp4"), Path("out.mp4")
        )
        self.assertEqual(argv[0], "ffmpeg")
        self.assertIn(str(segments.TARGET_FPS), argv)
        # The video filter must produce a 1080x1920 crop with the correct
        # scale-to-cover strategy.
        vf_idx = argv.index("-vf")
        self.assertIn("1080:1920", argv[vf_idx + 1])
        self.assertIn("force_original_aspect_ratio=increase", argv[vf_idx + 1])
        # Audio: AAC at the target sample rate, stereo.
        self.assertIn("-c:a", argv)
        ac_idx = argv.index("-ac")
        self.assertEqual(argv[ac_idx + 1], "2")
        # Source and output paths in expected positions.
        self.assertIn("src.mp4", argv)
        self.assertEqual(argv[-1], "out.mp4")

    def test_splice_cmd_concat_filter_shape(self):
        inputs = [Path("a.mp4"), Path("b.mp4"), Path("c.mp4")]
        argv = segments._ffmpeg_splice_cmd(inputs, Path("out.mp4"))
        self.assertEqual(argv[0], "ffmpeg")
        # One -i per input.
        i_count = sum(1 for x in argv if x == "-i")
        self.assertEqual(i_count, 3)
        # filter_complex includes concat=n=3:v=1:a=1
        fc_idx = argv.index("-filter_complex")
        self.assertIn("concat=n=3:v=1:a=1", argv[fc_idx + 1])
        self.assertEqual(argv[-1], "out.mp4")

    def test_splice_cmd_rejects_single_input(self):
        # Concat with one input is meaningless — caller handles the body-only
        # case by copying the file through, not by invoking ffmpeg.
        with self.assertRaises(ValueError):
            segments._ffmpeg_splice_cmd([Path("a.mp4")], Path("out.mp4"))

    def test_splice_cmd_video_only_drops_audio_mapping(self):
        argv = segments._ffmpeg_splice_cmd(
            [Path("a.mp4"), Path("b.mp4")], Path("out.mp4"), has_audio=False
        )
        # With has_audio=False the filter graph drops [N:a:0] and the concat
        # is a=0. The output stays untouched.
        fc_idx = argv.index("-filter_complex")
        self.assertIn("concat=n=2:v=1:a=0", argv[fc_idx + 1])
        self.assertNotIn("-c:a", argv)


if __name__ == "__main__":
    unittest.main()
