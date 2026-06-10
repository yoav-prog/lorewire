"""Tests for pipeline.media: id sanitization, filename pattern, cost math.

Pure-logic only. No network. The provider integrations were verified end to end
against the live APIs in the previous session; what we guard here is the math
and the parts that touch the filesystem path machinery.
"""
from __future__ import annotations

import unittest
from unittest import mock

from pipeline import media


class SanitizeIdTests(unittest.TestCase):
    def test_accepts_typical_reddit_id(self):
        self.assertEqual(media._sanitize_id("1abc23x"), "1abc23x")

    def test_accepts_letters_digits_underscore_dash(self):
        self.assertEqual(media._sanitize_id("A_b-9"), "A_b-9")

    def test_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            media._sanitize_id("../etc/passwd")

    def test_rejects_path_separators(self):
        for bad in ("foo/bar", "foo\\bar"):
            with self.assertRaises(ValueError):
                media._sanitize_id(bad)

    def test_rejects_empty(self):
        with self.assertRaises(ValueError):
            media._sanitize_id("")

    def test_rejects_unicode(self):
        with self.assertRaises(ValueError):
            media._sanitize_id("café")

    def test_rejects_too_long(self):
        with self.assertRaises(ValueError):
            media._sanitize_id("a" * 65)


class ImageFilenameTests(unittest.TestCase):
    def test_index_zero_is_hero(self):
        self.assertEqual(media._image_filename(0), "hero.png")

    def test_higher_indexes_are_scenes(self):
        self.assertEqual(media._image_filename(1), "scene-1.png")
        self.assertEqual(media._image_filename(3), "scene-3.png")


class StoryCostCentsTests(unittest.TestCase):
    def test_google_chirp_default_stack(self):
        # 4 images * $0.05 (kie/gpt-image-2) + 1800 chars * $30/1M (chirp HD)
        # + 150s * ($0.024/60) STT = 0.20 + 0.054 + 0.06 = 0.314 -> 31 cents
        with mock.patch("pipeline.media.models.get_selected") as get:
            get.side_effect = lambda stage: {"images": "kie/gpt-image-2", "voice": "google/chirp3-hd"}[stage]
            self.assertEqual(media._story_cost_cents(4, 1800, 150.0), 31)

    def test_elevenlabs_stack(self):
        # 4 * 0.05 + 1800 * 300e-6 (ElevenLabs Starter) = 0.20 + 0.54 = 0.74 -> 74 cents
        with mock.patch("pipeline.media.models.get_selected") as get:
            get.side_effect = lambda stage: {"images": "kie/gpt-image-2", "voice": "elevenlabs/default"}[stage]
            self.assertEqual(media._story_cost_cents(4, 1800, 0.0), 74)

    def test_unknown_voice_falls_back_to_zero_voice_cost(self):
        with mock.patch("pipeline.media.models.get_selected") as get:
            get.side_effect = lambda stage: {"images": "kie/gpt-image-2", "voice": "azure/neural"}[stage]
            self.assertEqual(media._story_cost_cents(4, 1800, 0.0), 20)


if __name__ == "__main__":
    unittest.main()
