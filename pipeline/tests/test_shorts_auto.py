"""Tests for shorts_auto.maybe_enqueue_short_for_story and the
short-render auto-apply helper for Reddit-import short-only stories.

Focus:
  - the `force=True` path added by the Reddit-import "output: short"
    flow (_plans/2026-06-16-reddit-default-to-shorts.md). Store calls
    are stubbed; what matters is the gate logic.
  - the `set_story_video_url_if_null` helper that makes the short the
    story's video. Without it, the publish gate stays blocked because
    stories.video_url is NULL on short-only Reddit-import rows.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from importlib import reload
from pathlib import Path
from unittest import mock

from pipeline import shorts_auto


def _settings(**overrides):
    """Build a get_setting fake from a flat dict. Anything not in the
    dict returns None - matching store.get_setting's contract."""
    return lambda key: overrides.get(key)


class ForcePathTests(unittest.TestCase):
    """maybe_enqueue_short_for_story(force=True) bypasses the
    shorts.auto.enabled gate (and the per-category override) but still
    respects the rolling-24h cap - the cap is a cost safety net, not an
    opt-in toggle."""

    def setUp(self) -> None:
        # Stub the DB-touching calls so the test is pure-logic.
        self._enqueue_patch = mock.patch.object(
            shorts_auto.store, "enqueue_short_render"
        )
        self._enqueue = self._enqueue_patch.start()
        self._count_patch = mock.patch.object(
            shorts_auto.store, "count_short_renders_since", return_value=0
        )
        self._count = self._count_patch.start()

    def tearDown(self) -> None:
        self._enqueue_patch.stop()
        self._count_patch.stop()

    def test_force_true_bypasses_disabled_gate(self):
        # Global toggle OFF, no per-category override. The pre-2026-06-16
        # call (force=False) would short-circuit here.
        result = shorts_auto.maybe_enqueue_short_for_story(
            "story-1",
            "Drama",
            requested_by="reddit-import",
            get_setting=_settings(),
            force=True,
        )
        self.assertTrue(result)
        self._enqueue.assert_called_once()

    def test_force_true_bypasses_per_category_off_override(self):
        # Global ON but a category-level OFF override would otherwise
        # block. Force still wins.
        result = shorts_auto.maybe_enqueue_short_for_story(
            "story-1",
            "Drama",
            requested_by="reddit-import",
            get_setting=_settings(**{
                "shorts.auto.enabled": "on",
                "shorts.auto.category.Drama": "off",
            }),
            force=True,
        )
        self.assertTrue(result)
        self._enqueue.assert_called_once()

    def test_force_true_still_respects_rolling_24h_cap(self):
        # The cap is a cost safety net, not an opt-in. The admin can
        # raise shorts.auto.daily_cap if they want a bigger import wave.
        self._count.return_value = 50  # default cap is 50
        result = shorts_auto.maybe_enqueue_short_for_story(
            "story-1",
            "Drama",
            requested_by="reddit-import",
            get_setting=_settings(),
            force=True,
        )
        self.assertFalse(result)
        self._enqueue.assert_not_called()

    def test_force_true_uses_admin_narration_and_length_settings(self):
        # A forced short still picks up the admin's narration vibe + length
        # preset so the result matches their preferred style.
        shorts_auto.maybe_enqueue_short_for_story(
            "story-1",
            "Drama",
            requested_by="reddit-import",
            get_setting=_settings(**{
                "shorts.auto.narration": "noir",
                "shorts.auto.length": "extended",
            }),
            force=True,
        )
        # enqueue_short_render(id, story_id, config_hash, narration, length, requested_by)
        args = self._enqueue.call_args[0]
        self.assertEqual(args[1], "story-1")
        self.assertEqual(args[3], "noir")
        self.assertEqual(args[4], "extended")
        self.assertEqual(args[5], "reddit-import")

    def test_force_false_still_obeys_disabled_gate(self):
        # Regression guard: the new parameter must not change the existing
        # auto-pipeline behaviour.
        result = shorts_auto.maybe_enqueue_short_for_story(
            "story-1",
            "Drama",
            get_setting=_settings(),
            force=False,
        )
        self.assertFalse(result)
        self._enqueue.assert_not_called()


class SetStoryVideoUrlIfNullTests(unittest.TestCase):
    """The Reddit-import short-only flow skips long-form rendering, so
    stories.video_url stays NULL. The short-render worker calls this
    helper after a successful finish so the publish gate unlocks.

    Needs a real DB because the IS NULL race guard is enforced at the
    UPDATE-WHERE clause, not in Python. Mirrors the test_story_jobs.py
    _IsolatedDB pattern (temp SQLite, reload pipeline modules).
    """

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

    def _seed_story(self, story_id: str, video_url: "str | None" = None):
        self.store.upsert_story({
            "id": story_id,
            "reddit_id": story_id,
            "slug": story_id,
            "category": "Drama",
            "title": "t",
            "summary": "s",
            "body": "b",
            "status": "review",
            "source_url": "",
            "video_url": video_url,
            "created_at": "2026-06-16T00:00:00+00:00",
            "updated_at": "2026-06-16T00:00:00+00:00",
        })

    def test_flips_null_video_url_to_short_url(self):
        self._seed_story("s-1", video_url=None)
        ok = self.store.set_story_video_url_if_null("s-1", "https://gcs/short.mp4")
        self.assertTrue(ok)
        row = self.store.fetch_story("s-1")
        self.assertEqual(row["video_url"], "https://gcs/short.mp4")

    def test_noop_when_video_url_already_set(self):
        # The auto-short pipeline (shorts.auto.enabled=on) finishes a short
        # alongside a long-form. In that case stories.video_url was already
        # written by the long-form render. The short must NOT clobber it:
        # the admin still expects long-form to be the story's video.
        self._seed_story("s-1", video_url="https://gcs/longform.mp4")
        ok = self.store.set_story_video_url_if_null("s-1", "https://gcs/short.mp4")
        self.assertFalse(ok)
        row = self.store.fetch_story("s-1")
        self.assertEqual(row["video_url"], "https://gcs/longform.mp4")

    def test_noop_when_story_id_missing(self):
        # No row for the id: rowcount=0, returns False, no crash.
        ok = self.store.set_story_video_url_if_null(
            "does-not-exist", "https://gcs/short.mp4",
        )
        self.assertFalse(ok)

    def test_updates_updated_at_on_successful_flip(self):
        # The publish-readiness UI reads updated_at to decide what to show
        # in the "last touched" column; the auto-apply has to bump it so
        # the row surfaces as "freshly ready to publish".
        self._seed_story("s-1", video_url=None)
        before = self.store.fetch_story("s-1")["updated_at"]
        self.store.set_story_video_url_if_null("s-1", "https://gcs/short.mp4")
        after = self.store.fetch_story("s-1")["updated_at"]
        self.assertNotEqual(before, after)


class ShortRenderWorkerAutoApplyTests(unittest.TestCase):
    """End-to-end integration of the auto-apply hook in run_one_tick.

    The unit tests above lock the helper; these lock the worker hook
    that calls it. The render_fn is stubbed so no Remotion / Cloud Run
    spend, but everything else (claim, finish, log_short_render_event,
    set_story_video_url_if_null) is the real path.
    """

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db_path = Path(self.tmpdir.name) / "test.db"
        self._patch = mock.patch.dict(os.environ, {
            "PIPELINE_DB": str(self.db_path),
            "DATABASE_URL": "",
        }, clear=False)
        self._patch.start()
        from pipeline import config, store, short_render_worker
        reload(config)
        reload(store)
        reload(short_render_worker)
        store.init()
        self.store = store
        self.worker = short_render_worker

    def tearDown(self):
        self._patch.stop()
        self.tmpdir.cleanup()
        from pipeline import config, store, short_render_worker
        reload(config)
        reload(store)
        reload(short_render_worker)

    def _seed_story(self, story_id: str, video_url: "str | None" = None):
        self.store.upsert_story({
            "id": story_id,
            "reddit_id": story_id,
            "slug": story_id,
            "category": "Drama",
            "title": "t",
            "summary": "s",
            "body": "b",
            "status": "review",
            "source_url": "",
            "video_url": video_url,
            "created_at": "2026-06-16T00:00:00+00:00",
            "updated_at": "2026-06-16T00:00:00+00:00",
        })

    def _enqueue_short(self, story_id: str, requested_by: str):
        self.store.enqueue_short_render(
            "render-1",
            story_id,
            "config-hash-1",
            "suspense",
            "standard",
            requested_by,
        )

    @staticmethod
    def _fake_render_fn(url: str):
        return lambda claimed: {"video_url": url}

    def test_reddit_import_short_auto_applies_to_story_video_url(self):
        # The publish-gate-unlock path: a Reddit-import short-only row
        # finishes, the worker calls set_story_video_url_if_null, and
        # stories.video_url is now the rendered short.
        self._seed_story("s-1", video_url=None)
        self._enqueue_short("s-1", requested_by="reddit-import")

        handled = self.worker.run_one_tick(
            render_fn=self._fake_render_fn("https://gcs/short.mp4"),
        )
        self.assertTrue(handled)

        story = self.store.fetch_story("s-1")
        self.assertEqual(story["video_url"], "https://gcs/short.mp4")
        # short_renders row also done with the same url.
        render = self.store.get_short_render("render-1")
        self.assertEqual(render["status"], "done")
        self.assertEqual(render["output_url"], "https://gcs/short.mp4")

    def test_auto_requested_short_does_not_touch_story_video_url(self):
        # The existing auto-short pipeline (shorts.auto.enabled=on) sits
        # alongside long-form. Long-form is what should land as
        # stories.video_url; the auto short is a separate asset. The
        # worker's requested_by gate makes sure we do not overwrite the
        # long-form url with the (likely later-finishing) short.
        self._seed_story("s-1", video_url=None)
        self._enqueue_short("s-1", requested_by="auto")

        self.worker.run_one_tick(
            render_fn=self._fake_render_fn("https://gcs/short.mp4"),
        )

        story = self.store.fetch_story("s-1")
        self.assertIsNone(story["video_url"])
        # short_renders row still landed.
        render = self.store.get_short_render("render-1")
        self.assertEqual(render["status"], "done")

    def test_reddit_import_short_does_not_clobber_existing_video_url(self):
        # Race scenario: a concurrent long-form render lands first and
        # writes stories.video_url. When the Reddit-import short
        # subsequently finishes, the auto-apply must not overwrite the
        # long-form url with the short.
        self._seed_story("s-1", video_url="https://gcs/longform.mp4")
        self._enqueue_short("s-1", requested_by="reddit-import")

        self.worker.run_one_tick(
            render_fn=self._fake_render_fn("https://gcs/short.mp4"),
        )

        story = self.store.fetch_story("s-1")
        self.assertEqual(story["video_url"], "https://gcs/longform.mp4")
        # The short still landed in its own queue; the long-form just wins
        # the publish-gate slot.
        render = self.store.get_short_render("render-1")
        self.assertEqual(render["status"], "done")
        self.assertEqual(render["output_url"], "https://gcs/short.mp4")


if __name__ == "__main__":
    unittest.main()
