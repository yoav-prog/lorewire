"""Tests for pipeline.segments: pick_segment resolution chain and ffmpeg
command builders.

Pure-logic only. The actual ffmpeg subprocess is exercised by the integration
test in test_segments_ffmpeg.py; running it in CI is opt-in because it
needs ffmpeg + ffprobe on PATH.
"""
from __future__ import annotations

import json
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


# ─── Phase 3 of _plans/2026-06-12-video-aspect-ratio.md ──────────────────────


class AspectAwareNormalizeTests(unittest.TestCase):
    """The ffmpeg normalize graph branches on aspect. Portrait keeps the
    legacy 1080x1920 byte-for-byte; landscape produces 1920x1080. Calls
    without an explicit aspect default to portrait so any caller that
    hasn't been updated stays byte-identical."""

    def test_default_aspect_keeps_legacy_1080x1920(self):
        argv = segments._ffmpeg_normalize_cmd(Path("src.mp4"), Path("out.mp4"))
        vf_idx = argv.index("-vf")
        self.assertIn("1080:1920", argv[vf_idx + 1])
        self.assertIn("crop=1080:1920", argv[vf_idx + 1])

    def test_explicit_portrait_aspect_is_identical_to_default(self):
        baseline = segments._ffmpeg_normalize_cmd(
            Path("src.mp4"), Path("out.mp4")
        )
        explicit = segments._ffmpeg_normalize_cmd(
            Path("src.mp4"), Path("out.mp4"), aspect="9:16"
        )
        self.assertEqual(baseline, explicit)

    def test_landscape_aspect_produces_1920x1080(self):
        argv = segments._ffmpeg_normalize_cmd(
            Path("src.mp4"), Path("out.mp4"), aspect="16:9"
        )
        vf_idx = argv.index("-vf")
        self.assertIn("1920:1080", argv[vf_idx + 1])
        self.assertIn("crop=1920:1080", argv[vf_idx + 1])
        self.assertIn("force_original_aspect_ratio=increase", argv[vf_idx + 1])

    def test_invalid_aspect_falls_back_to_portrait(self):
        # Defensive default — a typo / NULL column / forgotten migration
        # must not crash the worker. Fall through to 9:16 portrait.
        argv = segments._ffmpeg_normalize_cmd(
            Path("src.mp4"), Path("out.mp4"), aspect="garbage"
        )
        vf_idx = argv.index("-vf")
        self.assertIn("1080:1920", argv[vf_idx + 1])


class PickSegmentAspectMatchTests(unittest.TestCase):
    """Phase 3 adds an aspect filter to the picker so the splice's concat
    filter never sees a clip whose dimensions disagree with the body.
    Existing tests with no aspect column or no story video_config still
    resolve to 9:16 on both sides, so the chain returns the same row as
    before — back-compat is structural here."""

    @staticmethod
    def _store(settings: dict, rows: dict):
        get_setting = lambda k: settings.get(k)  # noqa: E731
        fetch_segment = lambda i: rows.get(i)  # noqa: E731
        return get_setting, fetch_segment

    def test_portrait_segment_matches_portrait_story(self):
        # Both default to 9:16 implicitly — exact back-compat for legacy
        # rows that pre-date the aspect column.
        get_setting, fetch_segment = self._store(
            settings={"video.active_intro_id": "active"},
            rows={
                "active": {
                    "id": "active",
                    "kind": "intro",
                    "enabled": 1,
                },  # no aspect column
            },
        )
        story = {}  # no video_config; resolves to 9:16
        result = segments.pick_segment(
            "intro", story, get_setting, fetch_segment
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["id"], "active")

    def test_landscape_segment_matches_landscape_story(self):
        get_setting, fetch_segment = self._store(
            settings={"video.active_intro_id": "landscape-intro"},
            rows={
                "landscape-intro": {
                    "id": "landscape-intro",
                    "kind": "intro",
                    "enabled": 1,
                    "aspect": "16:9",
                },
            },
        )
        story = {
            "video_config": json.dumps({
                "voiceover_url": "/v.mp3",
                "duration_ms": 10000,
                "doodle_frames": [],
                "captions": [],
                "aspect": "16:9",
            }),
        }
        result = segments.pick_segment(
            "intro", story, get_setting, fetch_segment
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["id"], "landscape-intro")

    def test_portrait_segment_dropped_for_landscape_story(self):
        # The splice's concat filter would either fail or letterbox a
        # 1080x1920 intro onto a 1920x1080 body; safer to skip and emit
        # a body-only render until the admin uploads a matching intro.
        get_setting, fetch_segment = self._store(
            settings={"video.active_intro_id": "portrait-intro"},
            rows={
                "portrait-intro": {
                    "id": "portrait-intro",
                    "kind": "intro",
                    "enabled": 1,
                    "aspect": "9:16",
                },
            },
        )
        story = {
            "video_config": json.dumps({
                "voiceover_url": "/v.mp3",
                "duration_ms": 10000,
                "doodle_frames": [],
                "captions": [],
                "aspect": "16:9",
            }),
        }
        self.assertIsNone(
            segments.pick_segment("intro", story, get_setting, fetch_segment)
        )

    def test_pinned_segment_also_filtered_on_aspect_mismatch(self):
        # The aspect check fires on both pin-path and global-active path,
        # so an admin who pinned a wrong-aspect segment doesn't accidentally
        # ship a broken render.
        get_setting, fetch_segment = self._store(
            settings={},
            rows={
                "wrong": {
                    "id": "wrong",
                    "kind": "intro",
                    "enabled": 1,
                    "aspect": "9:16",
                },
            },
        )
        story = {
            "intro_segment_id": "wrong",
            "video_config": json.dumps({
                "voiceover_url": "/v.mp3",
                "duration_ms": 10000,
                "doodle_frames": [],
                "captions": [],
                "aspect": "16:9",
            }),
        }
        self.assertIsNone(
            segments.pick_segment("intro", story, get_setting, fetch_segment)
        )


class ProbeVideoDimsTests(unittest.TestCase):
    """`probe_video_dims` is the load-bearing piece of the 2026-06-14
    aspect auto-detect plan: the worker reads the source file's actual
    width and height and overrides the client-claimed aspect when they
    disagree. The function has to fail soft on every weird path
    (missing ffprobe, no video stream, garbled output) so the worker
    can fall back to the declared value instead of crashing the loop."""

    def _patched(self, stdout: str = "", side_effect=None):
        """Patch subprocess.run inside pipeline.segments with a stub that
        returns the given stdout. Returns the patcher so the caller can
        use the .start()/.stop() pair via `with`."""
        from unittest import mock as _mock

        class _Result:
            def __init__(self, out: str):
                self.stdout = out
                self.stderr = ""
                self.returncode = 0

        kwargs = {}
        if side_effect is not None:
            kwargs["side_effect"] = side_effect
        else:
            kwargs["return_value"] = _Result(stdout)
        return _mock.patch.object(segments.subprocess, "run", **kwargs)

    def test_clean_landscape_output_parses(self):
        with self._patched("3840\n2160\n"):
            self.assertEqual(segments.probe_video_dims(Path("x.mp4")), (3840, 2160))

    def test_clean_portrait_output_parses(self):
        with self._patched("1080\n1920\n"):
            self.assertEqual(segments.probe_video_dims(Path("x.mp4")), (1080, 1920))

    def test_missing_ffprobe_returns_none(self):
        with self._patched(side_effect=FileNotFoundError("ffprobe")):
            self.assertIsNone(segments.probe_video_dims(Path("x.mp4")))

    def test_blank_output_returns_none(self):
        # No video stream means -select_streams v:0 prints nothing.
        with self._patched(""):
            self.assertIsNone(segments.probe_video_dims(Path("x.mp4")))

    def test_single_line_output_returns_none(self):
        with self._patched("1920\n"):
            self.assertIsNone(segments.probe_video_dims(Path("x.mp4")))

    def test_non_numeric_output_returns_none(self):
        with self._patched("N/A\nN/A\n"):
            self.assertIsNone(segments.probe_video_dims(Path("x.mp4")))

    def test_zero_or_negative_dims_return_none(self):
        # Defense in depth — a corrupt encode shouldn't drive an
        # infer_aspect_from_dims call with garbage.
        with self._patched("0\n1080\n"):
            self.assertIsNone(segments.probe_video_dims(Path("x.mp4")))
        with self._patched("1920\n-1\n"):
            self.assertIsNone(segments.probe_video_dims(Path("x.mp4")))


if __name__ == "__main__":
    unittest.main()
