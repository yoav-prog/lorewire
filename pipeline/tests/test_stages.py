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


class DeriveSceneNarrationsTests(unittest.TestCase):
    """The grounded-prompt path needs ONE narration line per scene. The
    binding lives on doodle_frames[i].caption_chunk_start_index:
    captions from start_i .. start_{i+1}-1 belong to scene i. Last scene
    runs to end of captions."""

    def test_three_frames_three_caption_chunks(self):
        frames = [
            {"id": "a", "caption_chunk_start_index": 0},
            {"id": "b", "caption_chunk_start_index": 1},
            {"id": "c", "caption_chunk_start_index": 2},
        ]
        captions = [
            {"text": "Once upon a time"},
            {"text": "a neighbor woke us"},
            {"text": "with a leaf blower"},
        ]
        out = stages.derive_scene_narrations(frames, captions)
        self.assertEqual(out, [
            "Once upon a time",
            "a neighbor woke us",
            "with a leaf blower",
        ])

    def test_one_frame_takes_all_captions(self):
        frames = [{"id": "a", "caption_chunk_start_index": 0}]
        captions = [
            {"text": "alpha"}, {"text": "beta"}, {"text": "gamma"},
        ]
        out = stages.derive_scene_narrations(frames, captions)
        self.assertEqual(out, ["alpha beta gamma"])

    def test_two_frames_split_at_start_index(self):
        # Frame B starts at chunk 2 → frame A gets chunks 0-1, frame B
        # gets 2-3.
        frames = [
            {"id": "a", "caption_chunk_start_index": 0},
            {"id": "b", "caption_chunk_start_index": 2},
        ]
        captions = [
            {"text": "one"}, {"text": "two"},
            {"text": "three"}, {"text": "four"},
        ]
        out = stages.derive_scene_narrations(frames, captions)
        self.assertEqual(out, ["one two", "three four"])

    def test_empty_inputs_return_empty(self):
        self.assertEqual(stages.derive_scene_narrations([], []), [])
        self.assertEqual(stages.derive_scene_narrations([], [{"text": "x"}]), [])
        self.assertEqual(
            stages.derive_scene_narrations([{"caption_chunk_start_index": 0}], []),
            [],
        )

    def test_malformed_frame_returns_empty(self):
        # A frame with no caption_chunk_start_index can't be bound — the
        # whole derivation gives up so the caller falls back to legacy.
        frames = [{"id": "a"}]
        captions = [{"text": "x"}]
        self.assertEqual(stages.derive_scene_narrations(frames, captions), [])


class ParseCharacterBibleTests(unittest.TestCase):
    """The bible response is a small JSON object. None on any parse
    failure so the per-scene call still runs without the continuity
    reinforcement."""

    def test_clean_bible_parses(self):
        raw = (
            '{"characters": [{"name": "A", "visual_cues": "tall, hat"}, '
            '{"name": "B", "visual_cues": "short, red coat"}], '
            '"setting": "city sidewalk"}'
        )
        out = stages._parse_character_bible(raw)
        self.assertIsNotNone(out)
        assert out is not None  # for type checker
        self.assertEqual(len(out["characters"]), 2)
        self.assertEqual(out["characters"][0]["name"], "A")
        self.assertEqual(out["summary"], "city sidewalk")

    def test_fenced_bible_parses(self):
        raw = '```json\n{"characters": [{"name": "A", "visual_cues": "X"}]}\n```'
        out = stages._parse_character_bible(raw)
        self.assertIsNotNone(out)

    def test_garbage_returns_none(self):
        self.assertIsNone(stages._parse_character_bible("nope"))

    def test_no_characters_returns_none(self):
        self.assertIsNone(stages._parse_character_bible('{"characters": []}'))

    def test_drops_unnamed_or_uncued_characters(self):
        # Without both name AND visual_cues a character can't be redrawn
        # consistently, so we drop it.
        raw = (
            '{"characters": [{"name": "A", "visual_cues": "X"}, '
            '{"name": "", "visual_cues": "Y"}, '
            '{"name": "C", "visual_cues": ""}]}'
        )
        out = stages._parse_character_bible(raw)
        self.assertIsNotNone(out)
        assert out is not None
        self.assertEqual(len(out["characters"]), 1)
        self.assertEqual(out["characters"][0]["name"], "A")

    def test_caps_characters_at_four(self):
        chars = ",".join(
            f'{{"name": "C{i}", "visual_cues": "cue{i}"}}' for i in range(8)
        )
        raw = f'{{"characters": [{chars}]}}'
        out = stages._parse_character_bible(raw)
        assert out is not None
        self.assertEqual(len(out["characters"]), 4)


class ParseGroundedPromptsTests(unittest.TestCase):
    """The grounded parser pads with PER-SCENE fallbacks (each carrying
    that scene's narration line) instead of repeating the last prompt
    like _parse_prompt_list. The whole point of grounded prompts is that
    prompt N targets narration line N — padding with 'continuation of
    scene 5' on scene 12 would defeat the binding."""

    def test_clean_array_returns_as_is(self):
        raw = '["a", "b", "c"]'
        narrations = ["one", "two", "three"]
        out = stages._parse_grounded_prompts(raw, narrations, "Headline", "style")
        self.assertEqual(out, ["a", "b", "c"])

    def test_partial_array_pads_with_per_scene_narration(self):
        # LLM truncated after 2 entries; remaining scenes get fallbacks
        # that mention THEIR narration line, not scene 2's.
        raw = '["a", "b"]'
        narrations = ["one", "two", "three", "four"]
        out = stages._parse_grounded_prompts(raw, narrations, "Headline", "style")
        self.assertEqual(len(out), 4)
        self.assertEqual(out[0], "a")
        self.assertEqual(out[1], "b")
        self.assertIn("three", out[2])
        self.assertIn("four", out[3])

    def test_total_failure_falls_back_per_scene(self):
        out = stages._parse_grounded_prompts(
            "sorry I can't", ["alpha", "beta"], "Headline", "doodle",
        )
        self.assertEqual(len(out), 2)
        self.assertIn("alpha", out[0])
        self.assertIn("beta", out[1])
        self.assertTrue(all("doodle" in p for p in out))


class MakeGroundedScenePromptsDryRunTests(unittest.TestCase):
    """Dry-run path returns deterministic stubs that EMBED each
    narration line — the rest of the pipeline can run end to end
    without an LLM key and tests can assert the binding survived."""

    def test_dry_run_embeds_narration_line(self):
        prompts, bible = stages.make_grounded_scene_prompts(
            {"headline": "Test"},
            "body irrelevant",
            ["The opening line", "The reveal", "The kicker"],
            dry_run=True,
        )
        self.assertEqual(len(prompts), 3)
        self.assertIn("opening line", prompts[0])
        self.assertIn("reveal", prompts[1])
        self.assertIn("kicker", prompts[2])
        # Dry-run bible is also deterministic.
        self.assertIsNotNone(bible)
        assert bible is not None
        self.assertEqual(len(bible["characters"]), 2)

    def test_dry_run_reuses_cached_bible(self):
        cached = {
            "characters": [{"name": "Z", "visual_cues": "scar"}],
            "summary": "alley",
        }
        _, bible = stages.make_grounded_scene_prompts(
            {"headline": "Test"}, "body", ["line a"],
            dry_run=True, cached_bible=cached,
        )
        self.assertIs(bible, cached)

    def test_long_narration_is_truncated_safely(self):
        long_line = "x" * 10_000
        prompts, _ = stages.make_grounded_scene_prompts(
            {"headline": "Test"}, "body", [long_line], dry_run=True,
        )
        # Truncation happens before embedding; the stub itself shows the
        # cap so a malformed captions field can't push the prompt to
        # unbounded size.
        self.assertLess(len(prompts[0]), 1500)


if __name__ == "__main__":
    unittest.main()
