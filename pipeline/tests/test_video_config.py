"""Tests for pipeline.video_config: lock-aware merge.

Covers the lost-edit guardrail the LLM Council called out as the highest-
trust risk in the design (see _plans/2026-06-11-video-editor.md §Where the
Council Clashes). Pure-logic — no DB, no Remotion. If these pass, the
pipeline can re-run against an edited video_config without clobbering the
user's work.
"""
from __future__ import annotations

import unittest

from pipeline.video_config import (
    _get_path,
    _parse_path,
    _set_path,
    merge_with_locks,
)


# ─── path parser ──────────────────────────────────────────────────────────────


class ParsePathTests(unittest.TestCase):
    def test_top_level(self):
        self.assertEqual(_parse_path("title"), ["title"])

    def test_nested_dot(self):
        self.assertEqual(_parse_path("music.url"), ["music", "url"])

    def test_array_index(self):
        self.assertEqual(
            _parse_path("captions[3].text"), ["captions", 3, "text"],
        )

    def test_deeply_nested(self):
        self.assertEqual(
            _parse_path("doodle_frames[0].url"),
            ["doodle_frames", 0, "url"],
        )

    def test_multiple_indices(self):
        self.assertEqual(
            _parse_path("a[1][2].b"), ["a", 1, 2, "b"],
        )

    def test_empty_string_returns_empty(self):
        # Used by the merge to skip empty lock keys without crashing.
        self.assertEqual(_parse_path(""), [])

    def test_garbage_returns_empty(self):
        self.assertEqual(_parse_path(".."), [])
        self.assertEqual(_parse_path("a..b"), [])
        self.assertEqual(_parse_path("a[]"), [])

    def test_trailing_garbage_returns_empty(self):
        self.assertEqual(_parse_path("title!"), [])


# ─── path get/set primitives ──────────────────────────────────────────────────


class GetPathTests(unittest.TestCase):
    def test_found_scalar(self):
        found, val = _get_path({"title": "Hi"}, "title")
        self.assertTrue(found)
        self.assertEqual(val, "Hi")

    def test_nested(self):
        found, val = _get_path({"music": {"url": "x.mp3"}}, "music.url")
        self.assertTrue(found)
        self.assertEqual(val, "x.mp3")

    def test_array_element_field(self):
        obj = {"captions": [{"text": "a"}, {"text": "b"}, {"text": "c"}]}
        found, val = _get_path(obj, "captions[1].text")
        self.assertTrue(found)
        self.assertEqual(val, "b")

    def test_missing_top_level(self):
        found, _ = _get_path({"x": 1}, "y")
        self.assertFalse(found)

    def test_missing_array_index(self):
        found, _ = _get_path({"a": [1, 2]}, "a[5]")
        self.assertFalse(found)

    def test_none_value_is_found(self):
        # Distinguishes `null` from `missing` — both are valid for fields like
        # character_image_mouth_removed.
        found, val = _get_path({"character_image_mouth_removed": None}, "character_image_mouth_removed")
        self.assertTrue(found)
        self.assertIsNone(val)


class SetPathTests(unittest.TestCase):
    def test_top_level_write(self):
        d: dict = {"title": "old"}
        self.assertTrue(_set_path(d, "title", "new"))
        self.assertEqual(d["title"], "new")

    def test_nested_write(self):
        d: dict = {"music": {"url": "old", "gain_db": -12}}
        self.assertTrue(_set_path(d, "music.url", "new.mp3"))
        self.assertEqual(d["music"]["url"], "new.mp3")
        # Sibling untouched.
        self.assertEqual(d["music"]["gain_db"], -12)

    def test_creates_intermediate_dict(self):
        d: dict = {}
        self.assertTrue(_set_path(d, "music.url", "x.mp3"))
        self.assertEqual(d, {"music": {"url": "x.mp3"}})

    def test_array_element_field_write(self):
        d: dict = {"captions": [{"text": "a"}, {"text": "b"}]}
        self.assertTrue(_set_path(d, "captions[0].text", "A!"))
        self.assertEqual(d["captions"][0]["text"], "A!")
        self.assertEqual(d["captions"][1]["text"], "b")

    def test_out_of_bounds_array_drops(self):
        # The pipeline shortened the array — the lock is moot.
        d: dict = {"captions": [{"text": "a"}]}
        self.assertFalse(_set_path(d, "captions[5].text", "x"))
        self.assertEqual(d, {"captions": [{"text": "a"}]})


# ─── merge_with_locks: the headline function ─────────────────────────────────


class MergeWithLocksTests(unittest.TestCase):
    def _basic(self, *, title="Hi", duration_ms=10000):
        return {
            "voiceover_url": "/v.mp3",
            "title": title,
            "duration_ms": duration_ms,
            "doodle_frames": [{"url": "/a.png", "caption_chunk_start_index": 0}],
            "captions": [{"start_ms": 0, "end_ms": 10000, "text": "Hi"}],
        }

    def test_no_current_returns_new(self):
        new = self._basic()
        out = merge_with_locks(None, new)
        self.assertEqual(out["title"], "Hi")
        # Defensive copy: caller can mutate without affecting `new`.
        out["title"] = "Mutated"
        self.assertEqual(new["title"], "Hi")

    def test_no_locks_pipeline_wins(self):
        current = {**self._basic(title="Old"), "_locks": {}}
        new = self._basic(title="New from pipeline")
        out = merge_with_locks(current, new)
        self.assertEqual(out["title"], "New from pipeline")

    def test_locked_top_level_scalar_preserved(self):
        current = {
            **self._basic(title="Human Title"),
            "_locks": {"title": True},
        }
        new = self._basic(title="Pipeline Title")
        out = merge_with_locks(current, new)
        self.assertEqual(out["title"], "Human Title")
        # Unlocked field still takes the pipeline value.
        self.assertEqual(out["voiceover_url"], new["voiceover_url"])

    def test_locked_nested_path_preserved(self):
        current = {
            **self._basic(),
            "music": {"url": "/user.mp3", "gain_db": -12},
            "_locks": {"music.url": True},
        }
        new = {**self._basic(), "music": {"url": "/pipeline.mp3", "gain_db": -8}}
        out = merge_with_locks(current, new)
        self.assertEqual(out["music"]["url"], "/user.mp3")
        # Unlocked sibling field takes pipeline value.
        self.assertEqual(out["music"]["gain_db"], -8)

    def test_locked_array_element_field_preserved(self):
        current = {
            **self._basic(),
            "captions": [
                {"start_ms": 0, "end_ms": 5000, "text": "Edited word"},
                {"start_ms": 5000, "end_ms": 10000, "text": "Two"},
            ],
            "_locks": {"captions[0].text": True},
        }
        new = {
            **self._basic(),
            "captions": [
                {"start_ms": 0, "end_ms": 5000, "text": "Pipeline rewrote me"},
                {"start_ms": 5000, "end_ms": 10000, "text": "Two updated"},
            ],
        }
        out = merge_with_locks(current, new)
        self.assertEqual(out["captions"][0]["text"], "Edited word")
        self.assertEqual(out["captions"][1]["text"], "Two updated")
        # Locked path's siblings (start_ms, end_ms) still take pipeline values.
        self.assertEqual(out["captions"][0]["start_ms"], 0)

    def test_lock_on_nonexistent_path_is_noop(self):
        current = {**self._basic(), "_locks": {"made_up.field": True}}
        new = self._basic(title="New")
        out = merge_with_locks(current, new)
        # No crash. Pipeline values flow through.
        self.assertEqual(out["title"], "New")
        # The lock map travels forward even though it points at nothing.
        self.assertEqual(out["_locks"], {"made_up.field": True})

    def test_pipeline_removed_array_element_lock_dropped(self):
        # User locked captions[3].text. The pipeline rebuilt the captions
        # and now only has 2 elements. The lock points at nothing — should
        # not resurrect a ghost entry.
        current = {
            **self._basic(),
            "captions": [
                {"start_ms": 0, "end_ms": 2500, "text": "one"},
                {"start_ms": 2500, "end_ms": 5000, "text": "two"},
                {"start_ms": 5000, "end_ms": 7500, "text": "three"},
                {"start_ms": 7500, "end_ms": 10000, "text": "user edit"},
            ],
            "_locks": {"captions[3].text": True},
        }
        new = {
            **self._basic(),
            "captions": [
                {"start_ms": 0, "end_ms": 5000, "text": "merged one"},
                {"start_ms": 5000, "end_ms": 10000, "text": "merged two"},
            ],
        }
        out = merge_with_locks(current, new)
        self.assertEqual(len(out["captions"]), 2)
        self.assertEqual(out["captions"][1]["text"], "merged two")

    def test_edit_session_preserved(self):
        session = {
            "user_id": "u1",
            "started_at": "2026-06-11T14:00:00Z",
            "heartbeat_at": "2026-06-11T14:05:00Z",
        }
        current = {**self._basic(), "_edit_session": session, "_locks": {"title": True}}
        new = self._basic(title="Pipeline")
        out = merge_with_locks(current, new)
        self.assertEqual(out["_edit_session"], session)

    def test_explicit_locks_argument_overrides_current(self):
        # The pipeline can pass a different lock map (e.g. one derived from
        # an admin action that just unlocked a field).
        current = {**self._basic(title="User"), "_locks": {"title": True}}
        new = self._basic(title="Pipeline")
        # Passing locks={} means "treat as nothing locked".
        out = merge_with_locks(current, new, locks={})
        self.assertEqual(out["title"], "Pipeline")
        # And the result reflects the override, not the stale lock in current.
        self.assertNotIn("title", out.get("_locks", {}))

    def test_does_not_mutate_inputs(self):
        current = {**self._basic(title="User"), "_locks": {"title": True}}
        new = self._basic(title="Pipeline")
        merge_with_locks(current, new)
        # Both inputs unchanged.
        self.assertEqual(current["title"], "User")
        self.assertEqual(new["title"], "Pipeline")

    def test_malformed_lock_value_ignored(self):
        # Anything that isn't `True` is treated as "not locked" so an editor
        # bug that writes `false` or `null` cannot resurrect a stale value.
        current = {**self._basic(title="Stale"), "_locks": {"title": False}}
        new = self._basic(title="Fresh")
        out = merge_with_locks(current, new)
        self.assertEqual(out["title"], "Fresh")

    def test_garbage_lock_key_ignored(self):
        # Path parser refuses garbage; merge keeps going.
        current = {**self._basic(title="User"), "_locks": {"..": True, "title": True}}
        new = self._basic(title="Pipeline")
        out = merge_with_locks(current, new)
        self.assertEqual(out["title"], "User")  # the valid lock still applied


if __name__ == "__main__":
    unittest.main()
