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

    def test_world_bible_section_present(self) -> None:
        # The planner must ask for supporting characters / locations / items
        # so the reference-gallery pass has entities to t2i. Loose phrasing
        # alone (without naming the three lists) lets the LLM ignore the
        # whole section.
        prompt = self._prompt(source="anything")
        for token in (
            "WORLD BIBLE",
            "supporting_characters",
            "locations",
            "items",
            "visual_cues",
        ):
            self.assertIn(token, prompt, f"planner prompt must reference {token!r}")

    def test_world_bible_caps_named_in_prompt(self) -> None:
        # Caps stop the LLM from over-producing entities and blowing past
        # gpt-image-2's input_urls limit. Numbers come from the constants.
        prompt = self._prompt(source="anything")
        self.assertIn(str(shorts.MAX_SUPPORTING_CHARS), prompt)
        self.assertIn(str(shorts.MAX_LOCATIONS), prompt)
        self.assertIn(str(shorts.MAX_ITEMS), prompt)

    def test_per_scene_entity_arrays_in_json_schema(self) -> None:
        # Scenes must declare which entities they include so the reference
        # gallery resolver can attach the right refs to each i2i call.
        prompt = self._prompt(source="anything")
        for token in ('"characters"', '"locations"', '"items"'):
            self.assertIn(token, prompt)


class EntityLookupTests(unittest.TestCase):
    """Normalisation of the planner's supporting_characters / locations /
    items lists into the {name: cues} dicts the gallery generator consumes."""

    def test_lowercases_and_collapses_whitespace(self) -> None:
        entries = [{"name": "  Wife  ", "visual_cues": "tall  woman   red hair"}]
        out = shorts._entity_lookup(entries, cap=4)
        self.assertEqual(out, {"wife": "tall woman red hair"})

    def test_drops_malformed_entries(self) -> None:
        entries = [
            {"name": "kitchen", "visual_cues": "stainless steel"},
            "not a dict",
            {"name": "", "visual_cues": "no name"},
            {"name": "no_cues", "visual_cues": ""},
            {"name": 42, "visual_cues": "non-string name"},
        ]
        self.assertEqual(
            shorts._entity_lookup(entries, cap=4),
            {"kitchen": "stainless steel"},
        )

    def test_enforces_cap(self) -> None:
        entries = [
            {"name": f"e{i}", "visual_cues": f"cues {i}"} for i in range(10)
        ]
        out = shorts._entity_lookup(entries, cap=3)
        self.assertEqual(len(out), 3)

    def test_non_list_input_returns_empty(self) -> None:
        self.assertEqual(shorts._entity_lookup(None, cap=4), {})
        self.assertEqual(shorts._entity_lookup({"oops": "dict"}, cap=4), {})


class ResolveSceneRefsTests(unittest.TestCase):
    """Per-scene `input_urls` assembly. The FIRST listed supporting char in
    scene.characters (if any) leads as the focal anchor; protagonist base
    follows; remaining supporting / locations / items append. Duplicates and
    unknown names dropped; capped at INPUT_URLS_MAX. When no supporting char
    is named, the base URL leads (protagonist-focal default).
    """

    def _gallery(self) -> shorts.ReferenceGallery:
        return shorts.ReferenceGallery(
            supporting_chars={"wife": "wife-ref", "boss": "boss-ref"},
            locations={"kitchen": "kitchen-ref"},
            items={"envelope": "envelope-ref"},
        )

    def test_focal_supporting_leads_when_named(self) -> None:
        # When a supporting char is listed, she's the focal anchor at
        # position 1 — protagonist base demoted to position 2.
        scene = {"characters": ["wife"], "locations": [], "items": []}
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(refs[0], "wife-ref")
        self.assertEqual(refs[1], "base-url")

    def test_pulls_referenced_entities_in_order(self) -> None:
        # First supporting char becomes anchor; remaining supporting /
        # locations / items follow protagonist.
        scene = {
            "characters": ["wife", "boss"],
            "locations": ["kitchen"],
            "items": ["envelope"],
        }
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(
            refs,
            ["wife-ref", "base-url", "boss-ref", "kitchen-ref", "envelope-ref"],
        )

    def test_drops_unknown_entity_names(self) -> None:
        # No known supporting char → protagonist-focal default. Unknown
        # location / character names get silently dropped.
        scene = {"characters": ["ghost"], "locations": ["void"], "items": []}
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(refs, ["base-url"])

    def test_case_insensitive_name_lookup(self) -> None:
        # Planner sometimes emits Title Case or UPPER. Lowercase lookup
        # is the load-bearing contract for matching gallery keys.
        scene = {"characters": ["WIFE"], "locations": ["Kitchen"], "items": []}
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(refs, ["wife-ref", "base-url", "kitchen-ref"])

    def test_dedupes_repeated_urls(self) -> None:
        # If the planner names "wife" twice (which it shouldn't but might),
        # the ref should only appear once — the model treats duplicates as
        # wasted input slots.
        scene = {"characters": ["wife", "wife"], "locations": [], "items": []}
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(refs, ["wife-ref", "base-url"])

    def test_caps_at_input_urls_max(self) -> None:
        many_chars = {f"c{i}": f"ref-{i}" for i in range(20)}
        gallery = shorts.ReferenceGallery(
            supporting_chars=many_chars, locations={}, items={},
        )
        scene = {"characters": list(many_chars.keys()), "locations": [], "items": []}
        refs = shorts._resolve_scene_refs(scene, "base-url", gallery)
        self.assertLessEqual(len(refs), shorts.INPUT_URLS_MAX)

    def test_empty_gallery_returns_base_only(self) -> None:
        empty = shorts.ReferenceGallery({}, {}, {})
        scene = {"characters": ["wife"], "locations": ["kitchen"], "items": []}
        refs = shorts._resolve_scene_refs(scene, "base-url", empty)
        self.assertEqual(refs, ["base-url"])

    def test_first_listed_supporting_char_becomes_focal_anchor(self) -> None:
        # When the planner lists wife FIRST in scene.characters (signalling
        # she's the visual subject of this beat), her ref must lead. The
        # protagonist's base stays in the set (so kie still has him to
        # anchor the cook's identity in the same frame) but at position 2.
        # Without this, kie's position-1-strongest heuristic locks the
        # protagonist hard and the wife drifts between scenes — exactly
        # what THE STEAK STANDOFF was hitting in prod.
        scene = {
            "characters": ["wife"],
            "locations": ["kitchen"],
            "items": [],
        }
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(refs, ["wife-ref", "base-url", "kitchen-ref"])

    def test_focal_uses_first_known_supporting_when_multiple_listed(self) -> None:
        # If the planner lists ["wife", "boss"], wife is the focal anchor —
        # first-listed by convention is the visual subject; boss still
        # appears in the ref set right after the protagonist.
        scene = {
            "characters": ["wife", "boss"],
            "locations": [],
            "items": [],
        }
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(refs, ["wife-ref", "base-url", "boss-ref"])

    def test_focal_skips_unknown_names_to_find_known_supporting(self) -> None:
        # A planner typo at position 0 ("ghost") must not block the focal
        # promotion of the real sub-char at position 1. We scan until we
        # find a known supporting char or fall back to base-first.
        scene = {
            "characters": ["ghost", "wife"],
            "locations": [],
            "items": [],
        }
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(refs, ["wife-ref", "base-url"])

    def test_focal_promotion_keeps_locations_and_items(self) -> None:
        # The location + item refs must still get appended after the
        # protagonist when a sub-character takes position 1.
        scene = {
            "characters": ["wife"],
            "locations": ["kitchen"],
            "items": ["envelope"],
        }
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(
            refs, ["wife-ref", "base-url", "kitchen-ref", "envelope-ref"],
        )

    def test_no_supporting_chars_keeps_default_ordering(self) -> None:
        # A protagonist-only scene (most scenes are like this) must keep
        # base_url at position 1 — back-compat with every existing render.
        scene = {"characters": [], "locations": ["kitchen"], "items": []}
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(refs, ["base-url", "kitchen-ref"])

    def test_focal_resilient_to_non_string_character_entries(self) -> None:
        # Planner edge case: nulls / ints slipping into the characters
        # list. The resolver must coerce safely and keep finding the next
        # known supporting name instead of crashing.
        scene = {
            "characters": [None, 42, "wife"],
            "locations": [],
            "items": [],
        }
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(refs, ["wife-ref", "base-url"])


class RedistributeChunkIndicesTests(unittest.TestCase):
    """Caption-chunk timing override. The planner concentrates frames on
    the script's first half and lets the last frame hold 20+ seconds; this
    helper rebalances chunk indices so per-frame on-screen duration is
    roughly even regardless of what the LLM emitted."""

    def test_distributes_evenly_when_chunks_divisible(self) -> None:
        scenes = [{"caption_chunk_start_index": 99} for _ in range(4)]
        shorts._redistribute_chunk_indices(scenes, total_chunks=16)
        self.assertEqual(
            [s["caption_chunk_start_index"] for s in scenes], [0, 4, 8, 12],
        )

    def test_fixes_lazy_planner_dropping_tail(self) -> None:
        # Reproduces the real Steak Standoff failure: 12 scenes, 33 caps,
        # planner clustered indices on the first half. After redistribute
        # the last frame's start sits comfortably before the tail.
        scenes = [
            {"caption_chunk_start_index": i}
            for i in [0, 1, 3, 4, 6, 7, 8, 10, 11, 13, 14, 15]
        ]
        shorts._redistribute_chunk_indices(scenes, total_chunks=33)
        out = [s["caption_chunk_start_index"] for s in scenes]
        self.assertEqual(out[0], 0)
        # Last frame must NOT start before the second-to-last + 1 — i.e.
        # monotonic non-decreasing — and the gap from the last frame to
        # total_chunks must be small (the bug we're fixing was 18 chunks
        # left to one frame; here it should be <= 3).
        self.assertLessEqual(33 - out[-1], 33 // len(scenes) + 1)
        for prev, curr in zip(out, out[1:]):
            self.assertGreaterEqual(curr, prev)

    def test_no_op_on_empty_scenes(self) -> None:
        scenes: list[dict] = []
        shorts._redistribute_chunk_indices(scenes, total_chunks=10)
        self.assertEqual(scenes, [])

    def test_no_op_on_zero_chunks(self) -> None:
        # Defensive: a malformed script with no captions must not crash.
        scenes = [{"caption_chunk_start_index": 0}]
        shorts._redistribute_chunk_indices(scenes, total_chunks=0)
        self.assertEqual(scenes[0]["caption_chunk_start_index"], 0)

    def test_single_scene_anchors_at_zero(self) -> None:
        scenes = [{"caption_chunk_start_index": 7}]
        shorts._redistribute_chunk_indices(scenes, total_chunks=15)
        self.assertEqual(scenes[0]["caption_chunk_start_index"], 0)

    def test_more_scenes_than_chunks_still_monotonic(self) -> None:
        # 5 scenes over 3 chunks — pathological but the helper must still
        # produce non-decreasing indices and not raise.
        scenes = [{} for _ in range(5)]
        shorts._redistribute_chunk_indices(scenes, total_chunks=3)
        out = [s["caption_chunk_start_index"] for s in scenes]
        for prev, curr in zip(out, out[1:]):
            self.assertGreaterEqual(curr, prev)


if __name__ == "__main__":
    unittest.main()
