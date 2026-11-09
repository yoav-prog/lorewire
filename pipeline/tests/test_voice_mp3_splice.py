"""MP3 bytestream splicing helpers behind the hook-first two-clip narration.

The measured-boundary splice (_plans/2026-07-02-hook-clip-measured-boundary.md)
rests on three byte-level facts these tests pin:

  1. `strip_mp3_container_tags` turns a provider MP3 into a bare MPEG frame
     stream (no ID3v2/ID3v1 tags, no Xing/Info header frame) — embedded
     container noise mid-stream makes decoders error at the seam (verified
     against ffmpeg 2026-07-02).
  2. `concat_mp3_streams` durations are EXACTLY additive under
     `mp3_duration_ms` — the property `hook_end_ms` is computed from.
  3. Mixed formats are rejected, never spliced.

Fixtures are real libmp3lame streams (the encoder writes ID3v2 + a Xing/Info
frame by default) so the strip logic is exercised against genuine container
noise, not synthetic bytes. 24 kHz mono MPEG-2 Layer III mirrors the Google
TTS output format; 44.1 kHz stereo MPEG-1 mirrors ElevenLabs.
"""
from __future__ import annotations

import unittest
from pathlib import Path

from pipeline import mp3_silence, voice

FIXTURES = Path(__file__).parent / "fixtures"

GOOGLE_PARAMS = {"version": "2", "layer": 3, "sample_rate": 24000, "channels": 1}


def _fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


class Mp3StreamParamsTests(unittest.TestCase):
    def test_google_format_fixture_parses(self):
        params = voice.mp3_stream_params(
            voice.strip_mp3_container_tags(_fixture("tts_24k_mono_a.mp3"))
        )
        self.assertEqual(params, GOOGLE_PARAMS)

    def test_elevenlabs_format_fixture_parses(self):
        params = voice.mp3_stream_params(
            voice.strip_mp3_container_tags(_fixture("tts_44k1_stereo.mp3"))
        )
        self.assertEqual(
            params,
            {"version": "1", "layer": 3, "sample_rate": 44100, "channels": 2},
        )

    def test_garbage_and_empty_return_none(self):
        self.assertIsNone(voice.mp3_stream_params(b"not an mp3 stream at all"))
        self.assertIsNone(voice.mp3_stream_params(b""))


class StripContainerTagsTests(unittest.TestCase):
    def test_id3v2_header_removed_and_stream_starts_on_frame_sync(self):
        raw = _fixture("tts_24k_mono_a.mp3")
        self.assertEqual(raw[:3], b"ID3")  # precondition: encoder wrote a tag
        stripped = voice.strip_mp3_container_tags(raw)
        self.assertEqual(stripped[0], 0xFF)
        self.assertEqual(stripped[1] & 0xE0, 0xE0)

    def test_xing_header_frame_dropped(self):
        # libmp3lame prepends one Xing/Info frame (576 samples = 24ms at
        # 24 kHz MPEG-2). Stripping must drop exactly that frame — no more,
        # no less — and no VBR tag may survive at the stream head.
        raw = _fixture("tts_24k_mono_a.mp3")
        stripped = voice.strip_mp3_container_tags(raw)
        self.assertEqual(voice.mp3_duration_ms(raw) - voice.mp3_duration_ms(stripped), 24)
        self.assertNotIn(b"Xing", stripped[:256])
        self.assertNotIn(b"Info", stripped[:256])

    def test_id3v1_trailer_removed(self):
        stripped = voice.strip_mp3_container_tags(_fixture("tts_24k_mono_a.mp3"))
        with_trailer = stripped + b"TAG" + b"\x00" * 125
        self.assertEqual(voice.strip_mp3_container_tags(with_trailer), stripped)

    def test_idempotent(self):
        once = voice.strip_mp3_container_tags(_fixture("tts_24k_mono_b.mp3"))
        self.assertEqual(voice.strip_mp3_container_tags(once), once)

    def test_unparseable_input_returned_unchanged(self):
        junk = b"\x00\x01\x02 definitely not mpeg"
        self.assertEqual(voice.strip_mp3_container_tags(junk), junk)


class ConcatMp3StreamsTests(unittest.TestCase):
    def test_duration_is_exactly_additive(self):
        # THE invariant: hook_end_ms is trustworthy because frame counting is
        # exact and additive across the splice — equality, not tolerance.
        a = _fixture("tts_24k_mono_a.mp3")
        b = _fixture("tts_24k_mono_b.mp3")
        silence = mp3_silence.silence_mp3_for(GOOGLE_PARAMS)
        combined = voice.concat_mp3_streams([a, silence, b])
        expected = (
            voice.mp3_duration_ms(voice.strip_mp3_container_tags(a))
            + voice.mp3_duration_ms(silence)
            + voice.mp3_duration_ms(voice.strip_mp3_container_tags(b))
        )
        self.assertEqual(voice.mp3_duration_ms(combined), expected)

    def test_result_is_a_bare_stream_with_source_params(self):
        a = _fixture("tts_24k_mono_a.mp3")
        b = _fixture("tts_24k_mono_b.mp3")
        combined = voice.concat_mp3_streams([a, b])
        self.assertEqual(combined[0], 0xFF)
        self.assertEqual(voice.mp3_stream_params(combined), GOOGLE_PARAMS)

    def test_mixed_formats_rejected(self):
        with self.assertRaises(ValueError):
            voice.concat_mp3_streams(
                [_fixture("tts_24k_mono_a.mp3"), _fixture("tts_44k1_stereo.mp3")]
            )

    def test_empty_and_unparseable_clips_rejected(self):
        with self.assertRaises(ValueError):
            voice.concat_mp3_streams([])
        with self.assertRaises(ValueError):
            voice.concat_mp3_streams([b"garbage bytes"])
        with self.assertRaises(ValueError):
            voice.concat_mp3_streams(
                [_fixture("tts_24k_mono_a.mp3"), b"garbage bytes"]
            )


class SilenceLookupTests(unittest.TestCase):
    def test_google_format_has_a_buffer(self):
        blob = mp3_silence.silence_mp3_for(GOOGLE_PARAMS)
        self.assertIsNotNone(blob)
        # Nominal 300ms, encoded up to whole frames; the splice cuts at the
        # measured midpoint so the exact figure only needs to be sane.
        self.assertGreaterEqual(voice.mp3_duration_ms(blob), 250)
        self.assertLessEqual(voice.mp3_duration_ms(blob), 500)
        # The blob itself must be a bare stream in the SAME format, or the
        # concat compatibility check would reject its own buffer.
        self.assertEqual(voice.mp3_stream_params(blob), GOOGLE_PARAMS)

    def test_elevenlabs_formats_have_buffers(self):
        for channels in (1, 2):
            params = {"version": "1", "layer": 3, "sample_rate": 44100, "channels": channels}
            blob = mp3_silence.silence_mp3_for(params)
            self.assertIsNotNone(blob, f"missing 44.1kHz {channels}ch buffer")
            self.assertEqual(voice.mp3_stream_params(blob), params)

    def test_unknown_format_and_none_return_none(self):
        self.assertIsNone(
            mp3_silence.silence_mp3_for(
                {"version": "1", "layer": 3, "sample_rate": 48000, "channels": 2}
            )
        )
        self.assertIsNone(mp3_silence.silence_mp3_for(None))
        self.assertIsNone(mp3_silence.silence_mp3_for({}))


if __name__ == "__main__":
    unittest.main()
