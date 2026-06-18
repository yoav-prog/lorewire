"""Tests for the Lane C builder (Phase 4 of the short editor plan).

What we lock down: validation surface on lane_inputs + the happy path
where the builder runs scene regens on the touched ids and assembles new
props by merging the freshly-regen'd urls into the baseline frame order.
The kie + GCS calls are stubbed via shorts_scene_regen's own seam.

Plan: _plans/2026-06-16-short-editor-full-parity.md.
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import shorts_lane_c, shorts_scene_regen, store


class _LaneCTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        db_path = Path(self._tmpdir.name) / "lane-c.db"
        self._db_patch = mock.patch.object(store, "DB_PATH", str(db_path))
        self._db_patch.start()
        self._env_patch = mock.patch.dict(os.environ, {}, clear=False)
        self._env_patch.start()
        os.environ.pop("DATABASE_URL", None)
        store.init()

    def tearDown(self) -> None:
        self._db_patch.stop()
        self._env_patch.stop()
        self._tmpdir.cleanup()

    def _seed_baseline(
        self, render_id: str, story_id: str, props: dict,
    ) -> None:
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "INSERT INTO short_renders "
                "(id, story_id, config_hash, narration_style, length_preset, "
                " status, phase, progress, error, output_url, props, "
                " requested_by, requested_at, started_at, finished_at, "
                " lane, lane_inputs) "
                "VALUES (?, ?, ?, 'suspense', 'standard', 'done', 'done', 1, "
                "        NULL, 'https://gcs/done.mp4', ?, NULL, ?, NULL, ?, "
                "        NULL, NULL)",
                (
                    render_id,
                    story_id,
                    f"hash-{render_id}",
                    json.dumps(props),
                    "2026-06-16T00:00:00.000Z",
                    "2026-06-16T00:01:00.000Z",
                ),
            )

    def _seed_story_with_config(
        self, story_id: str, short_config: dict,
    ) -> None:
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "INSERT INTO stories (id, slug, title, status, short_config) "
                "VALUES (?, ?, ?, 'ready', ?)",
                (story_id, f"slug-{story_id}", f"Title {story_id}",
                 json.dumps(short_config)),
            )


class ValidationTests(_LaneCTestCase):
    def test_missing_lane_inputs_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_c.build_short_props_lane_c(
                {"story_id": "s", "lane_inputs": None}, Path("."),
            )
        self.assertIn("lane_inputs", str(cm.exception))

    def test_malformed_lane_inputs_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_c.build_short_props_lane_c(
                {"story_id": "s", "lane_inputs": "{not json"}, Path("."),
            )
        self.assertIn("malformed", str(cm.exception))

    def test_missing_source_render_id_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_c.build_short_props_lane_c(
                {"story_id": "s",
                 "lane_inputs": json.dumps({"touched_frame_ids": ["f"]})},
                Path("."),
            )
        self.assertIn("source_render_id", str(cm.exception))

    def test_touched_frame_ids_must_be_list_of_strings(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_c.build_short_props_lane_c(
                {"story_id": "s",
                 "lane_inputs": json.dumps(
                     {"source_render_id": "r", "touched_frame_ids": [1, 2]},
                 )},
                Path("."),
            )
        self.assertIn("touched_frame_ids", str(cm.exception))

    def test_empty_touched_list_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_c.build_short_props_lane_c(
                {"story_id": "s",
                 "lane_inputs": json.dumps(
                     {"source_render_id": "r", "touched_frame_ids": []},
                 )},
                Path("."),
            )
        self.assertIn("empty", str(cm.exception))

    def test_unknown_baseline_raises(self):
        with self.assertRaises(ValueError) as cm:
            shorts_lane_c.build_short_props_lane_c(
                {"story_id": "s",
                 "lane_inputs": json.dumps(
                     {
                         "source_render_id": "ghost",
                         "touched_frame_ids": ["frame-00"],
                     },
                 )},
                Path("."),
            )
        self.assertIn("not found", str(cm.exception))

    def test_baseline_without_props_raises(self):
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "INSERT INTO short_renders "
                "(id, story_id, config_hash, status, progress, props, requested_at) "
                "VALUES ('no-props', 's', 'h', 'done', 1, NULL, "
                "        '2026-06-16T00:00:00.000Z')",
            )
        with self.assertRaises(ValueError) as cm:
            shorts_lane_c.build_short_props_lane_c(
                {"story_id": "s",
                 "lane_inputs": json.dumps(
                     {
                         "source_render_id": "no-props",
                         "touched_frame_ids": ["frame-00"],
                     },
                 )},
                Path("."),
            )
        self.assertIn("no props", str(cm.exception))


class HappyPathTests(_LaneCTestCase):
    def _baseline_props(self) -> dict:
        return {
            "config_version": 2,
            "voiceover_url": "https://gcs/voice.mp3",
            "duration_ms": 30000,
            "title": "Old title",
            "doodle_frames": [
                {
                    "id": "frame-00",
                    "url": "https://gcs/00-old.png",
                    "caption_chunk_start_index": 0,
                },
                {
                    "id": "frame-01",
                    "url": "https://gcs/01-old.png",
                    "caption_chunk_start_index": 3,
                },
                {
                    "id": "frame-02",
                    "url": "https://gcs/02-old.png",
                    "caption_chunk_start_index": 6,
                },
            ],
            "captions": [
                {"start_ms": 0, "end_ms": 2000, "text": "hello"},
            ],
        }

    def _short_config(self) -> dict:
        # The Scenes tab has already saved the new prompts; the regen call
        # reads them off short_config.
        return {
            "config_version": 1,
            "character_base_url": "https://gcs/base.png",
            "doodle_frames": [
                {
                    "id": "frame-00",
                    "url": "https://gcs/00-old.png",
                    "image_prompt": "a forest",
                },
                {
                    "id": "frame-01",
                    "url": "https://gcs/01-old.png",
                    "image_prompt": "an ocean",
                },
                {
                    "id": "frame-02",
                    "url": "https://gcs/02-old.png",
                    "image_prompt": "a mountain",
                },
            ],
            "captions": [],
        }

    def test_regens_touched_frames_and_merges_urls_into_baseline(self):
        self._seed_baseline("base-1", "story-1", self._baseline_props())
        self._seed_story_with_config("story-1", self._short_config())

        regen_calls: list[tuple[str, str]] = []

        def fake_regen(story_id: str, asset: str, repo_root: Path):
            # Mimic shorts_scene_regen: stamp a new url into short_config so
            # the merge step picks it up.
            regen_calls.append((story_id, asset))
            _, _, frame_id = asset.partition(":")
            story = store.fetch_story(story_id)
            assert story is not None
            cfg = json.loads(story["short_config"])
            for f in cfg["doodle_frames"]:
                if f["id"] == frame_id:
                    f["url"] = f"https://gcs/{frame_id}-NEW.png"
                    f["is_pinned"] = True
            store.update_story_short_config(story_id, cfg)
            return f"https://gcs/{frame_id}-NEW.png", 5

        with mock.patch.object(
            shorts_lane_c.shorts_scene_regen,
            "regen_short_scene",
            side_effect=fake_regen,
        ):
            built = shorts_lane_c.build_short_props_lane_c(
                {
                    "story_id": "story-1",
                    "lane_inputs": json.dumps(
                        {
                            "source_render_id": "base-1",
                            "touched_frame_ids": ["frame-00", "frame-02"],
                        },
                    ),
                },
                Path(self._tmpdir.name),
            )

        # Two scenes touched → two regen calls in input order.
        self.assertEqual(
            regen_calls,
            [
                ("story-1", "frame:frame-00"),
                ("story-1", "frame:frame-02"),
            ],
        )
        self.assertEqual(built.regen_count, 2)

        frames = built.props["doodle_frames"]
        # frame-00 and frame-02 swapped to the new urls; frame-01 untouched.
        # All three urls carry the per-render `?v=<token>` cache-bust so the
        # editor doesn't show the previous render's bytes from image cache.
        self.assertEqual(frames[0]["id"], "frame-00")
        self.assertRegex(frames[0]["url"], r"^https://gcs/frame-00-NEW\.png\?v=[0-9a-f]{8}$")
        self.assertEqual(frames[1]["id"], "frame-01")
        self.assertRegex(frames[1]["url"], r"^https://gcs/01-old\.png\?v=[0-9a-f]{8}$")
        self.assertEqual(frames[2]["id"], "frame-02")
        self.assertRegex(frames[2]["url"], r"^https://gcs/frame-02-NEW\.png\?v=[0-9a-f]{8}$")
        # Every frame shares the same token.
        token = frames[0]["url"].rsplit("=", 1)[1]
        for f in frames:
            self.assertTrue(f["url"].endswith(f"?v={token}"))

        # Voice URL also carries the bust (so the editor's audio preview refreshes).
        self.assertRegex(
            built.props["voiceover_url"],
            r"^https://gcs/voice\.mp3\?v=[0-9a-f]{8}$",
        )
        # Captions are unchanged when the audio probe couldn't reach the URL
        # (mock URLs fail to resolve in unit tests).
        self.assertEqual(built.props["captions"], self._baseline_props()["captions"])
        self.assertEqual(built.props["title"], "Old title")
        self.assertEqual(frames[0]["caption_chunk_start_index"], 0)

    def test_progress_callback_fires_per_scene(self):
        self._seed_baseline("base-p", "story-p", self._baseline_props())
        self._seed_story_with_config("story-p", self._short_config())

        progress_calls: list[tuple[str, int, int]] = []

        def on_progress(phase: str, cur: int = 0, total: int = 0) -> None:
            progress_calls.append((phase, cur, total))

        with mock.patch.object(
            shorts_lane_c.shorts_scene_regen,
            "regen_short_scene",
            return_value=("https://gcs/x.png", 5),
        ):
            shorts_lane_c.build_short_props_lane_c(
                {
                    "story_id": "story-p",
                    "lane_inputs": json.dumps(
                        {
                            "source_render_id": "base-p",
                            "touched_frame_ids": ["frame-00", "frame-01"],
                        },
                    ),
                },
                Path(self._tmpdir.name),
                on_progress=on_progress,
            )

        scene_calls = [c for c in progress_calls if c[0] == "scene"]
        self.assertEqual(
            scene_calls, [("scene", 0, 2), ("scene", 1, 2)],
        )
        # stage fires after the regen loop.
        self.assertIn(("stage", 0, 0), progress_calls)


class CaptionStyleOverrideTests(_LaneCTestCase):
    """Lane C merges short_config.caption_style onto baseline.caption_template
    so a bundled Style + per-scene edit lands in the same Lane C MP4."""

    def _baseline_with_template(self, template: dict | None) -> dict:
        props = {
            "config_version": 2,
            "voiceover_url": "https://gcs/voice.mp3",
            "duration_ms": 30000,
            "doodle_frames": [
                {
                    "id": "frame-00",
                    "url": "https://gcs/00-old.png",
                    "caption_chunk_start_index": 0,
                },
            ],
            "captions": [],
        }
        if template is not None:
            props["caption_template"] = template
        return props

    def _short_config_with_style(
        self, caption_style: dict | None,
    ) -> dict:
        cfg = {
            "config_version": 1,
            "character_base_url": "https://gcs/base.png",
            "doodle_frames": [
                {
                    "id": "frame-00",
                    "url": "https://gcs/00-old.png",
                    "image_prompt": "a forest",
                },
            ],
            "captions": [],
        }
        if caption_style is not None:
            cfg["caption_style"] = caption_style
        return cfg

    def _run(self, story_id: str, baseline_id: str):
        with mock.patch.object(
            shorts_lane_c.shorts_scene_regen,
            "regen_short_scene",
            return_value=("https://gcs/new.png", 5),
        ):
            return shorts_lane_c.build_short_props_lane_c(
                {
                    "story_id": story_id,
                    "lane_inputs": json.dumps({
                        "source_render_id": baseline_id,
                        "touched_frame_ids": ["frame-00"],
                    }),
                },
                Path(self._tmpdir.name),
            )

    def test_no_style_override_leaves_caption_template_alone(self):
        self._seed_baseline(
            "base-no-style", "story-no-style",
            self._baseline_with_template({"color": "#facc15"}),
        )
        self._seed_story_with_config(
            "story-no-style", self._short_config_with_style(None),
        )
        built = self._run("story-no-style", "base-no-style")
        self.assertEqual(built.props["caption_template"], {"color": "#facc15"})

    def test_style_override_merges_onto_baseline_template(self):
        self._seed_baseline(
            "base-with-style", "story-with-style",
            self._baseline_with_template({"color": "#facc15", "position_y": "0.6"}),
        )
        self._seed_story_with_config(
            "story-with-style",
            self._short_config_with_style(
                {"color": "#ff0000", "word_highlight": "scale"},
            ),
        )
        built = self._run("story-with-style", "base-with-style")
        self.assertEqual(built.props["caption_template"]["color"], "#ff0000")
        self.assertEqual(
            built.props["caption_template"]["word_highlight"], "scale",
        )
        self.assertEqual(
            built.props["caption_template"]["position_y"], "0.6",
        )

    def test_style_override_with_no_baseline_template(self):
        self._seed_baseline(
            "base-fresh-style", "story-fresh-style",
            self._baseline_with_template(None),
        )
        self._seed_story_with_config(
            "story-fresh-style",
            self._short_config_with_style({"color": "#00ff00"}),
        )
        built = self._run("story-fresh-style", "base-fresh-style")
        self.assertEqual(
            built.props["caption_template"], {"color": "#00ff00"},
        )


class AudioSanitizationTests(_LaneCTestCase):
    """Lane C reuses the baseline's voice + captions, so a baseline rendered
    BEFORE the audio-duration floor existed can carry stale metadata: phantom
    captions past the actual audio end, or a duration_ms that undershoots the
    audio. Lane C now re-probes the baseline's voice MP3 and reconciles
    duration_ms + captions against the real audio length so old baselines
    can't poison new Lane C renders. Falls back to baseline-as-is on probe
    failure — never makes things worse."""

    def _baseline_with_audio_state(
        self,
        captions: list[dict],
        duration_ms: int,
        end_hold_ms: int | None = None,
    ) -> dict:
        props = {
            "config_version": 2,
            "voiceover_url": "https://gcs/voice.mp3",
            "duration_ms": duration_ms,
            "doodle_frames": [
                {"id": "frame-00", "url": "https://gcs/00.png",
                 "caption_chunk_start_index": 0},
            ],
            "captions": captions,
        }
        if end_hold_ms is not None:
            props["end_hold_ms"] = end_hold_ms
        return props

    def _short_config(self) -> dict:
        return {
            "config_version": 1,
            "character_base_url": "https://gcs/base.png",
            "doodle_frames": [
                {"id": "frame-00", "url": "https://gcs/00.png",
                 "image_prompt": "a beat"},
            ],
            "captions": [],
        }

    def _run_lane_c(
        self,
        baseline_id: str,
        story_id: str,
        baseline_props: dict,
        audio_probe_ms: int,
    ):
        self._seed_baseline(baseline_id, story_id, baseline_props)
        self._seed_story_with_config(story_id, self._short_config())
        with mock.patch.object(
            shorts_lane_c.shorts_scene_regen,
            "regen_short_scene",
            return_value=("https://gcs/x.png", 5),
        ), mock.patch.object(
            shorts_lane_c,
            "_probe_baseline_audio_ms",
            return_value=audio_probe_ms,
        ):
            return shorts_lane_c.build_short_props_lane_c(
                {
                    "story_id": story_id,
                    "lane_inputs": json.dumps(
                        {
                            "source_render_id": baseline_id,
                            "touched_frame_ids": ["frame-00"],
                        },
                    ),
                },
                Path(self._tmpdir.name),
            )

    def test_audio_runs_past_captions_extends_last_caption(self):
        # Baseline captions end at 20s but real audio is 25s. Lane C bumps
        # the last caption to cover the trailing 5s of speech so the
        # on-screen text stays present until the audio ends.
        baseline = self._baseline_with_audio_state(
            captions=[
                {"start_ms": 0, "end_ms": 5000, "text": "first"},
                {"start_ms": 5000, "end_ms": 20000, "text": "second"},
            ],
            duration_ms=20000,
        )
        built = self._run_lane_c("base-ext", "story-ext", baseline, audio_probe_ms=25000)
        captions = built.props["captions"]
        self.assertEqual(len(captions), 2)
        self.assertEqual(captions[-1]["end_ms"], 25000)
        self.assertEqual(captions[-1]["text"], "second")
        self.assertEqual(built.props["duration_ms"], 25000)

    def test_audio_shorter_than_captions_trims_phantom_chunks(self):
        # Baseline captions extend to 36s but real audio is 30s. The 30-36s
        # captions describe content that doesn't exist in the audio — the
        # exact "captions completely unrelated to narration" symptom. Lane C
        # drops chunks past the audio length and clamps the last surviving
        # chunk to the audio end.
        baseline = self._baseline_with_audio_state(
            captions=[
                {"start_ms": 0, "end_ms": 10000, "text": "early"},
                {"start_ms": 10000, "end_ms": 20000, "text": "middle"},
                {"start_ms": 20000, "end_ms": 30500, "text": "boundary"},
                {"start_ms": 30500, "end_ms": 36000, "text": "phantom"},
            ],
            duration_ms=36000,
        )
        built = self._run_lane_c("base-trim", "story-trim", baseline, audio_probe_ms=30000)
        captions = built.props["captions"]
        # The phantom chunk is dropped (its start was past audio_ms).
        texts = [c["text"] for c in captions]
        self.assertNotIn("phantom", texts)
        self.assertEqual(len(captions), 3)
        # Last surviving caption clamps to the audio end.
        self.assertEqual(captions[-1]["end_ms"], 30000)
        # And duration matches the real audio.
        self.assertEqual(built.props["duration_ms"], 30000)

    def test_probe_failure_preserves_baseline_metadata(self):
        # When the probe can't reach the voice URL, the sanitizer must not
        # mutate anything — old behavior is the safe fallback. This is the
        # default path for any baseline whose GCS object got expired or
        # whose URL is malformed.
        baseline = self._baseline_with_audio_state(
            captions=[{"start_ms": 0, "end_ms": 30000, "text": "all of it"}],
            duration_ms=30000,
        )
        built = self._run_lane_c("base-keep", "story-keep", baseline, audio_probe_ms=0)
        self.assertEqual(built.props["captions"], baseline["captions"])
        self.assertEqual(built.props["duration_ms"], 30000)

    def test_end_hold_ms_backfilled_when_baseline_missing_it(self):
        # Baselines rendered before 61a4ba0 / 6775c13 cherry-pick don't carry
        # end_hold_ms. Lane C must backfill it so the outro can't splice in
        # immediately at body end (the original "outro cuts speech" symptom).
        baseline = self._baseline_with_audio_state(
            captions=[{"start_ms": 0, "end_ms": 30000, "text": "x"}],
            duration_ms=30000,
            end_hold_ms=None,  # legacy baseline
        )
        built = self._run_lane_c("base-eh", "story-eh", baseline, audio_probe_ms=30000)
        self.assertEqual(built.props["end_hold_ms"], shorts_lane_c.SHORT_END_HOLD_MS)

    def test_end_hold_ms_preserved_when_baseline_carries_it(self):
        # If the baseline already had its own end_hold_ms (a newer render),
        # respect that value — don't blindly overwrite with the constant.
        baseline = self._baseline_with_audio_state(
            captions=[{"start_ms": 0, "end_ms": 30000, "text": "x"}],
            duration_ms=30000,
            end_hold_ms=2200,  # custom value
        )
        built = self._run_lane_c("base-eh2", "story-eh2", baseline, audio_probe_ms=30000)
        self.assertEqual(built.props["end_hold_ms"], 2200)

    def test_empty_baseline_captions_dont_crash(self):
        # Defensive: a baseline whose captions list is empty (failed alignment
        # at gen time) must not raise. We return zero captions + use audio_ms
        # as the duration floor.
        baseline = self._baseline_with_audio_state(
            captions=[],
            duration_ms=10000,
        )
        built = self._run_lane_c("base-zc", "story-zc", baseline, audio_probe_ms=10000)
        self.assertEqual(built.props["captions"], [])
        self.assertEqual(built.props["duration_ms"], 10000)

    def test_reproduces_steak_standoff_prod_failure_scenario(self):
        # The exact failure from prod (THE STEAK STANDOFF, render ffe95fbe at
        # 2026-06-18T21:27Z): baseline had 29 captions whose last end_ms was
        # 36600ms but the actual voice MP3 was 30048ms. Lane C inherited the
        # bogus duration → 7s of dead audio in the rendered MP4 + outro
        # clipping speech once the audio briefly resumed.
        captions = [
            {"start_ms": i * 1200, "end_ms": (i + 1) * 1200, "text": f"chunk-{i}"}
            for i in range(29)
        ]
        # Tail of the last 5 chunks falls past audio_ms=30048; they're the
        # "phantom" captions the user was reading while the audio was silent.
        baseline = self._baseline_with_audio_state(
            captions=captions,
            duration_ms=36600,  # what Lane C inherited (wrong)
        )
        built = self._run_lane_c(
            "base-prod", "story-prod", baseline, audio_probe_ms=30048,
        )
        # The phantom chunks past audio_ms must be dropped.
        for cap in built.props["captions"]:
            self.assertLess(
                int(cap["start_ms"]), 30048,
                f"phantom caption survived sanitization: {cap}",
            )
        # The last surviving caption is clamped to the real audio end.
        self.assertEqual(built.props["captions"][-1]["end_ms"], 30048)
        # And the body duration matches the real audio — no more 7s gap.
        self.assertEqual(built.props["duration_ms"], 30048)
        # Reduces from 29 to ~25 captions (5 phantom chunks dropped: those
        # whose start_ms >= 30048).
        self.assertLess(len(built.props["captions"]), len(captions))

    def test_sanitize_helper_falls_back_when_probe_returns_zero(self):
        # Pure-helper test on _sanitize_baseline_audio_metadata: probe=0
        # signals "don't change anything". Asserts the helper contract
        # without going through the full lane c build.
        baseline = {
            "voiceover_url": "https://gcs/v.mp3",
            "duration_ms": 30000,
            "captions": [
                {"start_ms": 0, "end_ms": 20000, "text": "a"},
                {"start_ms": 20000, "end_ms": 30000, "text": "b"},
            ],
        }
        with mock.patch.object(
            shorts_lane_c, "_probe_baseline_audio_ms", return_value=0,
        ):
            caps, dur, audio_ms = shorts_lane_c._sanitize_baseline_audio_metadata(
                baseline, baseline["voiceover_url"],
            )
        self.assertEqual(caps, baseline["captions"])
        self.assertEqual(dur, 30000)
        self.assertEqual(audio_ms, 0)


class CacheBustHelperTests(unittest.TestCase):
    """Pure-helper tests for shorts_lane_c._cache_bust. Mirror of the
    shorts_render helper tests — same contract, separate import so a regression
    in one doesn't mask the other."""

    def test_appends_v_query_with_question_separator(self):
        self.assertEqual(
            shorts_lane_c._cache_bust("https://gcs/x.png", "abc12345"),
            "https://gcs/x.png?v=abc12345",
        )

    def test_appends_with_ampersand_when_url_already_has_query(self):
        self.assertEqual(
            shorts_lane_c._cache_bust("https://gcs/x.png?w=200", "abc12345"),
            "https://gcs/x.png?w=200&v=abc12345",
        )

    def test_returns_url_unchanged_on_empty_token(self):
        self.assertEqual(
            shorts_lane_c._cache_bust("https://gcs/x.png", ""),
            "https://gcs/x.png",
        )

    def test_returns_url_unchanged_on_non_string_input(self):
        self.assertIsNone(shorts_lane_c._cache_bust(None, "abc12345"))
        self.assertEqual(shorts_lane_c._cache_bust("", "abc12345"), "")


class ClearLaneTests(_LaneCTestCase):
    def test_clear_lane_nulls_the_column(self):
        with sqlite3.connect(store.DB_PATH) as c:
            c.execute(
                "INSERT INTO short_renders "
                "(id, story_id, config_hash, status, progress, requested_at, lane) "
                "VALUES ('rid', 's', 'h', 'queued', 0, '2026-06-16T00:00:00Z', 'C')",
            )
        shorts_lane_c.clear_lane("rid")
        row = store.get_short_render("rid")
        assert row is not None
        self.assertIsNone(row["lane"])


if __name__ == "__main__":
    unittest.main()
