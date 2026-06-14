"""Tests for `pipeline.world_bible` — pure schema/parse/cap helpers.

The LLM-driven build itself isn't tested here (that's an integration
concern in `test_stages.py`); these tests pin the parser, the caps, the
id determinism, and the read-from-config eviction logic that the bulk
scene path depends on.
"""
from __future__ import annotations

import json
import unittest

from pipeline import world_bible as wb


class StableIdTests(unittest.TestCase):
    """The id-from-name function is the load-bearing piece that lets
    `doodle_frames[i].bible_entity_ids` survive a rebuild without
    pointing at stale entries. Same name + kind must always produce
    the same id; different names must produce different ids."""

    def test_same_name_same_kind_same_id(self):
        a = wb._stable_id("char", "Maya")
        b = wb._stable_id("char", "Maya")
        self.assertEqual(a, b)

    def test_name_is_case_and_whitespace_insensitive(self):
        # An LLM rebuild might capitalise differently or add stray
        # whitespace; the id must not split into two entities.
        self.assertEqual(
            wb._stable_id("char", "Maya"),
            wb._stable_id("char", " maya "),
        )

    def test_kind_namespacing_prevents_collision(self):
        # A character and a location can share a name; their ids must
        # not collide because they live in different buckets.
        self.assertNotEqual(
            wb._stable_id("char", "Refuge"),
            wb._stable_id("loc", "Refuge"),
        )

    def test_ids_carry_kind_prefix(self):
        self.assertTrue(wb._stable_id("char", "X").startswith("char_"))
        self.assertTrue(wb._stable_id("loc", "Y").startswith("loc_"))
        self.assertTrue(wb._stable_id("item", "Z").startswith("item_"))
        self.assertTrue(wb._stable_id("sub", "A").startswith("sub_"))


class ClampCuesTests(unittest.TestCase):
    def test_short_string_unchanged(self):
        self.assertEqual(wb._clamp_cues("tall, dark coat"), "tall, dark coat")

    def test_collapses_whitespace(self):
        self.assertEqual(
            wb._clamp_cues("tall,   dark\n\ncoat"),
            "tall, dark coat",
        )

    def test_truncates_above_cap(self):
        raw = "a" * 1000
        out = wb._clamp_cues(raw)
        self.assertTrue(len(out) <= wb.MAX_VISUAL_CUES_CHARS + len("..."))
        self.assertTrue(out.endswith("..."))

    def test_non_string_returns_empty(self):
        for v in (None, 0, [], {}, True):
            self.assertEqual(wb._clamp_cues(v), "", msg=f"value={v!r}")


class ParseCharacterTests(unittest.TestCase):
    def test_clean_entry_parses(self):
        out = wb.parse_character({
            "name": "Maya",
            "role": "lead",
            "visual_cues": "early 30s, dark curly hair, navy cardigan",
        })
        self.assertIsNotNone(out)
        assert out is not None
        self.assertEqual(out["name"], "Maya")
        self.assertEqual(out["role"], "lead")
        self.assertTrue(out["id"].startswith("char_"))
        self.assertIsNone(out["reference_image_url"])

    def test_reference_url_passes_through(self):
        out = wb.parse_character({
            "name": "Maya",
            "visual_cues": "tall",
            "reference_image_url": "https://example.test/maya.png",
        })
        assert out is not None
        self.assertEqual(out["reference_image_url"], "https://example.test/maya.png")

    def test_missing_name_returns_none(self):
        self.assertIsNone(wb.parse_character({"visual_cues": "tall"}))
        self.assertIsNone(wb.parse_character({"name": "", "visual_cues": "tall"}))

    def test_missing_cues_returns_none(self):
        # Without visual_cues there's nothing for kie to ground a
        # prompt or a ref-image on; treat as malformed.
        self.assertIsNone(wb.parse_character({"name": "Maya"}))

    def test_invalid_role_falls_through_to_default(self):
        out = wb.parse_character(
            {"name": "Maya", "visual_cues": "tall", "role": "antagonist"},
        )
        assert out is not None
        self.assertEqual(out["role"], "supporting")

    def test_sub_character_default_role_is_background(self):
        out = wb.parse_character(
            {"name": "Doorman", "visual_cues": "gray uniform"},
            default_role="background",
        )
        assert out is not None
        self.assertEqual(out["role"], "background")
        # Sub-character ids namespace under "sub_" not "char_" so they
        # can never collide with main characters.
        self.assertTrue(out["id"].startswith("sub_"))


class ParseLocationTests(unittest.TestCase):
    def test_clean_entry_parses(self):
        out = wb.parse_location({
            "name": "open_office",
            "visual_cues": "cubicles, fluorescent lighting",
        })
        assert out is not None
        self.assertEqual(out["name"], "open_office")
        self.assertTrue(out["id"].startswith("loc_"))

    def test_missing_fields_returns_none(self):
        self.assertIsNone(wb.parse_location({"name": "x"}))
        self.assertIsNone(wb.parse_location({"visual_cues": "x"}))


class ParseItemTests(unittest.TestCase):
    def test_clean_entry_parses(self):
        out = wb.parse_item({"name": "envelope", "visual_cues": "manila, worn"})
        assert out is not None
        self.assertTrue(out["id"].startswith("item_"))
        # Items have no reference_image_url in the v1 schema — confirm
        # the parser doesn't accidentally pass it through.
        self.assertNotIn("reference_image_url", out)


class ParseWorldBibleTests(unittest.TestCase):
    """End-to-end parsing of the LLM's JSON blob. The whole-bible
    parser is the surface every caller hits, so it must be resilient
    to half-malformed input — one bad locations list should NOT kill
    the rest of the bible."""

    def _fixture(self) -> dict:
        return {
            "characters": [
                {"name": "Maya", "role": "lead", "visual_cues": "30s, curly hair"},
                {"name": "Greg", "role": "supporting", "visual_cues": "40s, beard"},
            ],
            "sub_characters": [
                {"name": "Security", "visual_cues": "uniform"},
            ],
            "locations": [
                {"name": "office", "visual_cues": "cubicles"},
                {"name": "alley", "visual_cues": "dim, brick"},
            ],
            "items": [
                {"name": "envelope", "visual_cues": "manila"},
            ],
        }

    def test_clean_fixture_round_trips(self):
        bible = wb.parse_world_bible(self._fixture())
        assert bible is not None
        self.assertEqual(bible["built_with"], wb.WORLD_BIBLE_BUILT_WITH)
        self.assertEqual(len(bible["characters"]), 2)
        self.assertEqual(len(bible["sub_characters"]), 1)
        self.assertEqual(len(bible["locations"]), 2)
        self.assertEqual(len(bible["items"]), 1)

    def test_non_dict_returns_none(self):
        for v in ("string", [1, 2], None, 42):
            self.assertIsNone(wb.parse_world_bible(v), msg=f"value={v!r}")

    def test_missing_lists_become_empty(self):
        bible = wb.parse_world_bible({"characters": [{"name": "M", "visual_cues": "x"}]})
        assert bible is not None
        self.assertEqual(len(bible["characters"]), 1)
        self.assertEqual(bible["sub_characters"], [])
        self.assertEqual(bible["locations"], [])
        self.assertEqual(bible["items"], [])

    def test_caps_enforced(self):
        many_chars = [
            {"name": f"C{i}", "visual_cues": "x"} for i in range(10)
        ]
        many_locs = [
            {"name": f"L{i}", "visual_cues": "x"} for i in range(10)
        ]
        many_items = [
            {"name": f"I{i}", "visual_cues": "x"} for i in range(10)
        ]
        bible = wb.parse_world_bible({
            "characters": many_chars,
            "locations": many_locs,
            "items": many_items,
        })
        assert bible is not None
        self.assertEqual(len(bible["characters"]), wb.MAX_CHARACTERS)
        self.assertEqual(len(bible["locations"]), wb.MAX_LOCATIONS)
        self.assertEqual(len(bible["items"]), wb.MAX_ITEMS)

    def test_promotes_first_to_lead_when_none_marked(self):
        # The LLM forgot to mark a lead — we still need one for the
        # hero gen / ref selection logic, so the first character is
        # promoted.
        bible = wb.parse_world_bible({
            "characters": [
                {"name": "A", "role": "supporting", "visual_cues": "x"},
                {"name": "B", "role": "supporting", "visual_cues": "y"},
            ],
        })
        assert bible is not None
        self.assertEqual(bible["characters"][0]["role"], "lead")
        self.assertEqual(bible["characters"][1]["role"], "supporting")

    def test_dedupes_by_id(self):
        bible = wb.parse_world_bible({
            "characters": [
                {"name": "Maya", "visual_cues": "x"},
                {"name": " maya ", "visual_cues": "y"},  # case+whitespace match → same id
            ],
        })
        assert bible is not None
        self.assertEqual(len(bible["characters"]), 1)


class LeadCharacterTests(unittest.TestCase):
    def test_returns_lead_when_marked(self):
        bible = {
            "characters": [
                {"id": "char_a", "name": "A", "role": "supporting", "visual_cues": "x"},
                {"id": "char_b", "name": "B", "role": "lead", "visual_cues": "y"},
            ],
        }
        out = wb.lead_character(bible)
        assert out is not None
        self.assertEqual(out["name"], "B")

    def test_falls_back_to_first_when_no_lead(self):
        bible = {
            "characters": [
                {"id": "char_a", "name": "A", "role": "supporting", "visual_cues": "x"},
            ],
        }
        out = wb.lead_character(bible)
        assert out is not None
        self.assertEqual(out["name"], "A")

    def test_returns_none_on_empty(self):
        self.assertIsNone(wb.lead_character(None))
        self.assertIsNone(wb.lead_character({}))
        self.assertIsNone(wb.lead_character({"characters": []}))


class EntitiesByIdsTests(unittest.TestCase):
    def test_resolves_across_buckets(self):
        bible = {
            "characters": [{"id": "char_a", "name": "A", "visual_cues": "x"}],
            "sub_characters": [{"id": "sub_b", "name": "B", "visual_cues": "y"}],
            "locations": [{"id": "loc_c", "name": "C", "visual_cues": "z"}],
            "items": [{"id": "item_d", "name": "D", "visual_cues": "w"}],
        }
        out = wb.entities_by_ids(bible, ["char_a", "loc_c", "item_d"])
        self.assertEqual([e["id"] for e in out], ["char_a", "loc_c", "item_d"])

    def test_drops_unknown_ids(self):
        bible = {"characters": [{"id": "char_a", "name": "A", "visual_cues": "x"}]}
        out = wb.entities_by_ids(bible, ["char_a", "char_missing"])
        self.assertEqual([e["id"] for e in out], ["char_a"])

    def test_empty_bible_returns_empty(self):
        self.assertEqual(wb.entities_by_ids(None, ["x"]), [])


class ReferenceUrlsTests(unittest.TestCase):
    def test_collects_non_empty(self):
        out = wb.reference_urls([
            {"reference_image_url": "https://a"},
            {"reference_image_url": None},  # ref-gen failed
            {"reference_image_url": "https://b"},
            {"reference_image_url": "   "},  # whitespace-only
            {"name": "no ref field"},
        ])
        self.assertEqual(out, ["https://a", "https://b"])


class ReadWorldBibleTests(unittest.TestCase):
    """Reading the bible off `pipeline_cache` is what gates "cache hit
    vs rebuild" in the regen path. Marker mismatch must produce None
    so the bulk path rebuilds — that's the migration story from the
    previous narration_v1 cache shape.

    2026-06-14: moved off `video_config` into the new `pipeline_cache`
    column. `read_world_bible` keeps a fallback peek into `video_config`
    so stories persisted before the column split still hit cache once on
    first read; that fallback is the transition net and goes away after
    the migration has run across all environments. See
    `_plans/2026-06-14-pipeline-cache-column.md`.
    """

    def _story_with_cache(self, cache: dict) -> dict:
        return {"pipeline_cache": json.dumps(cache)}

    def _story_with_legacy_video_config(self, config: dict) -> dict:
        return {"video_config": json.dumps(config)}

    def test_matching_marker_returns_bible(self):
        story = self._story_with_cache({
            "world_bible": {
                "built_with": wb.WORLD_BIBLE_BUILT_WITH,
                "characters": [],
                "sub_characters": [],
                "locations": [],
                "items": [],
            },
        })
        out = wb.read_world_bible(story)
        self.assertIsNotNone(out)

    def test_wrong_marker_returns_none(self):
        # Pre-Option-C cache shape — caller treats this as a miss and
        # rebuilds. That's the migration path from narration_v1 onto
        # world_bible_v1.
        story = self._story_with_cache({
            "world_bible": {
                "built_with": "narration_v1",
                "characters": [],
            },
        })
        self.assertIsNone(wb.read_world_bible(story))

    def test_missing_bible_returns_none(self):
        story = self._story_with_cache({"scene_prompts": ["..."]})
        self.assertIsNone(wb.read_world_bible(story))

    def test_malformed_json_returns_none(self):
        self.assertIsNone(wb.read_world_bible({"pipeline_cache": "{not json"}))

    def test_none_story_returns_none(self):
        self.assertIsNone(wb.read_world_bible(None))
        self.assertIsNone(wb.read_world_bible({"pipeline_cache": None}))

    def test_legacy_video_config_fallback_still_hits(self):
        # Backward-compat: a story persisted before 2026-06-14 still has
        # its bible inside video_config. The read path falls back so the
        # first post-deploy regen hits cache; the next persist writes to
        # pipeline_cache and the fallback becomes dormant for that row.
        story = self._story_with_legacy_video_config({
            "world_bible": {
                "built_with": wb.WORLD_BIBLE_BUILT_WITH,
                "characters": [],
                "sub_characters": [],
                "locations": [],
                "items": [],
            },
        })
        out = wb.read_world_bible(story)
        self.assertIsNotNone(out)

    def test_pipeline_cache_wins_when_both_columns_have_bible(self):
        # During the dual-write transition, the canonical source is
        # pipeline_cache. A mismatched bible in video_config (e.g. left
        # behind by an incomplete migration run) MUST be ignored so the
        # editor's residual stomping can never resurface.
        story = {
            "pipeline_cache": json.dumps({
                "world_bible": {
                    "built_with": wb.WORLD_BIBLE_BUILT_WITH,
                    "characters": [{"id": "ab", "name": "Alice"}],
                    "sub_characters": [],
                    "locations": [],
                    "items": [],
                },
            }),
            "video_config": json.dumps({
                "world_bible": {
                    "built_with": wb.WORLD_BIBLE_BUILT_WITH,
                    "characters": [{"id": "zz", "name": "Stale"}],
                    "sub_characters": [],
                    "locations": [],
                    "items": [],
                },
            }),
        }
        out = wb.read_world_bible(story)
        self.assertIsNotNone(out)
        self.assertEqual(out["characters"][0]["name"], "Alice")


if __name__ == "__main__":
    unittest.main()
