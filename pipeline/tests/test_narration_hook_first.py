"""Two-clip measured-boundary narration (render_hook_first_narration).

Pins the contract of the permanent hook-splice fix
(_plans/2026-07-02-hook-clip-measured-boundary.md):

  - the hook and the rest are SEPARATE synth calls whose byte streams are
    joined around a real silence buffer;
  - `hook_end_ms` / `hook_tail_hold_ms` are frame-counted facts derived from
    the hook clip + buffer, never from alignment;
  - the rest clip's word timings are offset past the buffer so caption
    chunking per clip can never produce a chunk spanning the seam;
  - every failure mode falls back to None (single-clip legacy path) instead
    of raising or shipping a broken file.

Synthesis is mocked with the REAL committed MP3 fixtures so the concat and
duration math run on genuine encoder output.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import mp3_silence, narration, voice

FIXTURES = Path(__file__).parent / "fixtures"

SCRIPT = "Five dollars. Again today. Two weeks earlier a poster said their cousin vanished."
HOOK = "Five dollars. Again today."


def _fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def _fake_synthesize(clips: list[bytes]):
    """voice.synthesize stand-in: writes the next fixture to dest and returns
    trivially-aligned words (provider 'elevenlabs' so the caption graft is the
    documented trust pass and the words flow through untouched)."""
    calls: list[str] = []

    def fake(text: str, dest: Path, **_kwargs) -> dict:
        data = clips[len(calls)]
        calls.append(text)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        words = [
            {"word": tok, "start": i * 0.3, "end": i * 0.3 + 0.25}
            for i, tok in enumerate(text.split())
        ]
        return {"audio": str(dest), "words": words, "provider": "elevenlabs"}

    return fake, calls


class SplitHookPrefixTests(unittest.TestCase):
    def test_exact_prefix_splits(self):
        parts = narration.split_hook_prefix(SCRIPT, HOOK)
        self.assertIsNotNone(parts)
        self.assertEqual(parts[0], "Five dollars. Again today.")
        self.assertTrue(parts[1].startswith("Two weeks earlier"))

    def test_match_is_case_insensitive(self):
        parts = narration.split_hook_prefix(SCRIPT, "five DOLLARS. again TODAY.")
        self.assertIsNotNone(parts)
        self.assertEqual(parts[0], "Five dollars. Again today.")

    def test_hook_is_normalized_before_matching(self):
        # The script side arrives normalized; the hook side must be run
        # through the same normalizer or "$5" could never match "five dollars".
        script = narration.text_normalize.normalize_for_tts("The fee was $5. It kept rising.")
        hook = "The fee was $5."
        parts = narration.split_hook_prefix(script, hook)
        self.assertIsNotNone(parts)
        self.assertTrue(parts[1].startswith("It kept rising"))

    def test_non_prefix_hook_returns_none(self):
        self.assertIsNone(narration.split_hook_prefix(SCRIPT, "A different opener."))

    def test_blank_hook_returns_none(self):
        self.assertIsNone(narration.split_hook_prefix(SCRIPT, ""))
        self.assertIsNone(narration.split_hook_prefix(SCRIPT, None))

    def test_hook_equal_to_whole_script_returns_none(self):
        self.assertIsNone(narration.split_hook_prefix(HOOK, HOOK))


class RenderHookFirstNarrationTests(unittest.TestCase):
    def _render(self, clips: list[bytes], tmp: str):
        fake, calls = _fake_synthesize(clips)
        dest = Path(tmp) / "voice.mp3"
        with mock.patch.object(narration.voice, "synthesize", side_effect=fake):
            result = narration.render_hook_first_narration(
                SCRIPT, dest, hook=HOOK, override_provider="elevenlabs/turbo",
            )
        return result, calls, dest

    def test_two_calls_measured_boundary_and_concatenated_output(self):
        hook_clip = _fixture("tts_24k_mono_a.mp3")
        rest_clip = _fixture("tts_24k_mono_b.mp3")
        with tempfile.TemporaryDirectory() as tmp:
            result, calls, dest = self._render([hook_clip, rest_clip], tmp)

            self.assertIsNotNone(result)
            # Two synth calls: the hook text alone, then the rest alone.
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0], "Five dollars. Again today.")
            self.assertTrue(calls[1].startswith("Two weeks earlier"))

            # The written artifact is exactly the tag-stripped byte concat.
            silence = mp3_silence.silence_mp3_for(
                voice.mp3_stream_params(voice.strip_mp3_container_tags(hook_clip))
            )
            self.assertEqual(
                dest.read_bytes(),
                voice.concat_mp3_streams([hook_clip, silence, rest_clip]),
            )

            # Boundary math: cut mid-buffer, hold through the buffer's rest.
            hook_ms = voice.mp3_duration_ms(voice.strip_mp3_container_tags(hook_clip))
            silence_ms = voice.mp3_duration_ms(silence)
            self.assertEqual(result["boundary"], "measured")
            self.assertEqual(result["hook_end_ms"], hook_ms + silence_ms // 2)
            self.assertEqual(
                result["hook_tail_hold_ms"], silence_ms - silence_ms // 2
            )
            # Staging clips were cleaned up; only the artifact remains.
            self.assertEqual(
                sorted(p.name for p in Path(tmp).iterdir()), ["voice.mp3"]
            )

    def test_rest_words_offset_past_the_buffer(self):
        hook_clip = _fixture("tts_24k_mono_a.mp3")
        rest_clip = _fixture("tts_24k_mono_b.mp3")
        with tempfile.TemporaryDirectory() as tmp:
            result, _calls, _dest = self._render([hook_clip, rest_clip], tmp)

        hook_ms = voice.mp3_duration_ms(voice.strip_mp3_container_tags(hook_clip))
        silence = mp3_silence.silence_mp3_for(
            voice.mp3_stream_params(voice.strip_mp3_container_tags(hook_clip))
        )
        offset_sec = (hook_ms + voice.mp3_duration_ms(silence)) / 1000.0

        # Hook words keep clip-local times; rest words start past the buffer,
        # so the earliest rest word can never precede hook_end_ms.
        self.assertEqual(result["hook_words"][0]["start"], 0.0)
        self.assertEqual(result["rest_words"][0]["start"], offset_sec)
        self.assertGreater(
            result["rest_words"][0]["start"] * 1000, result["hook_end_ms"]
        )
        # The merged list is hook words then offset rest words.
        self.assertEqual(
            result["words"],
            result["hook_words"] + result["rest_words"],
        )

    def test_hook_not_prefix_falls_back_without_synthesizing(self):
        fake, calls = _fake_synthesize([])
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(narration.voice, "synthesize", side_effect=fake):
            result = narration.render_hook_first_narration(
                SCRIPT, Path(tmp) / "voice.mp3", hook="Not the opener.",
            )
        self.assertIsNone(result)
        self.assertEqual(calls, [])

    def test_synth_error_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(
                    narration.voice, "synthesize",
                    side_effect=RuntimeError("provider down"),
                ):
            result = narration.render_hook_first_narration(
                SCRIPT, Path(tmp) / "voice.mp3", hook=HOOK,
            )
        self.assertIsNone(result)

    def test_format_mismatch_falls_back_and_writes_nothing(self):
        # Hook comes back 24 kHz mono, rest 44.1 kHz stereo — a splice would
        # be an invalid stream, so the path must bail to the single-clip
        # renderer and leave no artifact or staging strays behind.
        clips = [_fixture("tts_24k_mono_a.mp3"), _fixture("tts_44k1_stereo.mp3")]
        with tempfile.TemporaryDirectory() as tmp:
            result, _calls, dest = self._render(clips, tmp)
            self.assertIsNone(result)
            self.assertFalse(dest.exists())
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_missing_silence_buffer_falls_back(self):
        clips = [_fixture("tts_24k_mono_a.mp3"), _fixture("tts_24k_mono_b.mp3")]
        fake, _calls = _fake_synthesize(clips)
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(narration.voice, "synthesize", side_effect=fake), \
                mock.patch.object(
                    narration.mp3_silence, "silence_mp3_for", return_value=None,
                ):
            result = narration.render_hook_first_narration(
                SCRIPT, Path(tmp) / "voice.mp3", hook=HOOK,
            )
            self.assertIsNone(result)
            self.assertEqual(list(Path(tmp).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
