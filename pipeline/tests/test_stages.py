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


class BuildWorldBibleDryRunTests(unittest.TestCase):
    """Dry-run path returns deterministic stubs structured exactly
    like the parsed shape from `world_bible.parse_world_bible`. This
    is how the rest of the pipeline can run end-to-end against the
    new bible without an LLM key — fixtures, smoke tests, and the
    media_regen integration tests all lean on it."""

    def test_dry_run_returns_parsed_bible_shape(self):
        bible = stages.build_world_bible(
            {"headline": "Office gift fund went missing"}, "body", dry_run=True,
        )
        self.assertIsNotNone(bible)
        assert bible is not None
        self.assertEqual(bible["built_with"], "world_bible_v1")
        self.assertEqual(len(bible["characters"]), 2)
        self.assertEqual(bible["characters"][0]["role"], "lead")
        self.assertEqual(len(bible["locations"]), 1)
        self.assertEqual(len(bible["items"]), 1)
        # Every entity has a stable id.
        for c in bible["characters"]:
            self.assertTrue(c["id"].startswith("char_"))

    def test_dry_run_embeds_headline_for_grounding(self):
        # The pipeline's manual-QA mode runs --dry-run end-to-end and
        # eyeballs whether the bible is tied to the article. Stub
        # embedding lets that check pass without an LLM key.
        bible = stages.build_world_bible(
            {"headline": "Custom Headline 12345"}, "x", dry_run=True,
        )
        assert bible is not None
        joined = " ".join(c["visual_cues"] for c in bible["characters"])
        self.assertIn("Custom Headline 12345", joined)


class ExtractJsonObjectTests(unittest.TestCase):
    """Shared by `build_world_bible` (and tomorrow's stages) to peel
    an object out of whatever the LLM wraps it in. Same tolerance
    rules as `_parse_prompt_list` but for `{}` not `[]`."""

    def test_clean_object_parses(self):
        out = stages._extract_json_object('{"a": 1, "b": 2}')
        self.assertEqual(out, {"a": 1, "b": 2})

    def test_strips_leading_prose(self):
        out = stages._extract_json_object("Here you go:\n\n{\"a\": 1}")
        self.assertEqual(out, {"a": 1})

    def test_fenced_block_parses(self):
        out = stages._extract_json_object('```json\n{"a": 1}\n```')
        self.assertEqual(out, {"a": 1})

    def test_garbage_returns_none(self):
        self.assertIsNone(stages._extract_json_object("sorry I can't"))

    def test_malformed_json_returns_none(self):
        self.assertIsNone(stages._extract_json_object('{"a": 1'))

    def test_non_object_returns_none(self):
        # We're only after objects; a top-level array shouldn't slip
        # through as the bible (the array parser owns that case).
        self.assertIsNone(stages._extract_json_object('[1, 2, 3]'))


class FormatBibleForSceneTests(unittest.TestCase):
    """The bible-block embedding is the prompt LLM the per-scene call
    sees. We need every entity surfaced with its stable id so the LLM
    can both quote the cues AND tag the scene with the right ids.
    Empty buckets are omitted to keep the prompt tight."""

    def test_renders_all_entity_buckets(self):
        bible = {
            "characters": [{"id": "char_a", "name": "Maya", "role": "lead", "visual_cues": "tall"}],
            "sub_characters": [{"id": "sub_b", "name": "Guard", "role": "background", "visual_cues": "uniform"}],
            "locations": [{"id": "loc_c", "name": "office", "visual_cues": "fluorescent"}],
            "items": [{"id": "item_d", "name": "envelope", "visual_cues": "manila"}],
        }
        out = stages._format_bible_for_scene_prompt(bible)
        for marker in [
            "CHARACTERS", "char_a", "Maya", "tall",
            "SUB-CHARACTERS", "sub_b", "Guard", "uniform",
            "LOCATIONS", "loc_c", "office", "fluorescent",
            "ITEMS", "item_d", "envelope", "manila",
        ]:
            self.assertIn(marker, out, msg=f"missing: {marker}")

    def test_omits_empty_buckets(self):
        bible = {
            "characters": [{"id": "char_a", "name": "X", "role": "lead", "visual_cues": "y"}],
            "sub_characters": [],
            "locations": [],
            "items": [],
        }
        out = stages._format_bible_for_scene_prompt(bible)
        self.assertIn("CHARACTERS", out)
        for marker in ("SUB-CHARACTERS", "LOCATIONS", "ITEMS"):
            self.assertNotIn(marker, out)


class MakeScenePromptsFromBibleDryRunTests(unittest.TestCase):
    """Dry-run path returns scene_count entries each with a prompt
    that embeds the narration line AND an entity_ids array tagging
    the first character. That gives downstream tests something to
    grip when verifying ref flow without an LLM key."""

    def _bible(self) -> dict:
        return {
            "built_with": "world_bible_v1",
            "characters": [
                {"id": "char_lead", "name": "Maya", "role": "lead", "visual_cues": "tall"},
            ],
            "sub_characters": [],
            "locations": [],
            "items": [],
        }

    def test_dry_run_returns_one_entry_per_scene(self):
        out = stages.make_scene_prompts_from_bible(
            {"headline": "Test"},
            "body",
            ["opening line", "the reveal", "the kicker"],
            self._bible(),
            dry_run=True,
        )
        self.assertEqual(len(out), 3)
        self.assertIn("opening line", out[0]["prompt"])
        self.assertIn("reveal", out[1]["prompt"])
        self.assertIn("kicker", out[2]["prompt"])

    def test_dry_run_tags_lead_character_id(self):
        # Without the lead-id tag the ref flow has nothing to test
        # against — every scene needs at least one entity id so the
        # bulk regen path's "pass refs to kie" code branch fires.
        out = stages.make_scene_prompts_from_bible(
            {"headline": "T"}, "x", ["one"], self._bible(), dry_run=True,
        )
        self.assertEqual(out[0]["entity_ids"], ["char_lead"])

    def test_dry_run_with_no_characters_yields_empty_ids(self):
        bible = {
            "built_with": "world_bible_v1",
            "characters": [],
            "sub_characters": [],
            "locations": [],
            "items": [],
        }
        out = stages.make_scene_prompts_from_bible(
            {"headline": "T"}, "x", ["one"], bible, dry_run=True,
        )
        self.assertEqual(out[0]["entity_ids"], [])


class ParseScenePromptsWithEntitiesTests(unittest.TestCase):
    """Parser branches: clean array, partial array (per-scene
    fallback pads), unknown ids dropped, total failure → all
    fallbacks. Crucial that unknown ids don't survive: the kie ref
    lookup would silently drop them anyway, so we strip here to keep
    the persisted shape honest."""

    def _bible(self) -> dict:
        return {
            "built_with": "world_bible_v1",
            "characters": [{"id": "char_a", "name": "A", "role": "lead", "visual_cues": "x"}],
            "sub_characters": [],
            "locations": [{"id": "loc_b", "name": "B", "visual_cues": "y"}],
            "items": [],
        }

    def test_clean_array_round_trips(self):
        raw = (
            '['
            '{"prompt": "scene one", "entity_ids": ["char_a"]},'
            '{"prompt": "scene two", "entity_ids": ["char_a","loc_b"]}'
            ']'
        )
        out = stages._parse_scene_prompts_with_entities(
            raw, ["narr1", "narr2"], "Headline", "style", self._bible(),
        )
        self.assertEqual(out[0]["prompt"], "scene one")
        self.assertEqual(out[0]["entity_ids"], ["char_a"])
        self.assertEqual(out[1]["entity_ids"], ["char_a", "loc_b"])

    def test_partial_array_pads_per_scene_fallback(self):
        raw = '[{"prompt": "first", "entity_ids": ["char_a"]}]'
        out = stages._parse_scene_prompts_with_entities(
            raw, ["narr1", "narr2", "narr3"], "H", "S", self._bible(),
        )
        self.assertEqual(len(out), 3)
        self.assertEqual(out[0]["prompt"], "first")
        # Padded entries fall back to narration-grounded prompts with
        # NO entity ids — better empty than wrong, since the kie call
        # would then run without refs (still produces an image).
        self.assertIn("narr2", out[1]["prompt"])
        self.assertEqual(out[1]["entity_ids"], [])
        self.assertIn("narr3", out[2]["prompt"])
        self.assertEqual(out[2]["entity_ids"], [])

    def test_unknown_ids_are_dropped(self):
        raw = '[{"prompt": "x", "entity_ids": ["char_a", "char_ghost", "loc_b"]}]'
        out = stages._parse_scene_prompts_with_entities(
            raw, ["n1"], "H", "S", self._bible(),
        )
        self.assertEqual(out[0]["entity_ids"], ["char_a", "loc_b"])

    def test_total_failure_yields_all_fallbacks(self):
        out = stages._parse_scene_prompts_with_entities(
            "sorry can't help", ["alpha", "beta"], "H", "doodle", self._bible(),
        )
        self.assertEqual(len(out), 2)
        self.assertIn("alpha", out[0]["prompt"])
        self.assertIn("beta", out[1]["prompt"])
        self.assertEqual(out[0]["entity_ids"], [])
        self.assertEqual(out[1]["entity_ids"], [])


if __name__ == "__main__":
    unittest.main()
