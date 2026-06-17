"""Tests for the hero style thumbnail generator.

Step 3 of _plans/2026-06-17-hero-style-registry.md. The generator is
the one piece of Phase 2 that touches kie + GCS, so the tests cover
the orchestration WITHOUT calling either: every I/O entry point is
injectable, so we mock `images.generate`, `images.download`,
`gcs.publish`, and the setting writer.

What we lock down:
  - Already-saved styles are skipped on the default run; `--force`
    regenerates them.
  - A failed generation on one style does NOT abort the rest of the
    library (partial-success contract).
  - The setting key for each style follows the documented format so
    the Step 4 picker can read it without a separate index.
  - The prompt builder always asks the model to omit text /
    watermarks (defense against the model baking a title into the
    sample — the picker draws the label separately).
"""
from __future__ import annotations

import unittest
from pathlib import Path
from unittest import mock

from pipeline import stages
from pipeline.scripts import generate_hero_style_thumbnails as gen


class SettingKeyTests(unittest.TestCase):
    def test_setting_key_format(self):
        # Picker depends on this exact format; changing it without
        # updating the picker would silently break thumbnail loads.
        self.assertEqual(
            gen.setting_key("neo_noir"),
            "hero.thumbnail.neo_noir",
        )


class BuildPromptTests(unittest.TestCase):
    def test_prompt_includes_style_band_and_subject_cue(self):
        style = stages.HERO_STYLES["neo_noir"]
        out = gen._build_prompt(style)
        # Style band drives the look; subject cue gives the model an
        # actual person to render so the result isn't an abstract
        # composition without a character.
        self.assertIn(style.system_prompt_band, out)
        self.assertIn("Subject:", out)

    def test_prompt_forbids_titles_and_watermarks(self):
        # Thumbnails are previews; baking a title would conflict with
        # the picker drawing the label separately.
        out = gen._build_prompt(stages.HERO_STYLES["comic_book"])
        self.assertIn("No text", out)
        self.assertIn("No title".lower(), out.lower())
        self.assertIn("watermark", out)


class RunOrchestrationTests(unittest.TestCase):
    """Drives `run()` with everything mocked. The interesting branches
    are skip-vs-generate, force, and per-style failures."""

    def setUp(self) -> None:
        # Sandbox path so the generator doesn't touch the real video/ tree.
        self._tmpdir = mock.MagicMock()
        # Settings live in this dict — `get_setting` reads, the mock
        # `set_setting` writes.
        self.settings: dict[str, str] = {}
        # Record calls so tests can verify which styles got generated.
        self.generated_styles: list[str] = []

        def fake_generate(prompt: str, aspect: str) -> str:
            # Return a stable fake URL keyed by a marker in the prompt.
            # We pick the style id off the prompt by looking for a token
            # the style's band contains. Easier: use side_effect list
            # with explicit URLs (set in tests that care).
            return "https://kie.fake/img.png"

        def fake_download(url: str, dest: Path) -> None:
            # Pretend we wrote bytes; tests don't read the file.
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"PNG")

        def fake_publish(local: Path, key: str, fallback: str) -> str:
            return f"https://gcs.fake/{key}"

        def fake_set_setting(key: str, value: str) -> None:
            self.settings[key] = value
            # Also note the style id for assertions
            if key.startswith("hero.thumbnail."):
                self.generated_styles.append(key.removeprefix("hero.thumbnail."))

        def fake_get_setting(key: str) -> str | None:
            return self.settings.get(key)

        self.fake_generate = fake_generate
        self.fake_download = fake_download
        self.fake_publish = fake_publish
        self.fake_set_setting = fake_set_setting
        self.fake_get_setting = fake_get_setting

    def _run(self, *, force: bool = False) -> dict[str, int]:
        return gen.run(
            force=force,
            repo_root=Path("/tmp/hero-styles-test"),
            get_setting=self.fake_get_setting,
            generate_fn=self.fake_generate,
            download_fn=self.fake_download,
            publish_fn=self.fake_publish,
            set_setting_fn=self.fake_set_setting,
        )

    def test_first_run_generates_every_style(self):
        # Empty settings → every style is generated.
        counts = self._run()
        self.assertEqual(counts["generated"], len(stages.HERO_STYLES))
        self.assertEqual(counts["skipped"], 0)
        self.assertEqual(counts["failed"], 0)
        # Every style id has a saved URL after the run.
        for style_id in stages.HERO_STYLES.keys():
            self.assertIn(gen.setting_key(style_id), self.settings)

    def test_second_run_skips_all(self):
        # First populate, then run again with no force — everything skips.
        self._run()
        before_calls = list(self.generated_styles)
        counts = self._run()
        self.assertEqual(counts["generated"], 0)
        self.assertEqual(counts["skipped"], len(stages.HERO_STYLES))
        # set_setting wasn't called again (no new style ids appended).
        self.assertEqual(self.generated_styles, before_calls)

    def test_force_regenerates_even_when_url_is_saved(self):
        # Pre-populate everything.
        for style_id in stages.HERO_STYLES.keys():
            self.settings[gen.setting_key(style_id)] = "https://gcs.fake/old.png"
        self.generated_styles.clear()

        counts = self._run(force=True)
        self.assertEqual(counts["generated"], len(stages.HERO_STYLES))
        self.assertEqual(counts["skipped"], 0)
        # Every style was re-set.
        for style_id in stages.HERO_STYLES.keys():
            self.assertNotEqual(
                self.settings[gen.setting_key(style_id)],
                "https://gcs.fake/old.png",
            )

    def test_empty_string_in_setting_is_treated_as_unset(self):
        # A row with an empty value (e.g. explicit clear) must NOT
        # short-circuit generation — it should re-fire and write a
        # real URL.
        first_style = next(iter(stages.HERO_STYLES.keys()))
        self.settings[gen.setting_key(first_style)] = "   "

        counts = self._run()
        self.assertEqual(counts["generated"], len(stages.HERO_STYLES))
        self.assertEqual(counts["skipped"], 0)
        self.assertTrue(
            self.settings[gen.setting_key(first_style)].startswith("https://"),
        )

    def test_failed_generation_doesnt_kill_the_run(self):
        # Simulate one style failing — others must still complete.
        failing_id = "neo_noir"

        def selective_generate(prompt: str, aspect: str) -> str:
            if stages.HERO_STYLES[failing_id].system_prompt_band in prompt:
                raise RuntimeError("simulated kie failure")
            return "https://kie.fake/img.png"

        counts = gen.run(
            force=False,
            repo_root=Path("/tmp/hero-styles-test"),
            get_setting=self.fake_get_setting,
            generate_fn=selective_generate,
            download_fn=self.fake_download,
            publish_fn=self.fake_publish,
            set_setting_fn=self.fake_set_setting,
        )
        # 1 failure + 5 generated.
        self.assertEqual(counts["failed"], 1)
        self.assertEqual(counts["generated"], len(stages.HERO_STYLES) - 1)
        # The failed style has no URL persisted (didn't reach set_setting).
        self.assertNotIn(gen.setting_key(failing_id), self.settings)

    def test_main_returns_zero_on_clean_skip_run(self):
        # Pre-populate everything, then call main — exit 0 (all skipped
        # is a successful no-op, not a misconfiguration).
        for style_id in stages.HERO_STYLES.keys():
            self.settings[gen.setting_key(style_id)] = "https://gcs.fake/x.png"

        with (
            mock.patch.object(gen.store, "init"),
            mock.patch.object(gen.store, "get_setting", side_effect=self.fake_get_setting),
            mock.patch.object(gen.store, "set_setting", side_effect=self.fake_set_setting),
            mock.patch.object(gen.images, "generate", side_effect=self.fake_generate),
            mock.patch.object(gen.images, "download", side_effect=self.fake_download),
            mock.patch.object(gen.gcs, "publish", side_effect=self.fake_publish),
        ):
            rc = gen.main([])
        self.assertEqual(rc, 0)

    def test_main_returns_one_when_any_generation_failed(self):
        # If one generation fails the exit code MUST be non-zero so CI
        # surfaces the partial-success. (Partial generations DO get
        # persisted; the exit code is just the signal.)
        def selective_generate(prompt: str, aspect: str) -> str:
            if "neo-noir" in prompt.lower():
                raise RuntimeError("simulated kie failure")
            return "https://kie.fake/img.png"

        with (
            mock.patch.object(gen.store, "init"),
            mock.patch.object(gen.store, "get_setting", side_effect=self.fake_get_setting),
            mock.patch.object(gen.store, "set_setting", side_effect=self.fake_set_setting),
            mock.patch.object(gen.images, "generate", side_effect=selective_generate),
            mock.patch.object(gen.images, "download", side_effect=self.fake_download),
            mock.patch.object(gen.gcs, "publish", side_effect=self.fake_publish),
        ):
            rc = gen.main([])
        self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main()
