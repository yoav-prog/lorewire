"""Tests for the hero + thumbnail finisher in pipeline.media.

The finisher reads the latest done short_render for a story, pulls its
character_base_url and scene list, asks the scene picker which two scenes
to seed from, then makes 5 i2i calls — hero (3:4 + 16:9) and thumbnail
(3:4 + 16:9 + 1:1). Each call sends image_input=[character, scene] in
THAT order; reversing it breaks character consistency.

Mocks the network surface (_generate_with_retry, images.download,
gcs.publish, the picker, the per-column store helpers) so the wiring is
verified without burning kie credits.

Plan: _plans/2026-06-19-reddit-source-auto-deliver-article-short-hero-thumbnail.md.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import media


STORY = {
    "id": "abc123",
    "title": "The Leaf Blower At Dawn",
    "body": "A neighbor turned a quiet street into an alarm clock at 6am.",
    "category": "Entitled",
}

SCENES = [
    {"scene": "Neighbor with leaf blower at dawn", "url": "https://kie/s0.png"},
    {"scene": "Frosted breath in cold air", "url": "https://kie/s1.png"},
    {"scene": "Window thrown open in fury", "url": "https://kie/s2.png"},
    {"scene": "Confrontation across the yard", "url": "https://kie/s3.png"},
    {"scene": "Quiet aftermath, looking at lawn", "url": "https://kie/s4.png"},
]

CHARACTER_URL = "https://kie/character-base.png"

SHORT_OUTPUT_URL = "https://gcs/bucket/short.mp4"

DONE_SHORT = {
    "status": "done",
    "output_url": SHORT_OUTPUT_URL,
    "props": json.dumps({
        "character_base_url": CHARACTER_URL,
        "scenes": SCENES,
        "duration_ms": 47_000,
    }),
}


def _patch_stack(stack: unittest.TestCase, **overrides):
    """Standard mock surface for the finisher tests. Each test can pass
    overrides for the entries it cares about."""
    base = {
        "fetch_story": mock.patch.object(media.store, "fetch_story", return_value=STORY),
        "latest_short": mock.patch.object(
            media.store, "latest_short_render_for_story", return_value=DONE_SHORT,
        ),
        "picker": mock.patch.object(
            media.stages, "pick_hero_and_thumbnail_scenes",
            return_value={
                "hero_index": 0,
                "thumbnail_index": 3,
                "picker_reasoning": "calm vs dramatic",
            },
        ),
        "make_thumb": mock.patch.object(
            media.stages, "make_thumbnail_prompt",
            side_effect=lambda *a, **k: f"prompt({k.get('aspect_ratio')})",
        ),
        "generate_with_retry": mock.patch.object(
            media, "_generate_with_retry", return_value="https://kie/result.png",
        ),
        "download": mock.patch.object(media.images, "download"),
        "publish": mock.patch.object(
            media.gcs, "publish",
            side_effect=lambda local, key, fallback: f"gs://bucket/{key}",
        ),
        "get_selected": mock.patch.object(
            media.models, "get_selected", return_value="kie/gpt-image-2",
        ),
        "update_hero": mock.patch.object(media.store, "update_story_hero"),
        "update_hero_landscape": mock.patch.object(
            media.store, "update_story_hero_landscape",
        ),
        "update_thumb": mock.patch.object(media.store, "update_story_thumbnail"),
        "update_thumb_landscape": mock.patch.object(
            media.store, "update_story_thumbnail_landscape",
        ),
        "update_thumb_square": mock.patch.object(
            media.store, "update_story_thumbnail_square",
        ),
        "update_scenes": mock.patch.object(
            media.store, "update_story_scenes",
        ),
        "update_video_url": mock.patch.object(
            media.store, "update_story_video_url",
        ),
        "update_duration": mock.patch.object(
            media.store, "update_story_duration",
        ),
    }
    base.update(overrides)
    started = {}
    for name, p in base.items():
        started[name] = p.start()
        stack.addCleanup(p.stop)
    return started


class HappyPathTests(unittest.TestCase):
    def test_all_five_variants_called_with_correct_aspect_and_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(self)
            result = media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        # Five calls total: 2 hero + 3 thumbnail. Each kie call receives
        # image_input=[character_base_url, scene_url] in exactly that order
        # (FIRST = identity, SECOND = composition — anything else and the
        # face drifts).
        calls = mocks["generate_with_retry"].call_args_list
        self.assertEqual(len(calls), 5)
        aspects = [c.kwargs["aspect_ratio"] for c in calls]
        self.assertEqual(aspects, ["3:4", "16:9", "3:4", "16:9", "1:1"])
        for c in calls:
            self.assertEqual(c.kwargs["model"], "kie/gpt-image-2-i2i")
            # The character URL must be first, scene URL second.
            inputs = c.kwargs["image_input"]
            self.assertEqual(inputs[0], CHARACTER_URL)
            self.assertIn(inputs[1], {SCENES[0]["url"], SCENES[3]["url"]})

    def test_hero_calls_use_hero_scene_thumbnail_calls_use_thumb_scene(self):
        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(self)
            media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        calls = mocks["generate_with_retry"].call_args_list
        # Order of variants in _HERO_THUMB_VARIANTS: hero portrait, hero
        # landscape, thumb portrait, thumb landscape, thumb square.
        # First two pull the hero scene (index 0 -> SCENES[0].url); last
        # three pull the thumbnail scene (index 3 -> SCENES[3].url).
        self.assertEqual(calls[0].kwargs["image_input"][1], SCENES[0]["url"])
        self.assertEqual(calls[1].kwargs["image_input"][1], SCENES[0]["url"])
        self.assertEqual(calls[2].kwargs["image_input"][1], SCENES[3]["url"])
        self.assertEqual(calls[3].kwargs["image_input"][1], SCENES[3]["url"])
        self.assertEqual(calls[4].kwargs["image_input"][1], SCENES[3]["url"])

    def test_each_landed_variant_writes_its_column(self):
        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(self)
            result = media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        mocks["update_hero"].assert_called_once()
        mocks["update_hero_landscape"].assert_called_once()
        mocks["update_thumb"].assert_called_once()
        mocks["update_thumb_landscape"].assert_called_once()
        mocks["update_thumb_square"].assert_called_once()
        # Result dict carries every URL so the worker can update its row.
        self.assertTrue(result["hero_image"].endswith("hero.png"))
        self.assertTrue(result["hero_image_landscape"].endswith("hero-landscape.png"))
        self.assertTrue(result["thumbnail_image"].endswith("thumbnail.png"))
        self.assertTrue(
            result["thumbnail_image_landscape"].endswith("thumbnail-landscape.png")
        )
        self.assertTrue(
            result["thumbnail_image_square"].endswith("thumbnail-square.png")
        )

    def test_total_cost_counts_only_variants_that_landed(self):
        # 5 variants land at $0.05 each = 25¢ total.
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self)
            result = media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        self.assertEqual(result["cost_cents"], 25)

    def test_picker_metadata_round_trips_into_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self)
            result = media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        self.assertEqual(result["hero_index"], 0)
        self.assertEqual(result["thumbnail_index"], 3)
        self.assertEqual(result["picker_reasoning"], "calm vs dramatic")

    def test_writes_short_scene_urls_into_stories_images(self):
        # 2026-06-19 (plan:
        # _plans/2026-06-19-no-long-form-video-for-reddit-jobs.md):
        # the worker stops generating long-form scene images, so the
        # finisher hands the short's scene URLs off to stories.images
        # for the public article reader's inline illustrations.
        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(self)
            media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        mocks["update_scenes"].assert_called_once()
        story_id, urls = mocks["update_scenes"].call_args.args
        self.assertEqual(story_id, "abc123")
        # All five SCENES carry URLs in the fixture; the handoff
        # passes them through verbatim and in order.
        self.assertEqual(urls, [s["url"] for s in SCENES])

    def test_auto_applies_short_as_stories_video_url(self):
        # 2026-06-19 (plan:
        # _plans/2026-06-19-no-long-form-video-for-reddit-jobs.md):
        # the finisher writes the short's output_url to stories.video_url
        # so the admin doesn't have to click the "Use as story video"
        # button. Mirrors what UseShortAsVideoButton + applyShortToStory
        # do on the TS side.
        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(self)
            media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        mocks["update_video_url"].assert_called_once_with(
            "abc123", SHORT_OUTPUT_URL,
        )

    def test_skips_video_url_apply_when_short_has_no_output_url(self):
        # Edge case: the short marks status='done' before the renderer
        # writes output_url (a race, or a render that failed midway but
        # left status=done somehow). We shouldn't blank out an existing
        # video_url by writing "". Skip the apply silently.
        broken_short = {
            "status": "done",
            "output_url": None,
            "props": DONE_SHORT["props"],
        }
        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(self, latest_short=mock.patch.object(
                media.store, "latest_short_render_for_story",
                return_value=broken_short,
            ))
            media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        mocks["update_video_url"].assert_not_called()
        # No video_url write -> no duration write either. stories.duration's
        # contract is "duration of the currently-applied video"; a skipped
        # apply must leave both columns untouched.
        mocks["update_duration"].assert_not_called()

    def test_auto_applies_short_duration_alongside_video_url(self):
        # The DONE_SHORT fixture carries duration_ms=47000 in its props
        # blob. After the finisher applies the short as the story's video,
        # stories.duration must land as the formatted "0:47" so the public
        # rail thumbnail badge stops painting the legacy "2:00".
        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(self)
            media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        mocks["update_duration"].assert_called_once_with("abc123", "0:47")

    def test_skips_duration_apply_when_props_lacks_duration_ms(self):
        # Older short_renders rows written before duration_ms was added to
        # the props schema. The video_url apply still runs (it doesn't
        # depend on duration_ms), but the duration write must be silently
        # skipped so we don't overwrite the column with an empty / "0:00"
        # value.
        short_without_duration = {
            "status": "done",
            "output_url": SHORT_OUTPUT_URL,
            "props": json.dumps({
                "character_base_url": CHARACTER_URL,
                "scenes": SCENES,
            }),
        }
        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(self, latest_short=mock.patch.object(
                media.store, "latest_short_render_for_story",
                return_value=short_without_duration,
            ))
            media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        mocks["update_video_url"].assert_called_once_with(
            "abc123", SHORT_OUTPUT_URL,
        )
        mocks["update_duration"].assert_not_called()


class PartialFailureTests(unittest.TestCase):
    def test_one_kie_call_returning_none_does_not_abort_the_others(self):
        # Drop the third call (thumbnail portrait) — kie returns None.
        # The other four variants must still ship, and the cost reflects
        # only the four that landed (20¢).
        sequence = iter([
            "https://kie/h.png",         # hero portrait
            "https://kie/h-land.png",    # hero landscape
            None,                        # thumb portrait FAILS
            "https://kie/t-land.png",    # thumb landscape
            "https://kie/t-sq.png",      # thumb square
        ])
        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(self, generate_with_retry=mock.patch.object(
                media, "_generate_with_retry", side_effect=lambda *a, **k: next(sequence),
            ))
            result = media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        self.assertIsNotNone(result["hero_image"])
        self.assertIsNotNone(result["hero_image_landscape"])
        self.assertIsNone(result["thumbnail_image"])
        self.assertIsNotNone(result["thumbnail_image_landscape"])
        self.assertIsNotNone(result["thumbnail_image_square"])
        self.assertEqual(result["cost_cents"], 20)
        mocks["update_thumb"].assert_not_called()


class SetupFailureTests(unittest.TestCase):
    """Setup failures MUST raise ValueError so the worker can surface a
    clear, admin-readable reason for skipping the finisher."""

    def test_raises_when_no_completed_short(self):
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self, latest_short=mock.patch.object(
                media.store, "latest_short_render_for_story", return_value=None,
            ))
            with self.assertRaisesRegex(ValueError, "no completed short"):
                media.generate_hero_and_thumbnail_from_short(
                    "abc123", Path(tmp),
                )

    def test_raises_when_short_status_not_done(self):
        running_short = {"status": "rendering", "props": DONE_SHORT["props"]}
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self, latest_short=mock.patch.object(
                media.store, "latest_short_render_for_story", return_value=running_short,
            ))
            with self.assertRaisesRegex(ValueError, "no completed short"):
                media.generate_hero_and_thumbnail_from_short(
                    "abc123", Path(tmp),
                )

    def test_raises_when_character_base_url_missing(self):
        short_without_char = {
            "status": "done",
            "props": json.dumps({"scenes": SCENES}),
        }
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self, latest_short=mock.patch.object(
                media.store, "latest_short_render_for_story", return_value=short_without_char,
            ))
            with self.assertRaisesRegex(ValueError, "no character_base_url"):
                media.generate_hero_and_thumbnail_from_short(
                    "abc123", Path(tmp),
                )

    def test_raises_when_scenes_missing(self):
        short_without_scenes = {
            "status": "done",
            "props": json.dumps({"character_base_url": CHARACTER_URL}),
        }
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self, latest_short=mock.patch.object(
                media.store, "latest_short_render_for_story",
                return_value=short_without_scenes,
            ))
            with self.assertRaisesRegex(ValueError, "no usable scene list"):
                media.generate_hero_and_thumbnail_from_short(
                    "abc123", Path(tmp),
                )

    def test_falls_back_to_doodle_frames_when_scenes_key_absent(self):
        # post-render props use `doodle_frames` instead of `scenes`. The
        # finisher accepts either source.
        short_with_doodle_frames = {
            "status": "done",
            "props": json.dumps({
                "character_base_url": CHARACTER_URL,
                "doodle_frames": SCENES,
            }),
        }
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self, latest_short=mock.patch.object(
                media.store, "latest_short_render_for_story",
                return_value=short_with_doodle_frames,
            ))
            result = media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        self.assertIsNotNone(result["hero_image"])

    def test_raises_when_props_blob_is_not_json(self):
        bad_short = {"status": "done", "props": "{this is not json"}
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self, latest_short=mock.patch.object(
                media.store, "latest_short_render_for_story", return_value=bad_short,
            ))
            with self.assertRaisesRegex(ValueError, "not valid JSON"):
                media.generate_hero_and_thumbnail_from_short(
                    "abc123", Path(tmp),
                )


class RegenWrapperTests(unittest.TestCase):
    """The admin "Generate hero + thumbnail from short" button dispatches
    through `regen_one(asset='hero_thumbnail_from_short')`. The wrapper
    must return the (first_url, total_cents) shape the image_renders queue
    expects."""

    def test_regen_one_dispatches_to_wrapper(self):
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self)
            url, cents = media.regen_one(
                "abc123", "hero_thumbnail_from_short", Path(tmp),
            )
        self.assertTrue(url.endswith("hero.png"))
        self.assertEqual(cents, 25)

    def test_regen_one_raises_when_all_five_fail(self):
        # All kie calls return None — the wrapper must raise because the
        # queue contract requires a sample URL for output_url.
        with tempfile.TemporaryDirectory() as tmp:
            _patch_stack(self, generate_with_retry=mock.patch.object(
                media, "_generate_with_retry", return_value=None,
            ))
            with self.assertRaisesRegex(RuntimeError, "all five i2i calls failed"):
                media.regen_one(
                    "abc123", "hero_thumbnail_from_short", Path(tmp),
                )


class ResumabilityTests(unittest.TestCase):
    """When the image_renders cron's Vercel function gets killed mid-run
    (5 sequential hybrid i2i calls don't fit in maxDuration=300s),
    `reap_stale_image_render_claims` puts the row back to queued and the
    next tick reclaims it. Without these guards the finisher would
    re-pick scenes AND re-run every i2i call from scratch, burning kie
    credits forever. See
    `_plans/2026-06-24-hero-thumb-finisher-resumable.md`.
    """

    def test_resumes_picker_choice_from_prior_scenes_picked_event(self):
        # Render context is bound and an older `scenes_picked` event is
        # already in the timeline → the LLM picker must NOT be called
        # again, and every i2i call must use the recovered indices.
        prior_payload = json.dumps({
            "hero_index": 2,
            "thumbnail_index": 4,
            "picker_reasoning": "from prior tick",
        })
        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(
                self,
                current_render_id=mock.patch.object(
                    media.store, "current_render_id", return_value="render-1",
                ),
                first_render_event=mock.patch.object(
                    media.store, "first_render_event",
                    return_value={"payload": prior_payload},
                ),
            )
            result = media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        mocks["picker"].assert_not_called()
        calls = mocks["generate_with_retry"].call_args_list
        self.assertEqual(len(calls), 5)
        # First two variants (hero portrait + landscape) seed from scenes[2];
        # last three (thumb portrait + landscape + square) seed from scenes[4].
        self.assertEqual(calls[0].kwargs["image_input"][1], SCENES[2]["url"])
        self.assertEqual(calls[1].kwargs["image_input"][1], SCENES[2]["url"])
        self.assertEqual(calls[2].kwargs["image_input"][1], SCENES[4]["url"])
        self.assertEqual(calls[3].kwargs["image_input"][1], SCENES[4]["url"])
        self.assertEqual(calls[4].kwargs["image_input"][1], SCENES[4]["url"])
        self.assertEqual(result["hero_index"], 2)
        self.assertEqual(result["thumbnail_index"], 4)
        self.assertEqual(result["picker_reasoning"], "from prior tick")

    def test_skips_variants_whose_story_columns_are_already_populated(self):
        # Story row already has hero_image + hero_image_landscape from a
        # prior tick's partial success. Variant loop must skip those two,
        # leave the carried-over URLs in place, and only fire the three
        # thumbnail i2i calls.
        partial_story = dict(STORY)
        partial_story["hero_image"] = "https://prev/hero.png"
        partial_story["hero_image_landscape"] = "https://prev/hero-landscape.png"
        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(
                self,
                fetch_story=mock.patch.object(
                    media.store, "fetch_story", return_value=partial_story,
                ),
            )
            result = media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        # Three i2i calls (the three thumbnail variants), not five.
        self.assertEqual(len(mocks["generate_with_retry"].call_args_list), 3)
        # No fresh writes to the already-populated hero columns.
        mocks["update_hero"].assert_not_called()
        mocks["update_hero_landscape"].assert_not_called()
        # Thumbnail columns still get written (all three fresh).
        mocks["update_thumb"].assert_called_once()
        mocks["update_thumb_landscape"].assert_called_once()
        mocks["update_thumb_square"].assert_called_once()
        # Carried-over URLs surface on the result dict so the queue
        # wrapper's first-URL sample sees them.
        self.assertEqual(result["hero_image"], "https://prev/hero.png")
        self.assertEqual(
            result["hero_image_landscape"], "https://prev/hero-landscape.png"
        )
        # cost_cents reflects only THIS tick's actual kie spend.
        self.assertEqual(result["cost_cents"], 15)

    def test_no_render_context_runs_full_picker_and_all_variants(self):
        # The story-jobs path runs without an image_renders row id bound,
        # so `current_render_id()` returns None and the resume branch
        # short-circuits. Picker MUST run, all 5 i2i calls MUST fire.
        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(
                self,
                current_render_id=mock.patch.object(
                    media.store, "current_render_id", return_value=None,
                ),
            )
            media.generate_hero_and_thumbnail_from_short(
                "abc123", Path(tmp),
            )
        mocks["picker"].assert_called_once()
        self.assertEqual(len(mocks["generate_with_retry"].call_args_list), 5)

    def test_second_cycle_only_retries_variants_whose_columns_are_empty(self):
        # The exact production bug, rolled into one test. Cycle 1 lands 3
        # of 5 variants; cycle 2 reclaims the same row. The picker must
        # NOT be called again and cycle 2's i2i attempts must be exactly
        # the 2 variants that didn't land in cycle 1 — not all 5 like
        # the unfixed code did. Note: cycle 1 itself still attempts all
        # 5 variants because nothing is pre-existing when it starts;
        # the resumability win shows up in cycle 2's smaller call count.

        # Story state shared across cycles. Column writers mutate it so
        # cycle 2's fresh fetch sees what cycle 1 persisted.
        story_state = dict(STORY)

        # The scenes_picked event log accumulates across ticks just like
        # the real `image_render_events` table. `first_render_event`
        # returns the oldest match (or None when empty).
        scenes_picked_payloads: list[dict] = []

        def fake_first_render_event(_render_id, event):
            if event != "scenes_picked":
                return None
            if not scenes_picked_payloads:
                return None
            return {"payload": json.dumps(scenes_picked_payloads[0])}

        def fake_log_render_event(
            event, message=None, *, level="info",
            payload=None, render_id=None,
        ):
            if event == "scenes_picked" and payload is not None:
                scenes_picked_payloads.append(dict(payload))

        # Track picker invocations so we can assert exactly one across
        # both cycles.
        picker_calls = []
        def fake_picker(*a, **k):
            picker_calls.append(1)
            return {
                "hero_index": 0,
                "thumbnail_index": 3,
                "picker_reasoning": "calm vs dramatic",
            }

        # _generate_with_retry: cycle 1 lands variants 1-3, "fails"
        # variants 4-5 by returning None. Cycle 2 lands the remaining
        # 2. After both cycles, generate_with_retry has been called
        # 5 times total — not 10.
        cycle1_results = iter([
            "https://kie/c1-hero.png",          # hero portrait
            "https://kie/c1-hero-landscape.png", # hero landscape
            "https://kie/c1-thumb.png",          # thumb portrait
            None,                                # thumb landscape FAILS
            None,                                # thumb square FAILS
        ])
        cycle2_results = iter([
            "https://kie/c2-thumb-landscape.png",
            "https://kie/c2-thumb-square.png",
        ])
        active = iter([])  # swapped per cycle

        def fake_generate(*a, **k):
            return next(active)

        # Column writers persist into story_state so cycle 2's
        # `fetch_story` sees the partial state.
        def make_writer(column):
            def writer(sid, url):
                story_state[column] = url
            return writer

        common = {
            "fetch_story": mock.patch.object(
                media.store, "fetch_story",
                side_effect=lambda sid: dict(story_state),
            ),
            "current_render_id": mock.patch.object(
                media.store, "current_render_id", return_value="render-loop-1",
            ),
            "first_render_event": mock.patch.object(
                media.store, "first_render_event",
                side_effect=fake_first_render_event,
            ),
            "log_render_event": mock.patch.object(
                media.store, "log_render_event",
                side_effect=fake_log_render_event,
            ),
            "picker": mock.patch.object(
                media.stages, "pick_hero_and_thumbnail_scenes",
                side_effect=fake_picker,
            ),
            "generate_with_retry": mock.patch.object(
                media, "_generate_with_retry", side_effect=fake_generate,
            ),
            "update_hero": mock.patch.object(
                media.store, "update_story_hero",
                side_effect=make_writer("hero_image"),
            ),
            "update_hero_landscape": mock.patch.object(
                media.store, "update_story_hero_landscape",
                side_effect=make_writer("hero_image_landscape"),
            ),
            "update_thumb": mock.patch.object(
                media.store, "update_story_thumbnail",
                side_effect=make_writer("thumbnail_image"),
            ),
            "update_thumb_landscape": mock.patch.object(
                media.store, "update_story_thumbnail_landscape",
                side_effect=make_writer("thumbnail_image_landscape"),
            ),
            "update_thumb_square": mock.patch.object(
                media.store, "update_story_thumbnail_square",
                side_effect=make_writer("thumbnail_image_square"),
            ),
        }

        with tempfile.TemporaryDirectory() as tmp:
            mocks = _patch_stack(self, **common)

            # Cycle 1 — fresh picker, attempts all 5 variants (story
            # starts empty so nothing is skipped). 3 land, 2 "fail"
            # (kie returns None — stand-in for any non-persisting
            # outcome, including a Vercel function kill mid-call).
            active = cycle1_results
            media.generate_hero_and_thumbnail_from_short("abc123", Path(tmp))
            calls_after_cycle_1 = len(
                mocks["generate_with_retry"].call_args_list
            )
            self.assertEqual(calls_after_cycle_1, 5)
            self.assertTrue(story_state.get("hero_image"))
            self.assertTrue(story_state.get("hero_image_landscape"))
            self.assertTrue(story_state.get("thumbnail_image"))
            self.assertFalse(story_state.get("thumbnail_image_landscape"))
            self.assertFalse(story_state.get("thumbnail_image_square"))
            self.assertEqual(len(picker_calls), 1)

            # Cycle 2 — reclaim. Picker MUST NOT fire again. Only the
            # 2 unfinished variants should re-enter i2i; the 3 already
            # persisted to the story row are skipped at the top of the
            # loop. If the resumability guard regresses, cycle 2's
            # delta would be 5 (the original bug's footprint).
            active = cycle2_results
            media.generate_hero_and_thumbnail_from_short("abc123", Path(tmp))

        cycle_2_delta = (
            len(mocks["generate_with_retry"].call_args_list)
            - calls_after_cycle_1
        )
        self.assertEqual(cycle_2_delta, 2)
        self.assertEqual(len(picker_calls), 1)
        # All five columns are now populated end-to-end.
        self.assertTrue(story_state["hero_image"])
        self.assertTrue(story_state["hero_image_landscape"])
        self.assertTrue(story_state["thumbnail_image"])
        self.assertTrue(story_state["thumbnail_image_landscape"])
        self.assertTrue(story_state["thumbnail_image_square"])


if __name__ == "__main__":
    unittest.main()
