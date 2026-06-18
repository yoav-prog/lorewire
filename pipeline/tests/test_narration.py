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


if __name__ == "__main__":
    unittest.main()
