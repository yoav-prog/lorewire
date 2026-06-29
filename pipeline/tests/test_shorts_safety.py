"""Tests for pipeline.shorts_safety — layer 2 of the brand-safety defense.

The system prompt is layer 1; this validator is the backstop that catches
bypass cases. We lock down: every locked decision from
_plans/2026-06-21-shorts-hook-first-restructure.md §4 + D5 is enforced,
the validator accumulates every error (does not short-circuit), and
back-compat fields are checked so a downstream consumer never reads a
malformed payload.
"""
from __future__ import annotations

import unittest

from pipeline import shorts_narration as sn
from pipeline import shorts_safety as ss


def _good_payload(**overrides) -> dict:
    """Baseline valid hook-first payload. Tests override specific fields to
    exercise each rule independently — keeping a single known-good fixture
    documents what shape downstream code expects."""
    base = {
        "title": "The Daily Six Dollar Ask",
        "hook": "She read the message and froze.",  # 6 words
        "rewind": "This started six days earlier.",
        "build": (
            "Every morning her cousin asked for six dollars. "
            "It seemed small. It was never small. The amount stayed the same. "
            "The story changed each time. She kept saying yes."
        ),
        "return": "She read the message and finally said no.",  # 8+ words, within range
        "cta": "Whose side are you on?",
        "short_script": (
            "She read the message and froze. This started six days earlier. "
            "Every morning her cousin asked for six dollars. It seemed small. "
            "It was never small. The amount stayed the same. The story changed each "
            "time. She kept saying yes. She read the message and finally said no. "
            "Whose side are you on?"
        ),
        "cold_open_visual_brief": "Close-up: a woman at a kitchen table reading her phone.",
        "payoff": "She read the message and finally said no. Whose side are you on?",
        "word_count": 60,
        "tone_knob": "tense",
        "poll": {
            "question": "Who's wrong for the daily six dollar ask?",
            "option_a": "Poster",
            "option_b": "Cousin",
        },
    }
    base.update(overrides)
    return base


class HappyPathTests(unittest.TestCase):
    def test_known_good_payload_validates(self) -> None:
        result = ss.validate_script(_good_payload(), target_seconds=50)
        self.assertTrue(result.ok, msg=f"validation errors: {result.errors}")
        self.assertEqual(result.errors, [])
        # details surface counts for observability (logged by the orchestrator).
        self.assertIn("hook_words", result.details)
        self.assertIn("script_words", result.details)


class RequiredFieldTests(unittest.TestCase):
    def test_missing_field_listed(self) -> None:
        payload = _good_payload()
        payload.pop("cta")
        result = ss.validate_script(payload, target_seconds=50)
        self.assertFalse(result.ok)
        self.assertTrue(
            any("'cta'" in e and "missing" in e for e in result.errors),
            msg=result.errors,
        )

    def test_empty_string_treated_as_missing(self) -> None:
        result = ss.validate_script(_good_payload(rewind="   "), target_seconds=50)
        self.assertFalse(result.ok)
        self.assertTrue(any("rewind" in e for e in result.errors))

    def test_non_dict_payload_fails_fast(self) -> None:
        result = ss.validate_script("not a dict", target_seconds=50)
        self.assertFalse(result.ok)
        self.assertIn("payload is not a JSON object", result.errors)

    def test_word_count_must_be_int(self) -> None:
        result = ss.validate_script(_good_payload(word_count="60"), target_seconds=50)
        self.assertFalse(result.ok)
        self.assertTrue(any("word_count" in e for e in result.errors))


class CapsAndProfanityTests(unittest.TestCase):
    def test_all_caps_shock_word_rejected(self) -> None:
        # Bypassing the all-caps ban is the #1 way the rejected-clickbait
        # vibe sneaks back in. Three-letter+ run trips the rule.
        payload = _good_payload(hook="SHE FROZE at the message.")  # 5 words, two caps runs
        result = ss.validate_script(payload, target_seconds=50)
        self.assertFalse(result.ok)
        self.assertTrue(any("all-caps" in e for e in result.errors))

    def test_short_acronyms_allowed(self) -> None:
        # Two-letter caps like OK, AI, FBI's 3-letter cousins do trip the
        # rule by design — the cleanest line is "≥3 caps = reject". This
        # test documents that AI / OK / 5G are fine.
        payload = _good_payload(
            hook="She got an OK from AI.",  # 6 words, no 3+ caps runs
        )
        result = ss.validate_script(payload, target_seconds=50)
        self.assertTrue(result.ok, msg=result.errors)

    def test_profanity_in_vo_rejected(self) -> None:
        payload = _good_payload(build="What the hell is this shit?" + " " * 1 +
                                _good_payload()["build"])
        result = ss.validate_script(payload, target_seconds=50)
        self.assertFalse(result.ok)
        self.assertTrue(any("profanity" in e for e in result.errors))

    def test_profanity_substring_safe(self) -> None:
        # "class" must not trip on "ass". Word-boundary lookup is the load-
        # bearing detail.
        payload = _good_payload(build="A classroom of kids. " + _good_payload()["build"])
        result = ss.validate_script(payload, target_seconds=50)
        self.assertTrue(result.ok, msg=result.errors)


class LengthCapTests(unittest.TestCase):
    def test_hook_over_hard_cap_rejected(self) -> None:
        # Decision D5: hard cap at COLD_OPEN_MAX_WORDS. Going over is one of
        # the validator's most important roles — the model occasionally
        # ignores the prompt and writes a 12-word hook.
        nine_word_hook = " ".join(["word"] * (sn.COLD_OPEN_MAX_WORDS + 1))
        result = ss.validate_script(_good_payload(hook=nine_word_hook), target_seconds=50)
        self.assertFalse(result.ok)
        self.assertTrue(any("'hook'" in e for e in result.errors))

    def test_hook_under_floor_rejected(self) -> None:
        result = ss.validate_script(_good_payload(hook="Hi."), target_seconds=50)
        self.assertFalse(result.ok)
        self.assertTrue(any("'hook'" in e for e in result.errors))

    def test_script_total_over_overrun_cap_rejected(self) -> None:
        # A script that fits structure but blows the +20% overrun cap will
        # render past the duration budget — caption timing breaks downstream.
        target = 50
        max_words = round(target * sn.WORDS_PER_SECOND * (1 + sn.LENGTH_OVERRUN_FRACTION)) + 5
        bloat = " ".join(["filler"] * max_words)
        result = ss.validate_script(_good_payload(short_script=bloat), target_seconds=target)
        self.assertFalse(result.ok)
        self.assertTrue(any("short_script" in e for e in result.errors))


class PollTests(unittest.TestCase):
    def test_poll_question_must_end_in_question_mark(self) -> None:
        payload = _good_payload(poll={
            "question": "Who is wrong for this daily ask",
            "option_a": "Poster", "option_b": "Cousin",
        })
        result = ss.validate_script(payload, target_seconds=50)
        self.assertFalse(result.ok)
        self.assertTrue(any("question" in e and "?" in e for e in result.errors))

    def test_poll_options_over_char_cap_rejected(self) -> None:
        too_long = "x" * (sn.POLL_OPTION_MAX_CHARS + 1)
        payload = _good_payload(poll={
            "question": "Who's right?", "option_a": too_long, "option_b": "Cousin",
        })
        result = ss.validate_script(payload, target_seconds=50)
        self.assertFalse(result.ok)
        self.assertTrue(any("option_a" in e for e in result.errors))

    def test_poll_options_leaking_verdict_rejected(self) -> None:
        # Plan §4 ban: options must not pre-answer the question. "Wrong"
        # in an option label is the most common slip.
        payload = _good_payload(poll={
            "question": "Who's right?",
            "option_a": "The wrong one",
            "option_b": "Cousin",
        })
        result = ss.validate_script(payload, target_seconds=50)
        self.assertFalse(result.ok)
        self.assertTrue(any("verdict" in e.lower() for e in result.errors))

    def test_poll_question_over_char_cap_rejected(self) -> None:
        too_long = ("x " * (sn.POLL_QUESTION_MAX_CHARS // 2 + 5)) + "?"
        payload = _good_payload(poll={
            "question": too_long, "option_a": "A", "option_b": "B",
        })
        result = ss.validate_script(payload, target_seconds=50)
        self.assertFalse(result.ok)
        self.assertTrue(any("question" in e and "chars" in e for e in result.errors))

    def test_poll_missing_field_rejected(self) -> None:
        payload = _good_payload(poll={"question": "Who?", "option_a": "A"})
        result = ss.validate_script(payload, target_seconds=50)
        self.assertFalse(result.ok)
        self.assertTrue(any("option_b" in e for e in result.errors))

    def test_poll_not_object_rejected(self) -> None:
        result = ss.validate_script(_good_payload(poll="not an object"), target_seconds=50)
        self.assertFalse(result.ok)
        self.assertTrue(any("poll" in e for e in result.errors))


class ToneKnobTests(unittest.TestCase):
    def test_unknown_tone_knob_rejected(self) -> None:
        result = ss.validate_script(_good_payload(tone_knob="hyped"), target_seconds=50)
        self.assertFalse(result.ok)
        self.assertTrue(any("tone_knob" in e for e in result.errors))

    def test_each_known_tone_knob_accepted(self) -> None:
        for knob in sn.TONE_KNOBS:
            result = ss.validate_script(_good_payload(tone_knob=knob), target_seconds=50)
            self.assertTrue(result.ok, msg=f"{knob!r}: {result.errors}")


class AccumulationTests(unittest.TestCase):
    def test_multiple_errors_all_reported(self) -> None:
        # Validator must not short-circuit on the first error; the LLM retry
        # prompt needs the full list so it can fix everything in one round.
        payload = _good_payload(
            hook="SHE FROZE.",  # caps + too few words
            tone_knob="hyped",
            poll={"question": "Who", "option_a": "A", "option_b": "B"},  # no ?
        )
        result = ss.validate_script(payload, target_seconds=50)
        self.assertFalse(result.ok)
        self.assertGreaterEqual(len(result.errors), 3)


if __name__ == "__main__":
    unittest.main()
