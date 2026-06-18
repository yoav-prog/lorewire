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
    """Per-scene `input_urls` assembly. Base char URL must always lead the
    list (identity anchor); supporting characters / locations / items follow;
    duplicates and unknown names dropped; capped at INPUT_URLS_MAX."""

    def _gallery(self) -> shorts.ReferenceGallery:
        return shorts.ReferenceGallery(
            supporting_chars={"wife": "wife-ref", "boss": "boss-ref"},
            locations={"kitchen": "kitchen-ref"},
            items={"envelope": "envelope-ref"},
        )

    def test_base_always_first(self) -> None:
        scene = {"characters": ["wife"], "locations": [], "items": []}
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(refs[0], "base-url")

    def test_pulls_referenced_entities_in_order(self) -> None:
        scene = {
            "characters": ["wife", "boss"],
            "locations": ["kitchen"],
            "items": ["envelope"],
        }
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(
            refs,
            ["base-url", "wife-ref", "boss-ref", "kitchen-ref", "envelope-ref"],
        )

    def test_drops_unknown_entity_names(self) -> None:
        scene = {"characters": ["ghost"], "locations": ["void"], "items": []}
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(refs, ["base-url"])

    def test_case_insensitive_name_lookup(self) -> None:
        scene = {"characters": ["WIFE"], "locations": ["Kitchen"], "items": []}
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(refs, ["base-url", "wife-ref", "kitchen-ref"])

    def test_dedupes_repeated_urls(self) -> None:
        # If the planner names "wife" twice (which it shouldn't but might),
        # the ref should only appear once — the model treats duplicates as
        # wasted input slots.
        scene = {"characters": ["wife", "wife"], "locations": [], "items": []}
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(refs, ["base-url", "wife-ref"])

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

    def test_focal_character_promotes_supporting_to_position_1(self) -> None:
        # When the scene is framed on the wife, her ref must lead. The
        # protagonist's base stays in the set (so kie still has him to
        # anchor the cook's identity in the same frame) but at position 2.
        # Without this, kie's position-1-strongest heuristic locks the
        # protagonist hard and the wife drifts between scenes — exactly
        # what THE STEAK STANDOFF was hitting in prod.
        scene = {
            "characters": ["wife"],
            "locations": ["kitchen"],
            "items": [],
            "focal_character": "wife",
        }
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(refs, ["wife-ref", "base-url", "kitchen-ref"])

    def test_focal_character_unknown_falls_back_to_default(self) -> None:
        # A focal name the gallery doesn't know (planner typo, name drift)
        # must NOT crash and must NOT silently drop the protagonist anchor —
        # we fall back to the default base-first ordering.
        scene = {
            "characters": ["wife"],
            "locations": [],
            "items": [],
            "focal_character": "ghost",
        }
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(refs, ["base-url", "wife-ref"])

    def test_focal_character_omitted_keeps_default_ordering(self) -> None:
        # The common case: most scenes are framed on the protagonist and
        # the planner omits focal_character. Order must match the pre-fix
        # behaviour so this change is back-compat for every existing render.
        scene = {"characters": ["wife"], "locations": [], "items": []}
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(refs, ["base-url", "wife-ref"])

    def test_focal_character_locations_and_items_still_appended(self) -> None:
        # Focal promotion must NOT drop locations / items from the ref set.
        # The kitchen + steak need to keep their anchors even when the
        # wife's ref takes position 1.
        scene = {
            "characters": ["wife"],
            "locations": ["kitchen"],
            "items": ["envelope"],
            "focal_character": "wife",
        }
        refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
        self.assertEqual(
            refs, ["wife-ref", "base-url", "kitchen-ref", "envelope-ref"],
        )

    def test_focal_character_non_string_treated_as_omitted(self) -> None:
        # Planner edge case: a bool / null / int slipping through. The
        # resolver must coerce safely and fall back to default ordering
        # without raising.
        for bad in (None, 0, False, ["wife"], {"name": "wife"}):
            scene = {
                "characters": ["wife"],
                "locations": [],
                "items": [],
                "focal_character": bad,
            }
            refs = shorts._resolve_scene_refs(scene, "base-url", self._gallery())
            self.assertEqual(refs, ["base-url", "wife-ref"], f"focal={bad!r}")


if __name__ == "__main__":
    unittest.main()
