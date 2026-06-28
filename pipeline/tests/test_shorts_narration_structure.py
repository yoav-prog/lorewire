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

    def test_cold_open_demands_stranger_stakes(self) -> None:
        # The cold-open rule was tightened on 2026-06-28 after a render
        # produced the weak hook "I sent them an invoice" (no stakes a
        # stranger could feel). If the wording drifts back to a generic
        # "drop the viewer inside the climax", the LLM stops anchoring on
        # loss/discovery/confrontation and weak hooks return.
        prompt = self._prompt()
        for token in ("stranger", "highest-stakes", "WAIT, WHAT"):
            self.assertIn(token, prompt, f"cold-open stakes anchor {token!r} missing")

    def test_cold_open_names_stakes_categories(self) -> None:
        # The rule names the categories the LLM should pick from. Without
        # them the LLM falls back to any "concrete event" and weak hooks
        # leak through again.
        prompt = self._prompt()
        for cat in ("loss", "discovery", "confrontation", "transgression", "rupture"):
            self.assertIn(cat, prompt, f"stakes category {cat!r} missing from cold-open rule")

    def test_cold_open_carries_three_step_weak_to_strong_gradient(self) -> None:
        # On 2026-06-28 the example pair (WEAK / STRONG) was upgraded to a
        # three-step gradient (WEAK / STILL WEAK / STRONG) after a render
        # picked "The envelope was empty Monday morning" — an artifact of
        # the loss, not the loss itself. The "STILL WEAK" tier explicitly
        # flags symptoms as too soft. Dropping any tier collapses the
        # teaching signal.
        prompt = self._prompt()
        for label in ("WEAK", "STILL WEAK", "STRONG"):
            self.assertIn(label, prompt, f"gradient label {label!r} missing")
        # Each tier must carry its own example so the LLM sees the contrast.
        self.assertIn("She emailed invoices to the floor", prompt)
        self.assertIn("The envelope was empty Monday morning", prompt)
        self.assertIn("Eight hundred dollars in cash. Gone.", prompt)

    def test_cold_open_demands_naming_loss_directly(self) -> None:
        # The principle behind the gradient: hook names the THING DIRECTLY,
        # not the artifact / symptom. "Empty envelope" is what you see;
        # "missing money" is what you feel. The hook must go for the felt
        # thing — no decoding required.
        prompt = self._prompt()
        self.assertIn("NAME THE THING DIRECTLY", prompt)
        self.assertIn("artifact", prompt)
        self.assertIn("symptom", prompt.lower())
        self.assertIn("felt thing", prompt)
        self.assertIn("no decoding required", prompt)

    def test_anti_ai_tells_block_present(self) -> None:
        # If the AI-tells ban drops out, the LLM falls back to its trained
        # tics ("in today's video", em dashes, etc.) and Lorewire shorts
        # immediately start reading like every other faceless shorts channel.
        prompt = self._prompt()
        for tell in ("buckle up", "let's dive in", "game-changer", "realm"):
            self.assertIn(tell, prompt)


class POVBlockTests(unittest.TestCase):
    """The third-person narrator rule. Added 2026-06-28 after a render's
    narrator spoke as 'I' (mirroring the first-person Reddit source). The
    block teaches the LLM to translate first-person source material into
    a third-person storyteller voice, with a 'they' / role-noun fallback
    when gender isn't established.
    """

    def _prompt(self) -> str:
        return sn.build_extraction_prompt(
            sn.DEFAULT_STYLE_ID,
            source="Test source story body.",
            target_seconds=50,
        )

    def test_pov_block_header_present(self) -> None:
        self.assertIn("POV", self._prompt())

    def test_pov_demands_third_person_narrator(self) -> None:
        prompt = self._prompt()
        self.assertIn("third-person storyteller", prompt)
        self.assertIn("NEVER the protagonist", prompt)
        self.assertIn("no first-person 'I'", prompt)

    def test_pov_handles_first_person_source_explicitly(self) -> None:
        # The Reddit posts the pipeline ingests are mostly first-person.
        # Without an explicit "translate I/me/my into third person" line
        # the LLM mirrors the source POV and the narrator ends up speaking
        # AS the OP, not ABOUT them.
        prompt = self._prompt()
        self.assertIn("translates every 'I/me/my' into third person", prompt)

    def test_pov_unknown_gender_falls_back_to_they_or_role(self) -> None:
        # Most AITA posts don't establish the OP's gender. Without an
        # explicit fallback the LLM guesses one (usually wrong) and the
        # narration suddenly genders someone the source never did.
        prompt = self._prompt()
        self.assertIn("default to 'they' or a role-noun", prompt)
        self.assertIn("NEVER guess a gender", prompt)

    def test_pov_block_sits_between_structure_and_clarity(self) -> None:
        # Order matters: STRUCTURE -> POV -> CLARITY -> BRAND SAFETY.
        # POV is a foundational voice rule that shapes every beat, so it
        # reads before the script-wide clarity bar but after the five-beat
        # structure (which doesn't speak about voice).
        prompt = self._prompt()
        i_structure = prompt.find("STRUCTURE")
        i_pov = prompt.find("POV")
        i_clarity = prompt.find("CLARITY")
        self.assertGreater(i_structure, -1)
        self.assertGreater(i_pov, -1)
        self.assertGreater(i_clarity, -1)
        self.assertLess(i_structure, i_pov)
        self.assertLess(i_pov, i_clarity)


class ClarityBlockTests(unittest.TestCase):
    """The clarity bar layered on top of the five-beat structure.
    See _plans/2026-06-28-content-clarity-bar.md.

    What we lock down: the prompt names the CLARITY block, the four anchor
    concepts that make it operable (retell-by-end, concrete event, curiosity
    question, sharp specifics from the source), and the block sits BETWEEN
    structure and brand-safety so the LLM reads it as a script-wide bar on
    top of the hook-first shape — not a replacement for it.
    """

    def _prompt(self) -> str:
        return sn.build_extraction_prompt(
            sn.DEFAULT_STYLE_ID,
            source="Test source story body.",
            target_seconds=50,
        )

    def test_clarity_block_header_present(self) -> None:
        prompt = self._prompt()
        self.assertIn("CLARITY", prompt)

    def test_clarity_does_not_override_hook_first_cold_open(self) -> None:
        # The new bar must explicitly preserve the climax-first opening so
        # the LLM can't read it as "lead with context." If this assertion
        # breaks, the manager-feedback wording lost the carve-out and the
        # cold open will start drifting into setup.
        prompt = self._prompt()
        self.assertIn("COLD OPEN still opens on the climax", prompt)

    def test_clarity_anchors_are_named(self) -> None:
        prompt = self._prompt()
        for anchor in (
            "retell what happened",                # comprehension bar
            "concrete event that HAPPENED",        # plot anchor
            "curiosity question",                  # question anchor
            "sharp specifics",                     # pepper-without-invention
        ):
            self.assertIn(anchor, prompt, f"clarity anchor {anchor!r} missing")

    def test_clarity_block_sits_between_structure_and_brand_safety(self) -> None:
        # Order matters: STRUCTURE → CLARITY → BRAND SAFETY. Clarity reads
        # as a layer on top of the five-beat shape; brand safety stays the
        # last layer of hard guardrails before the poll / tone / schema.
        prompt = self._prompt()
        i_structure = prompt.find("STRUCTURE")
        i_clarity = prompt.find("CLARITY")
        i_safety = prompt.find("BRAND SAFETY")
        self.assertGreater(i_structure, -1)
        self.assertGreater(i_clarity, -1)
        self.assertGreater(i_safety, -1)
        self.assertLess(i_structure, i_clarity)
        self.assertLess(i_clarity, i_safety)

    def test_clarity_forbids_invented_drama(self) -> None:
        # The "lift it with sharp specifics" rule has a known failure mode:
        # the LLM invents a vivid detail that wasn't in the source. The
        # block must close that door explicitly or the safety bar drops.
        prompt = self._prompt()
        self.assertIn("never invented drama", prompt)


class PosterTextBlockTests(unittest.TestCase):
    """The 2026-06-29 prompt-update for Phase 2 social posters. See
    _plans/2026-06-28-phase-2-social-poster-render.md.

    What we lock down: the prompt names a dedicated POSTER TEXT block,
    explains it as DIFFERENT from the spoken hook (oblique for spoken
    vs. clear for static grid), surfaces a concrete contrast example
    against beat 1, and the output JSON schema carries the new
    `poster_text` field. If any of these regresses the LLM will silently
    revert to using the spoken hook as the cover text — which is the
    failure mode the manager flagged on the IG grid.
    """

    def _prompt(self) -> str:
        return sn.build_extraction_prompt(
            sn.DEFAULT_STYLE_ID,
            source="Test source story body.",
            target_seconds=50,
        )

    def test_poster_text_block_header_present(self) -> None:
        prompt = self._prompt()
        self.assertIn("POSTER TEXT", prompt)

    def test_poster_text_distinguished_from_spoken_hook(self) -> None:
        # The block has to explicitly say "DIFFERENT from the spoken
        # hook" or the LLM defaults to re-using beat 1 verbatim. The
        # contrast example is what teaches it the style.
        prompt = self._prompt()
        self.assertIn("STATIC", prompt)
        self.assertIn("oblique", prompt)
        self.assertIn("climax-revealing", prompt)
        # The two concrete contrast examples must be present so the LLM
        # sees the spoken-vs-poster pairing it should imitate.
        self.assertIn("Her wedding dress was destroyed", prompt)
        self.assertIn(
            "Her wedding dress was destroyed the morning of the ceremony",
            prompt,
        )
        self.assertIn("Her refusal ended everything", prompt)

    def test_poster_text_in_output_schema(self) -> None:
        prompt = self._prompt()
        # Schema must explicitly declare the field so the LLM's strict-
        # JSON output includes it. Without this, downstream pipeline
        # silently sees `null` and falls back to the spoken hook.
        self.assertIn('"poster_text"', prompt)
        self.assertIn("8-14 word", prompt)

    def test_poster_text_block_sits_before_output_schema(self) -> None:
        # Order matters: every content block must precede OUTPUT so the
        # LLM reads the schema as the last instruction.
        prompt = self._prompt()
        i_poster = prompt.find("POSTER TEXT")
        i_output = prompt.find("OUTPUT")
        self.assertGreater(i_poster, -1)
        self.assertGreater(i_output, -1)
        self.assertLess(i_poster, i_output)

    def test_poster_text_forbids_fabrication(self) -> None:
        # The poster line must be defensible against the source story
        # — same anti-invention rule the script body carries.
        prompt = self._prompt()
        self.assertIn("no fabrication beyond the source", prompt)
        self.assertIn("isn't in the source story", prompt)


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
