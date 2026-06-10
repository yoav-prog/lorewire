"""Tests for pipeline.llm: model resolution + override.

We don't hit the network here. The override behavior is what we guard: a
sub-stage caller (image-prompt builder, future title generator) should be
able to call gpt-5-nano without changing the admin's stage selection.
"""
from __future__ import annotations

import os
import unittest
from unittest import mock

from pipeline import llm


class ResolveTests(unittest.TestCase):
    def test_uses_active_stage_selection_when_no_override(self):
        with mock.patch("pipeline.llm.models.get_selected", return_value="openai/gpt-5.4-mini"), \
             mock.patch.dict(os.environ, {"OPENAI_API_KEY": "k", "OPENAI_BASE_URL": "https://x"}, clear=False):
            key, base, model = llm._resolve()
            self.assertEqual(key, "k")
            self.assertEqual(base, "https://x")
            self.assertEqual(model, "gpt-5.4-mini")

    def test_override_wins_over_stage_selection(self):
        with mock.patch("pipeline.llm.models.get_selected", return_value="openai/gpt-5.4-mini"), \
             mock.patch.dict(os.environ, {"OPENAI_API_KEY": "k"}, clear=False):
            _, _, model = llm._resolve("openai/gpt-5-nano")
            self.assertEqual(model, "gpt-5-nano")

    def test_unknown_provider_raises(self):
        with mock.patch("pipeline.llm.models.get_selected", return_value="moon/gpt-7"):
            with self.assertRaises(NotImplementedError):
                llm._resolve()

    def test_missing_openai_key_raises_runtime_error(self):
        with mock.patch("pipeline.llm.models.get_selected", return_value="openai/gpt-5-nano"), \
             mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                llm._resolve()


if __name__ == "__main__":
    unittest.main()
