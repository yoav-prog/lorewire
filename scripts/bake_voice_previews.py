"""Phase 2.b of _plans/2026-06-14-voiceover-picker.md.

One-off (re-runnable) script that synthesizes a short audition clip
for every Google Chirp 3 HD + Gemini Flash TTS voice the picker will
surface, and uploads each clip to GCS at the path
`voice-previews/<provider>/<voice_id>.mp3` — exactly where
`lorewire-app/src/lib/voice-library.ts:_previewUrlFor` points the
UI's <audio> element.

Why not bake at deploy time? The set of voices changes rarely (it's a
curated hardcoded list) and a deploy-time hook would conflate two
concerns (TTS provisioning + frontend deploy). A standalone script the
admin runs once per refresh keeps the responsibility crisp and lets
the picker UI ship before the previews exist (graceful degrade in the
component handles a missing MP3).

Usage:
    # Bake everything missing from GCS
    python scripts/bake_voice_previews.py

    # Force re-bake even objects already in GCS (e.g. after a voice
    # quality complaint — re-run to pick up new TTS model versions)
    python scripts/bake_voice_previews.py --force

    # Dry-run (no synth, no upload)
    python scripts/bake_voice_previews.py --dry-run

    # Single voice / provider
    python scripts/bake_voice_previews.py \\
        --provider google/chirp3-hd \\
        --voice en-US-Chirp3-HD-Aoede

Cost: ~$0.001 per voice for Chirp 3 HD, ~$0.006 for Gemini. Full bake
of 8 voices × 3 providers = ~$0.06 total. Idempotent skip keeps
re-runs free.
"""
from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

# Repo root layout: scripts/<this>.py and pipeline/ are siblings.
_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from pipeline import gcs, voice  # noqa: E402

# Sample text the UI's <audio> plays when an admin clicks ▶ on a voice
# card. Short enough that every TTS provider returns in <1s, long
# enough to give a true sense of the narrator's timbre.
PREVIEW_TEXT = "Hi, I'm your narrator for today's story."

# MUST stay in sync with GOOGLE_CHIRP3_HD_VOICES in
# lorewire-app/src/lib/voice-library.ts. A drift here means a voice
# shows up in the picker with a broken preview URL (the TS list
# defines what the UI surfaces; this list defines what gets baked).
# The Python parity test (pipeline/tests/test_bake_voice_previews.py)
# locks the count and the ordering so a one-sided edit fails CI.
GOOGLE_CHIRP3_HD_VOICE_IDS: tuple[str, ...] = (
    "en-US-Chirp3-HD-Aoede",
    "en-US-Chirp3-HD-Charon",
    "en-US-Chirp3-HD-Fenrir",
    "en-US-Chirp3-HD-Kore",
    "en-US-Chirp3-HD-Leda",
    "en-US-Chirp3-HD-Puck",
    "en-US-Chirp3-HD-Achernar",
    "en-US-Chirp3-HD-Vindemiatrix",
)

# All providers the picker exposes for these voice ids. ElevenLabs
# preview URLs come straight from /v1/voices and don't need a bake —
# they're omitted on purpose.
PROVIDERS_TO_BAKE: tuple[str, ...] = (
    "google/chirp3-hd",
    "google/gemini-25-flash-tts",
    "google/gemini-31-flash-tts",
)

# Bake result tags so the summary line and tests can count outcomes
# without parsing log strings.
RESULT_BAKED = "baked"
RESULT_SKIPPED = "skipped"
RESULT_DRY_RUN = "dry-run"
RESULT_FAILED = "failed"


def gcs_key_for(provider: str, voice_id: str) -> str:
    """Return the bucket-relative object key — the SAME shape
    `voice-library.ts:_previewUrlFor` constructs on the TS side. Lock
    the path here so a drift between the two writers (the bake) and
    the reader (the picker) is impossible without changing one file."""
    return f"voice-previews/{provider}/{voice_id}.mp3"


def bake_one(
    provider: str,
    voice_id: str,
    *,
    force: bool = False,
    dry_run: bool = False,
) -> str:
    """Synthesize + upload one preview. Returns one of the RESULT_*
    constants. Pure-ish (no logging) so tests can assert behaviour
    without grepping stdout."""
    key = gcs_key_for(provider, voice_id)
    if not force and not dry_run and gcs.exists(key):
        return RESULT_SKIPPED
    if dry_run:
        return RESULT_DRY_RUN
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp) / "preview.mp3"
        voice.synthesize(
            PREVIEW_TEXT,
            dest,
            override_provider=provider,
            override_voice_id=voice_id,
        )
        gcs.upload(dest, key)
    return RESULT_BAKED


def voices_to_bake(
    voice_filter: str | None,
    provider_filter: str | None,
) -> list[tuple[str, str]]:
    """Build the (provider, voice_id) work list. Filters narrow the
    full cross-product down; a None filter means "all"."""
    providers = (
        (provider_filter,) if provider_filter else PROVIDERS_TO_BAKE
    )
    voices = (
        (voice_filter,) if voice_filter else GOOGLE_CHIRP3_HD_VOICE_IDS
    )
    return [(p, v) for p in providers for v in voices]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Bake voice preview MP3s for the picker UI.",
    )
    parser.add_argument(
        "--provider",
        choices=PROVIDERS_TO_BAKE,
        help="Only bake this provider (defaults to all three).",
    )
    parser.add_argument(
        "--voice",
        help="Only bake this voice_id (e.g. en-US-Chirp3-HD-Aoede).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-bake even when the object already exists in GCS.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip the TTS call + upload; just print what would happen.",
    )
    args = parser.parse_args(argv)

    work = voices_to_bake(args.voice, args.provider)
    summary = {
        RESULT_BAKED: 0,
        RESULT_SKIPPED: 0,
        RESULT_DRY_RUN: 0,
        RESULT_FAILED: 0,
    }
    print(
        f"[voice preview bake] start providers={list(set(p for p, _ in work))} "
        f"voices={len(work)} force={args.force} dry_run={args.dry_run}"
    )
    for provider, voice_id in work:
        try:
            result = bake_one(
                provider, voice_id,
                force=args.force, dry_run=args.dry_run,
            )
            summary[result] += 1
            print(
                f"[voice preview {result}] provider={provider} "
                f"voice_id={voice_id}"
            )
        except Exception as e:  # noqa: BLE001 — per-row guard
            summary[RESULT_FAILED] += 1
            print(
                f"[voice preview fail] provider={provider} "
                f"voice_id={voice_id} error={type(e).__name__}: {e}"
            )

    print(f"[voice preview bake] done {summary}")
    return 0 if summary[RESULT_FAILED] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
