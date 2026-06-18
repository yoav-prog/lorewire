"""Tests for pipeline.captions: tokenization + script-graft alignment.

Pure-logic only — no real TTS calls, no model loads. Covers the bug fix
in _plans/2026-06-18-caption-accuracy-and-naturalness.md Phase 1: the
Google STT path was rewriting caption text to the homophone/lowercase/
no-punctuation form STT returned. After alignment the caption text is
the source script's tokens, with the provider's timings.
"""
from __future__ import annotations

import unittest

from pipeline import captions, video


class TokenizeScriptTests(unittest.TestCase):
    def test_glues_trailing_punctuation_to_word(self):
        self.assertEqual(
            captions.tokenize_script("Red, the barn was old."),
            ["Red,", "the", "barn", "was", "old."],
        )

    def test_handles_question_and_quotes(self):
        self.assertEqual(
            captions.tokenize_script('Was it? "Yes," she said.'),
            ["Was", "it?", '"Yes,"', "she", "said."],
        )

    def test_collapses_internal_whitespace(self):
        self.assertEqual(
            captions.tokenize_script("a  b\nc\t d"),
            ["a", "b", "c", "d"],
        )

    def test_empty_returns_empty(self):
        self.assertEqual(captions.tokenize_script(""), [])
        self.assertEqual(captions.tokenize_script("   "), [])


class AlignScriptToWordsTests(unittest.TestCase):
    def test_empty_words_returns_words_unchanged(self):
        self.assertEqual(
            captions.align_script_to_words("Red barn.", [], "google"), []
        )

    def test_empty_script_returns_words_unchanged(self):
        words = [{"word": "red", "start": 0.0, "end": 0.5}]
        self.assertEqual(
            captions.align_script_to_words("", words, "google"), words
        )

    def test_elevenlabs_provider_is_a_noop(self):
        # ElevenLabs already derives word text from the script's characters
        # (voice._chars_to_words), so the words array is trusted as-is.
        # Verifies the dispatch path does not run the graft.
        words = [
            {"word": "Red,", "start": 0.0, "end": 0.5},
            {"word": "the",  "start": 0.5, "end": 0.8},
        ]
        out = captions.align_script_to_words(
            "Completely different script.", words, "elevenlabs"
        )
        self.assertEqual(out, words)

    def test_google_identical_script_replaces_with_script_tokens(self):
        # STT returned lowercase, no punctuation. Script has caps + comma + period.
        # Alignment matches 1:1 and the output carries the script's form.
        words = [
            {"word": "red",  "start": 0.0, "end": 0.5},
            {"word": "the",  "start": 0.5, "end": 0.8},
            {"word": "barn", "start": 0.8, "end": 1.2},
        ]
        out = captions.align_script_to_words("Red, the barn.", words, "google")
        self.assertEqual(
            [w["word"] for w in out], ["Red,", "the", "barn."]
        )
        # Timings preserved verbatim.
        self.assertEqual([w["start"] for w in out], [0.0, 0.5, 0.8])
        self.assertEqual([w["end"] for w in out], [0.5, 0.8, 1.2])

    def test_google_homophone_substitution_is_corrected(self):
        # The motivating bug: STT mishears "Red" as "Read".
        # After alignment the caption shows "Red" with STT's timing.
        words = [
            {"word": "read", "start": 0.0, "end": 0.5},  # mishearing
            {"word": "the",  "start": 0.5, "end": 0.8},
            {"word": "barn", "start": 0.8, "end": 1.2},
        ]
        out = captions.align_script_to_words("Red the barn", words, "google")
        self.assertEqual([w["word"] for w in out], ["Red", "the", "barn"])

    def test_google_phantom_stt_word_is_dropped(self):
        # STT inserted a word the script does not have. The caption omits it.
        words = [
            {"word": "red",   "start": 0.0, "end": 0.5},
            {"word": "uh",    "start": 0.5, "end": 0.6},  # phantom
            {"word": "the",   "start": 0.6, "end": 0.9},
            {"word": "barn",  "start": 0.9, "end": 1.3},
        ]
        out = captions.align_script_to_words("Red the barn", words, "google")
        self.assertEqual([w["word"] for w in out], ["Red", "the", "barn"])
        # The phantom's timing is dropped along with it; downstream words
        # keep their own timings from STT.
        self.assertEqual([w["start"] for w in out], [0.0, 0.6, 0.9])

    def test_google_missing_stt_word_gets_zero_duration_wedge(self):
        # STT collapsed two words into one (or dropped one).
        # The script word still appears in the caption, with a 0 ms wedge
        # at the prior word's end so the karaoke pulse does not dwell on it.
        words = [
            {"word": "red",  "start": 0.0, "end": 0.5},
            # missing: "the"
            {"word": "barn", "start": 0.5, "end": 1.0},
        ]
        out = captions.align_script_to_words("Red the barn", words, "google")
        self.assertEqual([w["word"] for w in out], ["Red", "the", "barn"])
        # The wedged "the" lives at the end of "Red" with zero duration.
        wedge = out[1]
        self.assertEqual(wedge["word"], "the")
        self.assertEqual(wedge["start"], 0.5)
        self.assertEqual(wedge["end"], 0.5)

    def test_google_punctuation_reattaches_to_word(self):
        # STT strips punctuation. Script's "hello," and "old." re-attach
        # after alignment so the chunker's punctuation break can fire.
        words = [
            {"word": "hello", "start": 0.0, "end": 0.4},
            {"word": "the",   "start": 0.4, "end": 0.7},
            {"word": "barn",  "start": 0.7, "end": 1.1},
            {"word": "was",   "start": 1.1, "end": 1.3},
            {"word": "old",   "start": 1.3, "end": 1.7},
        ]
        out = captions.align_script_to_words(
            "Hello, the barn was old.", words, "google"
        )
        self.assertEqual(
            [w["word"] for w in out],
            ["Hello,", "the", "barn", "was", "old."],
        )


class ChunkerRegressionAfterGraftTests(unittest.TestCase):
    """End-to-end check that the chunker's punctuation break fires on
    the Google path after the graft. Before the fix, STT stripped the
    `,` and `.` so `PUNCTUATION_BREAK_RE` never matched and chunks broke
    only on the 4-word cap and 400 ms pauses.
    """

    def test_chunker_breaks_on_punctuation_after_google_graft(self):
        # STT-shape input (lowercase, no punctuation).
        stt_words = [
            {"word": "hello", "start": 0.0, "end": 0.4},
            {"word": "the",   "start": 0.4, "end": 0.7},
            {"word": "barn",  "start": 0.7, "end": 1.1},
            {"word": "was",   "start": 1.1, "end": 1.3},
            {"word": "old",   "start": 1.3, "end": 1.7},
        ]
        grafted = captions.align_script_to_words(
            "Hello, the barn was old.", stt_words, "google"
        )
        chunks = video._chunk_alignment(grafted)
        # Three chunks: "Hello," forces a break, then "the barn was old."
        # breaks on the period. The 4-word cap is not the trigger here.
        self.assertEqual(
            [c["text"] for c in chunks], ["Hello,", "the barn was old."]
        )

    def test_chunker_groups_run_on_sentences_before_period(self):
        # No comma in the middle; punctuation only at the end. Confirms
        # the chunker does NOT spuriously break — it should produce one
        # chunk capped by the 4-word rule, then a remainder chunk.
        stt_words = [
            {"word": "hello",   "start": 0.0, "end": 0.4},
            {"word": "the",     "start": 0.4, "end": 0.7},
            {"word": "barn",    "start": 0.7, "end": 1.1},
            {"word": "was",     "start": 1.1, "end": 1.3},
            {"word": "old",     "start": 1.3, "end": 1.7},
        ]
        grafted = captions.align_script_to_words(
            "Hello the barn was old.", stt_words, "google"
        )
        chunks = video._chunk_alignment(grafted)
        # 4-word cap on the first chunk, period closes the second.
        self.assertEqual(
            [c["text"] for c in chunks],
            ["Hello the barn was", "old."],
        )


if __name__ == "__main__":
    unittest.main()
