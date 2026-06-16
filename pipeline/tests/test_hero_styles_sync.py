"""Parity test for the hero style registry's TS-side JSON dump.

The TS picker reads `lorewire-app/src/data/hero-styles.json`, which
`pipeline/scripts/sync_hero_styles.py` regenerates from
`pipeline/stages.py:HERO_STYLES` + `CATEGORY_STYLE_WHITELIST`. This test
re-runs the dump in memory and diffs against the committed JSON, so
forgetting to run the sync after editing the Python side fails CI
instead of shipping a drifted TS file.

If this test fails after a legitimate Python-side edit, run:

    python -m pipeline.scripts.sync_hero_styles

and commit the regenerated `lorewire-app/src/data/hero-styles.json`.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from pipeline.scripts import sync_hero_styles


class HeroStylesSyncTests(unittest.TestCase):
    def _committed_payload(self) -> dict:
        path = sync_hero_styles.output_path()
        self.assertTrue(
            path.exists(),
            f"committed JSON is missing at {path}; "
            "run `python -m pipeline.scripts.sync_hero_styles` to create it.",
        )
        return json.loads(path.read_text(encoding="utf-8"))

    def test_committed_json_matches_python_registry(self):
        # build_payload is pure (no I/O) so we can compute the expected
        # bytes without touching the disk. If this test fails, the
        # message tells the dev exactly what to do.
        expected = sync_hero_styles.build_payload()
        actual = self._committed_payload()
        self.assertEqual(
            actual, expected,
            "lorewire-app/src/data/hero-styles.json is out of sync with "
            "pipeline.stages.HERO_STYLES / CATEGORY_STYLE_WHITELIST. "
            "Run `python -m pipeline.scripts.sync_hero_styles` and commit "
            "the regenerated JSON.",
        )

    def test_committed_json_has_schema_version(self):
        # If we ever change the on-disk schema we'll bump this; pinning
        # it in a test means consumers (the TS reader) get a loud
        # signal instead of silently ingesting a new shape.
        self.assertEqual(self._committed_payload().get("schema_version"), 1)

    def test_committed_styles_array_order_preserves_insertion_order(self):
        # The picker renders styles in this order. A reordering in
        # Python without re-running the sync would silently change the
        # admin UI — caught here because dict iteration order matches
        # the Python registry's insertion order.
        from pipeline import stages
        committed_ids = [s["id"] for s in self._committed_payload()["styles"]]
        registry_ids = list(stages.HERO_STYLES.keys())
        self.assertEqual(committed_ids, registry_ids)

    def test_writer_is_idempotent(self):
        # Re-running the sync without any Python-side edits must
        # produce a no-op file write (byte-identical). Otherwise CI
        # would churn the JSON on every run.
        before = sync_hero_styles.output_path().read_bytes()
        sync_hero_styles.write()
        after = sync_hero_styles.output_path().read_bytes()
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
