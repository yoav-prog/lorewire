"""Smoke tests for the narration orchestrator.

The unit-level behavior of normalize / TTS / align is covered by their
own suites; this file pins the contract of the high-level helper that
ties them together so future callers can't accidentally bypass one of
the steps.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from unittest import mock

from pipeline import narration


class RenderNarrationContractTests(unittest.TestCase):
    def test_pipeline_runs_normalize_then_synthesize_then_graft(self):
        # Input script has a `$5` that normalize expands; the mocked
        # TTS returns STT-shape lowercase words; the helper grafts the
        # spoken-script tokens onto the returned timings.
        stt_words = [
            {"word": "the", "start": 0.0, "end": 0.3},
            {"word": "fee", "start": 0.3, "end": 0.7},
            {"word": "was", "start": 0.7, "end": 1.0},
            {"word": "five", "start": 1.0, "end": 1.4},
            {"word": "dollars", "start": 1.4, "end": 1.9},
        ]
        with mock.patch(
            "pipeline.voice.synthesize",
            return_value={
                "audio": "/tmp/voice.mp3",
                "words": stt_words,
                "provider": "google",
            },
        ) as mock_synth:
            result = narration.render_narration(
                "The fee was $5.", Path("/tmp/voice.mp3")
            )

        # voice.synthesize received the normalized form, not the raw script.
        mock_synth.assert_called_once()
        spoken_arg = mock_synth.call_args.args[0]
        self.assertIn("five dollars", spoken_arg)
        self.assertNotIn("$5", spoken_arg)

        # The returned words carry the script tokens (with case +
        # punctuation), not the lowercase STT shapes.
        words = result["words"]
        self.assertIn("The", [w["word"] for w in words])
        self.assertIn("five", [w["word"] for w in words])
        self.assertIn("dollars.", [w["word"] for w in words])

        # Provider + audio + spoken_script are surfaced verbatim.
        self.assertEqual(result["provider"], "google")
        self.assertEqual(result["audio"], "/tmp/voice.mp3")
        self.assertEqual(result["spoken_script"], spoken_arg)

    def test_override_kwargs_thread_through_to_synthesize(self):
        with mock.patch(
            "pipeline.voice.synthesize",
            return_value={"audio": "x", "words": [], "provider": "elevenlabs"},
        ) as mock_synth:
            narration.render_narration(
                "Hello world.",
                Path("/tmp/voice.mp3"),
                override_provider="elevenlabs",
                override_voice_id="abc-123",
            )
        kwargs = mock_synth.call_args.kwargs
        self.assertEqual(kwargs.get("override_provider"), "elevenlabs")
        self.assertEqual(kwargs.get("override_voice_id"), "abc-123")


class PauseMarkupForTests(unittest.TestCase):
    def test_gemini_uses_inline_long_pause(self):
        self.assertEqual(
            narration._pause_markup_for("google/gemini-25-flash-tts"),
            ("[long pause]", False),
        )

    def test_chirp_uses_markup_field_pause_long(self):
        self.assertEqual(
            narration._pause_markup_for("google/chirp3-hd"), ("[pause long]", True)
        )

    def test_other_providers_get_no_tag(self):
        self.assertEqual(narration._pause_markup_for("elevenlabs/x"), ("", False))
        self.assertEqual(narration._pause_markup_for(None), ("", False))


class HookPauseInjectionTests(unittest.TestCase):
    def test_pause_inserted_after_hook_prefix(self):
        spoken = "She opened the box. Six days earlier, it began."
        out = narration._inject_hook_pause(spoken, "She opened the box.", "[long pause]")
        self.assertEqual(
            out, "She opened the box. [long pause] Six days earlier, it began."
        )

    def test_falls_back_to_first_sentence_when_hook_blank(self):
        # Lane B has no structured hook; the pause anchors on the first
        # sentence break instead.
        spoken = "She opened the box. Six days earlier, it began."
        out = narration._inject_hook_pause(spoken, "", "[pause long]")
        self.assertEqual(
            out, "She opened the box. [pause long] Six days earlier, it began."
        )

    def test_unchanged_when_no_boundary(self):
        # No hook match and no sentence terminator -> return as-is so a render
        # is never blocked on a missing beat.
        spoken = "no punctuation here just words"
        self.assertEqual(
            narration._inject_hook_pause(spoken, "nope", "[long pause]"), spoken
        )


class RenderNarrationCodificationTests(unittest.TestCase):
    def test_gemini_hook_pause_inline_no_markup_field(self):
        # On the Gemini path the pause tag is [long pause] inline in input.text
        # (use_markup stays False), and style_prompt threads through.
        stt_words = [
            {"word": "she", "start": 0.0, "end": 0.3},
            {"word": "ran", "start": 1.3, "end": 1.6},  # gap = the pause
        ]
        with mock.patch(
            "pipeline.voice.synthesize",
            return_value={"audio": "a", "words": stt_words, "provider": "google"},
        ) as mock_synth:
            result = narration.render_narration(
                "She ran.",
                Path("/tmp/voice.mp3"),
                override_provider="google/gemini-25-flash-tts",
                hook_pause=True,
                hook_text="She ran.",
                style_prompt="lively young creator",
            )
        kwargs = mock_synth.call_args.kwargs
        self.assertFalse(kwargs.get("use_markup"))  # Gemini reads markup from text
        self.assertEqual(kwargs.get("style_prompt"), "lively young creator")
        tts_text = mock_synth.call_args.args[0]
        self.assertIn("[long pause]", tts_text)
        # Captions graft against the clean script — the tag never shows up.
        caption_words = " ".join(w["word"] for w in result["words"])
        self.assertNotIn("pause", caption_words)
        self.assertEqual(result["spoken_script"], "She ran.")

    def test_chirp_hook_pause_uses_markup_field(self):
        with mock.patch(
            "pipeline.voice.synthesize",
            return_value={"audio": "a", "words": [], "provider": "google"},
        ) as mock_synth:
            narration.render_narration(
                "She ran.",
                Path("/tmp/voice.mp3"),
                override_provider="google/chirp3-hd",
                speaking_rate=1.2,
                hook_pause=True,
                hook_text="She ran.",
            )
        kwargs = mock_synth.call_args.kwargs
        self.assertTrue(kwargs.get("use_markup"))  # Chirp uses the markup field
        self.assertEqual(kwargs.get("speaking_rate"), 1.2)
        self.assertIn("[pause long]", mock_synth.call_args.args[0])

    def test_no_hook_pause_keeps_text_field(self):
        with mock.patch(
            "pipeline.voice.synthesize",
            return_value={"audio": "a", "words": [], "provider": "google"},
        ) as mock_synth:
            narration.render_narration("She ran.", Path("/tmp/voice.mp3"))
        kwargs = mock_synth.call_args.kwargs
        self.assertFalse(kwargs.get("use_markup"))
        self.assertIsNone(kwargs.get("speaking_rate"))
        self.assertNotIn("[pause", mock_synth.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
