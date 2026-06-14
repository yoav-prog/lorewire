"""Tests for the voice_renders queue + worker (Phase 4 of
_plans/2026-06-14-voiceover-picker.md).

Mirrors the test_story_jobs.py shape — per-test isolated SQLite, a
seeded story row, and the worker's process_fn injected via the
run_one_tick seam so we never burn a real ElevenLabs call. What we
lock here:

  1. Schema invariants: the partial unique index rejects a second
     active enqueue for the same (story, text, voice) tuple but
     allows a fresh enqueue once the prior render settles.
  2. Worker tick paths: happy path writes the new audio + alignment +
     video_config, missing-story path records a clean error, process
     failure path records the exception and doesn't crash the loop.
  3. video_config rebuild: captions come from the new word alignment,
     duration_ms tracks the last chunk's end, trim window resets,
     doodle_frames are preserved AND their out-of-range
     caption_chunk_start_index values are clamped into the new
     captions count.
  4. text_hash determinism: same input -> same hex.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from importlib import reload
from pathlib import Path
from unittest import mock

# scripts/ + repo root pathing so the worker import resolves before
# config picks up the temp DB env var.
_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))


class _IsolatedDB(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db_path = Path(self.tmpdir.name) / "test.db"
        self._patch = mock.patch.dict(os.environ, {
            "PIPELINE_DB": str(self.db_path),
            "DATABASE_URL": "",
        }, clear=False)
        self._patch.start()
        from pipeline import config, store
        reload(config)
        reload(store)
        store.init()
        self.store = store

    def tearDown(self):
        self._patch.stop()
        self.tmpdir.cleanup()
        from pipeline import config, store
        reload(config)
        reload(store)


def _seed_story(store_mod, story_id: str = "envelope", body: str = "Hello world."):
    """Insert a minimal story row. The voice worker only reads body +
    voice_provider + voice_id + video_config; everything else is
    incidental."""
    now = "2026-06-14T00:00:00+00:00"
    store_mod.upsert_story({
        "id": story_id,
        "reddit_id": None,
        "slug": story_id,
        "category": "Drama",
        "title": "Test",
        "summary": "",
        "body": body,
        "teleprompter": None,
        "status": "review",
        "source_url": "",
        "hero_image": None,
        "hero_image_landscape": None,
        "hero_has_baked_title": 0,
        "images": "[]",
        "audio_url": None,
        "video_url": None,
        "duration": None,
        "alignment": "[]",
        "props": None,
        "character_image": None,
        "character_image_mouth_removed": None,
        "intro_segment_id": None,
        "outro_segment_id": None,
        "skip_intro": 0,
        "skip_outro": 0,
        "video_config": None,
        "pipeline_cache": None,
        "voice_provider": None,
        "voice_id": None,
        "tokens": 0,
        "cost_cents": 0,
        "created_at": now,
        "updated_at": now,
        "published_at": None,
        "payload": "{}",
    })


class TextHashTests(unittest.TestCase):
    def test_hex_digest_for_known_input(self):
        from pipeline import voice_renders_worker
        # sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
        self.assertEqual(
            voice_renders_worker.text_hash("hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        )

    def test_empty_input_returns_empty_hash(self):
        from pipeline import voice_renders_worker
        # Permissive: caller may pass empty / None during validation.
        # Empty string sha256 is well-known.
        self.assertEqual(
            voice_renders_worker.text_hash(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        )
        self.assertEqual(
            voice_renders_worker.text_hash(None),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        )


class EnqueueTests(_IsolatedDB):
    def test_first_enqueue_inserts_row(self):
        _seed_story(self.store)
        row = self.store.enqueue_voice_render(
            "r-1", "envelope", "hash1", "google/chirp3-hd", "Aoede",
        )
        self.assertIsNotNone(row)
        self.assertEqual(row["status"], "queued")
        self.assertEqual(row["voice_provider"], "google/chirp3-hd")

    def test_duplicate_active_enqueue_is_noop(self):
        # Partial unique index rejects a second active row for the SAME
        # (story, text, voice) tuple. Returns None — caller can surface
        # "already in progress" to the admin.
        _seed_story(self.store)
        first = self.store.enqueue_voice_render(
            "r-1", "envelope", "hash1", "elevenlabs", "vid-rachel",
        )
        second = self.store.enqueue_voice_render(
            "r-2", "envelope", "hash1", "elevenlabs", "vid-rachel",
        )
        self.assertIsNotNone(first)
        self.assertIsNone(second)

    def test_different_voice_does_not_collide(self):
        # Same story + same text but a DIFFERENT voice picks should be
        # allowed simultaneously — the admin might be A/B-ing two
        # narrators and both should drain.
        _seed_story(self.store)
        first = self.store.enqueue_voice_render(
            "r-1", "envelope", "hash1", "elevenlabs", "vid-a",
        )
        second = self.store.enqueue_voice_render(
            "r-2", "envelope", "hash1", "elevenlabs", "vid-b",
        )
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)

    def test_enqueue_after_done_is_allowed(self):
        _seed_story(self.store)
        self.store.enqueue_voice_render(
            "r-1", "envelope", "hash1", "elevenlabs", "vid-a",
        )
        # Settle the first render — the partial index only catches
        # ACTIVE rows so a fresh enqueue after a done one is fine.
        self.store.finish_voice_render("r-1", "https://new.mp3", 75)
        row = self.store.enqueue_voice_render(
            "r-2", "envelope", "hash1", "elevenlabs", "vid-a",
        )
        self.assertIsNotNone(row)


class ClaimAndFinishTests(_IsolatedDB):
    def test_claim_returns_none_on_empty(self):
        self.assertIsNone(self.store.claim_next_voice_render())

    def test_claim_flips_status_and_marks_started(self):
        _seed_story(self.store)
        self.store.enqueue_voice_render(
            "r-1", "envelope", "h", "elevenlabs", "v",
        )
        claimed = self.store.claim_next_voice_render()
        self.assertIsNotNone(claimed)
        self.assertEqual(claimed["status"], "processing")
        self.assertIsNotNone(claimed["started_at"])

    def test_finish_writes_output_url_and_cost(self):
        _seed_story(self.store)
        self.store.enqueue_voice_render(
            "r-1", "envelope", "h", "elevenlabs", "v",
        )
        self.store.claim_next_voice_render()
        self.store.finish_voice_render("r-1", "https://new.mp3", 75)
        row = self.store.get_voice_render("r-1")
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["output_url"], "https://new.mp3")
        self.assertEqual(row["cost_cents"], 75)

    def test_fail_records_message(self):
        _seed_story(self.store)
        self.store.enqueue_voice_render(
            "r-1", "envelope", "h", "elevenlabs", "v",
        )
        self.store.claim_next_voice_render()
        self.store.fail_voice_render("r-1", "ElevenLabs HTTP 429")
        row = self.store.get_voice_render("r-1")
        self.assertEqual(row["status"], "error")
        self.assertIn("429", row["error"])


class WorkerTickTests(_IsolatedDB):
    def test_happy_path_writes_audio_alignment_and_video_config(self):
        from pipeline import voice_renders_worker
        _seed_story(self.store, body="Hi there world")
        self.store.enqueue_voice_render(
            "r-1", "envelope", "h", "elevenlabs", "vid-a",
        )

        def stub_process(render, story):
            # Stub bypasses the real TTS path. Mimics what the live
            # path would write: audio_url + cost_cents + a side
            # effect on stories (so the test can verify the worker
            # called the side-effect helper too).
            self.store.update_story_voice_render_output(
                story_id=story["id"],
                audio_url="https://new/narration.mp3",
                alignment_json=json.dumps([
                    {"word": "Hi", "start": 0.0, "end": 0.5},
                    {"word": "there", "start": 0.5, "end": 1.0},
                ]),
                video_config_json=json.dumps({
                    "captions": [
                        {"start_ms": 0, "end_ms": 1000, "text": "Hi there"},
                    ],
                    "duration_ms": 1000,
                }),
            )
            return {"audio_url": "https://new/narration.mp3", "cost_cents": 42}

        ran = voice_renders_worker.run_one_tick(process_fn=stub_process)
        self.assertTrue(ran)
        render = self.store.get_voice_render("r-1")
        self.assertEqual(render["status"], "done")
        self.assertEqual(render["output_url"], "https://new/narration.mp3")
        self.assertEqual(render["cost_cents"], 42)
        # Story side: the helper wrote through.
        story = self.store.fetch_story("envelope")
        self.assertEqual(story["audio_url"], "https://new/narration.mp3")
        self.assertIn("Hi there", story["video_config"])

    def test_missing_story_fails_render_cleanly(self):
        from pipeline import voice_renders_worker
        # Enqueue against a non-existent story (caller skipped the
        # existence check). Worker MUST surface a clean error rather
        # than crash the tick loop.
        self.store.enqueue_voice_render(
            "r-1", "ghost", "h", "elevenlabs", "vid-a",
        )
        ran = voice_renders_worker.run_one_tick(
            process_fn=lambda r, s: {"audio_url": "x", "cost_cents": 0},
        )
        self.assertTrue(ran)
        render = self.store.get_voice_render("r-1")
        self.assertEqual(render["status"], "error")
        self.assertIn("not found", render["error"])

    def test_process_exception_records_error_and_returns_true(self):
        from pipeline import voice_renders_worker
        _seed_story(self.store, body="Hi")
        self.store.enqueue_voice_render(
            "r-1", "envelope", "h", "elevenlabs", "vid-a",
        )

        def boom(render, story):
            raise RuntimeError("kie down")

        ran = voice_renders_worker.run_one_tick(process_fn=boom)
        self.assertTrue(ran)
        render = self.store.get_voice_render("r-1")
        self.assertEqual(render["status"], "error")
        self.assertIn("kie down", render["error"])

    def test_empty_queue_returns_false(self):
        from pipeline import voice_renders_worker
        self.assertFalse(
            voice_renders_worker.run_one_tick(
                process_fn=lambda r, s: {"audio_url": "x", "cost_cents": 0},
            ),
        )


class VideoConfigRebuildTests(_IsolatedDB):
    """The worker rebuilds captions + duration + clears trim while
    PRESERVING doodle_frames. This is the load-bearing invariant: a
    voice regen must NOT clobber the editor's frame layout, even
    though captions land at new ms boundaries."""

    def test_real_default_process_rebuilds_captions_and_clamps_frames(self):
        from pipeline import voice_renders_worker
        existing_cfg = {
            "voiceover_url": "/old.mp3",
            "duration_ms": 99999,
            "captions": [
                {"start_ms": 0, "end_ms": 1000, "text": "old", "words": []},
            ],
            "doodle_frames": [
                {"id": "f-0", "url": "/a.png", "caption_chunk_start_index": 0},
                # Out-of-range index — the new audio is shorter so this
                # would point past the end of captions. Worker clamps.
                {"id": "f-1", "url": "/b.png", "caption_chunk_start_index": 99},
            ],
            "clip_start_ms": 200,
            "clip_end_ms": 5000,
        }
        _seed_story(self.store, body="Hi there friend")
        # Patch the existing story's video_config so the worker reads
        # it back at process time.
        self.store.update_story_video_config("envelope", existing_cfg)

        self.store.enqueue_voice_render(
            "r-1", "envelope", "h", "elevenlabs", "vid-a",
        )

        # Stub voice.synthesize so we control the words list — the test
        # asserts the chunker's output AND the clamp behaviour without
        # hitting any TTS provider.
        fake_words = [
            {"word": "Hi", "start": 0.0, "end": 0.3},
            {"word": "there", "start": 0.3, "end": 0.7},
            {"word": "friend", "start": 0.7, "end": 1.2},
        ]
        with mock.patch(
            "pipeline.voice.synthesize",
            return_value={
                "audio": "/tmp/narration.mp3",
                "words": fake_words,
                "provider": "elevenlabs",
            },
        ), mock.patch(
            "pipeline.gcs.publish",
            return_value="https://gcs/new/narration.mp3",
        ), mock.patch(
            # _default_process imports media lazily for running_cost_usd.
            # Stub the snapshot so the cost-delta math doesn't try to
            # hit the live counter.
            "pipeline.media.running_cost_usd",
            return_value=0.50,
        ):
            ran = voice_renders_worker.run_one_tick()
        self.assertTrue(ran)
        render = self.store.get_voice_render("r-1")
        self.assertEqual(render["status"], "done")
        self.assertEqual(render["output_url"], "https://gcs/new/narration.mp3")

        story = self.store.fetch_story("envelope")
        cfg = json.loads(story["video_config"])
        # Captions came from the chunker (might be 1 chunk for 3 short
        # words; the chunker breaks at MAX_WORDS_PER_CHUNK = 4 OR pause
        # >= PAUSE_BREAK_MS — neither triggers here so we expect 1
        # chunk).
        self.assertGreaterEqual(len(cfg["captions"]), 1)
        # Duration tracks the last chunk's end_ms.
        self.assertEqual(
            cfg["duration_ms"], cfg["captions"][-1]["end_ms"],
        )
        # Trim window cleared.
        self.assertNotIn("clip_start_ms", cfg)
        self.assertNotIn("clip_end_ms", cfg)
        # doodle_frames preserved AND the out-of-range index was
        # clamped to the new max.
        self.assertEqual(len(cfg["doodle_frames"]), 2)
        self.assertEqual(cfg["doodle_frames"][0]["id"], "f-0")
        self.assertEqual(cfg["doodle_frames"][1]["id"], "f-1")
        max_idx = len(cfg["captions"]) - 1
        for f in cfg["doodle_frames"]:
            self.assertLessEqual(f["caption_chunk_start_index"], max_idx)


class StaleReapTests(_IsolatedDB):
    def test_reap_moves_old_processing_back_to_queued(self):
        _seed_story(self.store)
        self.store.enqueue_voice_render(
            "r-1", "envelope", "h", "elevenlabs", "v",
        )
        # Claim then manually back-date started_at so the reap window
        # bites. Mirrors the story_jobs reap test pattern.
        self.store.claim_next_voice_render()
        with self.store._sqlite_conn() as c:
            c.execute(
                "UPDATE voice_renders SET started_at='2020-01-01T00:00:00+00:00' "
                "WHERE id=?",
                ("r-1",),
            )
        reaped = self.store.reap_stale_voice_renders(stale_after_s=60)
        self.assertEqual(reaped, 1)
        row = self.store.get_voice_render("r-1")
        self.assertEqual(row["status"], "queued")
        self.assertIsNone(row["started_at"])


if __name__ == "__main__":
    unittest.main()
