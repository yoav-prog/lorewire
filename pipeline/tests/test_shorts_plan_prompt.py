"""Tests for `pipeline.shorts.build_plan_prompt`.

What we lock down: the protagonist-identity hardening introduced after
admins noticed the short's main character sometimes flipped gender
relative to the original Reddit OP. The character planner used to see
only the condensed short script, which the LLM rewriter can rewrite
gender-neutrally. We now pass the full source article through and
explicitly instruct the planner to mirror the protagonist's gender +
age band — locking the chain so the hero / poster (which uses the
short's base as an i2i seed) inherits the same person.

The LLM call itself isn't tested. What's exercised here is the prompt
string the LLM receives: source body included verbatim when supplied,
gender-extraction instructions present, back-compat preserved when
`source_body` is omitted.
"""
from __future__ import annotations

import unittest

from pipeline import shorts


class BuildPlanPromptTests(unittest.TestCase):
    SCRIPT = "OP collected money, the envelope vanished, they sent invoices."
    HOOK = "About \\$800 in cash. Gone over a long weekend."
    PAYOFF = "Half the floor stopped speaking."
    CAPTIONS = ["So about that office gift fund", "By Friday it was fat"]

    # Marker only the user-block source dump uses, NOT the system-block
    # "consult the source article" instruction. Lets the tests distinguish
    # "source body was embedded" from "the system block mentions the source
    # as a concept".
    SOURCE_DUMP_MARKER = "SOURCE ARTICLE (ground truth for the protagonist's identity)"

    def test_source_body_is_embedded_when_supplied(self):
        # The protagonist's gender flair lives in the source body
        # ("42M", "I (29F)", "as a single dad") — the planner can only
        # honor it if the body is in the prompt.
        source = (
            "I (42M) volunteered to collect cash for our boss's retirement gift. "
            "The envelope had about 800 dollars by Friday. Over a long weekend "
            "it vanished from my drawer."
        )
        prompt = shorts.build_plan_prompt(
            self.SCRIPT, self.HOOK, self.PAYOFF, self.CAPTIONS, max_scenes=3,
            source_body=source,
        )
        self.assertIn(self.SOURCE_DUMP_MARKER, prompt)
        self.assertIn("42M", prompt)
        self.assertIn("vanished from my drawer", prompt)

    def test_no_source_body_omits_the_source_block_for_back_compat(self):
        # Legacy callers (or call sites that genuinely have nothing) get
        # the prompt without the source dump, so a partial integration
        # doesn't silently inject an empty source block.
        prompt = shorts.build_plan_prompt(
            self.SCRIPT, self.HOOK, self.PAYOFF, self.CAPTIONS, max_scenes=3,
        )
        self.assertNotIn(self.SOURCE_DUMP_MARKER, prompt)
        # Script + hook + payoff still appear so the planner has a
        # usable spec without the source.
        self.assertIn(self.HOOK, prompt)
        self.assertIn(self.PAYOFF, prompt)
        self.assertIn(self.SCRIPT, prompt)

    def test_prompt_requires_protagonist_identity_to_match_source(self):
        # The strongest guarantee against the LLM inventing a different
        # gender is the explicit instruction. If this string moves, the
        # planner regresses to "model picks whatever feels right".
        prompt = shorts.build_plan_prompt(
            self.SCRIPT, self.HOOK, self.PAYOFF, self.CAPTIONS, max_scenes=3,
            source_body="I (42M) ...",
        )
        self.assertIn("PROTAGONIST IDENTITY IS NON-NEGOTIABLE", prompt)
        # Lists the explicit markers the LLM should look for so a missed
        # pronoun doesn't fall through to "guess".
        for marker in ("he/him", "she/her", "they/them", "42M", "17F"):
            self.assertIn(marker, prompt)
        self.assertIn("Never invent a different gender", prompt)

    def test_first_scene_pinning_survives_alongside_identity_lock(self):
        # The earlier base-image-opener removal pinned scene[0] to
        # caption_chunk_start_index=0. That instruction has to coexist
        # with the new identity-lock block — easy to drop in a rewrite.
        prompt = shorts.build_plan_prompt(
            self.SCRIPT, self.HOOK, self.PAYOFF, self.CAPTIONS, max_scenes=3,
            source_body="...",
        )
        self.assertIn("FIRST SCENE MUST set caption_chunk_start_index=0", prompt)

    def test_whitespace_only_source_treated_as_empty(self):
        prompt = shorts.build_plan_prompt(
            self.SCRIPT, self.HOOK, self.PAYOFF, self.CAPTIONS, max_scenes=3,
            source_body="   \n\n   ",
        )
        # Whitespace-only body shouldn't inject a dead source dump that
        # the LLM then tries to honor with nothing to honor.
        self.assertNotIn(self.SOURCE_DUMP_MARKER, prompt)


if __name__ == "__main__":
    unittest.main()
