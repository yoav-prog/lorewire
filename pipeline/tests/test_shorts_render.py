"""Tests for pipeline.shorts_render — the short props assembly.

Focus: the base reference frame must NEVER become a visible scene (it is the
i2i character anchor only), it must instead survive as props.character_base_url,
and the opening scene must cover t=0. Plus a guard that the shared doodle style
suffix no longer hard-codes a single character's identity (that made every
short the same glasses-wearing person). See
_plans/2026-06-17-shorts-editor-and-character-bugs.md.

The generation + voice + upload steps are stubbed so the assembly logic is
exercised without burning kie / TTS credits or touching the network.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import shorts, shorts_image_style as sis, shorts_render


class MapFramesTests(unittest.TestCase):
    def test_first_frame_pinned_to_caption_zero(self):
        # Even when every scene was planned against a later beat, the opening
        # frame is pinned to caption 0 so DoodleShort has no blank lead.
        staged = [
            {"id": "frame-00", "url": "u0", "planned": 3, "image_prompt": None},
            {"id": "frame-01", "url": "u1", "planned": 6, "image_prompt": None},
        ]
        frames = shorts_render._map_frames(staged, caption_count=10, planning_count=8)
        self.assertEqual(frames[0]["caption_chunk_start_index"], 0)

    def test_indices_stay_unique_and_sorted(self):
        staged = [
            {"id": "a", "url": "ua", "planned": 0, "image_prompt": None},
            {"id": "b", "url": "ub", "planned": 0, "image_prompt": None},
            {"id": "c", "url": "uc", "planned": 1, "image_prompt": None},
        ]
        frames = shorts_render._map_frames(staged, caption_count=6, planning_count=3)
        idxs = [f["caption_chunk_start_index"] for f in frames]
        self.assertEqual(idxs, sorted(idxs))
        self.assertEqual(len(idxs), len(set(idxs)))


class BuildShortPropsBaseFrameTests(unittest.TestCase):
    """The base reference image is the model's i2i identity anchor — a neutral
    standing pose on a plain background. It must not appear in the rendered
    video; it lives only as props.character_base_url."""

    def _assets(self) -> shorts.ShortAssets:
        return shorts.ShortAssets(
            narration_style="suspense",
            length_preset="standard",
            script={"short_script": "Hello there. This is a short test script."},
            character="a tall man with a red scarf",
            base_url="https://kie/base.png",
            base_prompt="BASE PROMPT",
            scenes=[
                {"caption_chunk_start_index": 0, "scene": "s0", "url": "https://kie/s0.png", "image_prompt": "p0"},
                {"caption_chunk_start_index": 2, "scene": "s1", "url": "https://kie/s1.png", "image_prompt": "p1"},
            ],
            cost_credits=0.0,
        )

    def test_base_excluded_from_frames_but_kept_as_character_base_url(self):
        words = [
            {"word": "Hello", "start": 0.0, "end": 0.4},
            {"word": "there.", "start": 0.4, "end": 0.9},
            {"word": "This", "start": 1.0, "end": 1.3},
            {"word": "is", "start": 1.3, "end": 1.5},
            {"word": "a", "start": 1.5, "end": 1.6},
            {"word": "short.", "start": 1.6, "end": 2.1},
        ]
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(shorts_render.store, "fetch_story",
                              return_value={"id": "s1", "title": "T", "body": "Body text here."}), \
            mock.patch.object(shorts_render.shorts, "generate_short_assets",
                              return_value=self._assets()), \
            mock.patch.object(shorts_render.voice, "synthesize",
                              return_value={"words": words}), \
            mock.patch.object(shorts_render.images, "download", return_value=None), \
            mock.patch.object(shorts_render.store, "get_setting", return_value=None):
            built = shorts_render.build_short_props("s1", Path(tmp), remote=False)

        self.assertIsNotNone(built)
        props = built.props
        # The base reference is preserved for Lane C regen / the editor...
        self.assertEqual(props["character_base_url"], "https://kie/base.png")
        # ...but it is NOT one of the visible frames.
        frame_urls = [f["url"] for f in props["doodle_frames"]]
        self.assertNotIn("https://kie/base.png", frame_urls)
        # Exactly the two scenes became frames (no base prepended).
        self.assertEqual(len(props["doodle_frames"]), 2)
        # And the short still opens at t=0.
        self.assertEqual(props["doodle_frames"][0]["caption_chunk_start_index"], 0)


class BuildQuestionCardTests(unittest.TestCase):
    """Phase 3 of _plans/2026-06-17-engagement-polls.md. The
    `_build_question_card` resolver decides whether to bake the burnt-in
    end card. Story rows resolve cleanly to a dict; missing or disabled
    polls return None and the short renders byte-identical to its
    pre-poll shape."""

    def _row(self, **over) -> dict:
        base = {
            "id": "story-1",
            "slug": "wife-vs-husband",
            "title": "T",
            "body": "Body text.",
        }
        base.update(over)
        return base

    def _poll(self, **over) -> dict:
        base = {
            "id": "poll-1",
            "story_id": "story-1",
            "question": "Who's wrong?",
            "option_a_text": "Wife",
            "option_b_text": "Husband",
            "enabled": 1,
            "category": "Drama",
        }
        base.update(over)
        return base

    def test_returns_card_when_poll_enabled(self):
        with mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNotNone(card)
        self.assertEqual(card["question"], "Who's wrong?")
        self.assertEqual(card["option_a"], "Wife")
        self.assertEqual(card["option_b"], "Husband")
        self.assertEqual(card["slug"], "wife-vs-husband")
        self.assertEqual(card["card_ms"], shorts_render.QUESTION_CARD_MS)

    def test_returns_none_when_no_poll(self):
        with mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=None,
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNone(card)

    def test_falls_back_to_story_id_when_slug_missing(self):
        with mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = shorts_render._build_question_card(self._row(slug=None))
        self.assertIsNotNone(card)
        self.assertEqual(card["slug"], "story-1")

    def test_skips_when_question_is_empty(self):
        with mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(question=""),
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNone(card)

    def test_skips_when_option_label_is_empty(self):
        with mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(option_b_text=""),
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNone(card)

    def test_returns_none_when_row_has_no_id(self):
        with mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ) as fetch:
            card = shorts_render._build_question_card({"slug": "x"})
        self.assertIsNone(card)
        # Defensive: the resolver should bail BEFORE hitting the DB
        # so a malformed row never wastes a query.
        fetch.assert_not_called()

    def test_returns_none_when_endcard_setting_disabled(self):
        # Master switch: polls.endcard.enabled = "0" → no card, period.
        # Even with a valid enabled poll on the row.
        with mock.patch.object(
            shorts_render.store,
            "get_setting",
            side_effect=lambda k: "0" if k == "polls.endcard.enabled" else None,
        ), mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ) as fetch:
            card = shorts_render._build_question_card(self._row())
        self.assertIsNone(card)
        # Bonus assertion: when the master switch is off, the poll
        # fetch is skipped entirely (no point reading the row just
        # to throw it away). Catches a perf regression.
        fetch.assert_not_called()

    def test_endcard_master_switch_treats_off_synonyms_as_disabled(self):
        for val in ("0", "false", "False", "FALSE", "off", "OFF", "no"):
            with mock.patch.object(
                shorts_render.store,
                "get_setting",
                side_effect=lambda k, v=val: v if k == "polls.endcard.enabled" else None,
            ), mock.patch.object(
                shorts_render.store,
                "fetch_enabled_poll_for_story",
                return_value=self._poll(),
            ):
                card = shorts_render._build_question_card(self._row())
            self.assertIsNone(card, f"setting value {val!r} should disable the card")

    def test_endcard_master_switch_unset_defaults_to_enabled(self):
        # Most common case: settings table has no row → get_setting
        # returns None → the card IS rendered.
        with mock.patch.object(
            shorts_render.store,
            "get_setting",
            return_value=None,
        ), mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNotNone(card)
        self.assertEqual(card["card_ms"], shorts_render.QUESTION_CARD_MS)

    def test_uses_duration_setting_override(self):
        # Custom in-range duration honored verbatim.
        def fake(k):
            if k == "polls.endcard.duration_ms":
                return "4000"
            return None
        with mock.patch.object(
            shorts_render.store, "get_setting", side_effect=fake,
        ), mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNotNone(card)
        self.assertEqual(card["card_ms"], 4000)

    def test_duration_above_ceiling_falls_back_to_default(self):
        # 20000ms is out of the 500-10000ms window → default applies.
        def fake(k):
            if k == "polls.endcard.duration_ms":
                return "20000"
            return None
        with mock.patch.object(
            shorts_render.store, "get_setting", side_effect=fake,
        ), mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNotNone(card)
        self.assertEqual(card["card_ms"], shorts_render.QUESTION_CARD_MS)

    def test_duration_below_floor_falls_back_to_default(self):
        def fake(k):
            if k == "polls.endcard.duration_ms":
                return "100"  # sub-floor
            return None
        with mock.patch.object(
            shorts_render.store, "get_setting", side_effect=fake,
        ), mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNotNone(card)
        self.assertEqual(card["card_ms"], shorts_render.QUESTION_CARD_MS)

    def test_garbage_duration_value_falls_back_to_default(self):
        # Non-numeric junk in the setting → default applies, no exception.
        def fake(k):
            if k == "polls.endcard.duration_ms":
                return "abc"
            return None
        with mock.patch.object(
            shorts_render.store, "get_setting", side_effect=fake,
        ), mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNotNone(card)
        self.assertEqual(card["card_ms"], shorts_render.QUESTION_CARD_MS)


class BuildShortPropsQuestionCardTests(unittest.TestCase):
    """End-to-end: when a story has an enabled poll, build_short_props
    surfaces a `question_card` field AND extends `duration_ms` by
    QUESTION_CARD_MS so the renderer has tail to draw into. When no
    poll exists the props match the pre-Phase-3 shape byte-for-byte."""

    def _assets(self) -> shorts.ShortAssets:
        return shorts.ShortAssets(
            narration_style="suspense",
            length_preset="standard",
            script={"short_script": "Hello there. This is a short test script."},
            character="a tall man with a red scarf",
            base_url="https://kie/base.png",
            base_prompt="BASE PROMPT",
            scenes=[
                {"caption_chunk_start_index": 0, "scene": "s0", "url": "https://kie/s0.png", "image_prompt": "p0"},
                {"caption_chunk_start_index": 2, "scene": "s1", "url": "https://kie/s1.png", "image_prompt": "p1"},
            ],
            cost_credits=0.0,
        )

    def _words(self) -> list[dict]:
        return [
            {"word": "Hello", "start": 0.0, "end": 0.4},
            {"word": "there.", "start": 0.4, "end": 0.9},
            {"word": "This", "start": 1.0, "end": 1.3},
            {"word": "is", "start": 1.3, "end": 1.5},
            {"word": "a", "start": 1.5, "end": 1.6},
            {"word": "short.", "start": 1.6, "end": 2.1},
        ]

    def _build(self, poll: dict | None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        with mock.patch.object(shorts_render.store, "fetch_story",
                               return_value={"id": "story-poll", "slug": "test-slug",
                                             "title": "T", "body": "Body text here."}), \
            mock.patch.object(shorts_render.shorts, "generate_short_assets",
                              return_value=self._assets()), \
            mock.patch.object(shorts_render.voice, "synthesize",
                              return_value={"words": self._words()}), \
            mock.patch.object(shorts_render.images, "download", return_value=None), \
            mock.patch.object(shorts_render.store, "get_setting", return_value=None), \
            mock.patch.object(shorts_render.store, "fetch_enabled_poll_for_story",
                              return_value=poll):
            return shorts_render.build_short_props("story-poll", Path(tmp.name), remote=False)

    def test_poll_present_appends_question_card_and_extends_duration(self):
        built = self._build({
            "id": "poll-1",
            "story_id": "story-poll",
            "question": "Who's wrong?",
            "option_a_text": "Wife",
            "option_b_text": "Husband",
            "enabled": 1,
            "category": "Drama",
        })
        self.assertIsNotNone(built)
        props = built.props
        self.assertIn("question_card", props)
        self.assertEqual(props["question_card"]["question"], "Who's wrong?")
        self.assertEqual(props["question_card"]["option_a"], "Wife")
        self.assertEqual(props["question_card"]["option_b"], "Husband")
        self.assertEqual(props["question_card"]["slug"], "test-slug")
        self.assertEqual(props["question_card"]["card_ms"], shorts_render.QUESTION_CARD_MS)
        # Narration ends at ~2100ms (last word "short." end); duration_ms
        # rounds to >= 2100. With the card appended it must be at least
        # narration_end + QUESTION_CARD_MS.
        self.assertGreaterEqual(
            props["duration_ms"],
            2100 + shorts_render.QUESTION_CARD_MS,
        )

    def test_no_poll_omits_question_card_and_keeps_duration(self):
        built = self._build(None)
        self.assertIsNotNone(built)
        props = built.props
        self.assertNotIn("question_card", props)
        # Narration-only duration. Tight upper bound — should not exceed
        # narration end by more than a few ms of caption padding.
        self.assertLess(props["duration_ms"], 3000)


class DoodleSuffixIdentityGuardTests(unittest.TestCase):
    """Regression guard: the shared doodle style suffix is appended to the base
    AND every scene prompt, so any character-identity token in it forces the
    SAME person into every short. The suffix must describe the ART STYLE only;
    identity comes from the per-story planner character description."""

    def test_no_hardcoded_character_identity_tokens(self):
        suffix = sis.DOODLE_SUFFIX.lower()
        for token in ("round glasses", "lab coats", "ties in blue", "beards / hair"):
            self.assertNotIn(
                token, suffix,
                msg=f"DOODLE_SUFFIX must not hard-code character identity: {token!r}",
            )


if __name__ == "__main__":
    unittest.main()
