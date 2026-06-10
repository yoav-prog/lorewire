"""Tests for pipeline.voice: alignment folding and Google duration parsing.

Provider HTTP calls were verified live in the previous session and again as part
of the QA pass on this orchestration work; what we lock here is the pure-logic
that runs on every response, where a regression silently corrupts the
read-along timings without the network telling us anything went wrong.
"""
from __future__ import annotations

import unittest

from pipeline import voice


class CharsToWordsTests(unittest.TestCase):
    def test_simple_two_word(self):
        # "hi yo" -> "hi" 0.0-0.2, "yo" 0.3-0.5
        alignment = {
            "characters":                       ["h", "i", " ", "y", "o"],
            "character_start_times_seconds":    [0.0, 0.1, 0.2, 0.3, 0.4],
            "character_end_times_seconds":      [0.1, 0.2, 0.3, 0.4, 0.5],
        }
        out = voice._chars_to_words(alignment)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["word"], "hi")
        self.assertAlmostEqual(out[0]["start"], 0.0)
        self.assertAlmostEqual(out[0]["end"], 0.2)
        self.assertEqual(out[1]["word"], "yo")
        self.assertAlmostEqual(out[1]["start"], 0.3)
        self.assertAlmostEqual(out[1]["end"], 0.5)

    def test_handles_multiple_spaces(self):
        alignment = {
            "characters":                       ["a", " ", " ", "b"],
            "character_start_times_seconds":    [0.0, 0.1, 0.2, 0.3],
            "character_end_times_seconds":      [0.1, 0.2, 0.3, 0.4],
        }
        out = voice._chars_to_words(alignment)
        self.assertEqual([w["word"] for w in out], ["a", "b"])

    def test_handles_empty_alignment(self):
        self.assertEqual(voice._chars_to_words({}), [])

    def test_handles_trailing_word_without_space(self):
        alignment = {
            "characters":                       ["o", "k"],
            "character_start_times_seconds":    [0.0, 0.1],
            "character_end_times_seconds":      [0.1, 0.2],
        }
        out = voice._chars_to_words(alignment)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["word"], "ok")


class GoogleDurationParseTests(unittest.TestCase):
    def test_seconds_suffix(self):
        self.assertEqual(voice._parse_google_duration("1.500s"), 1.5)

    def test_integer_seconds(self):
        self.assertEqual(voice._parse_google_duration("2s"), 2.0)

    def test_zero(self):
        self.assertEqual(voice._parse_google_duration("0s"), 0.0)

    def test_none_returns_zero(self):
        self.assertEqual(voice._parse_google_duration(None), 0.0)

    def test_float_passthrough(self):
        self.assertEqual(voice._parse_google_duration(3.75), 3.75)

    def test_garbage_returns_zero(self):
        self.assertEqual(voice._parse_google_duration("abc"), 0.0)


class GoogleVoiceResolutionTests(unittest.TestCase):
    def test_language_code_extracted_from_voice_name(self):
        self.assertEqual(voice._google_language_code("en-US-Chirp3-HD-Aoede"), "en-US")
        self.assertEqual(voice._google_language_code("fr-FR-Standard-A"), "fr-FR")

    def test_language_code_short_name_falls_back(self):
        self.assertEqual(voice._google_language_code("solo"), "en-US")

    def test_tier_extraction(self):
        self.assertEqual(voice._google_tier("google/chirp3-hd"), "chirp3-hd")
        self.assertEqual(voice._google_tier("google/standard"), "standard")

    def test_tier_extraction_rejects_unsuffixed(self):
        with self.assertRaises(RuntimeError):
            voice._google_tier("google")


if __name__ == "__main__":
    unittest.main()
