"""Tests for pipeline.video: alignment chunking, frame distribution, title
truncation, file-uri conversion.

Pure-logic only. The Remotion render itself is verified by a real render in
the QA pass — there's no useful way to mock npx + Chromium.
"""
from __future__ import annotations

import unittest
from pathlib import Path

from pipeline import video


class ChunkAlignmentTests(unittest.TestCase):
    def test_empty_input(self):
        self.assertEqual(video._chunk_alignment([]), [])

    def test_breaks_on_four_word_cap(self):
        words = [{"word": f"w{i}", "start": i * 0.2, "end": (i + 1) * 0.2} for i in range(5)]
        chunks = video._chunk_alignment(words)
        self.assertEqual(len(chunks), 2)
        self.assertEqual(len(chunks[0]["words"]), 4)
        self.assertEqual(chunks[0]["text"], "w0 w1 w2 w3")
        self.assertEqual(chunks[1]["text"], "w4")

    def test_breaks_on_long_pause(self):
        # 2 words, then 500ms gap, then 2 more
        words = [
            {"word": "hi",     "start": 0.0, "end": 0.2},
            {"word": "there",  "start": 0.2, "end": 0.4},
            {"word": "after",  "start": 0.9, "end": 1.1},  # 500ms gap
            {"word": "pause",  "start": 1.1, "end": 1.3},
        ]
        chunks = video._chunk_alignment(words)
        self.assertEqual(len(chunks), 2)
        self.assertEqual(chunks[0]["text"], "hi there")
        self.assertEqual(chunks[1]["text"], "after pause")

    def test_breaks_on_punctuation(self):
        words = [
            {"word": "hello,",  "start": 0.0, "end": 0.2},
            {"word": "world",   "start": 0.2, "end": 0.4},
            {"word": "again!",  "start": 0.4, "end": 0.6},
            {"word": "ok",      "start": 0.6, "end": 0.8},
        ]
        chunks = video._chunk_alignment(words)
        # "hello," forces a break, then "world again!" forces a break, then "ok"
        self.assertEqual([c["text"] for c in chunks], ["hello,", "world again!", "ok"])

    def test_skips_empty_words(self):
        words = [
            {"word": "real",  "start": 0.0, "end": 0.2},
            {"word": "",      "start": 0.2, "end": 0.3},
            {"word": "  ",    "start": 0.3, "end": 0.4},
            {"word": "word",  "start": 0.4, "end": 0.5},
        ]
        chunks = video._chunk_alignment(words)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0]["text"], "real word")

    def test_chunk_carries_word_level_timings_in_ms(self):
        words = [
            {"word": "a", "start": 0.0,  "end": 0.25},
            {"word": "b", "start": 0.25, "end": 0.50},
        ]
        chunks = video._chunk_alignment(words)
        self.assertEqual(chunks[0]["start_ms"], 0)
        self.assertEqual(chunks[0]["end_ms"], 500)
        self.assertEqual(
            chunks[0]["words"],
            [
                {"word": "a", "start_ms": 0,   "end_ms": 250},
                {"word": "b", "start_ms": 250, "end_ms": 500},
            ],
        )


class DistributeFramesTests(unittest.TestCase):
    def _captions(self, *starts_ms: int) -> list[dict]:
        return [{"start_ms": s, "end_ms": s + 500} for s in starts_ms]

    def test_no_inputs_returns_empty(self):
        self.assertEqual(video._distribute_frames([], [], 1000), [])

    def test_no_captions_stacks_frames_at_zero(self):
        frames = video._distribute_frames(["a", "b"], [], 1000)
        self.assertEqual(
            [f["caption_chunk_start_index"] for f in frames], [0, 0]
        )

    def test_single_image_starts_at_chunk_zero(self):
        frames = video._distribute_frames(["only"], self._captions(0, 1000), 2000)
        self.assertEqual(frames, [{"url": "only", "caption_chunk_start_index": 0}])

    def test_four_images_snap_to_chunks_and_stay_ordered(self):
        captions = self._captions(0, 500, 1000, 1500, 2000, 2500, 3000, 3500)
        frames = video._distribute_frames(
            ["hero", "s1", "s2", "s3"], captions, 4000
        )
        indexes = [f["caption_chunk_start_index"] for f in frames]
        # 4 frames, monotonically increasing, each on a different chunk.
        self.assertEqual(sorted(indexes), indexes)
        self.assertEqual(len(set(indexes)), 4)
        self.assertEqual(frames[0]["caption_chunk_start_index"], 0)

    def test_more_frames_than_chunks_does_not_crash(self):
        captions = self._captions(0, 1000)
        frames = video._distribute_frames(
            ["a", "b", "c", "d"], captions, 2000
        )
        self.assertEqual(len(frames), 4)


class TruncateTitleTests(unittest.TestCase):
    def test_short_title_unchanged(self):
        self.assertEqual(video._truncate_title("hello"), "hello")

    def test_long_title_truncated_with_ellipsis(self):
        out = video._truncate_title("a" * 80, max_chars=20)
        self.assertEqual(out, "a" * 19 + "...")

    def test_empty_title(self):
        self.assertEqual(video._truncate_title(""), "")
        self.assertEqual(video._truncate_title(None), "")


class PublicUrlResolutionTests(unittest.TestCase):
    def test_resolves_public_url_to_filesystem_path(self):
        repo_root = Path(__file__).resolve().parent.parent.parent
        path = video._public_url_to_filesystem_path(repo_root, "/generated/abc/hero.png")
        self.assertTrue(str(path).replace("\\", "/").endswith("/lorewire-app/public/generated/abc/hero.png"))


if __name__ == "__main__":
    unittest.main()
