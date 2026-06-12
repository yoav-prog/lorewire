"""Tests for pipeline.video: alignment chunking, frame distribution, title
truncation, file-uri conversion.

Pure-logic only. The Remotion render itself is verified by a real render in
the QA pass — there's no useful way to mock npx + Chromium.
"""
from __future__ import annotations

import unittest
from pathlib import Path

from pipeline import video


class ChunkAlignmentTests(unittest.TestCase):
    def test_empty_input(self):
        self.assertEqual(video._chunk_alignment([]), [])

    def test_breaks_on_four_word_cap(self):
        words = [{"word": f"w{i}", "start": i * 0.2, "end": (i + 1) * 0.2} for i in range(5)]
        chunks = video._chunk_alignment(words)
        self.assertEqual(len(chunks), 2)
        self.assertEqual(len(chunks[0]["words"]), 4)
        self.assertEqual(chunks[0]["text"], "w0 w1 w2 w3")
        self.assertEqual(chunks[1]["text"], "w4")

    def test_breaks_on_long_pause(self):
        # 2 words, then 500ms gap, then 2 more
        words = [
            {"word": "hi",     "start": 0.0, "end": 0.2},
            {"word": "there",  "start": 0.2, "end": 0.4},
            {"word": "after",  "start": 0.9, "end": 1.1},  # 500ms gap
            {"word": "pause",  "start": 1.1, "end": 1.3},
        ]
        chunks = video._chunk_alignment(words)
        self.assertEqual(len(chunks), 2)
        self.assertEqual(chunks[0]["text"], "hi there")
        self.assertEqual(chunks[1]["text"], "after pause")

    def test_breaks_on_punctuation(self):
        words = [
            {"word": "hello,",  "start": 0.0, "end": 0.2},
            {"word": "world",   "start": 0.2, "end": 0.4},
            {"word": "again!",  "start": 0.4, "end": 0.6},
            {"word": "ok",      "start": 0.6, "end": 0.8},
        ]
        chunks = video._chunk_alignment(words)
        # "hello," forces a break, then "world again!" forces a break, then "ok"
        self.assertEqual([c["text"] for c in chunks], ["hello,", "world again!", "ok"])

    def test_skips_empty_words(self):
        words = [
            {"word": "real",  "start": 0.0, "end": 0.2},
            {"word": "",      "start": 0.2, "end": 0.3},
            {"word": "  ",    "start": 0.3, "end": 0.4},
            {"word": "word",  "start": 0.4, "end": 0.5},
        ]
        chunks = video._chunk_alignment(words)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0]["text"], "real word")

    def test_chunk_carries_word_level_timings_in_ms(self):
        words = [
            {"word": "a", "start": 0.0,  "end": 0.25},
            {"word": "b", "start": 0.25, "end": 0.50},
        ]
        chunks = video._chunk_alignment(words)
        self.assertEqual(chunks[0]["start_ms"], 0)
        self.assertEqual(chunks[0]["end_ms"], 500)
        self.assertEqual(
            chunks[0]["words"],
            [
                {"word": "a", "start_ms": 0,   "end_ms": 250},
                {"word": "b", "start_ms": 250, "end_ms": 500},
            ],
        )


class DistributeFramesTests(unittest.TestCase):
    def _captions(self, *starts_ms: int) -> list[dict]:
        return [{"start_ms": s, "end_ms": s + 500} for s in starts_ms]

    def test_no_inputs_returns_empty(self):
        self.assertEqual(video._distribute_frames([], [], 1000), [])

    def test_no_captions_stacks_frames_at_zero(self):
        frames = video._distribute_frames(["a", "b"], [], 1000)
        self.assertEqual(
            [f["caption_chunk_start_index"] for f in frames], [0, 0]
        )

    def test_single_image_starts_at_chunk_zero(self):
        frames = video._distribute_frames(["only"], self._captions(0, 1000), 2000)
        self.assertEqual(frames, [{"url": "only", "caption_chunk_start_index": 0}])

    def test_four_images_snap_to_chunks_and_stay_ordered(self):
        captions = self._captions(0, 500, 1000, 1500, 2000, 2500, 3000, 3500)
        frames = video._distribute_frames(
            ["hero", "s1", "s2", "s3"], captions, 4000
        )
        indexes = [f["caption_chunk_start_index"] for f in frames]
        # 4 frames, monotonically increasing, each on a different chunk.
        self.assertEqual(sorted(indexes), indexes)
        self.assertEqual(len(set(indexes)), 4)
        self.assertEqual(frames[0]["caption_chunk_start_index"], 0)

    def test_more_frames_than_chunks_does_not_crash(self):
        captions = self._captions(0, 1000)
        frames = video._distribute_frames(
            ["a", "b", "c", "d"], captions, 2000
        )
        self.assertEqual(len(frames), 4)


class TruncateTitleTests(unittest.TestCase):
    def test_short_title_unchanged(self):
        self.assertEqual(video._truncate_title("hello"), "hello")

    def test_long_title_truncated_with_ellipsis(self):
        out = video._truncate_title("a" * 80, max_chars=20)
        self.assertEqual(out, "a" * 19 + "...")

    def test_empty_title(self):
        self.assertEqual(video._truncate_title(""), "")
        self.assertEqual(video._truncate_title(None), "")


class PublicUrlResolutionTests(unittest.TestCase):
    def test_resolves_public_url_to_filesystem_path(self):
        repo_root = Path(__file__).resolve().parent.parent.parent
        path = video._public_url_to_filesystem_path(repo_root, "/generated/abc/hero.png")
        self.assertTrue(str(path).replace("\\", "/").endswith("/lorewire-app/public/generated/abc/hero.png"))


class ResolveCaptionTemplateTests(unittest.TestCase):
    def test_all_unset_returns_defaults(self):
        t = video.resolve_caption_template(lambda k: None)
        self.assertEqual(t["position_y"], 0.55)
        self.assertEqual(t["color"], "#facc15")
        self.assertEqual(t["entry_effect"], "fade")
        self.assertEqual(t["word_highlight"], "karaoke")
        self.assertEqual(t["font_weight"], 900)

    def test_partial_override_merges_with_defaults(self):
        store = {"caption.color": "#00ff00", "caption.position_y": "0.75"}
        t = video.resolve_caption_template(lambda k: store.get(k))
        # Overridden
        self.assertEqual(t["color"], "#00ff00")
        self.assertEqual(t["position_y"], 0.75)
        # Untouched defaults
        self.assertEqual(t["outline_color"], "#0f172a")
        self.assertEqual(t["font_weight"], 900)

    def test_invalid_numeric_falls_back(self):
        store = {"caption.font_weight": "not a number", "caption.position_y": "abc"}
        t = video.resolve_caption_template(lambda k: store.get(k))
        self.assertEqual(t["font_weight"], 900)
        self.assertEqual(t["position_y"], 0.55)

    def test_numeric_clamped_to_range(self):
        store = {"caption.position_y": "5", "caption.outline_width": "999", "caption.font_weight": "50"}
        t = video.resolve_caption_template(lambda k: store.get(k))
        # position_y is 0..1
        self.assertEqual(t["position_y"], 1.0)
        # outline_width is 0..12
        self.assertEqual(t["outline_width"], 12)
        # font_weight is 100..900
        self.assertEqual(t["font_weight"], 100)

    def test_invalid_enum_falls_back(self):
        store = {"caption.entry_effect": "explode", "caption.word_highlight": "blink"}
        t = video.resolve_caption_template(lambda k: store.get(k))
        self.assertEqual(t["entry_effect"], "fade")
        self.assertEqual(t["word_highlight"], "karaoke")

    def test_color_rejects_javascript_uri(self):
        store = {"caption.color": "javascript:alert(1)"}
        t = video.resolve_caption_template(lambda k: store.get(k))
        # Falls back to default rather than letting a JS URI ride into the prop.
        self.assertEqual(t["color"], "#facc15")

    def test_integer_fields_stay_int(self):
        store = {"caption.font_weight": "750.6", "caption.padding_x": "44.9"}
        t = video.resolve_caption_template(lambda k: store.get(k))
        # Integer fields: rounded, not floating.
        self.assertEqual(t["font_weight"], 751)
        self.assertEqual(t["padding_x"], 45)
        self.assertIsInstance(t["font_weight"], int)
        self.assertIsInstance(t["padding_x"], int)


class ScopeChainTests(unittest.TestCase):
    """Phase 2: per-story -> per-category -> global -> defaults."""

    def test_no_scope_falls_back_to_global(self):
        store = {"caption.color": "#abcdef"}
        t = video.resolve_caption_template_for(None, None, lambda k: store.get(k))
        self.assertEqual(t["color"], "#abcdef")

    def test_category_overrides_global(self):
        store = {
            "caption.color": "#111111",
            "caption.cat.Drama.color": "#222222",
        }
        t = video.resolve_caption_template_for(None, "Drama", lambda k: store.get(k))
        self.assertEqual(t["color"], "#222222")

    def test_story_overrides_category_and_global(self):
        store = {
            "caption.color": "#111111",
            "caption.cat.Drama.color": "#222222",
            "caption.story.envelope.color": "#333333",
        }
        t = video.resolve_caption_template_for("envelope", "Drama", lambda k: store.get(k))
        self.assertEqual(t["color"], "#333333")

    def test_mixed_tiers_compose_per_field(self):
        # Color comes from story, font_weight from category, position_y from global.
        store = {
            "caption.color": "#111111",
            "caption.font_weight": "500",
            "caption.position_y": "0.40",
            "caption.cat.Drama.font_weight": "700",
            "caption.cat.Drama.color": "#222222",
            "caption.story.envelope.color": "#333333",
        }
        t = video.resolve_caption_template_for("envelope", "Drama", lambda k: store.get(k))
        self.assertEqual(t["color"], "#333333")
        self.assertEqual(t["font_weight"], 700)
        self.assertEqual(t["position_y"], 0.40)

    def test_empty_string_at_tier_falls_through(self):
        # Story-tier override is intentionally empty to "inherit" — should
        # fall through to category, then global.
        store = {
            "caption.color": "#111111",
            "caption.cat.Drama.color": "#222222",
            "caption.story.envelope.color": "",
        }
        t = video.resolve_caption_template_for("envelope", "Drama", lambda k: store.get(k))
        self.assertEqual(t["color"], "#222222")

    def test_completely_unset_returns_defaults(self):
        t = video.resolve_caption_template_for("anything", "Drama", lambda k: None)
        self.assertEqual(t["color"], "#facc15")
        self.assertEqual(t["entry_effect"], "fade")


class ResolveCaptionTemplateAspectTests(unittest.TestCase):
    """Phase 5 of _plans/2026-06-12-video-aspect-ratio.md: the caption
    resolver gains an aspect dimension. Per-aspect tiers must win over
    their aspect-agnostic siblings; absent aspect must reproduce the
    pre-Phase-5 four-tier chain byte-for-byte."""

    def test_aspect_segment_safe_transform(self):
        # The aspect string can't enter the dotted key namespace as
        # "16:9" because the colon would parse ambiguously. The helper
        # maps the two supported aspects to safe segments and rejects
        # everything else.
        self.assertEqual(video._aspect_segment("16:9"), "16x9")
        self.assertEqual(video._aspect_segment("9:16"), "9x16")
        self.assertIsNone(video._aspect_segment("4:3"))
        self.assertIsNone(video._aspect_segment(None))
        self.assertIsNone(video._aspect_segment(""))

    def test_no_aspect_walks_legacy_chain(self):
        # Same expectations as the pre-Phase-5 ResolveCaptionTemplateForTests
        # — when aspect is omitted, the resolver behaves byte-identical.
        store = {"caption.color": "#abcdef"}
        t = video.resolve_caption_template_for(
            None, None, lambda k: store.get(k)
        )
        self.assertEqual(t["color"], "#abcdef")

    def test_global_per_aspect_beats_global_agnostic(self):
        store = {
            "caption.color": "#aaaaaa",
            "caption.16x9.color": "#16cafe",
        }
        t_landscape = video.resolve_caption_template_for(
            None, None, lambda k: store.get(k), aspect="16:9",
        )
        self.assertEqual(t_landscape["color"], "#16cafe")
        # Portrait still reads the aspect-agnostic key — the per-16:9
        # key is silent on the other aspect.
        t_portrait = video.resolve_caption_template_for(
            None, None, lambda k: store.get(k), aspect="9:16",
        )
        self.assertEqual(t_portrait["color"], "#aaaaaa")

    def test_cat_per_aspect_beats_global_per_aspect(self):
        store = {
            "caption.color": "#aaaaaa",
            "caption.16x9.color": "#16cafe",
            "caption.cat.Drama.color": "#dccccc",
            "caption.cat.Drama.16x9.color": "#16d666",
        }
        t = video.resolve_caption_template_for(
            None, "Drama", lambda k: store.get(k), aspect="16:9",
        )
        self.assertEqual(t["color"], "#16d666")

    def test_story_per_aspect_beats_everything(self):
        store = {
            "caption.color": "#aaaaaa",
            "caption.16x9.color": "#16cafe",
            "caption.cat.Drama.color": "#dccccc",
            "caption.cat.Drama.16x9.color": "#16d666",
            "caption.story.envelope.color": "#sssssss"[:7],
            "caption.story.envelope.16x9.color": "#16ee77",
        }
        t = video.resolve_caption_template_for(
            "envelope", "Drama", lambda k: store.get(k), aspect="16:9",
        )
        self.assertEqual(t["color"], "#16ee77")

    def test_falls_through_per_aspect_to_aspect_agnostic_same_tier(self):
        # When the admin only set the aspect-agnostic story key, that
        # still wins over the cat / global aspect-agnostic tiers. The
        # per-aspect tier at story scope is empty so the resolver moves
        # on to the aspect-agnostic story key BEFORE descending tiers.
        store = {
            "caption.color": "#aaaaaa",
            "caption.16x9.color": "#16cafe",
            "caption.story.envelope.color": "#story-only"[:7],
        }
        t = video.resolve_caption_template_for(
            "envelope", "Drama", lambda k: store.get(k), aspect="16:9",
        )
        self.assertEqual(t["color"], "#story-only"[:7])

    def test_empty_string_at_per_aspect_tier_falls_through(self):
        # An empty string at a tier means "unset at this tier" — the
        # admin's UI uses this to clear a per-aspect override.
        store = {
            "caption.color": "#aaaaaa",
            "caption.16x9.color": "",
        }
        t = video.resolve_caption_template_for(
            None, None, lambda k: store.get(k), aspect="16:9",
        )
        self.assertEqual(t["color"], "#aaaaaa")


class MotionFlagTests(unittest.TestCase):
    """Wave 3 Phase 3: motion beat flags share the same truthy-string parser
    Ken-Burns uses. The parser is inlined inside generate_video()'s scope —
    these cases reproduce the same logic to lock the accepted truthy values."""

    @staticmethod
    def _truthy(raw):
        return (raw or "").strip().lower() in {"1", "true", "on", "yes"}

    def test_truthy_strings(self):
        for s in ("1", "true", "TRUE", " on ", "yes", "Yes"):
            self.assertTrue(self._truthy(s), f"expected truthy: {s!r}")

    def test_falsy_strings(self):
        for s in ("", "0", "false", "off", "no", "nope", None):
            self.assertFalse(self._truthy(s), f"expected falsy: {s!r}")

    def test_unknown_strings_are_falsy(self):
        # Anything not in the explicit allowlist is off — the parser is
        # intentionally strict so a typo in /admin/settings never accidentally
        # turns a beat on.
        for s in ("enable", "active", "y", "ja", "si"):
            self.assertFalse(self._truthy(s))


if __name__ == "__main__":
    unittest.main()
