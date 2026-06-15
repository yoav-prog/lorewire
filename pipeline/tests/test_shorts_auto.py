"""Tests for shorts_auto.maybe_enqueue_short_for_story.

Focus: the `force=True` path added by the Reddit-import "output: short"
flow (_plans/2026-06-16-reddit-default-to-shorts.md). The store calls are
stubbed - DB-level enqueue idempotency is covered by the
short-renders integration suite; what matters here is the gate logic.
"""
from __future__ import annotations

import unittest
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


if __name__ == "__main__":
    unittest.main()
