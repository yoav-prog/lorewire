"""Tests for pipeline.shorts_auto.maybe_enqueue_short_for_story(force=...).

The Reddit-source story-jobs worker now ships article + short + hero +
thumbnail as one unit, so it calls this function with force=True to bypass
the per-category enable check. The global 24h cost cap MUST still apply
(that's the real backstop against a runaway 200-row backfill).

Plan: _plans/2026-06-19-reddit-source-auto-deliver-article-short-hero-thumbnail.md.
"""
from __future__ import annotations

import unittest
from unittest import mock

from pipeline import shorts_auto


class _BaseTest(unittest.TestCase):
    """Each test injects its own get_setting + patches the store helpers
    that would otherwise touch the DB. Mirrors how shorts_auto exposes the
    GetSetting seam for tests."""

    def _settings(self, **overrides: str) -> dict:
        # Defaults match what an admin who hasn't touched anything sees:
        # global auto OFF, no category override, narration + length pinned
        # to the module defaults.
        return {
            "shorts.auto.enabled": "off",
            "shorts.auto.narration": "",
            "shorts.auto.length": "",
            "shorts.auto.daily_cap": "",
            **overrides,
        }

    def _get_setting(self, settings: dict):
        return lambda key: settings.get(key)


class ForceBypassesCategoryGateTests(_BaseTest):
    def test_force_true_enqueues_even_when_globally_off(self):
        settings = self._settings(**{"shorts.auto.enabled": "off"})
        with mock.patch.object(
            shorts_auto.store, "count_short_renders_since", return_value=0,
        ), mock.patch.object(
            shorts_auto.store, "enqueue_short_render",
        ) as enqueue:
            result = shorts_auto.maybe_enqueue_short_for_story(
                "story123", "Drama",
                force=True,
                get_setting=self._get_setting(settings),
            )
        self.assertTrue(result)
        enqueue.assert_called_once()

    def test_force_true_enqueues_even_when_category_off(self):
        # Per-category 'off' is a stronger signal than global, but force
        # overrides it just the same — the worker has already committed
        # to producing a short for THIS row.
        settings = self._settings(**{
            "shorts.auto.enabled": "on",
            "shorts.auto.category.Drama": "off",
        })
        with mock.patch.object(
            shorts_auto.store, "count_short_renders_since", return_value=0,
        ), mock.patch.object(
            shorts_auto.store, "enqueue_short_render",
        ) as enqueue:
            result = shorts_auto.maybe_enqueue_short_for_story(
                "story123", "Drama",
                force=True,
                get_setting=self._get_setting(settings),
            )
        self.assertTrue(result)
        enqueue.assert_called_once()

    def test_force_false_still_respects_off_gate(self):
        # Default behaviour for existing CMS-complete callers MUST be
        # unchanged — force defaults to False, and a globally-off setting
        # still skips the enqueue.
        settings = self._settings(**{"shorts.auto.enabled": "off"})
        with mock.patch.object(
            shorts_auto.store, "enqueue_short_render",
        ) as enqueue:
            result = shorts_auto.maybe_enqueue_short_for_story(
                "story123", "Drama",
                get_setting=self._get_setting(settings),
            )
        self.assertFalse(result)
        enqueue.assert_not_called()


class ForceRespectsCostCapTests(_BaseTest):
    def test_force_true_still_blocked_by_24h_cap(self):
        # The cap is the real backstop. Even with force=True, when the
        # rolling-24h count of auto/story_job rows has hit the cap, we
        # refuse to enqueue. Burning ~$0.70 per short, 200 stories
        # backfilled at once would otherwise burn $140 silently.
        settings = self._settings(**{"shorts.auto.enabled": "off"})
        with mock.patch.object(
            shorts_auto.store,
            "count_short_renders_since",
            return_value=shorts_auto.DEFAULT_AUTO_DAILY_CAP,
        ), mock.patch.object(
            shorts_auto.store, "enqueue_short_render",
        ) as enqueue:
            result = shorts_auto.maybe_enqueue_short_for_story(
                "story123", "Drama",
                force=True,
                requested_by="story_job",
                get_setting=self._get_setting(settings),
            )
        self.assertFalse(result)
        enqueue.assert_not_called()

    def test_force_true_under_cap_proceeds(self):
        # Same setup as the cap test but with one row of headroom — the
        # gate opens.
        settings = self._settings(**{"shorts.auto.enabled": "off"})
        with mock.patch.object(
            shorts_auto.store,
            "count_short_renders_since",
            return_value=shorts_auto.DEFAULT_AUTO_DAILY_CAP - 1,
        ), mock.patch.object(
            shorts_auto.store, "enqueue_short_render",
        ) as enqueue:
            result = shorts_auto.maybe_enqueue_short_for_story(
                "story123", "Drama",
                force=True,
                requested_by="story_job",
                get_setting=self._get_setting(settings),
            )
        self.assertTrue(result)
        enqueue.assert_called_once()

    def test_force_true_passes_requested_by_through_to_count(self):
        # The cap is scoped by requested_by so manual admin clicks (which
        # use requested_by='manual') don't eat into the auto budget. The
        # worker passes requested_by='story_job' and the cap counts only
        # THAT scope's recent rows.
        settings = self._settings(**{"shorts.auto.enabled": "off"})
        with mock.patch.object(
            shorts_auto.store,
            "count_short_renders_since",
            return_value=0,
        ) as count, mock.patch.object(
            shorts_auto.store, "enqueue_short_render",
        ):
            shorts_auto.maybe_enqueue_short_for_story(
                "story123", "Drama",
                force=True,
                requested_by="story_job",
                get_setting=self._get_setting(settings),
            )
        count.assert_called_once()
        # Second positional / keyword arg is the requested_by filter.
        kwargs = count.call_args.kwargs
        self.assertEqual(kwargs.get("requested_by"), "story_job")


if __name__ == "__main__":
    unittest.main()
