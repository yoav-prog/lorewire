"""Tests for the cold-open visual brief threading + climax-frame tagging
inside the scene planner.

What we lock down: when build_plan_prompt is called with a non-empty
cold_open_visual_brief, the system prompt instructs the LLM that scene 0
IS the climax frame composed from the brief, scene N is the return,
both carry is_climax_frame=true, and the brief itself appears verbatim
in the prompt (so the planner has the literal text to compose from).

Decisions: D1 (fresh cold-open frame) and D2 (rewind cue stays inside
narration) from _plans/2026-06-21-shorts-hook-first-restructure.md §11.
"""
from __future__ import annotations

import unittest

from pipeline import shorts


class ColdOpenBriefInPlannerPromptTests(unittest.TestCase):
    def _prompt(
        self,
        brief: str = "Close-up: a woman at a kitchen table reading her phone.",
        max_scenes: int = 12,
        captions: list[str] | None = None,
    ) -> str:
        caps = captions if captions is not None else [f"cap {i}" for i in range(12)]
        return shorts.build_plan_prompt(
            script="Hook. Rewind. Build. Return. CTA.",
            hook="She read the message and froze.",
            payoff="She read the message and finally said no. Whose side are you on?",
            captions=caps,
            max_scenes=max_scenes,
            source="A test source story.",
            cold_open_visual_brief=brief,
        )

    def test_brief_appears_verbatim_in_prompt(self) -> None:
        brief = "Close-up: a woman at a kitchen table reading her phone."
        prompt = self._prompt(brief=brief)
        self.assertIn(brief, prompt)

    def test_cold_open_instructions_name_scene_0_and_last(self) -> None:
        prompt = self._prompt(max_scenes=12)
        self.assertIn("Scene 0", prompt)
        # max_scenes=12 with 12 captions => n=12, so last index is 11.
        self.assertIn("Scene 11", prompt)

    def test_is_climax_frame_field_in_scene_schema(self) -> None:
        prompt = self._prompt()
        self.assertIn("is_climax_frame", prompt)

    def test_empty_brief_omits_cold_open_block(self) -> None:
        # Legacy callers / fixtures that don't have a brief must not get
        # cold-open instructions that reference a "" brief — that would
        # confuse the planner. The block is a no-op when brief is empty.
        prompt = shorts.build_plan_prompt(
            script="x", hook="", payoff="",
            captions=["a", "b", "c"], max_scenes=3, source="",
            cold_open_visual_brief="",
        )
        # Scene 0 + Scene N instructions only appear when the brief is
        # present. Absent => no climax tagging block.
        self.assertNotIn("Scene 0", prompt)

    def test_single_scene_omits_cold_open_block(self) -> None:
        # n=1 means cold open and return collapse into the same frame —
        # the block doesn't apply. Without this guard the prompt would
        # reference "Scene 0" and "Scene -1" or similar nonsense.
        prompt = self._prompt(
            brief="A brief.",
            captions=["only one"],
            max_scenes=12,
        )
        self.assertNotIn("Scene 0", prompt)

    def test_existing_anti_default_grounding_preserved(self) -> None:
        # The cold-open additions must NOT have displaced the anti-default
        # character grounding rules from the previous planner work. If
        # they did, every short goes back to the East Asian woman archetype.
        prompt = self._prompt()
        for token in ("ANTI-DEFAULT", "chin-length", "gray", "round", "teal"):
            self.assertIn(token, prompt, f"anti-default token {token!r} dropped")

    def test_world_bible_section_still_present(self) -> None:
        # Same defensive check — the world bible instructions (supporting
        # cast / locations / items) must survive the cold-open additions.
        prompt = self._prompt()
        for token in ("WORLD BIBLE", "supporting_characters", "locations", "items"):
            self.assertIn(token, prompt)


if __name__ == "__main__":
    unittest.main()
