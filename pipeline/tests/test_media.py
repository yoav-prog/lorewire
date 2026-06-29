"""Tests for pipeline.media: id sanitization, filename pattern, cost math.

Pure-logic only. No network. The provider integrations were verified end to end
against the live APIs in the previous session; what we guard here is the math
and the parts that touch the filesystem path machinery.
"""
from __future__ import annotations

import os
import unittest
from unittest import mock

from pipeline import images, media


class SanitizeIdTests(unittest.TestCase):
    def test_accepts_typical_reddit_id(self):
        self.assertEqual(media._sanitize_id("1abc23x"), "1abc23x")

    def test_accepts_letters_digits_underscore_dash(self):
        self.assertEqual(media._sanitize_id("A_b-9"), "A_b-9")

    def test_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            media._sanitize_id("../etc/passwd")

    def test_rejects_path_separators(self):
        for bad in ("foo/bar", "foo\\bar"):
            with self.assertRaises(ValueError):
                media._sanitize_id(bad)

    def test_rejects_empty(self):
        with self.assertRaises(ValueError):
            media._sanitize_id("")

    def test_rejects_unicode(self):
        with self.assertRaises(ValueError):
            media._sanitize_id("café")

    def test_rejects_too_long(self):
        with self.assertRaises(ValueError):
            media._sanitize_id("a" * 65)


class ImageFilenameTests(unittest.TestCase):
    def test_index_zero_is_hero(self):
        self.assertEqual(media._image_filename(0), "hero.png")

    def test_higher_indexes_are_scenes(self):
        self.assertEqual(media._image_filename(1), "scene-1.png")
        self.assertEqual(media._image_filename(3), "scene-3.png")


class GenerateWithRetryErrorSidechannelTests(unittest.TestCase):
    """`_generate_with_retry` returns None on failure; the upstream exception
    text is stashed on `_LAST_KIE_ERROR` so callers can include it in the
    admin timeline's `kie_failed` event (read via `last_kie_error()`).

    Plan: _plans/2026-06-23-pipeline-outbound-url-rewriter.md."""

    def test_failure_stashes_exception_text(self):
        with mock.patch.object(
            images, "generate", side_effect=RuntimeError("kie task t-1 failed: bad URL")
        ):
            url = media._generate_with_retry("prompt", "id=x")
        self.assertIsNone(url)
        self.assertEqual(
            media.last_kie_error(), "kie task t-1 failed: bad URL"
        )

    def test_success_clears_previous_error(self):
        # First call fails — sidechannel carries the error.
        with mock.patch.object(images, "generate", side_effect=RuntimeError("first")):
            self.assertIsNone(media._generate_with_retry("p", "id=x"))
        self.assertEqual(media.last_kie_error(), "first")

        # Second call succeeds — sidechannel resets to None so a future
        # caller can't read a stale error from a previous unrelated call.
        with mock.patch.object(images, "generate", return_value="https://kie/out.png"):
            self.assertEqual(
                media._generate_with_retry("p", "id=x"),
                "https://kie/out.png",
            )
        self.assertIsNone(media.last_kie_error())

    def test_retry_reports_last_exception(self):
        # Both attempts fail with different messages — the FINAL one is what
        # the sidechannel carries (matches the human-readable log line).
        with mock.patch.object(
            images,
            "generate",
            side_effect=[RuntimeError("first"), RuntimeError("second")],
        ):
            self.assertIsNone(media._generate_with_retry("p", "id=x", attempts=2))
        self.assertEqual(media.last_kie_error(), "second")

    def test_quota_error_short_circuits_retry(self):
        """A kie.ai 433 daily-cap error is unrecoverable inside the same
        tick — kie's points budget is wall-clock-bound and a second
        createTask just burns another round-trip to confirm the same
        rejection. `_generate_with_retry` must bail after the FIRST
        attempt when the upstream error carries the 433 marker, not the
        normal 2-attempt loop. Without this short-circuit a 5-variant
        finisher (hero+thumbnail) wastes 5 extra API calls confirming
        the same wall.
        """
        # Use a generator side_effect so we can assert exactly how many
        # times images.generate was invoked — the second call should not
        # happen on a quota error.
        quota_err = RuntimeError(
            "kie createTask failed: {'code': 433, 'msg': 'The current "
            "number of points used by apiKey has exceeded the daily limit', "
            "'data': None}"
        )
        with mock.patch.object(images, "generate") as gen:
            gen.side_effect = quota_err
            self.assertIsNone(media._generate_with_retry("p", "id=x", attempts=2))
            # Only ONE call despite attempts=2 — the quota error short-
            # circuited the retry.
            self.assertEqual(gen.call_count, 1)
        # Both the raw error AND the kind sidechannel are set so callers
        # can either show the verbatim kie text or branch on `last_kie_error_kind`.
        self.assertIn("code': 433", media.last_kie_error())
        self.assertEqual(media.last_kie_error_kind(), "quota")

    def test_quota_kind_drives_user_friendly_msg(self):
        """`_kie_failed_msg` rewrites the event's user-facing text when
        the upstream failure was a 433 cap, so the admin sees a quota
        notice instead of the generic "returned no URL after retries"
        that previously made the failure look transient.
        """
        quota_err = RuntimeError(
            "kie createTask failed: {'code': 433, 'msg': 'exceeded the daily limit'}"
        )
        with mock.patch.object(images, "generate", side_effect=quota_err):
            media._generate_with_retry("p", "id=x")
        self.assertEqual(media.last_kie_error_kind(), "quota")
        msg = media._kie_failed_msg("Portrait i2i generation")
        self.assertIn("kie.ai daily points cap", msg)
        self.assertIn("Portrait i2i generation", msg)

    def test_generic_kind_keeps_legacy_msg(self):
        """Non-quota failures keep the existing wording so existing log
        searches / admin-eye patterns are not disturbed."""
        with mock.patch.object(
            images, "generate", side_effect=RuntimeError("connection reset")
        ):
            media._generate_with_retry("p", "id=x")
        self.assertEqual(media.last_kie_error_kind(), "generic")
        self.assertEqual(
            media._kie_failed_msg("Portrait i2i generation"),
            "Portrait i2i generation returned no URL after retries",
        )

    def test_quota_kind_resets_on_success(self):
        """A successful call must clear `kind` along with `msg`, so a
        later unrelated failure doesn't read as quota by mistake."""
        with mock.patch.object(
            images,
            "generate",
            side_effect=RuntimeError(
                "kie createTask failed: {'code': 433, 'msg': 'exceeded the daily limit'}"
            ),
        ):
            media._generate_with_retry("p", "id=x")
        self.assertEqual(media.last_kie_error_kind(), "quota")

        with mock.patch.object(images, "generate", return_value="https://kie/x.png"):
            media._generate_with_retry("p", "id=x")
        self.assertIsNone(media.last_kie_error())
        self.assertIsNone(media.last_kie_error_kind())


class StoryCostCentsTests(unittest.TestCase):
    def test_google_chirp_default_stack(self):
        # 4 images * $0.05 (kie/gpt-image-2) + 1800 chars * $30/1M (chirp HD)
        # + 150s * ($0.024/60) STT = 0.20 + 0.054 + 0.06 = 0.314 -> 31 cents
        with mock.patch("pipeline.media.models.get_selected") as get:
            get.side_effect = lambda stage: {"images": "kie/gpt-image-2", "voice": "google/chirp3-hd"}[stage]
            self.assertEqual(media._story_cost_cents(4, 1800, 150.0), 31)

    def test_elevenlabs_stack(self):
        # 4 * 0.05 + 1800 * 300e-6 (ElevenLabs Starter) = 0.20 + 0.54 = 0.74 -> 74 cents
        with mock.patch("pipeline.media.models.get_selected") as get:
            get.side_effect = lambda stage: {"images": "kie/gpt-image-2", "voice": "elevenlabs/default"}[stage]
            self.assertEqual(media._story_cost_cents(4, 1800, 0.0), 74)

    def test_unknown_voice_falls_back_to_zero_voice_cost(self):
        with mock.patch("pipeline.media.models.get_selected") as get:
            get.side_effect = lambda stage: {"images": "kie/gpt-image-2", "voice": "azure/neural"}[stage]
            self.assertEqual(media._story_cost_cents(4, 1800, 0.0), 20)


class MouthSwapEnabledTests(unittest.TestCase):
    """Wave 3 Phase 3 (slice 3): the MouthSwap beat reads `video.mouth_swap`
    through the same truthy parser the other motion flags use. The test
    locks the key + parser parity so a typo in /admin/settings never
    accidentally turns the (paid) character generation on."""

    def _with_setting(self, value):
        return mock.patch("pipeline.media.store.get_setting", return_value=value)

    def test_truthy_values_enable(self):
        for v in ("1", "true", "TRUE", "  on ", "yes"):
            with self._with_setting(v):
                self.assertTrue(media._mouth_swap_enabled(), f"expected enabled: {v!r}")

    def test_falsy_values_disable(self):
        for v in (None, "", "0", "false", "off", "no", "maybe"):
            with self._with_setting(v):
                self.assertFalse(media._mouth_swap_enabled(), f"expected disabled: {v!r}")

    def test_reads_the_mouth_swap_key(self):
        with mock.patch("pipeline.media.store.get_setting") as get:
            get.return_value = "1"
            media._mouth_swap_enabled()
            get.assert_called_with("video.mouth_swap")


class FormatDurationMsTests(unittest.TestCase):
    def test_sub_minute_pads_seconds_to_two_digits(self):
        self.assertEqual(media._format_duration_ms(28_400), "0:28")
        self.assertEqual(media._format_duration_ms(5_000), "0:05")

    def test_multi_minute(self):
        self.assertEqual(media._format_duration_ms(75_000), "1:15")
        self.assertEqual(media._format_duration_ms(134_000), "2:14")

    def test_rounds_up_at_minute_boundary(self):
        # 59.6s rounds the seconds to 60; the helper must roll that into
        # the minute count instead of emitting a malformed "0:60".
        self.assertEqual(media._format_duration_ms(59_600), "1:00")
        self.assertEqual(media._format_duration_ms(119_600), "2:00")

    def test_returns_none_for_zero_negative_or_non_numeric(self):
        self.assertIsNone(media._format_duration_ms(0))
        self.assertIsNone(media._format_duration_ms(-1))
        self.assertIsNone(media._format_duration_ms(None))
        self.assertIsNone(media._format_duration_ms("nope"))


class ShortDurationFromPropsTests(unittest.TestCase):
    def test_pulls_duration_from_json_string(self):
        props = '{"duration_ms": 47000}'
        self.assertEqual(media._short_duration_from_props(props), "0:47")

    def test_pulls_duration_from_already_decoded_dict(self):
        # Some Postgres adapters auto-decode JSON columns; we accept the
        # dict form so the caller doesn't need to know which driver is
        # active.
        self.assertEqual(
            media._short_duration_from_props({"duration_ms": 30_000}),
            "0:30",
        )

    def test_missing_duration_ms_returns_none(self):
        self.assertIsNone(media._short_duration_from_props('{"other": 1}'))
        self.assertIsNone(media._short_duration_from_props("{}"))

    def test_unparseable_or_wrong_shape_returns_none(self):
        self.assertIsNone(media._short_duration_from_props(None))
        self.assertIsNone(media._short_duration_from_props("{not json}"))
        self.assertIsNone(media._short_duration_from_props(42))
        self.assertIsNone(media._short_duration_from_props("[1, 2, 3]"))


class ParseDurationTests(unittest.TestCase):
    def test_minute_second_format(self):
        self.assertEqual(media._parse_duration_to_seconds("2:14"), 134.0)
        self.assertEqual(media._parse_duration_to_seconds("0:30"), 30.0)
        self.assertEqual(media._parse_duration_to_seconds("10:00"), 600.0)

    def test_hour_minute_second_format(self):
        self.assertEqual(media._parse_duration_to_seconds("1:00:00"), 3600.0)
        self.assertEqual(media._parse_duration_to_seconds("0:01:30"), 90.0)

    def test_none_and_empty(self):
        self.assertIsNone(media._parse_duration_to_seconds(None))
        self.assertIsNone(media._parse_duration_to_seconds(""))
        self.assertIsNone(media._parse_duration_to_seconds("   "))

    def test_malformed_falls_through(self):
        for bad in ("abc", "2:bad", "-1:30", "::", "1:2:3:4"):
            self.assertIsNone(
                media._parse_duration_to_seconds(bad),
                msg=f"expected None for {bad!r}",
            )


class EstimateDurationTests(unittest.TestCase):
    def test_uses_duration_string_when_present(self):
        # Audio duration beats word-count estimate every time.
        self.assertEqual(
            media._estimate_duration_seconds("just three words", "1:30"),
            90.0,
        )

    def test_falls_through_to_word_count_at_150_wpm(self):
        # 250 words at 150 wpm ≈ 100s. Helper uses 2.5 words/sec.
        body = " ".join(["word"] * 250)
        self.assertAlmostEqual(
            media._estimate_duration_seconds(body, None),
            100.0,
            places=1,
        )

    def test_blank_body_and_no_duration_returns_zero(self):
        self.assertEqual(media._estimate_duration_seconds("", None), 0.0)
        self.assertEqual(media._estimate_duration_seconds(None, None), 0.0)


class AutoSceneCountTests(unittest.TestCase):
    def test_short_video_picks_floor_when_too_few(self):
        with mock.patch("pipeline.media.store.get_setting") as gs:
            gs.return_value = None
            # 10 seconds at 5s/scene = 2 -> clamped up to SCENE_COUNT_MIN.
            self.assertEqual(media._auto_scene_count(10.0), media.SCENE_COUNT_MIN)

    def test_medium_video_picks_proportional(self):
        with mock.patch("pipeline.media.store.get_setting") as gs:
            gs.return_value = None  # use default 5s/scene
            self.assertEqual(media._auto_scene_count(60.0), 12)
            self.assertEqual(media._auto_scene_count(120.0), 24)
            self.assertEqual(media._auto_scene_count(150.0), 30)

    def test_very_long_video_clamps_at_ceiling(self):
        with mock.patch("pipeline.media.store.get_setting") as gs:
            gs.return_value = None
            # 1000s / 5 = 200 -> capped at SCENE_COUNT_MAX.
            self.assertEqual(media._auto_scene_count(1000.0), media.SCENE_COUNT_MAX)

    def test_admin_target_changes_density(self):
        with mock.patch("pipeline.media.store.get_setting") as gs:
            gs.return_value = "3"  # one scene every 3s — denser cuts
            # 60s / 3 = 20 scenes
            self.assertEqual(media._auto_scene_count(60.0), 20)

    def test_target_setting_clamped_to_safe_range(self):
        with mock.patch("pipeline.media.store.get_setting") as gs:
            # Wildly small target would explode the scene count; clamp it.
            gs.return_value = "0.1"
            # target -> SCENE_TARGET_SECONDS_PER_SCENE_MIN (1.0) -> 60s / 1 = 60
            self.assertEqual(media._auto_scene_count(60.0), media.SCENE_COUNT_MAX)
            # Wildly large target -> long shots, scene count drops.
            gs.return_value = "1000"
            # target -> SCENE_TARGET_SECONDS_PER_SCENE_MAX (30) -> 60s / 30 = 2 -> floor
            self.assertEqual(media._auto_scene_count(60.0), media.SCENE_COUNT_MIN)

    def test_zero_duration_returns_default(self):
        # Defensive: duration unknown -> use the configured default.
        with mock.patch("pipeline.media.store.get_setting") as gs:
            gs.return_value = None
            self.assertEqual(
                media._auto_scene_count(0.0), media.DEFAULT_SCENE_COUNT
            )


class ResolveSceneCountTests(unittest.TestCase):
    """Verifies the precedence chain: override > manual mode > auto mode.
    Back-compat: the legacy `media.scene_count` setting MUST still win
    over the auto path when mode='manual'."""

    def test_explicit_override_wins_over_everything(self):
        with mock.patch("pipeline.media.store.get_setting") as gs:
            gs.return_value = "auto"
            # Override is honored regardless of mode.
            self.assertEqual(media._resolve_scene_count(45), 45)

    def test_override_clamped_to_safe_range(self):
        self.assertEqual(media._resolve_scene_count(1), media.SCENE_COUNT_MIN)
        self.assertEqual(media._resolve_scene_count(9999), media.SCENE_COUNT_MAX)

    def test_manual_mode_uses_media_scene_count(self):
        store: dict[str, str] = {
            "media.scene_count_mode": "manual",
            "media.scene_count": "42",
        }
        with mock.patch("pipeline.media.store.get_setting") as gs:
            gs.side_effect = lambda k: store.get(k)
            self.assertEqual(media._resolve_scene_count(None), 42)

    def test_manual_mode_with_no_setting_falls_back_to_default(self):
        store: dict[str, str] = {"media.scene_count_mode": "manual"}
        with mock.patch("pipeline.media.store.get_setting") as gs:
            gs.side_effect = lambda k: store.get(k)
            self.assertEqual(
                media._resolve_scene_count(None), media.DEFAULT_SCENE_COUNT
            )

    def test_auto_mode_with_story_duration(self):
        store_settings: dict[str, str | None] = {
            "media.scene_count_mode": "auto",
        }
        with mock.patch("pipeline.media.store.get_setting") as gs:
            gs.side_effect = lambda k: store_settings.get(k)
            story = {"duration": "2:30", "body": "anything"}
            # 150s / 5s = 30 scenes
            self.assertEqual(media._resolve_scene_count(None, story=story), 30)

    def test_auto_mode_with_body_estimate(self):
        store_settings: dict[str, str | None] = {
            "media.scene_count_mode": "auto",
        }
        body = " ".join(["word"] * 250)  # ~100s
        with mock.patch("pipeline.media.store.get_setting") as gs:
            gs.side_effect = lambda k: store_settings.get(k)
            # 100s / 5s = 20 scenes
            self.assertEqual(media._resolve_scene_count(None, body=body), 20)

    def test_mode_unset_defaults_to_auto(self):
        # Back-compat: an empty / missing mode setting reads as auto so
        # admins who haven't touched the new setting get the new default.
        with mock.patch("pipeline.media.store.get_setting") as gs:
            gs.return_value = None
            body = " ".join(["word"] * 250)
            self.assertEqual(media._resolve_scene_count(None, body=body), 20)


class StagingDirTests(unittest.TestCase):
    """Regression for the read-only-filesystem crash that hit production
    on 2026-06-14: the Vercel cron drain claimed a media job, called
    generate_media, which tried to mkdir under repo_root —
    `/var/task/api/_lib/lorewire-app/public/generated/...` — which is
    read-only on Vercel's runtime. The helper now routes intermediate
    files to /tmp/lorewire/ when VERCEL=1 is set."""

    def test_vercel_env_routes_to_tmp(self):
        from pathlib import Path
        import tempfile
        with mock.patch.dict(os.environ, {"VERCEL": "1"}, clear=False):
            path = media._staging_dir("abc", Path("/var/task/api/_lib"))
        expected_parent = Path(tempfile.gettempdir()) / "lorewire" / "generated"
        self.assertEqual(path, expected_parent / "abc")
        # Path must actually be mkdir-able — this is the assertion that
        # would have caught the prod crash if it had existed earlier.
        path.mkdir(parents=True, exist_ok=True)
        self.assertTrue(path.exists())

    def test_no_vercel_env_uses_repo_root(self):
        from pathlib import Path
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("VERCEL", None)
            path = media._staging_dir("abc", Path("/repo"))
        self.assertEqual(
            path,
            Path("/repo") / "lorewire-app" / "public" / "generated" / "abc",
        )

    def test_blank_vercel_env_treated_as_unset(self):
        """Defensive: VERCEL='' falls through to the local-dev path —
        bool('') is False, the helper's os.environ.get() returns '' which
        is falsy."""
        from pathlib import Path
        with mock.patch.dict(os.environ, {"VERCEL": ""}, clear=False):
            path = media._staging_dir("abc", Path("/repo"))
        self.assertEqual(
            path,
            Path("/repo") / "lorewire-app" / "public" / "generated" / "abc",
        )


class GenerateMediaSkipFlagsTests(unittest.TestCase):
    """Verify the two skip flags on `generate_media` actually short-circuit
    the right cost centers (plans:
    _plans/2026-06-19-reddit-source-auto-deliver-article-short-hero-thumbnail.md
    _plans/2026-06-19-no-long-form-video-for-reddit-jobs.md).

    The Reddit-source worker passes BOTH skip_hero=True and
    skip_long_form_scenes=True, so the total kie image calls must be
    ZERO — the hero is built later by the finisher, and the scenes
    come from the short. Heavy mocking is intentional: the goal is
    to exercise the GATING, not the rest of the pipeline."""

    def setUp(self) -> None:
        # Patches that prevent any real network / disk / config read.
        # Each stub returns the minimum the function needs to keep going.
        from pathlib import Path
        self._tmpdir = Path(__file__).parent / "_tmp_skip_flags"
        self._tmpdir.mkdir(exist_ok=True)
        # Patch order: the narration step happens AFTER the hero+scene
        # loops. We stub it to a quick no-op so the function can return
        # without touching real TTS infra.
        self._stack = [
            # 3 prompts: first is the fallback hero (dropped by media.py), the
            # other 2 are scene prompts. So default path = 2 hero variants + 2
            # scene generations = 4 kie calls.
            mock.patch.object(media.stages, "make_image_prompts", return_value=["p0", "p1", "p2"]),
            mock.patch.object(media, "_resolve_scene_count", return_value=2),
            mock.patch.object(media, "_generate_with_retry", return_value="https://kie/img.png"),
            mock.patch.object(media.images, "download"),
            mock.patch.object(media.gcs, "publish", side_effect=lambda local, key, url: url),
            mock.patch.object(media.models, "get_selected", return_value="kie/gpt-image-2"),
            mock.patch.object(media.narration, "render_narration",
                              return_value={"words": [], "spoken_script": "", "provider": "stub"}),
            mock.patch.object(media, "_budget_log"),
            mock.patch.object(media, "_staging_dir", return_value=self._tmpdir),
            mock.patch.object(media, "_prop_slide_enabled", return_value=False),
            mock.patch.object(media, "_mouth_swap_enabled", return_value=False),
        ]
        self._mocks = [p.start() for p in self._stack]
        self.gen_mock = self._mocks[2]  # _generate_with_retry

    def tearDown(self) -> None:
        for p in self._stack:
            p.stop()

    def _call(self, **kwargs):
        from pathlib import Path
        return media.generate_media(
            "id1",
            {"reddit_id": "id1", "category": "Drama", "headline": "T"},
            "Some body.",
            "Title",
            False,
            repo_root=Path("/repo"),
            **kwargs,
        )

    def test_default_path_calls_kie_for_hero_and_scenes(self):
        # Without the skip flags the gates are open: hero (2 variants) +
        # 2 scene prompts = 4 kie calls.
        self._call()
        self.assertEqual(self.gen_mock.call_count, 4)

    def test_skip_hero_drops_hero_kie_calls(self):
        # Hero gone, 2 scene calls remain.
        self._call(skip_hero=True)
        self.assertEqual(self.gen_mock.call_count, 2)

    def test_skip_long_form_scenes_drops_scene_kie_calls(self):
        # Scene loop gone, 2 hero calls remain.
        self._call(skip_long_form_scenes=True)
        self.assertEqual(self.gen_mock.call_count, 2)

    def test_both_skip_flags_zero_kie_calls(self):
        # The Reddit-source worker path: zero paid kie image gen here.
        out = self._call(skip_hero=True, skip_long_form_scenes=True)
        self.assertEqual(self.gen_mock.call_count, 0)
        # And the returned dict has no "images" key so the caller's
        # store.upsert_story doesn't overwrite the column with an empty
        # JSON list.
        self.assertNotIn("images", out)

    def test_skip_long_form_motion_beats_short_circuits_props_even_when_enabled(self):
        # 2026-06-24: even with the global prop_slide setting ON, the new
        # flag must short-circuit the prop block. Production was hitting
        # Vercel's 800s timeout because one prop's kie task took 306s by
        # itself; the Reddit-source worker now passes this flag because
        # the long-form video those motion beats compose into isn't
        # rendered for these jobs anyway.
        with mock.patch.object(media, "_prop_slide_enabled", return_value=True), \
             mock.patch.object(media.stages, "make_prop_plan") as plan_mock:
            self._call(
                skip_hero=True,
                skip_long_form_scenes=True,
                skip_long_form_motion_beats=True,
            )
            # The fast guard fires BEFORE make_prop_plan, so it must not
            # have been called even once. Without the guard, the prop
            # loop would burn ~60s per prop on kie.
            plan_mock.assert_not_called()

    def test_skip_long_form_motion_beats_short_circuits_mouth_swap_even_when_enabled(self):
        # Same shape for the mouth_swap block.
        with mock.patch.object(media, "_mouth_swap_enabled", return_value=True), \
             mock.patch.object(media.stages, "make_character_prompt") as char_mock, \
             mock.patch.object(media, "_mouth_swap_block") as swap_mock:
            self._call(
                skip_hero=True,
                skip_long_form_scenes=True,
                skip_long_form_motion_beats=True,
            )
            char_mock.assert_not_called()
            swap_mock.assert_not_called()

    def test_motion_beats_default_off_still_runs_when_settings_are_off(self):
        # The flag is opt-in. When it's NOT passed (long-form callers),
        # the existing setting toggle still decides whether prop_slide /
        # mouth_swap fire. With both disabled (the test default), the
        # blocks stay skipped — but via the original gate, not the new
        # one. This pins the regression-shape so a future refactor can't
        # silently make the new flag the only off-switch.
        with mock.patch.object(media.stages, "make_prop_plan") as plan_mock:
            self._call(skip_hero=True, skip_long_form_scenes=True)
            plan_mock.assert_not_called()  # because _prop_slide_enabled=False (default mock)


if __name__ == "__main__":
    unittest.main()
