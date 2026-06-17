"""Tests for the shorts planner prompt builder.

What we lock down: the planner prompt MUST ground the character in the source
article and MUST instruct the LLM not to fall back to the trained default
archetype (East Asian woman, chin-length dark hair with gray streak, round
glasses, teal button-up, white apron). That default produced near-identical
characters across totally different stories — bug report 2026-06-18.
"""
from __future__ import annotations

import unittest

from pipeline import shorts


class BuildPlanPromptTests(unittest.TestCase):
    def _prompt(self, source: str = "") -> str:
        return shorts.build_plan_prompt(
            script="A short narration script.",
            hook="The hook.",
            payoff="The payoff.",
            captions=["chunk one", "chunk two", "chunk three"],
            max_scenes=3,
            source=source,
        )

    def test_includes_source_when_provided(self) -> None:
        source = "I'm a 47-year-old plumber from Ohio and one day my apprentice..."
        prompt = self._prompt(source=source)
        self.assertIn(source, prompt)
        self.assertIn("mine this for the protagonist", prompt)

    def test_omits_empty_source_block(self) -> None:
        # The injected source block is detectable by its "mine this for the
        # protagonist's real demographics" marker. The system prompt itself
        # mentions "SOURCE ARTICLE" so we can't assert on that token.
        prompt = self._prompt(source="   ")
        self.assertNotIn("mine this for the protagonist", prompt)

    def test_demands_demographic_grounding(self) -> None:
        prompt = self._prompt(source="anything")
        # The anti-default rule lives or dies on these tokens — if a future edit
        # softens them, the LLM goes back to its trained archetype.
        for token in ("age", "gender", "ethnicity", "ANTI-DEFAULT"):
            self.assertIn(token, prompt, f"planner prompt must reference {token!r}")

    def test_calls_out_the_specific_default_to_avoid(self) -> None:
        prompt = self._prompt(source="anything")
        # The model only stops defaulting when you name the default. Loose
        # diversity phrasing alone wasn't enough.
        for token in (
            "chin-length",
            "gray",
            "round",
            "glasses",
            "teal",
        ):
            self.assertIn(token, prompt, f"anti-default must name {token!r}")

    def test_glasses_are_optional(self) -> None:
        prompt = self._prompt(source="anything")
        self.assertIn("OPTIONAL", prompt)

    def test_scene_count_capped_by_captions(self) -> None:
        prompt = shorts.build_plan_prompt(
            script="x", hook="", payoff="", captions=["only one"], max_scenes=12, source=""
        )
        self.assertIn("SCENE FRAMES (1 frames)", prompt)


if __name__ == "__main__":
    unittest.main()
