"""Tests for pipeline.voice: alignment folding and Google duration parsing.

Provider HTTP calls were verified live in the previous session and again as part
of the QA pass on this orchestration work; what we lock here is the pure-logic
that runs on every response, where a regression silently corrupts the
read-along timings without the network telling us anything went wrong.
"""
from __future__ import annotations

import unittest

from unittest import mock

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


class CalibrateToAudioDurationTests(unittest.TestCase):
    def test_returns_unchanged_when_within_tolerance(self):
        words = [
            {"word": "a", "start": 0.0, "end": 1.0},
            {"word": "b", "start": 1.0, "end": 2.0},
        ]
        with mock.patch("pipeline.voice._probe_mp3_duration", return_value=2.04):
            out = voice._calibrate_to_audio_duration(words, b"\xff\xfb\x00\x00")
        self.assertEqual(out, words)

    def test_scales_when_stt_drifts_significantly(self):
        words = [
            {"word": "a", "start": 0.0, "end": 1.0},
            {"word": "b", "start": 1.0, "end": 3.0},
        ]
        with mock.patch("pipeline.voice._probe_mp3_duration", return_value=2.0):
            out = voice._calibrate_to_audio_duration(words, b"\xff\xfb\x00\x00")
        # ratio = 2.0 / 3.0 = 0.667; everything multiplied by it
        self.assertAlmostEqual(out[0]["end"], 0.6667, places=3)
        self.assertAlmostEqual(out[1]["end"], 2.0, places=3)

    def test_no_scale_when_audio_probe_fails(self):
        words = [{"word": "a", "start": 0.0, "end": 5.0}]
        with mock.patch("pipeline.voice._probe_mp3_duration", return_value=0.0):
            out = voice._calibrate_to_audio_duration(words, b"")
        self.assertEqual(out, words)

    def test_empty_words_returned_as_is(self):
        with mock.patch("pipeline.voice._probe_mp3_duration", return_value=10.0):
            self.assertEqual(voice._calibrate_to_audio_duration([], b"x"), [])


class ProbeMp3DurationTests(unittest.TestCase):
    def test_garbage_bytes_return_zero(self):
        self.assertEqual(voice._probe_mp3_duration(b"not an mp3"), 0.0)

    def test_empty_bytes_return_zero(self):
        self.assertEqual(voice._probe_mp3_duration(b""), 0.0)

    def test_real_google_mp3_decodes(self):
        # The MP3 sitting in lorewire-app/public/generated/envelope/narration.mp3
        # is a real Google-TTS output from the QA pass; if it exists, our parser
        # should land inside a sensible duration band (>10s, <600s).
        from pathlib import Path
        mp3 = Path(__file__).resolve().parent.parent.parent / "lorewire-app" / "public" / "generated" / "envelope" / "narration.mp3"
        if not mp3.exists():
            self.skipTest("envelope narration.mp3 not on disk (run --media first)")
        seconds = voice._probe_mp3_duration(mp3.read_bytes())
        self.assertGreater(seconds, 10.0)
        self.assertLess(seconds, 600.0)


class GeminiTtsTests(unittest.TestCase):
    def test_tier_detection(self):
        self.assertTrue(voice._is_gemini_tier("gemini-25-flash-tts"))
        self.assertTrue(voice._is_gemini_tier("gemini-31-flash-tts"))
        self.assertFalse(voice._is_gemini_tier("chirp3-hd"))
        self.assertFalse(voice._is_gemini_tier("neural2"))

    def test_voice_name_stripped_from_chirp_prefix(self):
        self.assertEqual(voice._gemini_voice_name("en-US-Chirp3-HD-Aoede"), "Aoede")
        self.assertEqual(voice._gemini_voice_name("en-US-Chirp3-HD-Charon"), "Charon")

    def test_voice_name_passthrough_for_bare_input(self):
        # Admin set the bare name directly — keep it.
        self.assertEqual(voice._gemini_voice_name("Aoede"), "Aoede")
        self.assertEqual(voice._gemini_voice_name("Puck"), "Puck")

    def test_payload_has_modelname_and_bare_voice(self):
        from unittest import mock
        with mock.patch("pipeline.voice.store.get_setting", return_value=None):
            payload = voice._build_gemini_payload(
                "hello world", "en-US-Chirp3-HD-Aoede", "en-US", "gemini-25-flash-tts"
            )
        self.assertEqual(payload["voice"]["name"], "Aoede")
        self.assertEqual(payload["voice"]["modelName"], "gemini-2.5-flash-tts")
        self.assertEqual(payload["voice"]["languageCode"], "en-US")
        self.assertEqual(payload["input"], {"text": "hello world"})
        self.assertEqual(payload["audioConfig"]["audioEncoding"], "MP3")
        self.assertEqual(payload["_billed_chars"], len("hello world"))

    def test_payload_includes_style_prompt_when_set(self):
        from unittest import mock
        with mock.patch(
            "pipeline.voice.store.get_setting",
            side_effect=lambda k: "calm, conversational" if k == "voice.google_style_prompt" else None,
        ):
            payload = voice._build_gemini_payload(
                "hello", "Charon", "en-US", "gemini-31-flash-tts"
            )
        self.assertEqual(payload["input"]["prompt"], "calm, conversational")
        self.assertEqual(payload["voice"]["modelName"], "gemini-3.1-flash-tts-preview")
        # Style prompt chars count toward billing.
        self.assertEqual(payload["_billed_chars"], len("hello") + len("calm, conversational"))

    def test_text_byte_limit_enforced(self):
        from unittest import mock
        with mock.patch("pipeline.voice.store.get_setting", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "text exceeds"):
                voice._build_gemini_payload(
                    "a" * 4001, "Aoede", "en-US", "gemini-25-flash-tts"
                )

    def test_prompt_byte_limit_enforced(self):
        from unittest import mock
        with mock.patch(
            "pipeline.voice.store.get_setting",
            side_effect=lambda k: "x" * 4001 if k == "voice.google_style_prompt" else None,
        ):
            with self.assertRaisesRegex(RuntimeError, "style_prompt exceeds"):
                voice._build_gemini_payload(
                    "hello", "Aoede", "en-US", "gemini-25-flash-tts"
                )

    def test_at_limit_boundary_passes(self):
        # Each field at exactly its 4000-byte cap, combined at exactly 8000 —
        # all three checks have to use `>` not `>=` for the legal boundary
        # case to land. (The combined check is defense-in-depth; the
        # individual 4000-byte caps make exceeding 8000 mathematically
        # impossible, but the check guards against a future limit bump.)
        from unittest import mock
        with mock.patch(
            "pipeline.voice.store.get_setting",
            side_effect=lambda k: "p" * 4000 if k == "voice.google_style_prompt" else None,
        ):
            payload = voice._build_gemini_payload(
                "t" * 4000, "Aoede", "en-US", "gemini-25-flash-tts"
            )
        self.assertEqual(payload["_billed_chars"], 8000)


if __name__ == "__main__":
    unittest.main()
