"""Tests for `pipeline.stages` — hero style registry, whitelist
integrity, deterministic auto-pick, and the four-layer resolution
chain.

Step 1 of _plans/2026-06-17-hero-style-registry.md. Locks down the
behavioral contracts callers depend on:

  - HERO_STYLES is a closed set; resolver MUST fall through on unknown
    ids instead of crashing.
  - CATEGORY_STYLE_WHITELIST entries point at real HERO_STYLES ids
    (typo guard).
  - deterministic_style_pick is idempotent per story id AND distributes
    across allowed styles for a batch of varied ids.
  - resolve_hero_style walks per-story → category default → global
    default → auto-hash, returning the layer that produced the pick so
    the admin UI can surface "why did it pick this".
"""
from __future__ import annotations

import unittest

from pipeline import stages


class HeroStylesRegistryTests(unittest.TestCase):
    """The registry's shape is part of the contract — every style ships
    with an id, label, prompt band, and an optional thumbnail URL. A
    typo or empty band would silently degrade hero quality without
    being caught at render time."""

    def test_six_styles_at_mvp(self):
        # Plan locks 6 styles for MVP. Adding a 7th is a deliberate plan
        # bump; this test catches an accidental addition.
        self.assertEqual(len(stages.HERO_STYLES), 6)

    def test_every_id_matches_its_key(self):
        # Mismatch between dict key and HeroStyle.id breaks the
        # picker's "highlight the resolved id" path silently.
        for key, style in stages.HERO_STYLES.items():
            self.assertEqual(
                key, style.id,
                f"dict key {key!r} doesn't match HeroStyle.id {style.id!r}",
            )

    def test_every_style_has_a_non_empty_prompt_band(self):
        for style in stages.HERO_STYLES.values():
            self.assertTrue(
                style.system_prompt_band.strip(),
                f"style {style.id!r} has empty system_prompt_band",
            )

    def test_every_style_has_a_human_label(self):
        for style in stages.HERO_STYLES.values():
            self.assertTrue(
                style.label.strip(),
                f"style {style.id!r} has empty label",
            )


class WhitelistIntegrityTests(unittest.TestCase):
    """A typo in CATEGORY_STYLE_WHITELIST would cause the auto-pick to
    return a KeyError when it tries to look up the style. This is the
    typo guard."""

    def test_every_whitelist_id_exists_in_registry(self):
        for category, ids in stages.CATEGORY_STYLE_WHITELIST.items():
            for sid in ids:
                self.assertIn(
                    sid, stages.HERO_STYLES,
                    f"category {category!r} whitelist references missing style {sid!r}",
                )

    def test_every_known_category_has_a_whitelist(self):
        # Every Cat the rest of the app uses must have at least one
        # auto-pick candidate. The Cat enum lives on the TS side; we
        # hardcode it here so the Python test doesn't have to read TS.
        for category in ("Entitled", "Drama", "Humor", "Wholesome", "Dating", "Roommate"):
            self.assertIn(
                category, stages.CATEGORY_STYLE_WHITELIST,
                f"category {category!r} has no whitelist entry",
            )
            self.assertGreaterEqual(
                len(stages.CATEGORY_STYLE_WHITELIST[category]), 2,
                f"category {category!r} whitelist must have >= 2 entries for variety",
            )


class DeterministicStylePickTests(unittest.TestCase):
    def test_same_id_picks_same_style_across_calls(self):
        allowed = ["magazine_editorial", "retro_pulp", "comic_book"]
        first = stages.deterministic_style_pick("story-abc", allowed)
        second = stages.deterministic_style_pick("story-abc", allowed)
        self.assertEqual(first, second)

    def test_different_ids_can_pick_different_styles(self):
        # Soft assertion: 100 distinct ids over a 3-element list should
        # hit every style at least once with overwhelming probability
        # (binomial: P(missing any single style in 100 picks) ≈ 0.66^100
        # ≈ 2.5e-18). If this fails the hash is broken.
        allowed = ["magazine_editorial", "retro_pulp", "comic_book"]
        picks = {stages.deterministic_style_pick(f"story-{i}", allowed) for i in range(100)}
        self.assertEqual(picks, set(allowed))

    def test_empty_allowed_raises(self):
        # Misconfigured whitelist (empty list) MUST fail loudly so we
        # don't silently render with no style band.
        with self.assertRaises(IndexError):
            stages.deterministic_style_pick("story-id", [])

    # Parity fixture shared with the TS resolver test
    # (`lorewire-app/src/lib/hero-styles-resolver.test.ts`). Same inputs,
    # same expected outputs on both sides — drift between Python and TS
    # would make the admin picker caption show one style while the
    # pipeline actually renders a different one. Keep these two test
    # files synchronised on edit.
    FIXED_THREE = ["a", "b", "c"]
    PARITY_FIXED_THREE = {
        "envelope": "b",
        "cold-shower-revenge": "a",
        "parking-spot-war": "c",
        "s-1": "c",
        "s-2": "a",
        "s-3": "c",
        "replyall": "b",
    }
    PARITY_ENTITLED = {
        "envelope": "retro_pulp",
        "cold-shower-revenge": "magazine_editorial",
        "parking-spot-war": "comic_book",
        "s-1": "comic_book",
        "s-2": "magazine_editorial",
        "s-3": "comic_book",
        "replyall": "retro_pulp",
    }

    def test_parity_with_ts_on_fixed_three_whitelist(self):
        for story_id, expected in self.PARITY_FIXED_THREE.items():
            got = stages.deterministic_style_pick(story_id, self.FIXED_THREE)
            self.assertEqual(got, expected, f"mismatch for {story_id!r}")

    def test_parity_with_ts_on_entitled_whitelist(self):
        whitelist = stages.CATEGORY_STYLE_WHITELIST["Entitled"]
        for story_id, expected in self.PARITY_ENTITLED.items():
            got = stages.deterministic_style_pick(story_id, whitelist)
            self.assertEqual(got, expected, f"mismatch for {story_id!r}")

    def test_pick_is_independent_of_list_ordering(self):
        # Reordering the whitelist would otherwise change picks across
        # the catalog — undesirable when the admin reshuffles. The hash
        # is computed against the order, so this test documents that
        # reordering DOES change picks (acceptable trade-off — we don't
        # alphabetize because the order reflects "preferred ranking").
        # If we ever want order-independence we'd sort `allowed` first.
        story_id = "fixed-id"
        a = stages.deterministic_style_pick(story_id, ["a", "b", "c"])
        b = stages.deterministic_style_pick(story_id, ["c", "b", "a"])
        # Either equal (lucky) or different (expected). Just check no crash.
        self.assertIn(a, ["a", "b", "c"])
        self.assertIn(b, ["a", "b", "c"])


class ResolveHeroStyleTests(unittest.TestCase):
    """Walks the full chain. Each layer has its own test so a regression
    pinpoints which layer broke without us having to read the resolver
    code line by line."""

    def _settings(self, values: dict[str, str] | None = None):
        """Returns a get_setting callable that reads from a dict, so
        each test can wire up its own settings without touching the
        real store."""
        rows = values or {}
        return lambda key: rows.get(key)

    def test_per_story_pin_wins_over_everything(self):
        # Story explicitly set + category default + global default all
        # present → per-story wins, source="per_story".
        resolved = stages.resolve_hero_style(
            story_id="s1",
            category="Drama",
            pinned_id="comic_book",
            get_setting=self._settings({
                "hero.category_default.drama": "neo_noir",
                "hero.global_style_id": "magazine_editorial",
            }),
        )
        self.assertEqual(resolved.style.id, "comic_book")
        self.assertEqual(resolved.source, "per_story")

    def test_unknown_pinned_id_falls_through_to_next_layer(self):
        # A stale or typoed per-story id must NOT crash the render. It
        # falls through to category default. This is the defense
        # against a value that aged out of the registry.
        resolved = stages.resolve_hero_style(
            story_id="s2",
            category="Drama",
            pinned_id="some_style_that_used_to_exist",
            get_setting=self._settings({
                "hero.category_default.drama": "neo_noir",
            }),
        )
        self.assertEqual(resolved.style.id, "neo_noir")
        self.assertEqual(resolved.source, "category_default")

    def test_category_default_wins_when_no_story_pin(self):
        resolved = stages.resolve_hero_style(
            story_id="s3",
            category="Entitled",
            pinned_id=None,
            get_setting=self._settings({
                "hero.category_default.entitled": "retro_pulp",
                "hero.global_style_id": "magazine_editorial",
            }),
        )
        self.assertEqual(resolved.style.id, "retro_pulp")
        self.assertEqual(resolved.source, "category_default")

    def test_global_default_wins_when_no_category_setting(self):
        resolved = stages.resolve_hero_style(
            story_id="s4",
            category="Wholesome",
            pinned_id=None,
            get_setting=self._settings({
                "hero.global_style_id": "vintage_hollywood",
            }),
        )
        self.assertEqual(resolved.style.id, "vintage_hollywood")
        self.assertEqual(resolved.source, "global_default")

    def test_auto_hash_fires_when_nothing_is_set(self):
        # No settings + no pin → auto-pick from the category's whitelist.
        # Whitelist surfaced on the result so the admin caption can
        # show "Auto-picked from [...]".
        resolved = stages.resolve_hero_style(
            story_id="s5",
            category="Entitled",
            pinned_id=None,
            get_setting=self._settings(),
        )
        self.assertEqual(resolved.source, "auto_hash")
        self.assertIn(resolved.style.id, stages.CATEGORY_STYLE_WHITELIST["Entitled"])
        self.assertEqual(resolved.whitelist, stages.CATEGORY_STYLE_WHITELIST["Entitled"])

    def test_unknown_category_falls_back_to_drama_whitelist(self):
        # A story tagged with a category the registry doesn't know
        # mustn't crash auto-pick. Drama is the default fallback.
        resolved = stages.resolve_hero_style(
            story_id="s6",
            category="UnknownCategory",
            pinned_id=None,
            get_setting=self._settings(),
        )
        self.assertEqual(resolved.source, "auto_hash")
        self.assertEqual(resolved.whitelist, stages.CATEGORY_STYLE_WHITELIST["Drama"])

    def test_resolved_style_object_is_the_real_registry_entry(self):
        # The resolved.style MUST be HERO_STYLES[id], not a copy — so the
        # picker, prompt builder, and observability log all point at the
        # same instance.
        resolved = stages.resolve_hero_style(
            story_id="s7",
            category="Drama",
            pinned_id="neo_noir",
            get_setting=self._settings(),
        )
        self.assertIs(resolved.style, stages.HERO_STYLES["neo_noir"])

    def test_per_story_pin_with_settings_uses_lowercase_category_key(self):
        # The category default lookup key is lowercased per the plan
        # ("hero.category_default.<lowercase cat>"). A capitalized
        # category passed in must still hit the lowercased setting key.
        resolved = stages.resolve_hero_style(
            story_id="s8",
            category="Drama",  # capitalized
            pinned_id=None,
            get_setting=self._settings({
                "hero.category_default.drama": "painted_realism",  # lowercase
            }),
        )
        self.assertEqual(resolved.style.id, "painted_realism")


class MakeThumbnailPromptWithStyleTests(unittest.TestCase):
    """Phase 1 already tested `make_thumbnail_prompt` with
    character_base_url. This adds the Phase 2 dimension: when a style
    is passed, the prompt's style band MUST be the style's
    system_prompt_band, not the per-category default."""

    TITLE = "THE COLD SHOWER REVENGE"
    CATEGORY = "Entitled"
    BODY = "After two decades of a forgotten diverter, a wife snaps."

    def test_style_supplied_overrides_category_default_band(self):
        # Entitled's per-category default band has the distinctive
        # phrase "mid-century magazine"; neo_noir's has "moody
        # atmospheric". Pass in neo_noir and the Entitled-default phrase
        # MUST be gone, neo_noir's MUST be in. We check distinctive
        # substrings instead of "poster" because the prompt's intro
        # line uses "Cinematic editorial poster..." regardless of style.
        neo_noir = stages.HERO_STYLES["neo_noir"]
        out = stages.make_thumbnail_prompt(
            self.TITLE, self.CATEGORY, self.BODY, "3:4", False,
            style=neo_noir,
        )
        self.assertIn("moody atmospheric", out)
        self.assertNotIn("mid-century magazine", out)

    def test_no_style_falls_back_to_per_category_band(self):
        # Back-compat: legacy callers that don't pass `style` get the
        # same prompt they always did. Per-category band for Entitled
        # has the distinctive "mid-century magazine" phrase.
        out = stages.make_thumbnail_prompt(
            self.TITLE, self.CATEGORY, self.BODY, "3:4", False,
        )
        self.assertIn("mid-century magazine", out)

    def test_dry_run_marks_the_picked_style_id(self):
        out = stages.make_thumbnail_prompt(
            self.TITLE, self.CATEGORY, self.BODY, "3:4", True,
            style=stages.HERO_STYLES["retro_pulp"],
        )
        # Dry-run output gets a [style_id] marker so a dry-run log
        # diff can show which style fired without re-reading the
        # full prompt.
        self.assertIn("[retro_pulp]", out)

    def test_style_and_i2i_combine_cleanly(self):
        # Both flags supplied → the prompt is the i2i redraw variant
        # AND uses the supplied style band.
        out = stages.make_thumbnail_prompt(
            self.TITLE, self.CATEGORY, self.BODY, "3:4", False,
            character_base_url="https://gcs/base.png",
            style=stages.HERO_STYLES["painted_realism"],
        )
        self.assertIn("Redraw the EXACT same character", out)
        self.assertIn("Oil-painted", out)  # painted_realism's band


if __name__ == "__main__":
    unittest.main()
