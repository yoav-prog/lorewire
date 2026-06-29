"""Tests for pipeline.question_card — the shared resolver both
shorts_render.py and video.py call to build the burnt-in card props.

The pre-extraction tests live in test_shorts_render.py against
`shorts_render._build_question_card` (kept as an alias for back-
compat). These tests cover the new public API + the long-form video
parity path.

2026-06-18 polls plan extension: every video render carries the card.
"""
from __future__ import annotations

import unittest
from unittest import mock

from pipeline import question_card


class BuildQuestionCardTests(unittest.TestCase):
    def _row(self, **over) -> dict:
        base = {
            "id": "story-q",
            "slug": "who-was-right",
            "title": "T",
        }
        base.update(over)
        return base

    def _poll(self, **over) -> dict:
        base = {
            "id": "poll-q",
            "story_id": "story-q",
            "question": "Who was right?",
            "option_a_text": "Wife",
            "option_b_text": "Husband",
            "enabled": 1,
            "category": "Drama",
        }
        base.update(over)
        return base

    def test_returns_card_when_poll_enabled(self):
        with mock.patch.object(
            question_card.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = question_card.build_question_card(self._row())
        self.assertIsNotNone(card)
        self.assertEqual(card["question"], "Who was right?")
        self.assertEqual(card["option_a"], "Wife")
        self.assertEqual(card["option_b"], "Husband")
        self.assertEqual(card["slug"], "who-was-right")
        self.assertEqual(card["card_ms"], question_card.QUESTION_CARD_MS)

    def test_returns_none_when_no_poll(self):
        with mock.patch.object(
            question_card.store,
            "fetch_enabled_poll_for_story",
            return_value=None,
        ):
            card = question_card.build_question_card(self._row())
        self.assertIsNone(card)

    def test_master_switch_disabled_skips_db(self):
        # The master switch fires BEFORE the poll fetch so a turned-off
        # card doesn't waste round trips on the long-form video drain.
        with mock.patch.object(
            question_card.store,
            "get_setting",
            side_effect=lambda k: "0" if k == "polls.endcard.enabled" else None,
        ), mock.patch.object(
            question_card.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ) as fetch:
            card = question_card.build_question_card(self._row())
        self.assertIsNone(card)
        fetch.assert_not_called()

    def test_duration_override_in_range_honored(self):
        def fake(k):
            if k == "polls.endcard.duration_ms":
                return "5000"
            return None
        with mock.patch.object(
            question_card.store, "get_setting", side_effect=fake,
        ), mock.patch.object(
            question_card.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = question_card.build_question_card(self._row())
        self.assertEqual(card["card_ms"], 5000)

    def test_duration_out_of_range_falls_back_to_default(self):
        for raw_val in ("99", "20000", "abc"):
            def fake(k, v=raw_val):
                if k == "polls.endcard.duration_ms":
                    return v
                return None
            with mock.patch.object(
                question_card.store, "get_setting", side_effect=fake,
            ), mock.patch.object(
                question_card.store,
                "fetch_enabled_poll_for_story",
                return_value=self._poll(),
            ):
                card = question_card.build_question_card(self._row())
            self.assertEqual(
                card["card_ms"],
                question_card.QUESTION_CARD_MS,
                msg=f"setting value {raw_val!r} should fall back",
            )

    def test_slug_falls_back_to_story_id(self):
        with mock.patch.object(
            question_card.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = question_card.build_question_card(self._row(slug=None))
        self.assertEqual(card["slug"], "story-q")


class ShortsRenderAliasTests(unittest.TestCase):
    """Back-compat: shorts_render exposes `_build_question_card` as
    an alias for the relocated helper. Existing tests + any other
    package-internal callers continue to work."""

    def test_alias_is_the_same_callable(self):
        from pipeline import shorts_render
        self.assertIs(
            shorts_render._build_question_card,
            question_card.build_question_card,
        )


if __name__ == "__main__":
    unittest.main()
