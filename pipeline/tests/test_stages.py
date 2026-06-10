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

    def test_returns_short_list_when_model_underdelivers(self):
        # Three items but caller asked for four: surface what the model returned
        # rather than padding silently. The image stage tolerates short lists.
        raw = '["a", "b", "c"]'
        out = stages._parse_prompt_list(raw, 4, HEADLINE, STYLE)
        self.assertEqual(out, ["a", "b", "c"])

    def test_falls_back_on_garbage(self):
        out = stages._parse_prompt_list("sorry I can't do that", 3, HEADLINE, STYLE)
        self.assertEqual(len(out), 3)
        self.assertIn(HEADLINE, out[0])
        self.assertTrue(all(STYLE in p for p in out))

    def test_falls_back_on_malformed_json(self):
        out = stages._parse_prompt_list('["a", "b"', 4, HEADLINE, STYLE)
        self.assertEqual(len(out), 4)

    def test_drops_empty_strings(self):
        raw = '["hero shot", "", "scene"]'
        out = stages._parse_prompt_list(raw, 3, HEADLINE, STYLE)
        self.assertEqual(out, ["hero shot", "scene"])


if __name__ == "__main__":
    unittest.main()
