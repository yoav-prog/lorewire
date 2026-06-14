"""Tests for pipeline.media.regen_one — per-asset image regeneration.

Mocks the network surface (_generate_with_retry, images.download,
gcs.publish, stages prompt builders, store.fetch_story / setters) so the
tests exercise the dispatch + DB-update wiring without burning kie credits.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import media


STORY = {
    "id": "abc123",
    "title": "A neighbor with a leaf blower",
    "body": "Once upon a time a neighbor unleashed a leaf blower at 6am.",
    "category": "Entitled",
}


def _patches(extra: dict | None = None) -> dict:
    """Base patch set every regen test reuses. Returns a dict so each test
    can override one entry without re-declaring the whole stack."""
    patches = {
        "fetch_story": mock.patch.object(media.store, "fetch_story", return_value=STORY),
        "generate_with_retry": mock.patch.object(
            media, "_generate_with_retry", return_value="https://kie/img.png",
        ),
        "download": mock.patch.object(media.images, "download"),
        "publish": mock.patch.object(
            media.gcs, "publish", side_effect=lambda local, key, fallback: fallback,
        ),
        "get_selected": mock.patch.object(
            media.models, "get_selected", return_value="kie/gpt-image-2",
        ),
    }
    if extra:
        patches.update(extra)
    return patches


def _apply(patches: dict, stack: unittest.TestCase):
    """Start every patch and stop it on tearDown via addCleanup."""
    started = {}
    for name, p in patches.items():
        started[name] = p.start()
        stack.addCleanup(p.stop)
    return started


class HeroRegenTests(unittest.TestCase):
    def test_hero_writes_hero_image_column(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "update_hero": mock.patch.object(media.store, "update_story_hero"),
                "make_thumb": mock.patch.object(
                    media.stages, "make_thumbnail_prompt",
                    return_value="cinematic prompt",
                ),
            })
            mocks = _apply(patches, self)
            url, cents = media.regen_one("abc123", "hero", Path(tmp))
            self.assertTrue(url.endswith("/hero.png"))
            # _regen_hero generates BOTH portrait (3:4) and landscape
            # (16:9) so the article reader, OG card, and 16:9 video
            # poster stay in sync. 2 images at $0.05 each.
            self.assertEqual(cents, 10)
            mocks["update_hero"].assert_called_once()
            mocks["update_hero"].assert_called_with("abc123", url)

    def test_hero_uploads_through_gcs_publish(self):
        """2026-06-13 regression: _regen_hero used to write the local
        URL straight to the DB, which broke production after the
        Vercel cron drain shipped (read-only filesystem + admin can't
        serve /generated/<id>/hero.png because the file lives nowhere
        persistent). The portrait path must go through gcs.publish
        with the right key so the URL stored is whatever GCS returns,
        same shape as the fresh-run pipeline."""
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "update_hero": mock.patch.object(media.store, "update_story_hero"),
                "make_thumb": mock.patch.object(
                    media.stages, "make_thumbnail_prompt",
                    return_value="cinematic prompt",
                ),
                "publish": mock.patch.object(
                    media.gcs, "publish",
                    return_value="https://storage.googleapis.com/b/abc123/hero.png",
                ),
            })
            mocks = _apply(patches, self)
            url, _ = media.regen_one("abc123", "hero", Path(tmp))
            # Stored URL is whatever gcs.publish returned, not the
            # /generated/... fallback.
            self.assertEqual(
                url,
                "https://storage.googleapis.com/b/abc123/hero.png",
            )
            # publish was called with the canonical key + fallback URL
            # at least once (portrait). Landscape attempts a second
            # call but kie may decline; we don't strictly require it.
            calls = mocks["publish"].call_args_list
            self.assertGreaterEqual(len(calls), 1)
            portrait_call = next(
                c for c in calls if c.args[1] == "abc123/hero.png"
            )
            self.assertEqual(
                portrait_call.args[2], "/generated/abc123/hero.png",
            )
            mocks["update_hero"].assert_called_with("abc123", url)

    def test_hero_raises_when_kie_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "generate_with_retry": mock.patch.object(
                    media, "_generate_with_retry", return_value=None,
                ),
                "make_thumb": mock.patch.object(
                    media.stages, "make_thumbnail_prompt",
                    return_value="cinematic prompt",
                ),
            })
            _apply(patches, self)
            with self.assertRaises(RuntimeError) as ctx:
                media.regen_one("abc123", "hero", Path(tmp))
            self.assertIn("no URL", str(ctx.exception))


class ScenesRegenTests(unittest.TestCase):
    def test_scenes_writes_images_column_and_returns_first_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            scene_prompts = [
                "hero prompt (discarded)",
                "scene 1 prompt",
                "scene 2 prompt",
                "scene 3 prompt",
            ]
            patches = _patches({
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                    return_value=scene_prompts,
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=3,
                ),
                "update_scenes": mock.patch.object(media.store, "update_story_scenes"),
                # 2026-06-14 Option C: world-bible path runs ahead of
                # `make_image_prompts` when on. This test pins the
                # pre-Option-C legacy flow, so the setting is forced off.
                "world_bible_enabled": mock.patch.object(
                    media, "_world_bible_enabled", return_value=False,
                ),
            })
            mocks = _apply(patches, self)
            url, cents = media.regen_one("abc123", "scenes", Path(tmp))
            # 3 scenes generated.
            self.assertEqual(mocks["update_scenes"].call_count, 1)
            scene_arg = mocks["update_scenes"].call_args.args[1]
            self.assertEqual(len(scene_arg), 3)
            self.assertEqual(url, scene_arg[0])
            self.assertEqual(cents, 15)  # 3 scenes * $0.05

    def test_scenes_raises_when_all_generations_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                    return_value=["hero", "s1", "s2"],
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=2,
                ),
                "generate_with_retry": mock.patch.object(
                    media, "_generate_with_retry", return_value=None,
                ),
                "update_scenes": mock.patch.object(media.store, "update_story_scenes"),
            })
            _apply(patches, self)
            with self.assertRaises(RuntimeError) as ctx:
                media.regen_one("abc123", "scenes", Path(tmp))
            self.assertIn("0 images", str(ctx.exception))


class RegenOutDirTests(unittest.TestCase):
    """The Vercel cron drain runs from a read-only filesystem except
    /tmp. `_regen_out_dir` has to honor gcs.is_configured() so prod
    writes land in /tmp and dev writes still land under
    lorewire-app/public/ where the local Next dev server can serve
    /generated/<id>/<file>."""

    def test_uses_tempdir_when_gcs_configured(self):
        import tempfile as _tmp
        with tempfile.TemporaryDirectory() as repo:
            with mock.patch.object(
                media.gcs, "is_configured", return_value=True,
            ):
                out = media._regen_out_dir(Path(repo), "abc123")
            self.assertEqual(
                out,
                Path(_tmp.gettempdir()) / "lorewire-regen" / "abc123",
            )

    def test_uses_public_dir_when_gcs_not_configured(self):
        with tempfile.TemporaryDirectory() as repo:
            with mock.patch.object(
                media.gcs, "is_configured", return_value=False,
            ):
                out = media._regen_out_dir(Path(repo), "abc123")
            self.assertEqual(
                out,
                Path(repo) / "lorewire-app" / "public" / "generated" / "abc123",
            )


class PropsRegenTests(unittest.TestCase):
    def test_props_blocked_when_setting_off(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "prop_slide_enabled": mock.patch.object(
                    media, "_prop_slide_enabled", return_value=False,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(RuntimeError) as ctx:
                media.regen_one("abc123", "props", Path(tmp))
            self.assertIn("video.prop_slide is off", str(ctx.exception))

    def test_props_writes_props_column_with_url_label_side(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = [
                {"keyword": "leaf blower", "label": "leaf blower", "side": "right"},
                {"keyword": "kite", "label": "kite", "side": "left"},
            ]
            patches = _patches({
                "prop_slide_enabled": mock.patch.object(
                    media, "_prop_slide_enabled", return_value=True,
                ),
                "prop_count": mock.patch.object(
                    media, "_prop_count", return_value=2,
                ),
                "make_prop_plan": mock.patch.object(
                    media.stages, "make_prop_plan", return_value=plan,
                ),
                "make_prop_image_prompt": mock.patch.object(
                    media.stages, "make_prop_image_prompt",
                    side_effect=lambda kw: f"prompt for {kw}",
                ),
                "update_props": mock.patch.object(media.store, "update_story_props"),
            })
            mocks = _apply(patches, self)
            url, cents = media.regen_one("abc123", "props", Path(tmp))
            self.assertEqual(cents, 10)  # 2 props * $0.05
            stored = mocks["update_props"].call_args.args[1]
            self.assertEqual(len(stored), 2)
            self.assertEqual(stored[0]["label"], "leaf blower")
            self.assertEqual(stored[0]["side"], "right")
            self.assertTrue(stored[0]["url"].endswith("/prop-1.png"))


class MouthSwapRegenTests(unittest.TestCase):
    def test_mouth_swap_blocked_when_setting_off(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "mouth_swap_enabled": mock.patch.object(
                    media, "_mouth_swap_enabled", return_value=False,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(RuntimeError) as ctx:
                media.regen_one("abc123", "mouth_swap", Path(tmp))
            self.assertIn("video.mouth_swap is off", str(ctx.exception))

    def test_mouth_swap_writes_both_character_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "mouth_swap_enabled": mock.patch.object(
                    media, "_mouth_swap_enabled", return_value=True,
                ),
                "make_character_prompt": mock.patch.object(
                    media.stages, "make_character_prompt",
                    return_value="character prompt",
                ),
                "mouth_swap_block": mock.patch.object(
                    media, "_mouth_swap_block",
                    return_value=("https://gcs/char.png", "https://gcs/char-no-mouth.png"),
                ),
                "update_char": mock.patch.object(media.store, "update_story_character"),
            })
            mocks = _apply(patches, self)
            url, cents = media.regen_one("abc123", "mouth_swap", Path(tmp))
            self.assertEqual(cents, 10)  # 2 images * $0.05
            mocks["update_char"].assert_called_with(
                "abc123",
                "https://gcs/char.png",
                "https://gcs/char-no-mouth.png",
            )

    def test_mouth_swap_partial_success_records_actual_cost(self):
        """When only one of the two kie calls returns a URL, the row should
        record only that cost so the daily cap stays honest."""
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "mouth_swap_enabled": mock.patch.object(
                    media, "_mouth_swap_enabled", return_value=True,
                ),
                "make_character_prompt": mock.patch.object(
                    media.stages, "make_character_prompt",
                    return_value="character prompt",
                ),
                "mouth_swap_block": mock.patch.object(
                    media, "_mouth_swap_block",
                    return_value=("https://gcs/char.png", None),
                ),
                "update_char": mock.patch.object(media.store, "update_story_character"),
            })
            _apply(patches, self)
            url, cents = media.regen_one("abc123", "mouth_swap", Path(tmp))
            self.assertEqual(cents, 5)  # only one image came back
            self.assertEqual(url, "https://gcs/char.png")


class DispatchTests(unittest.TestCase):
    def test_unknown_asset_raises_not_implemented(self):
        with tempfile.TemporaryDirectory() as tmp:
            _apply(_patches(), self)
            with self.assertRaises(NotImplementedError):
                media.regen_one("abc123", "frog", Path(tmp))

    def test_missing_story_raises_value_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=None,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(ValueError):
                media.regen_one("nope", "hero", Path(tmp))


class ParseIndexTests(unittest.TestCase):
    def test_parses_valid_indices(self):
        self.assertEqual(media._parse_index("scene:0"), 0)
        self.assertEqual(media._parse_index("scene:12"), 12)
        self.assertEqual(media._parse_index("prop:3"), 3)

    def test_rejects_missing_index(self):
        with self.assertRaises(ValueError):
            media._parse_index("scene:")

    def test_rejects_non_numeric(self):
        with self.assertRaises(ValueError):
            media._parse_index("scene:abc")

    def test_rejects_negative(self):
        with self.assertRaises(ValueError):
            media._parse_index("scene:-1")


class PerSceneRegenTests(unittest.TestCase):
    def _story_with_scenes(self, urls):
        import json as _json
        return {**STORY, "images": _json.dumps(urls)}

    def test_one_scene_splices_only_that_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            existing = [f"https://old/scene-{i + 1}.png" for i in range(5)]
            story = self._story_with_scenes(existing)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                    return_value=["hero"] + [f"scene {i}" for i in range(5)],
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=5,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                # World bible off — this test pins the splice logic
                # below the bible layer.
                "world_bible_enabled": mock.patch.object(
                    media, "_world_bible_enabled", return_value=False,
                ),
            })
            mocks = _apply(patches, self)
            url, cents = media.regen_one("abc123", "scene:2", Path(tmp))
            self.assertEqual(cents, 5)
            # Only index 2 should change; the other four URLs preserved verbatim.
            new_scenes = mocks["update_scenes"].call_args.args[1]
            self.assertEqual(len(new_scenes), 5)
            self.assertEqual(new_scenes[0], existing[0])
            self.assertEqual(new_scenes[1], existing[1])
            self.assertNotEqual(new_scenes[2], existing[2])
            self.assertEqual(new_scenes[2], url)
            self.assertEqual(new_scenes[3], existing[3])
            self.assertEqual(new_scenes[4], existing[4])

    def test_out_of_range_index_grows_the_array(self):
        # Production case 2026-06-13: `envelope` story had stories.images=
        # [3 urls] but Rebuild-all enqueued 30 scene:N rows. The worker
        # used to error every row past index 2. Now it pads with empty
        # placeholders and stamps the new URL at the target index so a
        # subsequent Rebuild-all finishes cleanly.
        with tempfile.TemporaryDirectory() as tmp:
            existing = ["url-0", "url-1", "url-2"]
            story = self._story_with_scenes(existing)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                    return_value=["hero"] + [f"p{i}" for i in range(27)],
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=27,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                # World bible off — this test pins the grow-on-overflow
                # behavior below the bible layer.
                "world_bible_enabled": mock.patch.object(
                    media, "_world_bible_enabled", return_value=False,
                ),
            })
            mocks = _apply(patches, self)
            url, cents = media.regen_one("abc123", "scene:10", Path(tmp))
            self.assertEqual(cents, 5)
            new_scenes = mocks["update_scenes"].call_args.args[1]
            # Pre-existing slots preserved.
            self.assertEqual(new_scenes[0], existing[0])
            self.assertEqual(new_scenes[1], existing[1])
            self.assertEqual(new_scenes[2], existing[2])
            # Target slot got the new URL.
            self.assertEqual(new_scenes[10], url)
            # Gap slots filled with empty placeholder strings.
            for i in range(3, 10):
                self.assertEqual(new_scenes[i], "")
            # No accidental over-growth past the target index.
            self.assertEqual(len(new_scenes), 11)


class ScenePromptCacheTests(unittest.TestCase):
    """Production diagnosis 2026-06-14 on `envelope`: each scene:N regen
    fired its own independent LLM call asking for 28 prompts. The 4000-
    token ceiling truncated mid-array on roughly 60% of calls, the parser
    fell through to the generic "Scene N from the story above" fallback,
    and kie drew unrelated stock illustrations. Caching the prompt list
    in `pipeline_cache.scene_prompts` and re-using it across the batch
    kills both the cost (27x cheaper) AND the truncation rate (one
    chance per batch, not 27).

    Phase 2 (2026-06-14 plan): each cached entry now carries a
    `scene_prompts_built_with` marker so a future prompt-shape change
    self-evicts every previously-cached batch. Stories cached before the
    marker shipped show up here as "no marker" → evicted on first contact.

    2026-06-14 cleavage: the cache lives in `pipeline_cache`, not
    `video_config`. The editor's parseVideoConfig was silently dropping
    these fields and forcing a fresh world-bible build on every queued
    scene — see `_plans/2026-06-14-pipeline-cache-column.md`.
    """

    def _story(self, scene_prompts=None, marker=None, extra_config=None):
        # 2026-06-14 cleavage: scene_prompts + marker live in
        # pipeline_cache now, not video_config. video_config stays
        # available for non-cache shape fixtures the test wants to
        # pass via `extra_config`. See
        # `_plans/2026-06-14-pipeline-cache-column.md`.
        import json as _json
        cache: dict = {}
        if scene_prompts is not None:
            cache["scene_prompts"] = scene_prompts
        if marker is not None:
            cache["scene_prompts_built_with"] = marker
        editor_config = dict(extra_config or {})
        return {
            **STORY,
            "images": "[]",
            "video_config":
                _json.dumps(editor_config) if editor_config else None,
            "pipeline_cache": _json.dumps(cache) if cache else None,
        }

    def test_legacy_marker_cache_hit_skips_llm_call(self):
        # Cached prompts with a matching legacy marker — story has no
        # doodle_frames so the resolver picks legacy as its expected
        # shape, the markers align, and we serve from cache.
        with tempfile.TemporaryDirectory() as tmp:
            cached = [f"cached prompt {i}" for i in range(27)]
            story = self._story(scene_prompts=cached, marker="legacy_v0")
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                ),
                "make_grounded_scene_prompts": mock.patch.object(
                    media.stages, "make_grounded_scene_prompts",
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=27,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
                "grounding_enabled": mock.patch.object(
                    media, "_scene_prompt_grounding_enabled", return_value=False,
                ),
            })
            mocks = _apply(patches, self)
            media.regen_one("abc123", "scene:5", Path(tmp))
            # Neither prompt builder was called — cache served the prompt.
            mocks["make_image_prompts"].assert_not_called()
            mocks["make_grounded_scene_prompts"].assert_not_called()

    def test_unmarked_legacy_cache_is_evicted(self):
        # Pre-marker caches are treated as poisoned and rebuilt on first
        # contact. This is the recovery path for every story whose cache
        # was populated before the 2026-06-14 fix shipped.
        with tempfile.TemporaryDirectory() as tmp:
            cached = [f"poisoned prompt {i}" for i in range(27)]
            story = self._story(scene_prompts=cached)  # NO marker
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                    return_value=["hero"] + [f"new {i}" for i in range(27)],
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=27,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
                "grounding_enabled": mock.patch.object(
                    media, "_scene_prompt_grounding_enabled", return_value=False,
                ),
            })
            mocks = _apply(patches, self)
            media.regen_one("abc123", "scene:5", Path(tmp))
            mocks["make_image_prompts"].assert_called_once()

    def test_cache_miss_calls_llm_and_persists(self):
        with tempfile.TemporaryDirectory() as tmp:
            story = self._story()  # no cache
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                    return_value=["hero"] + [f"fresh {i}" for i in range(5)],
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=5,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
            })
            mocks = _apply(patches, self)
            media.regen_one("abc123", "scene:0", Path(tmp))
            # LLM fired once, prompts stamped into
            # `pipeline_cache.scene_prompts` (moved out of video_config
            # 2026-06-14 — see _plans/2026-06-14-pipeline-cache-column.md).
            mocks["make_image_prompts"].assert_called_once()
            cache_writes = [
                call.args[1] for call in mocks["update_pipeline_cache"].call_args_list
                if isinstance(call.args[1], dict) and "scene_prompts" in call.args[1]
            ]
            self.assertTrue(cache_writes)
            cached_now = cache_writes[0]["scene_prompts"]
            self.assertEqual(len(cached_now), 5)
            self.assertEqual(cached_now[0], "fresh 0")

    def test_partial_cache_triggers_rebuild(self):
        # Cache smaller than scene_count is treated as a miss.
        with tempfile.TemporaryDirectory() as tmp:
            story = self._story(scene_prompts=["only-one"])
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                    return_value=["hero"] + [f"new {i}" for i in range(10)],
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=10,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
            })
            mocks = _apply(patches, self)
            media.regen_one("abc123", "scene:5", Path(tmp))
            mocks["make_image_prompts"].assert_called_once()


class GroundedScenePromptTests(unittest.TestCase):
    """2026-06-14 plan: scene prompts are derived from the per-frame
    narration line (captions sliced by doodle_frames.caption_chunk_start_index)
    rather than from the full article body. This binds prompt N to what
    the narrator is actually saying when scene N appears on screen.
    """

    def _story_with_frames(self, marker=None, scene_prompts=None, bible=None):
        # 2026-06-14 cleavage: doodle_frames + captions are editor data
        # (stay in video_config); scene_prompts / marker / character_bible
        # are pipeline-owned (move to pipeline_cache). See
        # `_plans/2026-06-14-pipeline-cache-column.md`.
        import json as _json
        editor_config = {
            "doodle_frames": [
                {"id": "f-0", "url": "u0", "caption_chunk_start_index": 0},
                {"id": "f-1", "url": "u1", "caption_chunk_start_index": 1},
                {"id": "f-2", "url": "u2", "caption_chunk_start_index": 2},
            ],
            "captions": [
                {"start_ms": 0, "end_ms": 1000, "text": "Once upon a time"},
                {"start_ms": 1000, "end_ms": 2000, "text": "a neighbor woke us"},
                {"start_ms": 2000, "end_ms": 3000, "text": "with a leaf blower"},
            ],
        }
        cache: dict = {}
        if scene_prompts is not None:
            cache["scene_prompts"] = scene_prompts
        if marker is not None:
            cache["scene_prompts_built_with"] = marker
        if bible is not None:
            cache["character_bible"] = bible
        return {
            **STORY,
            "images": "[]",
            "video_config": _json.dumps(editor_config),
            "pipeline_cache": _json.dumps(cache) if cache else None,
        }

    def test_grounded_path_uses_narration_when_frames_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            story = self._story_with_frames()
            grounded = mock.MagicMock(
                return_value=(
                    ["grounded 0", "grounded 1", "grounded 2"],
                    {"characters": [{"name": "N", "visual_cues": "tall, hat"}], "summary": ""},
                ),
            )
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "make_grounded_scene_prompts": mock.patch.object(
                    media.stages, "make_grounded_scene_prompts", grounded,
                ),
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=3,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
                # 2026-06-14 Option C: this test exercises the grounded
                # path that runs UNDER the world-bible layer. Force the
                # bible off so the grounded resolver is what fires.
                "world_bible_enabled": mock.patch.object(
                    media, "_world_bible_enabled", return_value=False,
                ),
            })
            mocks = _apply(patches, self)
            media.regen_one("abc123", "scene:1", Path(tmp))
            # Grounded builder was used, NOT the legacy one.
            mocks["make_grounded_scene_prompts"].assert_called_once()
            mocks["make_image_prompts"].assert_not_called()
            call = mocks["make_grounded_scene_prompts"].call_args
            narrations = call.args[2]
            # Each scene narration line corresponds to its caption chunk.
            self.assertEqual(narrations[0], "Once upon a time")
            self.assertEqual(narrations[1], "a neighbor woke us")
            self.assertEqual(narrations[2], "with a leaf blower")

    def test_grounded_cache_hit_reuses_prompts_and_bible(self):
        with tempfile.TemporaryDirectory() as tmp:
            cached = [f"cached grounded {i}" for i in range(3)]
            bible = {"characters": [{"name": "X", "visual_cues": "cap, beard"}], "summary": ""}
            story = self._story_with_frames(
                marker="narration_v1", scene_prompts=cached, bible=bible,
            )
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "make_grounded_scene_prompts": mock.patch.object(
                    media.stages, "make_grounded_scene_prompts",
                ),
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=3,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
                # Force the world-bible layer off so this test still
                # exercises the grounded cache-hit branch.
                "world_bible_enabled": mock.patch.object(
                    media, "_world_bible_enabled", return_value=False,
                ),
            })
            mocks = _apply(patches, self)
            media.regen_one("abc123", "scene:0", Path(tmp))
            # Neither builder was called — both prompt set + bible cached.
            mocks["make_grounded_scene_prompts"].assert_not_called()
            mocks["make_image_prompts"].assert_not_called()

    def test_legacy_marker_evicted_when_grounding_on_and_frames_exist(self):
        # Cache was populated by an older legacy run. Now grounding is on
        # (default) AND the story has frames + captions, so the resolver
        # evicts the legacy cache and rebuilds via the grounded path.
        with tempfile.TemporaryDirectory() as tmp:
            cached = [f"old legacy {i}" for i in range(3)]
            story = self._story_with_frames(
                marker="legacy_v0", scene_prompts=cached,
            )
            grounded = mock.MagicMock(
                return_value=(
                    ["fresh grounded 0", "fresh grounded 1", "fresh grounded 2"],
                    None,
                ),
            )
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "make_grounded_scene_prompts": mock.patch.object(
                    media.stages, "make_grounded_scene_prompts", grounded,
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=3,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
                # World bible off — this test pins the grounded layer
                # below it (marker eviction within the narration_v1 path).
                "world_bible_enabled": mock.patch.object(
                    media, "_world_bible_enabled", return_value=False,
                ),
            })
            mocks = _apply(patches, self)
            media.regen_one("abc123", "scene:1", Path(tmp))
            mocks["make_grounded_scene_prompts"].assert_called_once()
            # New cache written to `pipeline_cache` with narration_v1
            # marker (moved out of video_config 2026-06-14).
            cache_writes = [
                call.args[1] for call in mocks["update_pipeline_cache"].call_args_list
                if isinstance(call.args[1], dict)
                and call.args[1].get("scene_prompts_built_with") == "narration_v1"
            ]
            self.assertTrue(cache_writes)

    def test_grounding_off_via_setting_uses_legacy_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            story = self._story_with_frames()  # has frames + captions
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                    return_value=["hero"] + [f"legacy {i}" for i in range(3)],
                ),
                "make_grounded_scene_prompts": mock.patch.object(
                    media.stages, "make_grounded_scene_prompts",
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=3,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
                "grounding_enabled": mock.patch.object(
                    media, "_scene_prompt_grounding_enabled", return_value=False,
                ),
                # World bible off — the test name says "grounding off
                # uses legacy", which only makes sense below the world
                # bible layer.
                "world_bible_enabled": mock.patch.object(
                    media, "_world_bible_enabled", return_value=False,
                ),
            })
            mocks = _apply(patches, self)
            media.regen_one("abc123", "scene:0", Path(tmp))
            # Setting off → legacy path even though narrations are available.
            mocks["make_grounded_scene_prompts"].assert_not_called()
            mocks["make_image_prompts"].assert_called_once()


class WorldBiblePathTests(unittest.TestCase):
    """Option C path: per-image regen runs through the world-bible
    resolver, fires `build_world_bible` on miss, generates character
    refs, passes the matching refs to the kie call, persists
    `scene_entity_ids` on `pipeline_cache` so a sibling regen on the
    same story finds the bible + refs already cached. (2026-06-14:
    cache moved out of video_config into pipeline_cache — see
    `_plans/2026-06-14-pipeline-cache-column.md`.)"""

    def _story_with_frames(self) -> dict:
        import json as _json
        config = {
            "doodle_frames": [
                {"id": "f-0", "url": "u0", "caption_chunk_start_index": 0},
                {"id": "f-1", "url": "u1", "caption_chunk_start_index": 1},
                {"id": "f-2", "url": "u2", "caption_chunk_start_index": 2},
            ],
            "captions": [
                {"start_ms": 0, "end_ms": 1000, "text": "Once upon a time"},
                {"start_ms": 1000, "end_ms": 2000, "text": "a neighbor woke us"},
                {"start_ms": 2000, "end_ms": 3000, "text": "with a leaf blower"},
            ],
        }
        return {**STORY, "images": "[]", "video_config": _json.dumps(config)}

    def test_world_bible_path_fires_bible_build_and_scene_prompts(self):
        # Story without a bible yet — first scene regen builds the
        # bible, generates one ref per character, then builds scene
        # prompts via the bible-aware builder.
        with tempfile.TemporaryDirectory() as tmp:
            story = self._story_with_frames()
            bible = {
                "built_with": "world_bible_v1",
                "characters": [{
                    "id": "char_lead",
                    "name": "Lead",
                    "role": "lead",
                    "visual_cues": "tall, dark coat",
                    "reference_image_url": None,
                }],
                "sub_characters": [],
                "locations": [],
                "items": [],
            }
            scene_entries = [
                {"prompt": f"scene {i} text", "entity_ids": ["char_lead"]}
                for i in range(3)
            ]
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "build_world_bible": mock.patch.object(
                    media.stages, "build_world_bible", return_value=bible,
                ),
                "make_scene_prompts_from_bible": mock.patch.object(
                    media.stages, "make_scene_prompts_from_bible",
                    return_value=scene_entries,
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=3,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
            })
            mocks = _apply(patches, self)
            media.regen_one("abc123", "scene:1", Path(tmp))
            mocks["build_world_bible"].assert_called_once()
            mocks["make_scene_prompts_from_bible"].assert_called_once()
            # scene_entity_ids persisted parallel to scene_prompts
            # inside pipeline_cache (moved out of video_config
            # 2026-06-14).
            entity_writes = [
                call.args[1] for call in mocks["update_pipeline_cache"].call_args_list
                if isinstance(call.args[1], dict)
                and "scene_entity_ids" in call.args[1]
            ]
            self.assertTrue(entity_writes)
            ids = entity_writes[-1]["scene_entity_ids"]
            self.assertEqual(ids[0], ["char_lead"])

    def test_kie_call_receives_reference_image_for_tagged_scene(self):
        # The point of the whole bible is that scene N's kie call
        # gets the reference image of the character on-screen. Verify
        # the refs flow all the way through `_generate_with_retry`.
        with tempfile.TemporaryDirectory() as tmp:
            story = self._story_with_frames()
            bible = {
                "built_with": "world_bible_v1",
                "characters": [{
                    "id": "char_lead",
                    "name": "Lead",
                    "role": "lead",
                    "visual_cues": "tall",
                    "reference_image_url": "https://ref/lead.png",
                }],
                "sub_characters": [],
                "locations": [],
                "items": [],
            }
            scene_entries = [
                {"prompt": "scene 0", "entity_ids": ["char_lead"]},
                {"prompt": "scene 1", "entity_ids": ["char_lead"]},
                {"prompt": "scene 2", "entity_ids": []},  # no entity → no refs
            ]
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "build_world_bible": mock.patch.object(
                    media.stages, "build_world_bible", return_value=bible,
                ),
                "make_scene_prompts_from_bible": mock.patch.object(
                    media.stages, "make_scene_prompts_from_bible",
                    return_value=scene_entries,
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=3,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
                # Disable ref-image generation so the bible's existing
                # reference_image_url is used as-is (no extra kie calls
                # for refs in this test — we're focused on the scene
                # call's image_input).
                "char_refs_enabled": mock.patch.object(
                    media, "_character_reference_images_enabled",
                    return_value=False,
                ),
            })
            mocks = _apply(patches, self)
            media.regen_one("abc123", "scene:0", Path(tmp))
            # The kie call for scene:0 fired with image_input pointing
            # at the lead's reference url AND model pinned to the
            # scenes model (nano-banana-2 by default).
            generate_kwargs = mocks["generate_with_retry"].call_args.kwargs
            self.assertEqual(
                generate_kwargs.get("image_input"),
                ["https://ref/lead.png"],
            )
            self.assertEqual(generate_kwargs.get("model"), "kie/nano-banana-2")

    def test_world_bible_off_falls_back_to_grounded(self):
        # The escape hatch. When `video.world_bible_enabled=0`, the
        # bible build is skipped entirely and the regen goes through
        # the previous grounded narration path. No refs, no bible.
        with tempfile.TemporaryDirectory() as tmp:
            story = self._story_with_frames()
            grounded = mock.MagicMock(
                return_value=(["g0", "g1", "g2"], None),
            )
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "build_world_bible": mock.patch.object(
                    media.stages, "build_world_bible",
                ),
                "make_grounded_scene_prompts": mock.patch.object(
                    media.stages, "make_grounded_scene_prompts", grounded,
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=3,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
                "world_bible_enabled": mock.patch.object(
                    media, "_world_bible_enabled", return_value=False,
                ),
            })
            mocks = _apply(patches, self)
            media.regen_one("abc123", "scene:0", Path(tmp))
            mocks["build_world_bible"].assert_not_called()
            mocks["make_grounded_scene_prompts"].assert_called_once()


class FallbackPromptTests(unittest.TestCase):
    """The pre-fix fallback was "Scene N from the story above. <style>" with
    zero story context — kie drew random stock illustrations. New fallback
    embeds headline + body excerpt so even a parse failure has SOMETHING
    grounded to draw from."""

    def test_full_failure_embeds_headline_and_body(self):
        from pipeline import stages
        raw_unparseable = "I cannot return JSON, sorry."
        result = stages._parse_prompt_list(
            raw_unparseable,
            n=5,
            headline="The Missing Envelope",
            style="doodle aesthetic",
            body="A retirement gift fund of $800 went missing after a long weekend.",
        )
        self.assertEqual(len(result), 5)
        # Every prompt carries the headline + body excerpt, not just "Scene N".
        for p in result:
            self.assertIn("envelope", p.lower() + " " + p.lower())
            self.assertIn("retirement gift", p.lower())

    def test_partial_parse_pads_with_continuation(self):
        from pipeline import stages
        # Trailing array bracket missing on purpose — only first 3 parse cleanly.
        raw_partial = '["hero shot", "scene a", "scene b"]'
        result = stages._parse_prompt_list(
            raw_partial,
            n=6,
            headline="X",
            style="s",
            body="body",
        )
        self.assertEqual(len(result), 6)
        # First three are LLM-returned verbatim.
        self.assertEqual(result[0], "hero shot")
        self.assertEqual(result[1], "scene a")
        self.assertEqual(result[2], "scene b")
        # Padded slots reference the last LLM prompt + a continuation note.
        for i in range(3, 6):
            self.assertIn("scene b", result[i])
            self.assertIn("Continuation", result[i])


class ScenePromptPersistTests(unittest.TestCase):
    """Bulk scenes regen now stamps the kie prompt onto the matching
    doodle_frame so the video editor's textarea fills with what the
    pipeline used (per _plans/2026-06-13-editor-intro-outro-regen-all.md).
    Per-frame Revert state (`prev_image`) must NOT be touched — that
    belongs to the editor's per-frame edit flow."""

    def _story_with_config(self, scene_urls, doodle_frames):
        import json as _json
        return {
            **STORY,
            "images": _json.dumps(scene_urls),
            "video_config": _json.dumps({"doodle_frames": doodle_frames}),
        }

    def test_persists_image_prompt_onto_matching_frame(self):
        with tempfile.TemporaryDirectory() as tmp:
            existing = [f"https://old/scene-{i+1}.png" for i in range(3)]
            frames = [
                {"id": "frame-a", "url": existing[0], "image_prompt": ""},
                {"id": "frame-b", "url": existing[1], "image_prompt": ""},
                {"id": "frame-c", "url": existing[2], "image_prompt": ""},
            ]
            story = self._story_with_config(existing, frames)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                    return_value=[
                        "hero",
                        "scene 0 prompt",
                        "scene 1 prompt",
                        "scene 2 prompt",
                    ],
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=3,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
            })
            mocks = _apply(patches, self)
            url, _cents = media.regen_one("abc123", "scene:1", Path(tmp))
            # update_story_video_config is called twice on a cache miss:
            # once to write scene_prompts cache, once to persist the frame
            # prompt. Pick the persist call (the one whose payload has the
            # new url stamped on a doodle_frame at the regen target index).
            self.assertGreaterEqual(
                mocks["update_video_config"].call_count, 1,
            )
            persist_calls = [
                c for c in mocks["update_video_config"].call_args_list
                if isinstance(c.args[1], dict)
                and "doodle_frames" in c.args[1]
            ]
            self.assertTrue(persist_calls)
            new_config = persist_calls[-1].args[1]
            self.assertEqual(
                new_config["doodle_frames"][1]["image_prompt"],
                "scene 1 prompt",
            )
            self.assertEqual(new_config["doodle_frames"][1]["url"], url)
            # Untouched frames stay identical.
            self.assertEqual(new_config["doodle_frames"][0], frames[0])
            self.assertEqual(new_config["doodle_frames"][2], frames[2])

    def test_does_not_touch_prev_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            existing = ["https://old/scene-1.png"]
            frames = [
                {
                    "id": "frame-a",
                    "url": existing[0],
                    "image_prompt": "manual edit",
                    "prev_image": {
                        "url": "https://prev.png",
                        "image_prompt": "earlier",
                        "replaced_at": "2026-06-12T00:00:00Z",
                    },
                },
            ]
            story = self._story_with_config(existing, frames)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                    return_value=["hero", "bulk scene"],
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=1,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
            })
            mocks = _apply(patches, self)
            media.regen_one("abc123", "scene:0", Path(tmp))
            new_config = mocks["update_video_config"].call_args.args[1]
            # prev_image untouched even though image_prompt + url changed.
            self.assertEqual(
                new_config["doodle_frames"][0]["prev_image"],
                frames[0]["prev_image"],
            )
            self.assertEqual(
                new_config["doodle_frames"][0]["image_prompt"], "bulk scene",
            )

    def test_noop_when_no_video_config(self):
        # Story that's never been opened in the editor has video_config=None.
        # The URL still lands in stories.images; the prompt persist skips
        # (no doodle_frames to stamp into). The scene_prompts cache write
        # still fires but lands on `pipeline_cache` now, not video_config
        # (split 2026-06-14) — so this test just asserts the editor's
        # video_config column was never touched.
        with tempfile.TemporaryDirectory() as tmp:
            story = {**STORY, "images": '["https://old/scene-1.png"]', "video_config": None}
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                    return_value=["hero", "scene"],
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=1,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
            })
            mocks = _apply(patches, self)
            media.regen_one("abc123", "scene:0", Path(tmp))
            mocks["update_scenes"].assert_called_once()
            # No call writes doodle_frames (there were none to grow into).
            for c in mocks["update_video_config"].call_args_list:
                payload = c.args[1]
                if isinstance(payload, dict):
                    self.assertNotIn("doodle_frames", payload)

    def test_grows_doodle_frames_when_scene_index_past_end(self):
        # Production case 2026-06-14: `envelope` had 3 doodle_frames and a
        # bulk regen targeting index 10. The persist helper used to skip,
        # which left the editor showing only 3 scene cards even after the
        # scene URLs grew to 27. Now it grows doodle_frames to fit so the
        # editor's storyboard rail matches the new scene count.
        with tempfile.TemporaryDirectory() as tmp:
            existing = ["url-0", "url-1", "url-2"]
            frames = [
                {"id": "f-0", "url": existing[0], "image_prompt": "", "caption_chunk_start_index": 0},
                {"id": "f-1", "url": existing[1], "image_prompt": "", "caption_chunk_start_index": 1},
                {"id": "f-2", "url": existing[2], "image_prompt": "", "caption_chunk_start_index": 2},
            ]
            captions = [{"text": f"chunk {i}", "start_ms": i * 1000, "end_ms": i * 1000 + 900} for i in range(20)]
            import json as _json
            story = {
                **STORY,
                "images": _json.dumps(existing),
                "video_config": _json.dumps({
                    "doodle_frames": frames,
                    "captions": captions,
                }),
            }
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                    return_value=["hero"] + [f"p{i}" for i in range(20)],
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=20,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
            })
            mocks = _apply(patches, self)
            url, _ = media.regen_one("abc123", "scene:10", Path(tmp))
            # update_story_video_config is called twice on a cache miss:
            # once to write scene_prompts cache, once to persist the frame
            # prompt. Pick the persist call (the one whose payload has the
            # new url stamped on a doodle_frame at the regen target index).
            self.assertGreaterEqual(
                mocks["update_video_config"].call_count, 1,
            )
            persist_calls = [
                c for c in mocks["update_video_config"].call_args_list
                if isinstance(c.args[1], dict)
                and "doodle_frames" in c.args[1]
            ]
            self.assertTrue(persist_calls)
            new_config = persist_calls[-1].args[1]
            new_frames = new_config["doodle_frames"]
            self.assertEqual(len(new_frames), 11)  # grown to index+1
            # Old frames preserved.
            self.assertEqual(new_frames[0]["id"], "f-0")
            self.assertEqual(new_frames[1]["id"], "f-1")
            self.assertEqual(new_frames[2]["id"], "f-2")
            # Newly minted frames have ids + caption indices spread across captions.
            for i in range(3, 11):
                self.assertTrue(new_frames[i]["id"])
                self.assertIn("caption_chunk_start_index", new_frames[i])
            # Target frame holds the new URL + prompt.
            self.assertEqual(new_frames[10]["url"], url)
            self.assertEqual(new_frames[10]["image_prompt"], "p10")

    def test_malformed_video_config_skipped_silently(self):
        with tempfile.TemporaryDirectory() as tmp:
            existing = ["https://old/scene-1.png"]
            story = {
                **STORY,
                "images": '["https://old/scene-1.png"]',
                "video_config": "{not valid json",
            }
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "make_image_prompts": mock.patch.object(
                    media.stages, "make_image_prompts",
                    return_value=["hero", "scene"],
                ),
                "resolve_scene_count": mock.patch.object(
                    media, "_resolve_scene_count", return_value=1,
                ),
                "update_scenes": mock.patch.object(
                    media.store, "update_story_scenes",
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
            })
            mocks = _apply(patches, self)
            media.regen_one("abc123", "scene:0", Path(tmp))
            mocks["update_scenes"].assert_called_once()
            # Malformed config: cache write reseeds an empty config with
            # scene_prompts (the only way to recover from a corrupted
            # row), but no doodle_frames write since we couldn't parse
            # what was there.
            for c in mocks["update_video_config"].call_args_list:
                payload = c.args[1]
                if isinstance(payload, dict):
                    self.assertNotIn("doodle_frames", payload)


class PerPropRegenTests(unittest.TestCase):
    def _story_with_props(self, props):
        import json as _json
        return {**STORY, "props": _json.dumps(props)}

    def test_one_prop_splices_url_preserves_label_and_side(self):
        with tempfile.TemporaryDirectory() as tmp:
            existing = [
                {"url": "https://old/p1.png", "label": "leaf blower", "side": "right"},
                {"url": "https://old/p2.png", "label": "kite", "side": "left"},
                {"url": "https://old/p3.png", "label": "flag", "side": "right"},
            ]
            story = self._story_with_props(existing)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "prop_slide_enabled": mock.patch.object(
                    media, "_prop_slide_enabled", return_value=True,
                ),
                "make_prop_image_prompt": mock.patch.object(
                    media.stages, "make_prop_image_prompt",
                    side_effect=lambda kw: f"prompt for {kw}",
                ),
                "update_props": mock.patch.object(
                    media.store, "update_story_props",
                ),
            })
            mocks = _apply(patches, self)
            url, cents = media.regen_one("abc123", "prop:1", Path(tmp))
            self.assertEqual(cents, 5)
            new_props = mocks["update_props"].call_args.args[1]
            # Index 1 swaps url; label + side preserved verbatim.
            self.assertEqual(new_props[0], existing[0])
            self.assertEqual(new_props[1]["label"], "kite")
            self.assertEqual(new_props[1]["side"], "left")
            self.assertNotEqual(new_props[1]["url"], existing[1]["url"])
            self.assertEqual(new_props[1]["url"], url)
            self.assertEqual(new_props[2], existing[2])

    def test_one_prop_blocked_when_setting_off(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches({
                "prop_slide_enabled": mock.patch.object(
                    media, "_prop_slide_enabled", return_value=False,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(RuntimeError):
                media.regen_one("abc123", "prop:0", Path(tmp))


class PerFrameRegenTests(unittest.TestCase):
    """Tests for the `frame:<id>` slug — video editor Phase 3 part 2.

    Verifies dispatch, prompt sourcing, sibling preservation, and the
    fail-loud paths (missing config / malformed JSON / unknown id /
    missing image_prompt). Mocks the network surface so no kie credits
    are burned.
    """

    def _story_with_frames(self, frames: list[dict]) -> dict:
        import json as _json
        return {
            **STORY,
            "video_config": _json.dumps({
                "config_version": 2,
                "voiceover_url": "/v.mp3",
                "duration_ms": 10000,
                "doodle_frames": frames,
                "captions": [
                    {"start_ms": 0, "end_ms": 10000, "text": "Hi"}
                ],
            }),
        }

    def test_writes_new_url_into_video_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            frames = [
                {
                    "id": "frame-a",
                    "url": "/old-a.png",
                    "caption_chunk_start_index": 0,
                    "image_prompt": "a doodle of an accountant",
                },
                {
                    "id": "frame-b",
                    "url": "/old-b.png",
                    "caption_chunk_start_index": 0,
                    "image_prompt": "a doodle of a leaf blower",
                },
            ]
            story = self._story_with_frames(frames)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
            })
            mocks = _apply(patches, self)
            url, cents = media.regen_one("abc123", "frame:frame-a", Path(tmp))
            self.assertEqual(cents, 5)
            new_config = mocks["update_video_config"].call_args.args[1]
            new_frames = new_config["doodle_frames"]
            # Only frame-a's url changed; frame-b is preserved verbatim.
            self.assertEqual(new_frames[0]["id"], "frame-a")
            self.assertNotEqual(new_frames[0]["url"], "/old-a.png")
            self.assertEqual(new_frames[0]["url"], url)
            self.assertEqual(new_frames[1], frames[1])

    def test_preserves_image_prompt_and_prev_image_on_target_frame(self):
        # The TS server action owns image_prompt + prev_image. The Python
        # worker must NOT touch them — Revert would lose its snapshot.
        with tempfile.TemporaryDirectory() as tmp:
            frames = [
                {
                    "id": "frame-a",
                    "url": "/old-a.png",
                    "caption_chunk_start_index": 0,
                    "image_prompt": "the new prompt",
                    "prev_image": {
                        "url": "/older.png",
                        "image_prompt": "the older prompt",
                        "replaced_at": "2026-06-12T11:00:00Z",
                    },
                },
            ]
            story = self._story_with_frames(frames)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "update_video_config": mock.patch.object(
                    media.store, "update_story_video_config",
                ),
                # 2026-06-14: pipeline_cache split. Tests that exercised
                # _persist_world_bible / _write_cached_scene_prompts /
                # _read_cached_* used to assert on update_story_video_config
                # because those helpers wrote there. Post-fix the cache
                # lives in pipeline_cache; mock both so any path under
                # test that touches either column doesn't hit the real
                # DB.
                "update_pipeline_cache": mock.patch.object(
                    media.store, "update_story_pipeline_cache",
                ),
            })
            mocks = _apply(patches, self)
            media.regen_one("abc123", "frame:frame-a", Path(tmp))
            new_frames = mocks["update_video_config"].call_args.args[1]["doodle_frames"]
            self.assertEqual(new_frames[0]["image_prompt"], "the new prompt")
            self.assertEqual(
                new_frames[0]["prev_image"],
                frames[0]["prev_image"],
            )

    def test_missing_video_config_raises_value_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            story = {**STORY}  # no video_config field at all
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(ValueError) as ctx:
                media.regen_one("abc123", "frame:frame-a", Path(tmp))
            self.assertIn("video_config", str(ctx.exception))

    def test_malformed_video_config_json_raises_value_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            story = {**STORY, "video_config": "{not valid json"}
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(ValueError) as ctx:
                media.regen_one("abc123", "frame:frame-a", Path(tmp))
            self.assertIn("malformed", str(ctx.exception).lower())

    def test_unknown_frame_id_raises_value_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            frames = [
                {
                    "id": "frame-a",
                    "url": "/old.png",
                    "caption_chunk_start_index": 0,
                    "image_prompt": "p",
                },
            ]
            story = self._story_with_frames(frames)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(ValueError) as ctx:
                media.regen_one("abc123", "frame:does-not-exist", Path(tmp))
            self.assertIn("not found", str(ctx.exception))

    def test_missing_image_prompt_raises_value_error(self):
        # The TS server action validates + writes image_prompt before
        # enqueueing; an empty prompt here means a regression or manual
        # queue insert. Fail loud so the admin sees the cause.
        with tempfile.TemporaryDirectory() as tmp:
            frames = [
                {
                    "id": "frame-a",
                    "url": "/old.png",
                    "caption_chunk_start_index": 0,
                    # no image_prompt
                },
            ]
            story = self._story_with_frames(frames)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(ValueError) as ctx:
                media.regen_one("abc123", "frame:frame-a", Path(tmp))
            self.assertIn("image_prompt", str(ctx.exception))

    def test_empty_frame_id_after_colon_raises_value_error(self):
        # A bare "frame:" slug (no id) is a malformed queue row.
        with tempfile.TemporaryDirectory() as tmp:
            story = self._story_with_frames([])
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(ValueError) as ctx:
                media.regen_one("abc123", "frame:", Path(tmp))
            self.assertIn("missing frame id", str(ctx.exception))

    def test_kie_returning_none_raises_runtime_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            frames = [
                {
                    "id": "frame-a",
                    "url": "/old.png",
                    "caption_chunk_start_index": 0,
                    "image_prompt": "p",
                },
            ]
            story = self._story_with_frames(frames)
            patches = _patches({
                "fetch_story": mock.patch.object(
                    media.store, "fetch_story", return_value=story,
                ),
                "generate_with_retry": mock.patch.object(
                    media, "_generate_with_retry", return_value=None,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(RuntimeError):
                media.regen_one("abc123", "frame:frame-a", Path(tmp))


if __name__ == "__main__":
    unittest.main()
