"""Tests for pipeline.text_normalize — script -> spoken-form pre-pass.

Pure-logic only. Covers Phase 2 of
_plans/2026-06-18-caption-accuracy-and-naturalness.md: the script is
expanded into spoken form before TTS so the voice and the captions
share the same surface tokens (so the karaoke highlight always lands
on the word the ear actually hears).
"""
from __future__ import annotations

import unittest

from pipeline import text_normalize


class CurrencyTests(unittest.TestCase):
    def test_whole_dollar_amount(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("It cost $5."),
            "It cost five dollars.",
        )

    def test_thousand_separator(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("$1,000 was on the table."),
            "one thousand dollars was on the table.",
        )

    def test_million_dollar_amount(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("She won $1,000,000."),
            "She won one million dollars.",
        )

    def test_dollar_with_cents_uses_currency_form(self):
        out = text_normalize.normalize_for_tts("The fee is $1.50.")
        self.assertIn("one dollar and fifty cents", out)

    def test_currency_with_M_suffix(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("The deal closed at $5M."),
            "The deal closed at five million dollars.",
        )

    def test_currency_with_decimal_and_B_suffix(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("$1.5B was raised."),
            "one point five billion dollars was raised.",
        )

    def test_currency_with_K_suffix(self):
        # num2words uses the British "and" form for hundreds, so the
        # expected reading is "two hundred AND fifty thousand". Stylistic
        # not stylistic — the voice reads it the same way and the karaoke
        # highlight still lands on every spoken word.
        self.assertEqual(
            text_normalize.normalize_for_tts("The grant was $250K."),
            "The grant was two hundred and fifty thousand dollars.",
        )


class PercentTests(unittest.TestCase):
    def test_whole_percent(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("Up by 50%."),
            "Up by fifty percent.",
        )

    def test_decimal_percent(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("12.5% growth."),
            "twelve point five percent growth.",
        )


class TimeTests(unittest.TestCase):
    def test_time_with_pm(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("Meet at 6:30PM."),
            "Meet at six thirty PM.",
        )

    def test_time_without_period(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("It happened at 14:45."),
            "It happened at fourteen forty-five.",
        )

    def test_time_with_oh_minute(self):
        # 6:05 reads as "six oh five", not "six five".
        self.assertEqual(
            text_normalize.normalize_for_tts("At 6:05 AM."),
            "At six oh five AM.",
        )

    def test_time_with_zero_minutes_omits_minutes(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("Wake up at 6:00."),
            "Wake up at six.",
        )


class OrdinalTests(unittest.TestCase):
    def test_first(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("On the 1st of June."),
            "On the first of June.",
        )

    def test_twenty_first(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("The 21st century."),
            "The twenty-first century.",
        )

    def test_third(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("Came in 3rd."),
            "Came in third.",
        )


class YearTests(unittest.TestCase):
    def test_year_in_twentieth_century(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("Born in 1985."),
            "Born in nineteen eighty-five.",
        )

    def test_year_in_twenty_first_century(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("In 2026 it shipped."),
            "In twenty twenty-six it shipped.",
        )


class AbbreviationTests(unittest.TestCase):
    def test_doctor_title_expanded_before_capital_name(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("Dr. Smith arrived."),
            "Doctor Smith arrived.",
        )

    def test_mister_title_expanded(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("Mr. Jones laughed."),
            "Mister Jones laughed.",
        )

    def test_mrs_title_expanded(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("Mrs. Lee paid."),
            "Missus Lee paid.",
        )

    def test_doctor_not_expanded_without_capital_name(self):
        # "back to the Dr." is not a title — leave alone (no following name).
        out = text_normalize.normalize_for_tts("Went back to the Dr. yesterday.")
        self.assertIn("Dr.", out)

    def test_eg_expanded(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("e.g. cats."),
            "for example cats.",
        )

    def test_ie_expanded(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("i.e. yesterday."),
            "that is yesterday.",
        )

    def test_vs_expanded(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("Cats vs. dogs."),
            "Cats versus dogs.",
        )

    def test_etcetera_expanded(self):
        # Commas survive — the rule only swaps the trailing "etc." token,
        # the period is consumed by the abbreviation, and the rest of the
        # sentence is left exactly as written.
        self.assertEqual(
            text_normalize.normalize_for_tts("Cats, dogs, etc."),
            "Cats, dogs, etcetera",
        )


class CardinalTests(unittest.TestCase):
    def test_small_number(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("She brought 5 cookies."),
            "She brought five cookies.",
        )

    def test_large_number_drops_commas_from_spoken_form(self):
        # num2words returns "one thousand, two hundred and thirty-four"
        # with internal commas; we strip them so the chunker does not
        # treat them as phrase breaks.
        out = text_normalize.normalize_for_tts("There were 1234 apples.")
        self.assertNotIn(",", out)
        self.assertIn("one thousand", out)

    def test_decimal_uses_point_form(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("Pi is roughly 3.14."),
            "Pi is roughly three point one four.",
        )

    def test_digit_inside_word_is_not_expanded(self):
        # "GPT-4" should stay as-is — we don't touch alphanumeric tokens.
        self.assertEqual(
            text_normalize.normalize_for_tts("Tested on GPT-4 today."),
            "Tested on GPT-4 today.",
        )


class AmpersandTests(unittest.TestCase):
    def test_space_amp_space_becomes_and(self):
        self.assertEqual(
            text_normalize.normalize_for_tts("Cats & dogs."),
            "Cats and dogs.",
        )

    def test_ampersand_inside_token_is_not_expanded(self):
        # "R&D" should not become "R and D" — keep it conservative.
        self.assertEqual(
            text_normalize.normalize_for_tts("Working in R&D."),
            "Working in R&D.",
        )


class NoopTests(unittest.TestCase):
    def test_empty_returns_empty(self):
        self.assertEqual(text_normalize.normalize_for_tts(""), "")

    def test_plain_prose_is_unchanged(self):
        text = "The red barn stood at the edge of the field."
        self.assertEqual(text_normalize.normalize_for_tts(text), text)


class CombinationTests(unittest.TestCase):
    def test_real_world_news_sentence(self):
        # All the rules fire on one sentence.
        text = "On the 1st of June 2026, Dr. Smith spent $1.5M, up 50%."
        out = text_normalize.normalize_for_tts(text)
        for fragment in (
            "first of June",
            "twenty twenty-six",
            "Doctor Smith",
            "one point five million dollars",
            "fifty percent",
        ):
            self.assertIn(fragment, out)
        # No raw digits or `$` or `%` survive in the spoken form.
        self.assertNotIn("$", out)
        self.assertNotIn("%", out)
        self.assertFalse(any(ch.isdigit() for ch in out))

    def test_homophone_class_bug_stays_fixed_with_normalization(self):
        # End-to-end intent: a sentence containing both a homophone-prone
        # word and a number should produce caption-safe spoken form, and
        # the script-graft (Phase 1) would carry these tokens through
        # unchanged on the Google path.
        text = "The Red barn cost $50."
        out = text_normalize.normalize_for_tts(text)
        self.assertIn("Red", out)
        self.assertIn("fifty dollars", out)


if __name__ == "__main__":
    unittest.main()
