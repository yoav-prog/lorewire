"""Tests for pipeline.shorts_render — the short props assembly.

Focus: the base reference frame must NEVER become a visible scene (it is the
i2i character anchor only), it must instead survive as props.character_base_url,
and the opening scene must cover t=0. Plus a guard that the shared doodle style
suffix no longer hard-codes a single character's identity (that made every
short the same glasses-wearing person). See
_plans/2026-06-17-shorts-editor-and-character-bugs.md.

The generation + voice + upload steps are stubbed so the assembly logic is
exercised without burning kie / TTS credits or touching the network.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import shorts, shorts_image_style as sis, shorts_render


class MapFramesTests(unittest.TestCase):
    def test_first_frame_pinned_to_caption_zero(self):
        # Even when every scene was planned against a later beat, the opening
        # frame is pinned to caption 0 so DoodleShort has no blank lead.
        staged = [
            {"id": "frame-00", "url": "u0", "planned": 3, "image_prompt": None},
            {"id": "frame-01", "url": "u1", "planned": 6, "image_prompt": None},
        ]
        frames = shorts_render._map_frames(staged, caption_count=10, planning_count=8)
        self.assertEqual(frames[0]["caption_chunk_start_index"], 0)

    def test_indices_stay_unique_and_sorted(self):
        staged = [
            {"id": "a", "url": "ua", "planned": 0, "image_prompt": None},
            {"id": "b", "url": "ub", "planned": 0, "image_prompt": None},
            {"id": "c", "url": "uc", "planned": 1, "image_prompt": None},
        ]
        frames = shorts_render._map_frames(staged, caption_count=6, planning_count=3)
        idxs = [f["caption_chunk_start_index"] for f in frames]
        self.assertEqual(idxs, sorted(idxs))
        self.assertEqual(len(idxs), len(set(idxs)))


class ExtendFirstSceneOverHookTests(unittest.TestCase):
    """The opening scene must span the WHOLE spoken hook so the hook-first splice
    separates hook from rest without scene 2's caption bleeding across the intro.
    See _plans/2026-06-29-hook-first-clean-pacing.md."""

    # Caption chunks for "She brought / a secret / child / HOURS EARLIER / ...":
    # the hook ends at ~1880ms, inside chunk 2 ("child"); chunk 3 is the first
    # post-hook chunk.
    CAPS = [
        {"start_ms": 0, "end_ms": 650},
        {"start_ms": 700, "end_ms": 1550},
        {"start_ms": 1600, "end_ms": 1880},
        {"start_ms": 2300, "end_ms": 2900},
        {"start_ms": 3000, "end_ms": 3800},
        {"start_ms": 4000, "end_ms": 4800},
    ]

    def _frames(self, *idxs: int) -> list[dict]:
        return [
            {"id": f"frame-{i:02d}", "url": f"u{i}", "caption_chunk_start_index": idx}
            for i, idx in enumerate(idxs)
        ]

    def _idxs(self, frames: list[dict]) -> list[int]:
        return [f["caption_chunk_start_index"] for f in frames]

    def test_scene_two_inside_hook_shifts_to_first_post_hook_chunk(self):
        # Scene 2 planned on the "child" chunk (2, inside the hook) moves to the
        # first chunk that starts after hook_end_ms (3 = "HOURS EARLIER"), and the
        # split snaps to that chunk's start_ms (2300) so the cut is on the edge.
        frames = self._frames(0, 2)
        frames, split = shorts_render._extend_first_scene_over_hook(frames, self.CAPS, 1880)
        self.assertEqual(self._idxs(frames), [0, 3])
        self.assertEqual(split, 2300)

    def test_multiple_scenes_in_hook_dedup_without_collision(self):
        frames = self._frames(0, 1, 2)
        frames, split = shorts_render._extend_first_scene_over_hook(frames, self.CAPS, 1880)
        idxs = self._idxs(frames)
        self.assertEqual(idxs, [0, 3, 4])
        self.assertEqual(len(idxs), len(set(idxs)))  # strictly increasing
        self.assertEqual(split, 2300)

    def test_scenes_already_past_hook_unchanged_but_split_snaps(self):
        frames = self._frames(0, 3, 4)
        frames, split = shorts_render._extend_first_scene_over_hook(frames, self.CAPS, 1880)
        self.assertEqual(self._idxs(frames), [0, 3, 4])
        self.assertEqual(split, 2300)

    def test_noop_when_hook_absent(self):
        frames = self._frames(0, 2)
        frames, split = shorts_render._extend_first_scene_over_hook(frames, self.CAPS, 0)
        self.assertEqual(self._idxs(frames), [0, 2])
        self.assertEqual(split, 0)

    def test_noop_with_single_scene(self):
        frames = self._frames(0)
        frames, split = shorts_render._extend_first_scene_over_hook(frames, self.CAPS, 1880)
        self.assertEqual(self._idxs(frames), [0])
        self.assertEqual(split, 1880)

    def test_noop_when_hook_spans_whole_clip(self):
        # hook_end_ms past the last chunk start -> no post-hook chunk -> leave it.
        frames = self._frames(0, 2)
        frames, split = shorts_render._extend_first_scene_over_hook(frames, self.CAPS, 99999)
        self.assertEqual(self._idxs(frames), [0, 2])
        self.assertEqual(split, 99999)

    def test_never_exceeds_last_caption_index(self):
        frames = self._frames(0, 1, 2)
        frames, _ = shorts_render._extend_first_scene_over_hook(frames, self.CAPS, 1880)
        for f in frames:
            self.assertLessEqual(f["caption_chunk_start_index"], len(self.CAPS) - 1)

    def test_padded_hook_end_overshooting_caption_boundary_snaps_back(self):
        # Real-data shape (story idea_15da45a5bbbd): the hook "She brought a
        # secret child" ends at caption [1] (..1800ms), but hook_end_ms=1880
        # (HOOK_END_PAD_MS=80 past the boundary) lands INSIDE caption [2]
        # ("Hours earlier", 1800-3200). Snapping by "first chunk start >=
        # hook_end_ms" would jump to caption [3] (3200) and leave "Hours
        # earlier" before the intro; snapping by nearest caption END lands the
        # split on 1800 with scene 2 at chunk 2.
        caps = [
            {"start_ms": 100, "end_ms": 1200},   # "She brought a secret"
            {"start_ms": 1200, "end_ms": 1800},  # "child."
            {"start_ms": 1800, "end_ms": 3200},  # "Hours earlier."
            {"start_ms": 3200, "end_ms": 5100},  # "He expected a normal"
        ]
        frames = self._frames(0, 1)
        frames, split = shorts_render._extend_first_scene_over_hook(frames, caps, 1880)
        self.assertEqual(self._idxs(frames), [0, 2])
        self.assertEqual(split, 1800)


class BuildShortPropsBaseFrameTests(unittest.TestCase):
    """The base reference image is the model's i2i identity anchor — a neutral
    standing pose on a plain background. It must not appear in the rendered
    video; it lives only as props.character_base_url."""

    def _assets(self) -> shorts.ShortAssets:
        return shorts.ShortAssets(
            narration_style="suspense",
            length_preset="standard",
            script={"short_script": "Hello there. This is a short test script."},
            character="a tall man with a red scarf",
            base_url="https://kie/base.png",
            base_prompt="BASE PROMPT",
            scenes=[
                {"caption_chunk_start_index": 0, "scene": "s0", "url": "https://kie/s0.png", "image_prompt": "p0"},
                {"caption_chunk_start_index": 2, "scene": "s1", "url": "https://kie/s1.png", "image_prompt": "p1"},
            ],
            cost_credits=0.0,
        )

    def test_base_excluded_from_frames_but_kept_as_character_base_url(self):
        words = [
            {"word": "Hello", "start": 0.0, "end": 0.4},
            {"word": "there.", "start": 0.4, "end": 0.9},
            {"word": "This", "start": 1.0, "end": 1.3},
            {"word": "is", "start": 1.3, "end": 1.5},
            {"word": "a", "start": 1.5, "end": 1.6},
            {"word": "short.", "start": 1.6, "end": 2.1},
        ]
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(shorts_render.store, "fetch_story",
                              return_value={"id": "s1", "title": "T", "body": "Body text here."}), \
            mock.patch.object(shorts_render.shorts, "generate_short_assets",
                              return_value=self._assets()), \
            mock.patch("pipeline.voice.synthesize",
                              return_value={"words": words}), \
            mock.patch.object(shorts_render.images, "download", return_value=None), \
            mock.patch.object(shorts_render.store, "get_setting", return_value=None):
            built = shorts_render.build_short_props("s1", Path(tmp), remote=False)

        self.assertIsNotNone(built)
        props = built.props
        # The base reference is preserved for Lane C regen / the editor...
        self.assertEqual(props["character_base_url"], "https://kie/base.png")
        # ...but it is NOT one of the visible frames.
        frame_urls = [f["url"] for f in props["doodle_frames"]]
        self.assertNotIn("https://kie/base.png", frame_urls)
        # Exactly the two scenes became frames (no base prepended).
        self.assertEqual(len(props["doodle_frames"]), 2)
        # And the short still opens at t=0.
        self.assertEqual(props["doodle_frames"][0]["caption_chunk_start_index"], 0)

    def test_duration_floors_at_real_audio_length(self):
        # The last aligned word ends at ~2.1s, but the real MP3 runs 8s (a
        # provider whose word timings undershoot the file). The composition body
        # must cover the FULL audio or the concatenated outro clips the closing
        # words, so duration_ms floors at the probe value.
        words = [
            {"word": "Hello", "start": 0.0, "end": 0.4},
            {"word": "short.", "start": 1.6, "end": 2.1},
        ]
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(shorts_render.store, "fetch_story",
                              return_value={"id": "s1", "title": "T", "body": "Body text here."}), \
            mock.patch.object(shorts_render.shorts, "generate_short_assets",
                              return_value=self._assets()), \
            mock.patch.object(shorts_render.voice, "synthesize",
                              return_value={"words": words}), \
            mock.patch.object(shorts_render.voice, "audio_duration_ms", return_value=8000), \
            mock.patch.object(shorts_render.images, "download", return_value=None), \
            mock.patch.object(shorts_render.store, "get_setting", return_value=None):
            built = shorts_render.build_short_props("s1", Path(tmp), remote=False)
        self.assertEqual(built.props["duration_ms"], 8000)

    def test_last_caption_extended_to_audio_tail_when_audio_runs_long(self):
        # User-visible symptom: last caption disappears while the narrator
        # keeps talking, so it reads as "captions don't match the narration".
        # When the audio probe shows the file runs past the last caption's
        # end_ms, extend the last caption to cover the trailing audio so the
        # on-screen text stays present until the audio actually ends.
        words = [
            {"word": "Hello", "start": 0.0, "end": 0.4},
            {"word": "short.", "start": 1.6, "end": 2.1},  # caption_end = 2100ms
        ]
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(shorts_render.store, "fetch_story",
                              return_value={"id": "s1", "title": "T", "body": "Body text here."}), \
            mock.patch.object(shorts_render.shorts, "generate_short_assets",
                              return_value=self._assets()), \
            mock.patch.object(shorts_render.voice, "synthesize",
                              return_value={"words": words}), \
            mock.patch.object(shorts_render.voice, "audio_duration_ms", return_value=8000), \
            mock.patch.object(shorts_render.images, "download", return_value=None), \
            mock.patch.object(shorts_render.store, "get_setting", return_value=None):
            built = shorts_render.build_short_props("s1", Path(tmp), remote=False)
        captions = built.props["captions"]
        # The last caption now covers up to the audio's actual end.
        self.assertEqual(captions[-1]["end_ms"], 8000)
        # And the text wasn't rewritten — we only stretch the time window.
        original_text = captions[-1]["text"]
        self.assertIsInstance(original_text, str)
        self.assertGreater(len(original_text), 0)

    def test_last_caption_unchanged_when_audio_matches_alignment(self):
        # Defensive: when the audio probe agrees with (or undershoots) the
        # last caption's end_ms, the last caption stays exactly as the
        # provider returned it. Avoids spurious end_ms bumps that could
        # desync the caption timeline against itself.
        words = [
            {"word": "Hello", "start": 0.0, "end": 0.4},
            {"word": "short.", "start": 1.6, "end": 2.1},
        ]
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(shorts_render.store, "fetch_story",
                              return_value={"id": "s1", "title": "T", "body": "Body text here."}), \
            mock.patch.object(shorts_render.shorts, "generate_short_assets",
                              return_value=self._assets()), \
            mock.patch.object(shorts_render.voice, "synthesize",
                              return_value={"words": words}), \
            mock.patch.object(shorts_render.voice, "audio_duration_ms", return_value=2100), \
            mock.patch.object(shorts_render.images, "download", return_value=None), \
            mock.patch.object(shorts_render.store, "get_setting", return_value=None):
            built = shorts_render.build_short_props("s1", Path(tmp), remote=False)
        self.assertEqual(built.props["captions"][-1]["end_ms"], 2100)

    def test_props_includes_end_hold_ms_so_outro_doesnt_clip(self):
        # The 1.5s post-roll hold runs AFTER duration_ms. Combined with the
        # audio-duration floor it means the held last frame plays for 1.5s
        # past the narration before the outro splices on — a hard guarantee
        # the closing word always finishes.
        words = [
            {"word": "Hello", "start": 0.0, "end": 0.4},
            {"word": "short.", "start": 1.6, "end": 2.1},
        ]
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(shorts_render.store, "fetch_story",
                              return_value={"id": "s1", "title": "T", "body": "Body text here."}), \
            mock.patch.object(shorts_render.shorts, "generate_short_assets",
                              return_value=self._assets()), \
            mock.patch.object(shorts_render.voice, "synthesize",
                              return_value={"words": words}), \
            mock.patch.object(shorts_render.voice, "audio_duration_ms", return_value=2100), \
            mock.patch.object(shorts_render.images, "download", return_value=None), \
            mock.patch.object(shorts_render.store, "get_setting", return_value=None):
            built = shorts_render.build_short_props("s1", Path(tmp), remote=False)
        self.assertEqual(built.props["end_hold_ms"], shorts_render.SHORT_END_HOLD_MS)
        self.assertGreater(built.props["end_hold_ms"], 0)

    def test_frame_urls_carry_cache_bust_query_so_editor_sees_fresh(self):
        # User-visible symptom: the editor shows the previous render's scene
        # thumbnails after a regenerate because each render overwrites
        # frame-NN.png on GCS and the browser caches by URL. Appending
        # `?v=<token>` makes every render produce visually distinct URLs so
        # the browser hits a fresh fetch.
        words = [{"word": "Hello", "start": 0.0, "end": 0.4}]
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(shorts_render.store, "fetch_story",
                              return_value={"id": "s1", "title": "T", "body": "Body text here."}), \
            mock.patch.object(shorts_render.shorts, "generate_short_assets",
                              return_value=self._assets()), \
            mock.patch.object(shorts_render.voice, "synthesize",
                              return_value={"words": words}), \
            mock.patch.object(shorts_render.voice, "audio_duration_ms", return_value=1000), \
            mock.patch.object(shorts_render.images, "download", return_value=None), \
            mock.patch.object(shorts_render.store, "get_setting", return_value=None):
            first = shorts_render.build_short_props("s1", Path(tmp), remote=False)
            second = shorts_render.build_short_props("s1", Path(tmp), remote=False)
        for frame in first.props["doodle_frames"]:
            self.assertIn("?v=", frame["url"], f"frame missing cache-bust: {frame['url']}")
        # Voice URL also gets the bust so the editor's audio preview refreshes.
        self.assertIn("?v=", first.props["voiceover_url"])
        # Each render produces a different token so URLs across regens differ.
        self.assertNotEqual(
            first.props["doodle_frames"][0]["url"],
            second.props["doodle_frames"][0]["url"],
            "two consecutive renders produced the same cache-bust URL",
        )


class ComputeHookEndMsTests(unittest.TestCase):
    """Pure-helper tests for shorts_render.compute_hook_end_ms. The boundary
    drives the hook-first splice reorder; off-by-a-syllable here means the
    brand intro lands mid-hook, so each branch (matched / fallback / empty)
    gets a focused lock. Per _plans/2026-06-28-hook-before-brand-intro.md."""

    def test_aligned_when_every_hook_token_matches_in_order(self):
        # The end timestamp + a small trailing pad (HOOK_END_PAD_MS) so the
        # syllable lands before the brand stinger jumps in.
        ms, source = shorts_render.compute_hook_end_ms(
            "Eight hundred dollars. Gone.",
            [
                {"word": "Eight", "start": 0.0, "end": 0.4},
                {"word": "hundred", "start": 0.4, "end": 0.9},
                {"word": "dollars.", "start": 0.9, "end": 1.6},
                {"word": "Gone.", "start": 1.8, "end": 2.2},
                {"word": "This", "start": 2.5, "end": 2.7},
                {"word": "started", "start": 2.7, "end": 3.1},
            ],
        )
        self.assertEqual(source, "aligned")
        self.assertEqual(ms, 2200 + shorts_render.HOOK_END_PAD_MS)

    def test_aligned_strips_punctuation_and_is_case_insensitive(self):
        # Hook: "DON'T LOOK NOW". Alignment: lowercase, no apostrophe.
        # Both normalize to the same token sequence and match.
        ms, source = shorts_render.compute_hook_end_ms(
            "DON'T LOOK NOW.",
            [
                {"word": "dont", "start": 0.0, "end": 0.5},
                {"word": "look", "start": 0.5, "end": 0.9},
                {"word": "now", "start": 0.9, "end": 1.3},
            ],
        )
        self.assertEqual(source, "aligned")
        self.assertEqual(ms, 1300 + shorts_render.HOOK_END_PAD_MS)

    def test_aligned_ignores_alignment_words_past_the_hook(self):
        # Hook is 2 tokens; alignment continues into beat 2 ("This started").
        # Boundary is the second matched word, NOT the last word in alignment.
        ms, source = shorts_render.compute_hook_end_ms(
            "Gone forever.",
            [
                {"word": "Gone", "start": 0.0, "end": 0.5},
                {"word": "forever.", "start": 0.5, "end": 1.2},
                {"word": "This", "start": 1.5, "end": 1.7},
                {"word": "started", "start": 1.7, "end": 2.1},
            ],
        )
        self.assertEqual(source, "aligned")
        self.assertEqual(ms, 1200 + shorts_render.HOOK_END_PAD_MS)

    def test_fallback_when_alignment_doesnt_contain_hook_tokens(self):
        # Drift / homophone — alignment says "ate hundred" instead of
        # "eight hundred". The matcher refuses partial matches because a
        # too-early cut clips the hook mid-syllable; fall back to the
        # script-budget midpoint with the "fallback" source flag.
        ms, source = shorts_render.compute_hook_end_ms(
            "Eight hundred dollars gone.",
            [
                {"word": "ate", "start": 0.0, "end": 0.3},
                {"word": "hundred", "start": 0.3, "end": 0.8},
                {"word": "dollars.", "start": 0.8, "end": 1.4},
            ],
        )
        self.assertEqual(source, "fallback")
        self.assertEqual(ms, shorts_render.HOOK_FALLBACK_MS)

    def test_fallback_when_alignment_is_empty(self):
        ms, source = shorts_render.compute_hook_end_ms("Eight hundred gone.", [])
        self.assertEqual(source, "fallback")
        self.assertEqual(ms, shorts_render.HOOK_FALLBACK_MS)

    def test_empty_when_hook_is_missing_or_blank(self):
        # No hook ⇒ no boundary to compute. Returns 0/"empty" so the
        # dispatcher gates the splice reorder OFF (legacy ordering).
        for bad in (None, "", "   ", ".", "?!"):
            ms, source = shorts_render.compute_hook_end_ms(
                bad,
                [{"word": "anything", "start": 0.0, "end": 0.5}],
            )
            self.assertEqual(ms, 0, f"hook={bad!r} should yield 0")
            self.assertEqual(source, "empty", f"hook={bad!r} should be empty")

    def test_handles_alignment_word_with_punctuation_tail(self):
        # Provider returns "hook." trailing the period; tokenizer strips it
        # so the match still succeeds.
        ms, source = shorts_render.compute_hook_end_ms(
            "The hook lands",
            [
                {"word": "The", "start": 0.0, "end": 0.2},
                {"word": "hook.", "start": 0.2, "end": 0.6},
                {"word": "lands", "start": 0.6, "end": 1.0},
            ],
        )
        self.assertEqual(source, "aligned")
        self.assertEqual(ms, 1000 + shorts_render.HOOK_END_PAD_MS)

    def test_alignment_entry_without_end_timestamp_falls_back(self):
        # Malformed alignment row (no `end` key) on the last hook word ⇒
        # we can't compute a real boundary. Fall back rather than emit a
        # bogus zero.
        ms, source = shorts_render.compute_hook_end_ms(
            "Two words",
            [
                {"word": "two", "start": 0.0, "end": 0.3},
                {"word": "words", "start": 0.3},  # no `end`
            ],
        )
        self.assertEqual(source, "fallback")
        self.assertEqual(ms, shorts_render.HOOK_FALLBACK_MS)


class HookTailHoldTests(unittest.TestCase):
    """Pure-helper tests for the per-video hook-first audio tail-hold
    (next_word_start_after_hook_ms + compute_hook_tail_hold_ms). The hold lets
    the hook clip's last word finish over a frozen frame; sizing it to the REAL
    gap before the next spoken word is what stops it bleeding into the next
    sentence when the hook has no pause after it (the 1l39ygh "you hear the next
    line start, then the intro cuts it" bug).
    Per _plans/2026-06-29-hook-first-clean-pacing.md."""

    def test_next_word_start_is_the_first_word_after_the_hook(self):
        # Hook is 2 tokens ("Gone forever."); the next spoken word is "This".
        start = shorts_render.next_word_start_after_hook_ms(
            "Gone forever.",
            [
                {"word": "Gone", "start": 0.0, "end": 0.5},
                {"word": "forever.", "start": 0.5, "end": 1.2},
                {"word": "This", "start": 1.5, "end": 1.7},
                {"word": "started", "start": 1.7, "end": 2.1},
            ],
        )
        self.assertEqual(start, 1500)

    def test_next_word_start_none_when_hook_is_the_last_thing_spoken(self):
        start = shorts_render.next_word_start_after_hook_ms(
            "Gone forever.",
            [
                {"word": "Gone", "start": 0.0, "end": 0.5},
                {"word": "forever.", "start": 0.5, "end": 1.2},
            ],
        )
        self.assertIsNone(start)

    def test_next_word_start_none_when_hook_doesnt_match(self):
        # Drift: the alignment never completes the hook token sequence.
        start = shorts_render.next_word_start_after_hook_ms(
            "Eight hundred gone.",
            [
                {"word": "ate", "start": 0.0, "end": 0.3},
                {"word": "hundred", "start": 0.3, "end": 0.8},
            ],
        )
        self.assertIsNone(start)

    def test_next_word_start_none_on_empty_inputs(self):
        self.assertIsNone(shorts_render.next_word_start_after_hook_ms("", []))
        self.assertIsNone(
            shorts_render.next_word_start_after_hook_ms(
                None, [{"word": "x", "start": 0.0, "end": 0.1}]
            )
        )
        self.assertIsNone(shorts_render.next_word_start_after_hook_ms("hook", []))

    def test_tail_hold_zero_when_next_sentence_butts_against_the_hook(self):
        # 1l39ygh: the hook ends and the next sentence starts on the same edge.
        # No pause -> 0 hold, so the splice never clips the next line's first
        # word ("Twenty") into the pre-intro clip.
        words = [
            {"word": "Cold", "start": 0.1, "end": 0.3},
            {"word": "water", "start": 0.3, "end": 0.7},
            {"word": "hit", "start": 0.7, "end": 0.9},
            {"word": "her", "start": 0.9, "end": 1.1},
            {"word": "face", "start": 1.1, "end": 1.5},
            {"word": "again.", "start": 1.5, "end": 1.72},
            {"word": "Twenty", "start": 1.8, "end": 2.1},
            {"word": "years", "start": 2.1, "end": 2.4},
        ]
        hold = shorts_render.compute_hook_tail_hold_ms(
            "Cold water hit her face again.", words, 1800
        )
        self.assertEqual(hold, 0)

    def test_tail_hold_is_the_pause_capped_at_max(self):
        # A 500ms pause before the next sentence -> hold caps at the max so the
        # pre-intro beat never drags.
        words = [
            {"word": "She", "start": 0.1, "end": 0.3},
            {"word": "brought", "start": 0.3, "end": 0.7},
            {"word": "a", "start": 0.7, "end": 0.8},
            {"word": "secret", "start": 0.8, "end": 1.3},
            {"word": "child.", "start": 1.3, "end": 1.8},
            {"word": "Hours", "start": 2.3, "end": 2.6},
            {"word": "earlier.", "start": 2.6, "end": 3.2},
        ]
        hold = shorts_render.compute_hook_tail_hold_ms(
            "She brought a secret child.", words, 1800
        )
        self.assertEqual(hold, shorts_render.HOOK_TAIL_HOLD_MAX_MS)

    def test_tail_hold_is_a_short_gap_verbatim(self):
        # A sub-cap gap (150ms < 300ms cap) is held in full.
        words = [
            {"word": "One", "start": 0.0, "end": 0.4},
            {"word": "two.", "start": 0.4, "end": 1.0},
            {"word": "Next", "start": 1.15, "end": 1.5},
        ]
        hold = shorts_render.compute_hook_tail_hold_ms("One two.", words, 1000)
        self.assertEqual(hold, 150)

    def test_tail_hold_falls_back_to_max_when_next_word_unknown(self):
        # No following word -> can't measure a gap -> the legacy constant hold.
        hold = shorts_render.compute_hook_tail_hold_ms(
            "One two.",
            [
                {"word": "One", "start": 0.0, "end": 0.4},
                {"word": "two.", "start": 0.4, "end": 1.0},
            ],
            1000,
        )
        self.assertEqual(hold, shorts_render.HOOK_TAIL_HOLD_MAX_MS)

    def test_tail_hold_clamps_negative_gap_to_zero(self):
        # Defensive: the snapped cut sits PAST the next word (shouldn't happen,
        # but max(0, ...) guards it) -> 0, never a negative hold.
        words = [
            {"word": "One", "start": 0.0, "end": 0.4},
            {"word": "two.", "start": 0.4, "end": 1.0},
            {"word": "Next", "start": 1.1, "end": 1.5},
        ]
        hold = shorts_render.compute_hook_tail_hold_ms("One two.", words, 1500)
        self.assertEqual(hold, 0)


class CacheBustHelperTests(unittest.TestCase):
    """Pure-helper tests for shorts_render._cache_bust. Covered separately so a
    URL-shape edge case can't regress without a targeted failure."""

    def test_appends_v_query_with_question_separator(self):
        result = shorts_render._cache_bust("https://gcs/x.png", "abc12345")
        self.assertEqual(result, "https://gcs/x.png?v=abc12345")

    def test_appends_with_ampersand_when_url_already_has_query(self):
        result = shorts_render._cache_bust("https://gcs/x.png?w=200", "abc12345")
        self.assertEqual(result, "https://gcs/x.png?w=200&v=abc12345")

    def test_returns_url_unchanged_on_empty_token(self):
        self.assertEqual(shorts_render._cache_bust("https://gcs/x.png", ""), "https://gcs/x.png")

    def test_returns_url_unchanged_on_non_string_input(self):
        self.assertIsNone(shorts_render._cache_bust(None, "abc12345"))
        self.assertEqual(shorts_render._cache_bust("", "abc12345"), "")


class BuildQuestionCardTests(unittest.TestCase):
    """Phase 3 of _plans/2026-06-17-engagement-polls.md. The
    `_build_question_card` resolver decides whether to bake the burnt-in
    end card. Story rows resolve cleanly to a dict; missing or disabled
    polls return None and the short renders byte-identical to its
    pre-poll shape."""

    def _row(self, **over) -> dict:
        base = {
            "id": "story-1",
            "slug": "wife-vs-husband",
            "title": "T",
            "body": "Body text.",
        }
        base.update(over)
        return base

    def _poll(self, **over) -> dict:
        base = {
            "id": "poll-1",
            "story_id": "story-1",
            "question": "Who's wrong?",
            "option_a_text": "Wife",
            "option_b_text": "Husband",
            "enabled": 1,
            "category": "Drama",
        }
        base.update(over)
        return base

    def test_returns_card_when_poll_enabled(self):
        with mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNotNone(card)
        self.assertEqual(card["question"], "Who's wrong?")
        self.assertEqual(card["option_a"], "Wife")
        self.assertEqual(card["option_b"], "Husband")
        self.assertEqual(card["slug"], "wife-vs-husband")
        self.assertEqual(card["card_ms"], shorts_render.QUESTION_CARD_MS)

    def test_returns_none_when_no_poll(self):
        with mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=None,
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNone(card)

    def test_falls_back_to_story_id_when_slug_missing(self):
        with mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = shorts_render._build_question_card(self._row(slug=None))
        self.assertIsNotNone(card)
        self.assertEqual(card["slug"], "story-1")

    def test_skips_when_question_is_empty(self):
        with mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(question=""),
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNone(card)

    def test_skips_when_option_label_is_empty(self):
        with mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(option_b_text=""),
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNone(card)

    def test_returns_none_when_row_has_no_id(self):
        with mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ) as fetch:
            card = shorts_render._build_question_card({"slug": "x"})
        self.assertIsNone(card)
        # Defensive: the resolver should bail BEFORE hitting the DB
        # so a malformed row never wastes a query.
        fetch.assert_not_called()

    def test_returns_none_when_endcard_setting_disabled(self):
        # Master switch: polls.endcard.enabled = "0" → no card, period.
        # Even with a valid enabled poll on the row.
        with mock.patch.object(
            shorts_render.store,
            "get_setting",
            side_effect=lambda k: "0" if k == "polls.endcard.enabled" else None,
        ), mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ) as fetch:
            card = shorts_render._build_question_card(self._row())
        self.assertIsNone(card)
        # Bonus assertion: when the master switch is off, the poll
        # fetch is skipped entirely (no point reading the row just
        # to throw it away). Catches a perf regression.
        fetch.assert_not_called()

    def test_endcard_master_switch_treats_off_synonyms_as_disabled(self):
        for val in ("0", "false", "False", "FALSE", "off", "OFF", "no"):
            with mock.patch.object(
                shorts_render.store,
                "get_setting",
                side_effect=lambda k, v=val: v if k == "polls.endcard.enabled" else None,
            ), mock.patch.object(
                shorts_render.store,
                "fetch_enabled_poll_for_story",
                return_value=self._poll(),
            ):
                card = shorts_render._build_question_card(self._row())
            self.assertIsNone(card, f"setting value {val!r} should disable the card")

    def test_endcard_master_switch_unset_defaults_to_enabled(self):
        # Most common case: settings table has no row → get_setting
        # returns None → the card IS rendered.
        with mock.patch.object(
            shorts_render.store,
            "get_setting",
            return_value=None,
        ), mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNotNone(card)
        self.assertEqual(card["card_ms"], shorts_render.QUESTION_CARD_MS)

    def test_uses_duration_setting_override(self):
        # Custom in-range duration honored verbatim.
        def fake(k):
            if k == "polls.endcard.duration_ms":
                return "4000"
            return None
        with mock.patch.object(
            shorts_render.store, "get_setting", side_effect=fake,
        ), mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNotNone(card)
        self.assertEqual(card["card_ms"], 4000)

    def test_duration_above_ceiling_falls_back_to_default(self):
        # 20000ms is out of the 500-10000ms window → default applies.
        def fake(k):
            if k == "polls.endcard.duration_ms":
                return "20000"
            return None
        with mock.patch.object(
            shorts_render.store, "get_setting", side_effect=fake,
        ), mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNotNone(card)
        self.assertEqual(card["card_ms"], shorts_render.QUESTION_CARD_MS)

    def test_duration_below_floor_falls_back_to_default(self):
        def fake(k):
            if k == "polls.endcard.duration_ms":
                return "100"  # sub-floor
            return None
        with mock.patch.object(
            shorts_render.store, "get_setting", side_effect=fake,
        ), mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNotNone(card)
        self.assertEqual(card["card_ms"], shorts_render.QUESTION_CARD_MS)

    def test_garbage_duration_value_falls_back_to_default(self):
        # Non-numeric junk in the setting → default applies, no exception.
        def fake(k):
            if k == "polls.endcard.duration_ms":
                return "abc"
            return None
        with mock.patch.object(
            shorts_render.store, "get_setting", side_effect=fake,
        ), mock.patch.object(
            shorts_render.store,
            "fetch_enabled_poll_for_story",
            return_value=self._poll(),
        ):
            card = shorts_render._build_question_card(self._row())
        self.assertIsNotNone(card)
        self.assertEqual(card["card_ms"], shorts_render.QUESTION_CARD_MS)


class BuildShortPropsQuestionCardTests(unittest.TestCase):
    """End-to-end: when a story has an enabled poll, build_short_props
    surfaces a `question_card` field AND extends `duration_ms` by
    QUESTION_CARD_MS so the renderer has tail to draw into. When no
    poll exists the props match the pre-Phase-3 shape byte-for-byte."""

    def _assets(self) -> shorts.ShortAssets:
        return shorts.ShortAssets(
            narration_style="suspense",
            length_preset="standard",
            script={"short_script": "Hello there. This is a short test script."},
            character="a tall man with a red scarf",
            base_url="https://kie/base.png",
            base_prompt="BASE PROMPT",
            scenes=[
                {"caption_chunk_start_index": 0, "scene": "s0", "url": "https://kie/s0.png", "image_prompt": "p0"},
                {"caption_chunk_start_index": 2, "scene": "s1", "url": "https://kie/s1.png", "image_prompt": "p1"},
            ],
            cost_credits=0.0,
        )

    def _words(self) -> list[dict]:
        return [
            {"word": "Hello", "start": 0.0, "end": 0.4},
            {"word": "there.", "start": 0.4, "end": 0.9},
            {"word": "This", "start": 1.0, "end": 1.3},
            {"word": "is", "start": 1.3, "end": 1.5},
            {"word": "a", "start": 1.5, "end": 1.6},
            {"word": "short.", "start": 1.6, "end": 2.1},
        ]

    def _build(self, poll: dict | None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        with mock.patch.object(shorts_render.store, "fetch_story",
                               return_value={"id": "story-poll", "slug": "test-slug",
                                             "title": "T", "body": "Body text here."}), \
            mock.patch.object(shorts_render.shorts, "generate_short_assets",
                              return_value=self._assets()), \
            mock.patch("pipeline.voice.synthesize",
                              return_value={"words": self._words()}), \
            mock.patch.object(shorts_render.images, "download", return_value=None), \
            mock.patch.object(shorts_render.store, "get_setting", return_value=None), \
            mock.patch.object(shorts_render.store, "fetch_enabled_poll_for_story",
                              return_value=poll):
            return shorts_render.build_short_props("story-poll", Path(tmp.name), remote=False)

    def test_poll_present_appends_question_card_and_extends_duration(self):
        built = self._build({
            "id": "poll-1",
            "story_id": "story-poll",
            "question": "Who's wrong?",
            "option_a_text": "Wife",
            "option_b_text": "Husband",
            "enabled": 1,
            "category": "Drama",
        })
        self.assertIsNotNone(built)
        props = built.props
        self.assertIn("question_card", props)
        self.assertEqual(props["question_card"]["question"], "Who's wrong?")
        self.assertEqual(props["question_card"]["option_a"], "Wife")
        self.assertEqual(props["question_card"]["option_b"], "Husband")
        self.assertEqual(props["question_card"]["slug"], "test-slug")
        self.assertEqual(props["question_card"]["card_ms"], shorts_render.QUESTION_CARD_MS)
        # Narration ends at ~2100ms (last word "short." end); duration_ms
        # rounds to >= 2100. With the card appended it must be at least
        # narration_end + QUESTION_CARD_MS.
        self.assertGreaterEqual(
            props["duration_ms"],
            2100 + shorts_render.QUESTION_CARD_MS,
        )

    def test_no_poll_omits_question_card_and_keeps_duration(self):
        built = self._build(None)
        self.assertIsNotNone(built)
        props = built.props
        self.assertNotIn("question_card", props)
        # Narration-only duration. Tight upper bound — should not exceed
        # narration end by more than a few ms of caption padding.
        self.assertLess(props["duration_ms"], 3000)


class DoodleSuffixIdentityGuardTests(unittest.TestCase):
    """Regression guard: the shared doodle style suffix is appended to the base
    AND every scene prompt, so any character-identity token in it forces the
    SAME person into every short. The suffix must describe the ART STYLE only;
    identity comes from the per-story planner character description."""

    def test_no_hardcoded_character_identity_tokens(self):
        suffix = sis.DOODLE_SUFFIX.lower()
        for token in ("round glasses", "lab coats", "ties in blue", "beards / hair"):
            self.assertNotIn(
                token, suffix,
                msg=f"DOODLE_SUFFIX must not hard-code character identity: {token!r}",
            )


if __name__ == "__main__":
    unittest.main()
