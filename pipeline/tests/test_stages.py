"""Tests for pipeline.stages: prompt-list parsing.

The LLM call itself is not tested (it would just be testing the network). What
we guard here is the parser that turns the model's response into a usable list:
clean JSON arrays, fenced code blocks, junk responses with a safe fallback.
"""
from __future__ import annotations

import unittest

from pipeline import stages


HEADLINE = "AITA for invoicing my coworkers?"
STYLE = "doodle, off-white paper"


class ParsePromptListTests(unittest.TestCase):
    def test_clean_json_array(self):
        raw = '["hero shot", "scene one", "scene two", "scene three"]'
        out = stages._parse_prompt_list(raw, 4, HEADLINE, STYLE)
        self.assertEqual(out, ["hero shot", "scene one", "scene two", "scene three"])

    def test_strips_leading_prose(self):
        raw = 'Here you go!\n\n["hero shot", "scene one"]'
        out = stages._parse_prompt_list(raw, 2, HEADLINE, STYLE)
        self.assertEqual(out, ["hero shot", "scene one"])

    def test_fenced_code_block(self):
        raw = '```json\n["a", "b", "c"]\n```'
        out = stages._parse_prompt_list(raw, 3, HEADLINE, STYLE)
        self.assertEqual(out, ["a", "b", "c"])

    def test_truncates_to_n(self):
        raw = '["a", "b", "c", "d", "e"]'
        out = stages._parse_prompt_list(raw, 3, HEADLINE, STYLE)
        self.assertEqual(out, ["a", "b", "c"])

    def test_pads_partial_list_with_continuation(self):
        # Three items but caller asked for four: post-2026-06-14 we pad
        # by repeating the last prompt with a "Continuation scene N"
        # suffix so every slot still carries the story-specific imagery.
        # Pre-fix: the parser returned the short list, and per-scene
        # regen used the LAST prompt for every out-of-range index, so
        # all the trailing scenes drew the same picture.
        raw = '["a", "b", "c"]'
        out = stages._parse_prompt_list(raw, 4, HEADLINE, STYLE)
        self.assertEqual(len(out), 4)
        self.assertEqual(out[:3], ["a", "b", "c"])
        self.assertIn("c", out[3])
        self.assertIn("Continuation", out[3])

    def test_falls_back_on_garbage(self):
        out = stages._parse_prompt_list("sorry I can't do that", 3, HEADLINE, STYLE)
        self.assertEqual(len(out), 3)
        self.assertIn(HEADLINE, out[0])
        self.assertTrue(all(STYLE in p for p in out))

    def test_falls_back_on_malformed_json(self):
        out = stages._parse_prompt_list('["a", "b"', 4, HEADLINE, STYLE)
        self.assertEqual(len(out), 4)

    def test_drops_empty_strings_and_pads_to_n(self):
        # Empty strings filtered out; the partial result then pads with a
        # continuation of the last valid prompt so every slot is non-empty.
        raw = '["hero shot", "", "scene"]'
        out = stages._parse_prompt_list(raw, 3, HEADLINE, STYLE)
        self.assertEqual(len(out), 3)
        self.assertEqual(out[0], "hero shot")
        self.assertEqual(out[1], "scene")
        self.assertIn("scene", out[2])
        self.assertIn("Continuation", out[2])


class ParseTitleSynopsisTests(unittest.TestCase):
    def test_clean_json(self):
        raw = '{"title": "THE BIG ENVELOPE", "synopsis": "A coworker collects money for a gift and the envelope goes missing."}'
        title, syn = stages._parse_title_synopsis(raw)
        self.assertEqual(title, "THE BIG ENVELOPE")
        self.assertTrue(syn.startswith("A coworker"))

    def test_fenced_code_block(self):
        raw = '```json\n{"title": "X Y Z", "synopsis": "abc"}\n```'
        title, syn = stages._parse_title_synopsis(raw)
        self.assertEqual(title, "X Y Z")
        self.assertEqual(syn, "abc")

    def test_strips_leading_prose(self):
        raw = 'Here you go:\n\n{"title": "T", "synopsis": "S"}'
        title, syn = stages._parse_title_synopsis(raw)
        self.assertEqual(title, "T")
        self.assertEqual(syn, "S")

    def test_falls_back_on_garbage(self):
        title, syn = stages._parse_title_synopsis("sorry can't do that")
        self.assertEqual(title, "")
        self.assertEqual(syn, "")

    def test_falls_back_when_either_missing(self):
        title, syn = stages._parse_title_synopsis('{"title": "X"}')
        self.assertEqual((title, syn), ("", ""))


class StripPromptWrappersTests(unittest.TestCase):
    """Used by make_character_prompt to pull a plain prompt out of whatever
    surface the LLM wraps it in. Locks the contract so a small model that
    drifts back to fenced or quoted output doesn't poison the prompt."""

    def test_plain_text_passes_through(self):
        self.assertEqual(stages._strip_prompt_wrappers("A bust."), "A bust.")

    def test_fenced_with_text_tag(self):
        self.assertEqual(
            stages._strip_prompt_wrappers("```text\nA bust.\n```"), "A bust."
        )

    def test_fenced_without_tag(self):
        self.assertEqual(
            stages._strip_prompt_wrappers("```\nA bust.\n```"), "A bust."
        )

    def test_fenced_inside_prose_extracts_block(self):
        raw = "Here is the prompt:\n```\nA bust.\n```\nLet me know."
        self.assertEqual(stages._strip_prompt_wrappers(raw), "A bust.")

    def test_outer_double_quotes_stripped(self):
        self.assertEqual(stages._strip_prompt_wrappers('"A bust."'), "A bust.")

    def test_outer_single_quotes_stripped(self):
        self.assertEqual(stages._strip_prompt_wrappers("'A bust.'"), "A bust.")

    def test_mismatched_outer_quotes_left_alone(self):
        # Don't be clever about \"A bust.': mixing quote chars probably means
        # the prompt itself contains the leading quote.
        self.assertEqual(
            stages._strip_prompt_wrappers("\"A bust.'"), "\"A bust.'"
        )

    def test_empty_returns_empty(self):
        self.assertEqual(stages._strip_prompt_wrappers(""), "")
        self.assertEqual(stages._strip_prompt_wrappers("   \n  "), "")

    def test_only_fence_markers_returns_empty(self):
        self.assertEqual(stages._strip_prompt_wrappers("```\n\n```"), "")


if __name__ == "__main__":
    unittest.main()
