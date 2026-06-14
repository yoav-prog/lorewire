"""Tests for the voice_renders Vercel drain handler.

Mirrors test_drain_story_jobs.py — auth, max-rows env, idle, drain,
failure-continue, max-rows cap. The drain composes
voice_renders_worker.run_one_tick so the per-row error path is already
covered by test_voice_renders.WorkerTickTests; here we exercise the
HTTP wrapper + the advisory-lock path + the cap loop.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from importlib import reload
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DRAIN_DIR = REPO_ROOT / "lorewire-app" / "api"
if str(DRAIN_DIR) not in sys.path:
    sys.path.insert(0, str(DRAIN_DIR))

# Imported here so the sys.path insert is in effect before the module
# resolves `from pipeline import ...` via the local pipeline pkg.
import drain_voice_renders as drain  # noqa: E402


class _DrainTestCase(unittest.TestCase):
    """Per-test isolated SQLite. We reload config + store after env
    patching so the cached module-level DB_PATH picks up the override
    — same pattern as test_voice_renders._IsolatedDB and the story_jobs
    drain tests."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self._db_path = Path(self._tmpdir.name) / "drain.db"
        self._env_patch = mock.patch.dict(os.environ, {
            "PIPELINE_DB": str(self._db_path),
            "DATABASE_URL": "",
        }, clear=False)
        self._env_patch.start()
        from pipeline import config, store
        reload(config)
        reload(store)
        store.init()
        self.store = store

    def tearDown(self) -> None:
        self._env_patch.stop()
        self._tmpdir.cleanup()
        from pipeline import config, store
        reload(config)
        reload(store)

    def _seed_story(self, story_id: str = "envelope", body: str = "Hi") -> None:
        now = "2026-06-14T00:00:00+00:00"
        self.store.upsert_story({
            "id": story_id,
            "reddit_id": None,
            "slug": story_id,
            "category": "Drama",
            "title": "T",
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

    def _enqueue(
        self, render_id: str, story_id: str,
        voice_provider: str = "elevenlabs", voice_id: str = "vid-a",
        text_hash: str | None = None,
    ) -> None:
        self._seed_story(story_id)
        self.store.enqueue_voice_render(
            render_id, story_id,
            text_hash or f"h-{render_id}",
            voice_provider, voice_id,
        )


class AuthTests(_DrainTestCase):
    def test_missing_cron_secret_rejects_everything(self):
        os.environ.pop("CRON_SECRET", None)
        self.assertFalse(drain._is_authorized("Bearer anything"))
        self.assertFalse(drain._is_authorized(None))

    def test_missing_header_rejects_when_secret_set(self):
        os.environ["CRON_SECRET"] = "abc"
        self.assertFalse(drain._is_authorized(None))
        self.assertFalse(drain._is_authorized(""))

    def test_wrong_token_rejects(self):
        os.environ["CRON_SECRET"] = "abc"
        self.assertFalse(drain._is_authorized("Bearer wrong"))
        # Bare token without "Bearer " prefix is also rejected — matches
        # the other drains' contract.
        self.assertFalse(drain._is_authorized("abc"))

    def test_right_token_accepts(self):
        os.environ["CRON_SECRET"] = "abc"
        self.assertTrue(drain._is_authorized("Bearer abc"))


class MaxRowsTests(_DrainTestCase):
    def test_default_when_unset(self):
        os.environ.pop("DRAIN_VOICE_RENDERS_MAX_ROWS_PER_TICK", None)
        self.assertEqual(drain._max_rows_per_tick(), drain.DEFAULT_MAX_ROWS)

    def test_override_via_env(self):
        os.environ["DRAIN_VOICE_RENDERS_MAX_ROWS_PER_TICK"] = "8"
        try:
            self.assertEqual(drain._max_rows_per_tick(), 8)
        finally:
            os.environ.pop("DRAIN_VOICE_RENDERS_MAX_ROWS_PER_TICK", None)

    def test_invalid_falls_back_to_default(self):
        os.environ["DRAIN_VOICE_RENDERS_MAX_ROWS_PER_TICK"] = "not-a-number"
        try:
            self.assertEqual(
                drain._max_rows_per_tick(), drain.DEFAULT_MAX_ROWS,
            )
        finally:
            os.environ.pop("DRAIN_VOICE_RENDERS_MAX_ROWS_PER_TICK", None)

    def test_clamped_to_safe_range(self):
        os.environ["DRAIN_VOICE_RENDERS_MAX_ROWS_PER_TICK"] = "9999"
        try:
            # Voice regen cap is 30 (higher than story_jobs because each
            # row is faster) — but still a guard against accidental
            # "999" values.
            self.assertEqual(drain._max_rows_per_tick(), 30)
            os.environ["DRAIN_VOICE_RENDERS_MAX_ROWS_PER_TICK"] = "0"
            self.assertEqual(drain._max_rows_per_tick(), 1)
        finally:
            os.environ.pop("DRAIN_VOICE_RENDERS_MAX_ROWS_PER_TICK", None)


class RunDrainTests(_DrainTestCase):
    def test_idle_when_queue_empty(self):
        body = drain.run_drain()
        self.assertEqual(body["drained"], 0)
        self.assertEqual(body["remaining"], 0)

    def test_drains_a_queued_row(self):
        from pipeline import voice_renders_worker
        self._enqueue("r-1", "envelope")

        def stub_process(render, story):
            return {"audio_url": "https://new.mp3", "cost_cents": 5}

        with mock.patch.object(
            voice_renders_worker, "_default_process",
            side_effect=stub_process,
        ):
            body = drain.run_drain()

        self.assertEqual(body["drained"], 1)
        self.assertEqual(body["remaining"], 0)
        render = self.store.get_voice_render("r-1")
        self.assertEqual(render["status"], "done")
        self.assertEqual(render["output_url"], "https://new.mp3")
        self.assertEqual(render["cost_cents"], 5)

    def test_failure_marks_row_error_and_continues(self):
        """Two rows; first one bombs, second one succeeds. The drain
        composes run_one_tick which already does per-row try/except —
        we're verifying the composition preserves that contract.
        Distinct voice ids so the partial unique index doesn't reject
        the second enqueue."""
        from pipeline import voice_renders_worker
        self._enqueue("r-bad", "envelope", voice_id="vid-bad")
        self._enqueue("r-good", "envelope", voice_id="vid-good")

        def stub_process(render, story):
            if render["id"] == "r-bad":
                raise RuntimeError("ElevenLabs HTTP 503")
            return {"audio_url": f"https://{render['id']}.mp3", "cost_cents": 5}

        with mock.patch.object(
            voice_renders_worker, "_default_process",
            side_effect=stub_process,
        ):
            body = drain.run_drain()

        self.assertEqual(body["drained"], 2)
        bad = self.store.get_voice_render("r-bad")
        good = self.store.get_voice_render("r-good")
        self.assertEqual(bad["status"], "error")
        self.assertIn("503", bad["error"])
        self.assertEqual(good["status"], "done")

    def test_max_rows_per_tick_caps_the_loop(self):
        """Enqueue more than the cap; drain stops at the cap and leaves
        the rest queued for the next tick. Verifies the per-tick
        ceiling protects the Vercel function from blowing past
        maxDuration on a stuffed queue."""
        from pipeline import voice_renders_worker
        for i in range(5):
            self._enqueue(f"r-{i}", "envelope", voice_id=f"vid-{i}")
        os.environ["DRAIN_VOICE_RENDERS_MAX_ROWS_PER_TICK"] = "2"
        try:
            def stub_process(render, story):
                return {
                    "audio_url": f"https://{render['id']}.mp3",
                    "cost_cents": 5,
                }

            with mock.patch.object(
                voice_renders_worker, "_default_process",
                side_effect=stub_process,
            ):
                body = drain.run_drain()
        finally:
            os.environ.pop("DRAIN_VOICE_RENDERS_MAX_ROWS_PER_TICK", None)

        self.assertEqual(body["drained"], 2)
        self.assertEqual(body["remaining"], 3)


if __name__ == "__main__":
    unittest.main()
