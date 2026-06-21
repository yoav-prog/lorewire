"""Tests for the hook-first narration prompt builder.

What we lock down: the system prompt MUST instruct the LLM to produce the
five-beat hook-first structure (cold open → rewind → build → return → CTA),
the bundled poll, the tone knob, and the cold-open visual brief. Loosening
any of these silently drops the structure and the new shorts read like the
old ones.

See _plans/2026-06-21-shorts-hook-first-restructure.md §3.
"""
from __future__ import annotations

import unittest

from pipeline import shorts_narration as sn


class HookFirstStructureTests(unittest.TestCase):
    def _prompt(self, target_seconds: int = 50, elaborate: bool = False) -> str:
        return sn.build_extraction_prompt(
            sn.DEFAULT_STYLE_ID,
            source="Test source story body.",
            target_seconds=target_seconds,
            elaborate=elaborate,
        )

    def test_names_all_five_beats_in_order(self) -> None:
        prompt = self._prompt()
        beat_markers = ["COLD OPEN", "REWIND CUE", "BUILD", "RETURN TO CLIMAX", "CTA"]
        positions = [prompt.find(m) for m in beat_markers]
        for marker, pos in zip(beat_markers, positions):
            self.assertGreater(pos, -1, f"beat marker {marker!r} missing from prompt")
        self.assertEqual(positions, sorted(positions), "beats must appear in order")

    def test_cold_open_word_cap_surfaced_to_llm(self) -> None:
        prompt = self._prompt()
        self.assertIn(str(sn.COLD_OPEN_MAX_WORDS), prompt)
        self.assertIn(str(sn.COLD_OPEN_MIN_WORDS), prompt)

    def test_brand_safety_block_present(self) -> None:
        prompt = self._prompt()
        for token in (
            "all-caps",
            "moralizing",
            "villain",
            "identity specifics",
            "profanity",
        ):
            self.assertIn(token, prompt, f"brand-safety must reference {token!r}")

    def test_bundled_poll_schema_present(self) -> None:
        prompt = self._prompt()
        self.assertIn("BUNDLED POLL", prompt)
        # The schema lines must show the exact field names the validator
        # checks for — drift here breaks parsing silently.
        for token in ('"poll"', '"question"', '"option_a"', '"option_b"'):
            self.assertIn(token, prompt)

    def test_tone_knob_options_listed(self) -> None:
        prompt = self._prompt()
        for knob in sn.TONE_KNOBS:
            self.assertIn(knob, prompt, f"tone knob {knob!r} must appear in prompt")
        self.assertIn("tone_knob", prompt)

    def test_cold_open_visual_brief_field_present(self) -> None:
        # The scene planner depends on the LLM producing cold_open_visual_brief
        # for scene 0; if the schema drops this, scene 0 falls back to a generic
        # composition and the hook-first structure breaks visually.
        prompt = self._prompt()
        self.assertIn("cold_open_visual_brief", prompt)

    def test_target_words_scale_with_seconds(self) -> None:
        short_prompt = self._prompt(target_seconds=45)
        long_prompt = self._prompt(target_seconds=62)
        short_target = round(45 * sn.WORDS_PER_SECOND)
        long_target = round(62 * sn.WORDS_PER_SECOND)
        self.assertIn(str(short_target), short_prompt)
        self.assertIn(str(long_target), long_prompt)
        self.assertNotEqual(short_target, long_target)

    def test_elaborate_adds_longer_cut_block(self) -> None:
        # The extended preset must tell the writer to develop the BUILD beat,
        # not the cold open / rewind / return / CTA (which keep their budgets).
        regular = self._prompt(elaborate=False)
        elaborate = self._prompt(elaborate=True)
        self.assertNotIn("LONGER CUT", regular)
        self.assertIn("LONGER CUT", elaborate)
        self.assertIn("BUILD beat", elaborate)

    def test_source_block_carries_through(self) -> None:
        prompt = sn.build_extraction_prompt(
            sn.DEFAULT_STYLE_ID,
            source="I'm a 47-year-old plumber from Ohio.",
            target_seconds=45,
        )
        self.assertIn("47-year-old plumber", prompt)

    def test_anti_ai_tells_block_present(self) -> None:
        # If the AI-tells ban drops out, the LLM falls back to its trained
        # tics ("in today's video", em dashes, etc.) and Lorewire shorts
        # immediately start reading like every other faceless shorts channel.
        prompt = self._prompt()
        for tell in ("buckle up", "let's dive in", "game-changer", "realm"):
            self.assertIn(tell, prompt)


class RegistryShapeTests(unittest.TestCase):
    """The picker + worker contract: list_styles() returns at least one row
    with the documented shape, and get_style() resolves unknown ids without
    crashing (auto-fallback for in-flight queue rows from before the rewrite).
    """

    def test_list_styles_returns_hook_first(self) -> None:
        styles = sn.list_styles()
        self.assertEqual(len(styles), 1)
        self.assertEqual(styles[0]["id"], sn.DEFAULT_STYLE_ID)
        self.assertIn("label", styles[0])
        self.assertIn("description", styles[0])

    def test_get_style_falls_back_for_legacy_ids(self) -> None:
        # In-flight queue rows from the pre-rewrite era carry style ids like
        # "suspense" or "punchy" in their config hash. The resolver must hand
        # them the new hook-first style instead of raising.
        for legacy in ("suspense", "punchy", "storyteller", "conversational",
                        "documentary", "", None, "completely-made-up"):
            style = sn.get_style(legacy)
            self.assertEqual(style.id, sn.DEFAULT_STYLE_ID)

    def test_default_style_id_constant_unchanged_by_rename(self) -> None:
        # shorts_auto.py imports this constant and the queue hash depends on
        # its string value. Changing it orphans every in-flight queue row.
        self.assertEqual(sn.DEFAULT_STYLE_ID, "hook-first")


class ToneToVoiceMoodTests(unittest.TestCase):
    """tone_knob → voice-mood routing. The TTS layer reads the mood hint so
    delivery matches the writing. An unknown tone must fall back to the
    default mood (not return an empty string)."""

    def test_known_tones_map_to_distinct_moods(self) -> None:
        moods = {sn.tone_to_voice_mood(t) for t in sn.TONE_KNOBS}
        self.assertEqual(len(moods), len(sn.TONE_KNOBS))

    def test_unknown_tone_falls_back_to_default(self) -> None:
        default_mood = sn.tone_to_voice_mood(sn.DEFAULT_TONE_KNOB)
        for missing in (None, "", "made-up-tone"):
            self.assertEqual(sn.tone_to_voice_mood(missing), default_mood)


if __name__ == "__main__":
    unittest.main()
