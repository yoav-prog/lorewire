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


class TitleLengthGateTests(unittest.TestCase):
    """Plan: _plans/2026-06-25-title-length-gate.md. Guards three things:
    the bounds check itself, the LLM retry path when the first attempt fails,
    and the deterministic salvage when both LLM attempts fail."""

    def test_within_bounds_accepts_brand_voice_titles(self):
        # The TITLE_STYLE_EXAMPLES list is the canonical "voice" set;
        # every entry must pass the gate or the gate is misconfigured.
        for example in stages.TITLE_STYLE_EXAMPLES:
            self.assertTrue(
                stages._title_within_bounds(example),
                f"style example failed gate: {example}",
            )

    def test_within_bounds_rejects_the_cinnamon_roll_title(self):
        # The exact 99-char string that reached the hero on 2026-06-25.
        bad = (
            "MY SON ATE THE MIDDLES OUT OF EVERY CINNAMON ROLL BEFORE "
            "I GOT TO THE TABLE THIS MORNING."
        )
        self.assertFalse(stages._title_within_bounds(bad))

    def test_within_bounds_rejects_empty(self):
        self.assertFalse(stages._title_within_bounds(""))
        self.assertFalse(stages._title_within_bounds("   "))

    def test_within_bounds_rejects_too_many_words(self):
        # 9 short words is within 50 chars but past the 8-word cap.
        nine_words = "ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE"
        self.assertLessEqual(len(nine_words), stages.TITLE_MAX_CHARS)
        self.assertFalse(stages._title_within_bounds(nine_words))

    def test_salvage_prefers_body_first_sentence(self):
        body = "She sent one envelope and the office never recovered."
        out = stages._salvage_title_from_body(body, "AITA for invoicing?")
        self.assertTrue(stages._title_within_bounds(out))
        self.assertTrue(out.isupper())
        # Should pull from the body, not the headline.
        self.assertNotIn("AITA", out)

    def test_salvage_falls_back_to_headline_when_body_unusable(self):
        # Empty body should make the salvage reach for the headline.
        out = stages._salvage_title_from_body("", "Wrong Number Right Guy")
        self.assertTrue(stages._title_within_bounds(out))
        self.assertTrue(out.isupper())

    def test_salvage_truncates_long_headlines_at_word_boundary(self):
        long_headline = (
            "My son ate the middles out of every cinnamon roll before "
            "I got to the table this morning"
        )
        out = stages._salvage_title_from_body("", long_headline)
        self.assertTrue(stages._title_within_bounds(out))
        # Must end on a whole word, never mid-word.
        self.assertFalse(out.endswith(("-", " ")))
        for word in out.split():
            self.assertIn(word.lower(), long_headline.lower())

    def test_salvage_returns_placeholder_for_empty_inputs(self):
        out = stages._salvage_title_from_body("", "")
        self.assertTrue(out)
        self.assertTrue(stages._title_within_bounds(out))

    def test_make_title_retries_on_too_long(self):
        # First call returns a too-long title (forces retry); second call
        # returns a clean one. We mock `pipeline.llm.chat` so no network.
        calls = {"n": 0}

        def fake_chat(prompt: str, max_tokens: int, model: str = "") -> str:
            calls["n"] += 1
            if calls["n"] == 1:
                return (
                    '{"title": "MY SON ATE THE MIDDLES OUT OF EVERY '
                    'CINNAMON ROLL BEFORE I GOT TO THE TABLE THIS MORNING", '
                    '"synopsis": "A short synopsis of the breakfast story '
                    'told over twenty words with a small hook for the reader."}'
                )
            return (
                '{"title": "THE CINNAMON ROLL HEIST", '
                '"synopsis": "A short synopsis of the breakfast story told '
                'over twenty words with a small hook for the reader."}'
            )

        from pipeline import llm as llm_mod

        original = llm_mod.chat
        llm_mod.chat = fake_chat  # type: ignore[assignment]
        try:
            title, syn = stages.make_title_and_synopsis(
                {"headline": "AITA for cinnamon rolls", "category": "Humor"},
                body="The boy reached the kitchen first.",
                dry_run=False,
            )
        finally:
            llm_mod.chat = original

        self.assertEqual(calls["n"], 2)
        self.assertEqual(title, "THE CINNAMON ROLL HEIST")
        self.assertTrue(stages._title_within_bounds(title))
        self.assertTrue(syn)

    def test_make_title_salvages_when_both_attempts_fail(self):
        # Both LLM responses violate the gate; salvage must fire and the
        # final title must still pass the gate (the worker's invariant).
        too_long = (
            '{"title": "AN EXTREMELY LONG TITLE THAT GOES WELL PAST THE '
            'FIFTY CHARACTER CAP AND THEN SOME MORE", "synopsis": "A long '
            'synopsis written for the test that fills out enough words to '
            'satisfy any reasonable lower bound."}'
        )

        def fake_chat(prompt: str, max_tokens: int, model: str = "") -> str:
            return too_long

        from pipeline import llm as llm_mod

        original = llm_mod.chat
        llm_mod.chat = fake_chat  # type: ignore[assignment]
        try:
            title, syn = stages.make_title_and_synopsis(
                {"headline": "Coworker took the envelope", "category": "Drama"},
                body="Sarah noticed the envelope was lighter than yesterday.",
                dry_run=False,
            )
        finally:
            llm_mod.chat = original

        self.assertTrue(title)
        self.assertTrue(stages._title_within_bounds(title))
        # Never the raw Reddit headline.
        self.assertNotIn("AITA", title.upper())
        self.assertTrue(syn)


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


class ThumbnailPromptCharacterRefTests(unittest.TestCase):
    """Locks down the i2i variant of `make_thumbnail_prompt`.

    The hero / poster gen used to invent a fresh face on every call
    because the prompt carried no character reference. Phase 1 of the
    hero-consistency work made `make_thumbnail_prompt` accept a
    character_base_url; passing it has to (a) switch the prompt to a
    "redraw THIS person" instruction and (b) leave the existing
    text-only output untouched when no ref is supplied so older callers
    (the fresh-run pipeline) stay byte-compatible.
    """

    TITLE = "THE COLD SHOWER REVENGE"
    CATEGORY = "Entitled"
    BODY = "After two decades of a forgotten diverter, a wife snaps."

    def test_no_character_base_url_falls_back_to_text_only(self):
        # Back-compat: every existing caller passes 5 positional args and
        # gets the same prompt shape it always did. The output must NOT
        # contain the i2i redraw instruction.
        out = stages.make_thumbnail_prompt(
            self.TITLE, self.CATEGORY, self.BODY, "3:4", False,
        )
        self.assertIn("Cinematic editorial poster", out)
        self.assertNotIn("Redraw the EXACT same character", out)
        # Title still baked in.
        self.assertIn(self.TITLE, out)

    def test_character_base_url_switches_to_i2i_redraw_instruction(self):
        out = stages.make_thumbnail_prompt(
            self.TITLE, self.CATEGORY, self.BODY, "3:4", False,
            character_base_url="https://gcs/base.png",
        )
        # The i2i instruction is unambiguous so the model knows to keep
        # the reference image's identity instead of inventing a new one.
        self.assertIn("Redraw the EXACT same character", out)
        # Identity-locked fields (gender, build, hair, clothing, age) are
        # spelled out so the model holds them even if the style band
        # nudges in another direction.
        for must_preserve in ("gender", "build", "hair", "clothing", "age"):
            self.assertIn(must_preserve, out)

    def test_dry_run_marks_i2i_variant_explicitly(self):
        # Dry-run output is a marker string; the suffix lets a human
        # reading a dry-run log distinguish text-only gen from i2i gen.
        text_only = stages.make_thumbnail_prompt(
            self.TITLE, self.CATEGORY, self.BODY, "3:4", True,
        )
        i2i = stages.make_thumbnail_prompt(
            self.TITLE, self.CATEGORY, self.BODY, "3:4", True,
            character_base_url="https://gcs/base.png",
        )
        self.assertNotIn("(i2i)", text_only)
        self.assertIn("(i2i)", i2i)


class BuildArticlePromptTests(unittest.TestCase):
    """The article prompt mirrors the short's _clarity_block.
    See _plans/2026-06-28-content-clarity-bar.md.

    What we lock down: the prompt names the clarity bar, the four anchor
    concepts (retell-by-end, concrete event, curiosity question, sharp
    specifics from the source), and still carries the existing "don't
    moralize / don't invent" rules and the headline + research brief.
    """

    IDEA = {"headline": "AITA for invoicing my coworkers?"}
    RESEARCH = {"brief": "Three to six beats of the office gift fund story."}

    def _prompt(self) -> str:
        return stages._build_article_prompt(self.IDEA, self.RESEARCH)

    def test_clarity_bar_present(self) -> None:
        self.assertIn("Clarity bar", self._prompt())

    def test_clarity_anchors_are_named(self) -> None:
        prompt = self._prompt()
        for anchor in (
            "retell what happened",          # comprehension bar
            "concrete events that HAPPENED", # plot anchor
            "curiosity question",            # question anchor
            "sharp specifics",               # pepper-without-invention
        ):
            self.assertIn(anchor, prompt, f"clarity anchor {anchor!r} missing")

    def test_existing_brand_rules_still_present(self) -> None:
        # The clarity bar is added ON TOP of the existing rules; the
        # don't-moralize and don't-invent guards must still appear or the
        # article voice drifts back to verdict-rendering.
        prompt = self._prompt()
        self.assertIn("Do NOT analyze, moralize, or render a verdict", prompt)
        self.assertIn("do not invent anything beyond the research", prompt)

    def test_article_pov_third_person_rule(self) -> None:
        # Added 2026-06-28 alongside the shorts _pov_block. The article
        # narrator is also a third-person storyteller — never the OP.
        # Same fallback rule for unknown gender: 'they' or a role-noun.
        prompt = self._prompt()
        self.assertIn("third-person storyteller", prompt)
        self.assertIn("NEVER the character", prompt)
        self.assertIn("translate every 'I/me/my' into third person", prompt)
        self.assertIn("default to 'they' or a role-noun", prompt)
        self.assertIn("NEVER guess a gender", prompt)

    def test_article_demands_naming_loss_directly(self) -> None:
        # Mirror of the shorts cold-open principle: name the THING, not the
        # artifact of it. Without this the article's opening sentence drifts
        # to symptoms ("the envelope was empty") instead of the loss
        # ("$800 in cash, gone").
        prompt = self._prompt()
        self.assertIn("NAME THE THING DIRECTLY, NOT THE ARTIFACT OF IT", prompt)
        self.assertIn("symptom", prompt)
        self.assertIn("felt thing", prompt)

    def test_clarity_bar_demands_open_on_stranger_stakes(self) -> None:
        # Mirror of the cold-open tightening in shorts_narration. The
        # article's first line must land on a stakes event a stranger
        # can feel — loss / discovery / confrontation / transgression /
        # rupture — not a routine action. Same fix as the short on
        # 2026-06-28 after the "I sent them an invoice" weak hook.
        prompt = self._prompt()
        for token in (
            "stranger",
            "highest-stakes",
            "WAIT, WHAT",
            "loss",
            "discovery",
            "transgression",
        ):
            self.assertIn(token, prompt, f"article stakes anchor {token!r} missing")

    def test_hook_carve_out_preserved(self) -> None:
        # The article keeps the existing hook-first opener. After the
        # 2026-06-28 tightening the carve-out is the explicit "open on
        # the highest-stakes moment" directive — that line IS the hook
        # instruction, replacing the looser "open on a vivid moment
        # (keep the hook)" wording.
        prompt = self._prompt()
        self.assertIn("open on the highest-stakes moment", prompt)
        self.assertIn("opening line IS the catch", prompt)

    def test_headline_and_research_carry_through(self) -> None:
        prompt = self._prompt()
        self.assertIn(self.IDEA["headline"], prompt)
        self.assertIn(self.RESEARCH["brief"], prompt)


class ClassifyCategoryTests(unittest.TestCase):
    """LLM category classifier (_plans/2026-06-21-category-classifier-and-pills.md).
    Stubs `pipeline.llm.chat` so we exercise the closed-enum guard, the
    canonical-cased output, and the safe-fallback behavior without a real
    network call."""

    TITLE = "THE $800 ENVELOPE"
    BODY = "A coworker collects cash for the boss's retirement gift, then the envelope quietly disappears."

    def _patch_llm(self, response):
        from pipeline import llm as pipeline_llm
        self._orig = pipeline_llm.chat

        def fake_chat(_prompt, _max_tokens, model=None):  # noqa: ARG001
            if isinstance(response, Exception):
                raise response
            return response

        pipeline_llm.chat = fake_chat

    def tearDown(self):
        from pipeline import llm as pipeline_llm
        if hasattr(self, "_orig"):
            pipeline_llm.chat = self._orig

    def test_dry_run_returns_fallback(self):
        out = stages.classify_category(self.TITLE, self.BODY, "Entitled", dry_run=True)
        self.assertEqual(out, "Entitled")

    def test_returns_canonical_cased_match(self):
        self._patch_llm("entitled")
        out = stages.classify_category(self.TITLE, self.BODY, "Drama")
        self.assertEqual(out, "Entitled")

    def test_strips_punctuation_around_answer(self):
        self._patch_llm('"Humor".')
        out = stages.classify_category(self.TITLE, self.BODY, "Drama")
        self.assertEqual(out, "Humor")

    def test_falls_back_on_unknown_response(self):
        self._patch_llm("Politics")
        out = stages.classify_category(self.TITLE, self.BODY, "Wholesome")
        self.assertEqual(out, "Wholesome")

    def test_falls_back_on_empty_response(self):
        self._patch_llm("   ")
        out = stages.classify_category(self.TITLE, self.BODY, "Roommate")
        self.assertEqual(out, "Roommate")

    def test_falls_back_when_llm_raises(self):
        self._patch_llm(RuntimeError("LLM HTTP 500: boom"))
        out = stages.classify_category(self.TITLE, self.BODY, "Dating")
        self.assertEqual(out, "Dating")

    def test_first_word_only_when_model_explains(self):
        self._patch_llm("Humor — it reads like a sitcom beat.")
        out = stages.classify_category(self.TITLE, self.BODY, "Drama")
        self.assertEqual(out, "Humor")


class ClassifyStoryTagsTests(unittest.TestCase):
    """Multi-tag classifier (_plans/2026-07-01-category-taxonomy-multitag.md).
    Stubs pipeline.llm.chat so we exercise the JSON parse, the closed-set
    guard, confidence clamping, ordering, the max-tags cap, dedupe, and the
    safe empty-list fallback without a real network call. Mirrors the TS
    intent so both stay pinned to the same contract."""

    TITLE = "THE $800 ENVELOPE"
    BODY = "A coworker collects cash for the boss's gift, then betrays everyone."
    CATEGORIES = [
        {"slug": "entitled-people", "label": "Entitled People", "description": "entitled, demanding people"},
        {"slug": "cheating-betrayal", "label": "Cheating & Betrayal", "description": "betrayal, infidelity"},
        {"slug": "workplace", "label": "Workplace Nightmares", "description": "toxic jobs and coworkers"},
    ]

    def _patch_llm(self, response):
        from pipeline import llm as pipeline_llm
        self._orig = pipeline_llm.chat

        def fake_chat(_prompt, _max_tokens=2000, model=None):  # noqa: ARG001
            if isinstance(response, Exception):
                raise response
            return response

        pipeline_llm.chat = fake_chat

    def tearDown(self):
        from pipeline import llm as pipeline_llm
        if hasattr(self, "_orig"):
            pipeline_llm.chat = self._orig

    def _classify(self, **kw):
        return stages.classify_story_tags(self.TITLE, self.BODY, self.CATEGORIES, **kw)

    def test_dry_run_returns_empty(self):
        out = stages.classify_story_tags(self.TITLE, self.BODY, self.CATEGORIES, dry_run=True)
        self.assertEqual(out, [])

    def test_no_categories_returns_empty(self):
        self.assertEqual(stages.classify_story_tags(self.TITLE, self.BODY, []), [])

    def test_orders_by_confidence_primary_first(self):
        self._patch_llm('[{"slug":"entitled-people","confidence":0.6},{"slug":"cheating-betrayal","confidence":0.9}]')
        out = self._classify()
        self.assertEqual([t["slug"] for t in out], ["cheating-betrayal", "entitled-people"])
        self.assertAlmostEqual(out[0]["confidence"], 0.9)

    def test_single_tag(self):
        self._patch_llm('[{"slug":"workplace","confidence":0.8}]')
        out = self._classify()
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["slug"], "workplace")

    def test_drops_unknown_slugs(self):
        self._patch_llm('[{"slug":"politics","confidence":0.9},{"slug":"workplace","confidence":0.7}]')
        out = self._classify()
        self.assertEqual([t["slug"] for t in out], ["workplace"])

    def test_caps_at_max_tags(self):
        self._patch_llm(
            '[{"slug":"entitled-people","confidence":0.9},'
            '{"slug":"cheating-betrayal","confidence":0.8},'
            '{"slug":"workplace","confidence":0.7}]'
        )
        out = self._classify(max_tags=2)
        self.assertEqual([t["slug"] for t in out], ["entitled-people", "cheating-betrayal"])

    def test_clamps_confidence(self):
        self._patch_llm('[{"slug":"workplace","confidence":1.7}]')
        self.assertEqual(self._classify()[0]["confidence"], 1.0)

    def test_tolerates_code_fences_and_prose(self):
        self._patch_llm('Sure:\n```json\n[{"slug":"workplace","confidence":0.5}]\n```')
        self.assertEqual([t["slug"] for t in self._classify()], ["workplace"])

    def test_dedupes_keeping_highest_confidence(self):
        self._patch_llm('[{"slug":"workplace","confidence":0.4},{"slug":"workplace","confidence":0.8}]')
        out = self._classify()
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["confidence"], 0.8)

    def test_empty_on_unparseable(self):
        self._patch_llm("not json at all")
        self.assertEqual(self._classify(), [])

    def test_empty_when_llm_raises(self):
        self._patch_llm(RuntimeError("LLM HTTP 500: boom"))
        self.assertEqual(self._classify(), [])


if __name__ == "__main__":
    unittest.main()
