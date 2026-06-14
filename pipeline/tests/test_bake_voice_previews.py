"""Tests for scripts/bake_voice_previews.py (Phase 2.b of
_plans/2026-06-14-voiceover-picker.md).

Two concerns locked here:
  1. The curated Google Chirp 3 HD voice list. The script's tuple
     MUST stay in sync with the TS-side `GOOGLE_CHIRP3_HD_VOICES`
     constant in lorewire-app/src/lib/voice-library.ts. A drift means
     a voice surfaces in the picker without a baked preview (broken
     ▶ button) or a preview is baked for a voice the picker doesn't
     show (wasted spend). We assert count, ordering, and exact set
     so an edit on one side has to land here too.
  2. The pure decision logic — voices_to_bake() filtering, bake_one()
     idempotency / dry-run / force. The TTS HTTP call + GCS upload
     are mocked because (a) we don't want to pay $0.001 every CI run
     and (b) we're testing the orchestration, not the providers.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

# scripts/ is not a package; add it to sys.path so the import resolves
# without making the script directory installable.
_HERE = Path(__file__).resolve().parent
_SCRIPTS = _HERE.parent.parent / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import bake_voice_previews as bake  # noqa: E402


class CuratedListParityTests(unittest.TestCase):
    """The Python list is the source of truth for what gets BAKED;
    the TS list is the source of truth for what gets SHOWN. Both must
    agree. If they drift, the picker either renders broken play
    buttons (TS knows about a voice Python skipped) or wastes spend
    (Python bakes a voice TS doesn't surface)."""

    def test_count_locked_at_eight(self):
        # Picker UX target: 8 voices is a comfortable scroll-free
        # column. Growing past 8 needs a UX decision (search? filter?).
        self.assertEqual(len(bake.GOOGLE_CHIRP3_HD_VOICE_IDS), 8)

    def test_no_duplicates(self):
        # A duplicate would silently double-bake one voice and skip
        # another. Set equality guard catches it before the script
        # spends money on the same voice twice.
        self.assertEqual(
            len(set(bake.GOOGLE_CHIRP3_HD_VOICE_IDS)),
            len(bake.GOOGLE_CHIRP3_HD_VOICE_IDS),
        )

    def test_all_voices_are_chirp3_hd_format(self):
        # Every id MUST match the Google Chirp 3 HD naming convention
        # (en-US-Chirp3-HD-<Name>). A typo here means Google returns a
        # 400 at synth time — the bake fails loudly, but better to
        # catch shape at build time.
        for vid in bake.GOOGLE_CHIRP3_HD_VOICE_IDS:
            self.assertTrue(
                vid.startswith("en-US-Chirp3-HD-"),
                f"voice id {vid!r} doesn't match Chirp 3 HD pattern",
            )

    def test_providers_to_bake_excludes_elevenlabs(self):
        # ElevenLabs preview URLs come from /v1/voices — they don't
        # need a bake. The bake list should NEVER include elevenlabs
        # or a spurious upload key collision shows up under
        # voice-previews/elevenlabs/.
        self.assertNotIn("elevenlabs", bake.PROVIDERS_TO_BAKE)
        # And all three providers we DO bake are Google-side.
        for p in bake.PROVIDERS_TO_BAKE:
            self.assertTrue(p.startswith("google/"))


class GcsKeyShapeTests(unittest.TestCase):
    def test_key_matches_voice_library_path(self):
        # MUST match _previewUrlFor in voice-library.ts. The TS test
        # locks the URL shape from its side; this test locks the key
        # shape from the writer's side. Drift here breaks the picker.
        self.assertEqual(
            bake.gcs_key_for(
                "google/chirp3-hd", "en-US-Chirp3-HD-Aoede",
            ),
            "voice-previews/google/chirp3-hd/en-US-Chirp3-HD-Aoede.mp3",
        )

    def test_key_distinguishes_chirp3_from_gemini(self):
        chirp = bake.gcs_key_for(
            "google/chirp3-hd", "en-US-Chirp3-HD-Aoede",
        )
        gemini = bake.gcs_key_for(
            "google/gemini-25-flash-tts", "en-US-Chirp3-HD-Aoede",
        )
        self.assertNotEqual(chirp, gemini)


class VoicesToBakeTests(unittest.TestCase):
    def test_no_filters_returns_full_cross_product(self):
        # 3 providers × 8 voices = 24 work items.
        out = bake.voices_to_bake(None, None)
        self.assertEqual(len(out), 3 * 8)

    def test_provider_filter_narrows_to_one_provider(self):
        out = bake.voices_to_bake(None, "google/chirp3-hd")
        self.assertEqual(len(out), 8)
        for provider, _ in out:
            self.assertEqual(provider, "google/chirp3-hd")

    def test_voice_filter_narrows_to_one_voice(self):
        out = bake.voices_to_bake("en-US-Chirp3-HD-Aoede", None)
        self.assertEqual(len(out), 3)
        for _, voice_id in out:
            self.assertEqual(voice_id, "en-US-Chirp3-HD-Aoede")

    def test_both_filters_narrow_to_one_item(self):
        out = bake.voices_to_bake(
            "en-US-Chirp3-HD-Aoede", "google/chirp3-hd",
        )
        self.assertEqual(
            out, [("google/chirp3-hd", "en-US-Chirp3-HD-Aoede")],
        )


class BakeOneTests(unittest.TestCase):
    def test_skips_when_gcs_object_exists(self):
        # Idempotent re-run path: if the preview is already in GCS,
        # bake_one returns SKIPPED without firing the TTS HTTP call.
        # This is the whole point of the existence check — re-running
        # the script after adding ONE voice doesn't re-bake the other
        # 23 (which is real money + real Google quota).
        with mock.patch.object(
            bake.gcs, "exists", return_value=True,
        ) as exists, mock.patch.object(
            bake.voice, "synthesize",
        ) as synth, mock.patch.object(
            bake.gcs, "upload",
        ) as upload:
            result = bake.bake_one(
                "google/chirp3-hd", "en-US-Chirp3-HD-Aoede",
            )
        self.assertEqual(result, bake.RESULT_SKIPPED)
        exists.assert_called_once_with(
            "voice-previews/google/chirp3-hd/en-US-Chirp3-HD-Aoede.mp3",
        )
        synth.assert_not_called()
        upload.assert_not_called()

    def test_force_overrides_existence_check(self):
        # --force is the escape hatch for "re-bake after a voice
        # quality regression / TTS model bump". It MUST skip the
        # existence check entirely.
        with mock.patch.object(
            bake.gcs, "exists", return_value=True,
        ) as exists, mock.patch.object(
            bake.voice, "synthesize",
        ) as synth, mock.patch.object(
            bake.gcs, "upload",
        ) as upload:
            result = bake.bake_one(
                "google/chirp3-hd", "en-US-Chirp3-HD-Aoede",
                force=True,
            )
        self.assertEqual(result, bake.RESULT_BAKED)
        exists.assert_not_called()
        synth.assert_called_once()
        upload.assert_called_once()

    def test_dry_run_returns_without_synth_or_upload(self):
        with mock.patch.object(
            bake.gcs, "exists", return_value=False,
        ), mock.patch.object(
            bake.voice, "synthesize",
        ) as synth, mock.patch.object(
            bake.gcs, "upload",
        ) as upload:
            result = bake.bake_one(
                "google/chirp3-hd", "en-US-Chirp3-HD-Aoede",
                dry_run=True,
            )
        self.assertEqual(result, bake.RESULT_DRY_RUN)
        synth.assert_not_called()
        upload.assert_not_called()

    def test_threads_override_into_synthesize(self):
        # The whole point of Phase 1's override args: each voice's
        # bake MUST send (provider, voice_id) into voice.synthesize
        # so the right narrator's audio comes back. If we accidentally
        # passed None here we'd bake the global default voice 24 times
        # — and the picker would play the same audio for every card.
        with mock.patch.object(
            bake.gcs, "exists", return_value=False,
        ), mock.patch.object(
            bake.voice, "synthesize",
        ) as synth, mock.patch.object(
            bake.gcs, "upload",
        ):
            bake.bake_one(
                "google/gemini-25-flash-tts",
                "en-US-Chirp3-HD-Charon",
            )
        _args, kwargs = synth.call_args
        self.assertEqual(
            kwargs.get("override_provider"),
            "google/gemini-25-flash-tts",
        )
        self.assertEqual(
            kwargs.get("override_voice_id"),
            "en-US-Chirp3-HD-Charon",
        )

    def test_uploads_to_the_expected_gcs_key(self):
        # Without this lock, a future refactor could split the GCS
        # writer and the URL reader (voice-library.ts) and have them
        # disagree on path. The TS test covers the reader side; this
        # covers the writer side. Both meeting in the middle is the
        # picker working.
        with mock.patch.object(
            bake.gcs, "exists", return_value=False,
        ), mock.patch.object(
            bake.voice, "synthesize",
        ), mock.patch.object(
            bake.gcs, "upload",
        ) as upload:
            bake.bake_one(
                "google/chirp3-hd", "en-US-Chirp3-HD-Leda",
            )
        _args, _kwargs = upload.call_args
        # upload(local_path, key) — key is the second positional.
        self.assertEqual(
            upload.call_args.args[1],
            "voice-previews/google/chirp3-hd/en-US-Chirp3-HD-Leda.mp3",
        )


if __name__ == "__main__":
    unittest.main()
