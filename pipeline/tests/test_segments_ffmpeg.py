"""Integration: actually invoke ffmpeg through pipeline.segments.normalize and
pipeline.segments.splice.

Skipped when ffmpeg or ffprobe isn't on PATH so the unit-only suite still
runs in CI environments without the binaries. When they are present, this
exercises the real subprocess + filter graph end-to-end.

Run explicitly:
    python -m unittest pipeline.tests.test_segments_ffmpeg
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from pipeline import segments


def _ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _make_fixture(path: Path, *, width: int, height: int, fps: int, seconds: int) -> None:
    """Generate a tiny mp4 with a solid color via ffmpeg's lavfi color source.
    Used to build the test inputs without shipping binary fixtures in the
    repo. Audio: silent stereo 48k so the concat filter has an a-stream."""
    argv = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=c=red:s={width}x{height}:d={seconds}:r={fps}",
        "-f", "lavfi", "-i", f"anullsrc=channel_layout=stereo:sample_rate=48000:d={seconds}",
        "-shortest",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        str(path),
    ]
    subprocess.run(argv, check=True, capture_output=True)


def _probe_wh_fps(path: Path) -> tuple[int, int, float]:
    """Return (width, height, fps) of the first video stream."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,r_frame_rate",
            "-of", "default=noprint_wrappers=1:nokey=0",
            str(path),
        ],
        check=True, capture_output=True, text=True,
    )
    width = height = 0
    fps = 0.0
    for line in result.stdout.splitlines():
        k, _, v = line.partition("=")
        if k == "width":
            width = int(v)
        elif k == "height":
            height = int(v)
        elif k == "r_frame_rate" and "/" in v:
            num, den = v.split("/", 1)
            fps = float(num) / float(den) if float(den) else 0.0
    return width, height, fps


@unittest.skipUnless(_ffmpeg_available(), "ffmpeg/ffprobe not on PATH")
class NormalizeIntegrationTests(unittest.TestCase):
    def test_landscape_input_is_center_cropped_to_target(self):
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            src = tdp / "src.mp4"
            out = tdp / "out.mp4"
            _make_fixture(src, width=1920, height=1080, fps=24, seconds=1)
            result = segments.normalize(src, out, segment_id="testseg")
            self.assertTrue(out.exists(), "normalize should produce an output")
            self.assertGreater(result["duration_ms"], 800, "duration should be ~1s")
            w, h, fps = _probe_wh_fps(out)
            self.assertEqual(w, segments.TARGET_WIDTH)
            self.assertEqual(h, segments.TARGET_HEIGHT)
            self.assertAlmostEqual(fps, float(segments.TARGET_FPS), delta=0.1)

    def test_normalize_raises_on_missing_source(self):
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            with self.assertRaises(RuntimeError):
                segments.normalize(tdp / "nope.mp4", tdp / "out.mp4")


@unittest.skipUnless(_ffmpeg_available(), "ffmpeg/ffprobe not on PATH")
class SpliceIntegrationTests(unittest.TestCase):
    def test_splice_three_clips_sums_durations(self):
        # Build three normalized fixtures so the concat filter sees matching
        # streams; without normalization first the filter would re-encode
        # and the assertion would still hold, but we want this test to
        # exercise the realistic body-segment shape.
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            raw = tdp / "raw.mp4"
            _make_fixture(raw, width=1080, height=1920, fps=30, seconds=1)
            intro = tdp / "intro.mp4"
            body = tdp / "body.mp4"
            outro = tdp / "outro.mp4"
            segments.normalize(raw, intro, segment_id="intro")
            segments.normalize(raw, body, segment_id="body")
            segments.normalize(raw, outro, segment_id="outro")

            out = tdp / "spliced.mp4"
            result = segments.splice(body, intro, outro, out, context_id="test")
            self.assertTrue(out.exists())
            # 3 clips of ~1s each: expect ~3s, allow 200ms slack for re-encode.
            self.assertGreater(result["duration_ms"], 2500)
            self.assertLess(result["duration_ms"], 3500)

    def test_splice_no_segments_copies_body_through(self):
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            body = tdp / "body.mp4"
            _make_fixture(body, width=1080, height=1920, fps=30, seconds=1)
            out = tdp / "out.mp4"
            segments.splice(body, None, None, out, context_id="copy-test")
            self.assertTrue(out.exists())
            # File should be byte-identical to the source.
            self.assertEqual(out.read_bytes(), body.read_bytes())


if __name__ == "__main__":
    unittest.main()
