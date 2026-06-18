"""Tests for voice.audio_duration_ms — the general MP3 duration probe that the
shorts body length is floored against so the concatenated outro stops clipping
the narration's closing words.

The probe is pure-stdlib (runs in the Vercel drain) and reads version + sample
rate + bitrate off every frame header, so it is exact for any TTS provider. We
verify it against hand-built frame streams of a known count + format, where the
duration is deterministic: frames * samples_per_frame / sample_rate.

See _plans/2026-06-17-shorts-outro-clips-narration.md.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from pipeline import voice


def _mp3_stream(header: bytes, frame_size: int, count: int) -> bytes:
    """`count` identical MPEG frames: a 4-byte header padded with zero data to
    `frame_size`. Zero data never contains a false 0xFFE sync, so the probe
    counts exactly `count` frames."""
    return (header + bytes(frame_size - len(header))) * count


class AudioDurationProbeTests(unittest.TestCase):
    def _write(self, data: bytes) -> Path:
        p = Path(tempfile.mkdtemp()) / "a.mp3"
        p.write_bytes(data)
        return p

    def test_mpeg1_layer3_44100(self):
        # MPEG-1 Layer III, 128 kbps, 44.1 kHz: 1152 samples/frame,
        # frame_size = 144*128000//44100 = 417 bytes. Header FF FB 90 00.
        data = _mp3_stream(bytes([0xFF, 0xFB, 0x90, 0x00]), 417, 100)
        expected = round(100 * 1152 / 44100 * 1000)  # ~2612 ms
        self.assertAlmostEqual(voice.audio_duration_ms(self._write(data)), expected, delta=2)

    def test_mpeg2_layer3_24000(self):
        # MPEG-2 Layer III, 48 kbps, 24 kHz: 576 samples/frame,
        # frame_size = 72*48000//24000 = 144 bytes. Header FF F3 64 00.
        data = _mp3_stream(bytes([0xFF, 0xF3, 0x64, 0x00]), 144, 50)
        expected = round(50 * 576 / 24000 * 1000)  # 1200 ms
        self.assertAlmostEqual(voice.audio_duration_ms(self._write(data)), expected, delta=2)

    def test_missing_file_returns_zero(self):
        self.assertEqual(voice.audio_duration_ms(Path("/no/such/file.mp3")), 0)

    def test_empty_file_returns_zero(self):
        self.assertEqual(voice.audio_duration_ms(self._write(b"")), 0)


if __name__ == "__main__":
    unittest.main()
