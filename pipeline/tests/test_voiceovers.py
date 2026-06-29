"""Tests for the shorts voiceover resolver.

Resolution order: per-category preset -> global default -> code fallback. The
resolver takes injectable getters so these run without a DB.
"""
from __future__ import annotations

import unittest

from pipeline import shorts_narration as sn
from pipeline import voiceovers


def _settings(mapping):
    return lambda k: mapping.get(k)


class ResolveVoiceoverTests(unittest.TestCase):
    def test_category_preset_wins_over_default(self):
        settings = _settings({
            "voiceovers.category.Drama": "vo-drama",
            "voiceovers.default": "vo-default",
        })
        presets = {
            "vo-drama": {"provider": "google/chirp3-hd", "voice_id": "X",
                          "style_prompt": "dramatic", "speaking_rate": 1.0,
                          "hook_pause": True},
            "vo-default": {"provider": "google/gemini-25-flash-tts", "voice_id": "Y",
                            "style_prompt": "default", "speaking_rate": 1.2,
                            "hook_pause": False},
        }
        vo = voiceovers.resolve_voiceover(
            "Drama", get_setting=settings, get_voiceover=presets.get,
        )
        self.assertEqual(vo["voice_id"], "X")
        self.assertEqual(vo["style_prompt"], "dramatic")

    def test_falls_back_to_default_when_category_unset(self):
        settings = _settings({"voiceovers.default": "vo-default"})
        presets = {"vo-default": {"provider": "google/gemini-25-flash-tts",
                                   "voice_id": "Y", "style_prompt": "d",
                                   "speaking_rate": 1.2, "hook_pause": True}}
        vo = voiceovers.resolve_voiceover(
            "Drama", get_setting=settings, get_voiceover=presets.get,
        )
        self.assertEqual(vo["voice_id"], "Y")

    def test_code_fallback_when_nothing_set(self):
        vo = voiceovers.resolve_voiceover(
            "Drama", get_setting=lambda k: None, get_voiceover=lambda i: None,
        )
        self.assertEqual(vo["provider"], sn.SHORTS_VOICE_PROVIDER)
        self.assertEqual(vo["voice_id"], sn.SHORTS_VOICE_NAME)
        self.assertEqual(vo["style_prompt"], sn.SHORTS_STYLE_PROMPT)

    def test_deleted_preset_ids_degrade_to_code_fallback(self):
        # Both the category and default point at presets that no longer exist.
        settings = _settings({
            "voiceovers.category.Drama": "ghost",
            "voiceovers.default": "ghost2",
        })
        vo = voiceovers.resolve_voiceover(
            "Drama", get_setting=settings, get_voiceover=lambda i: None,
        )
        self.assertEqual(vo["provider"], sn.SHORTS_VOICE_PROVIDER)

    def test_blank_preset_fields_filled_from_fallback(self):
        settings = _settings({"voiceovers.default": "vo"})
        presets = {"vo": {"provider": "", "voice_id": "", "style_prompt": "",
                           "speaking_rate": None, "hook_pause": True}}
        vo = voiceovers.resolve_voiceover(
            None, get_setting=settings, get_voiceover=presets.get,
        )
        self.assertEqual(vo["provider"], sn.SHORTS_VOICE_PROVIDER)
        self.assertEqual(vo["speaking_rate"], sn.SHORTS_SPEAKING_RATE)
        self.assertTrue(vo["hook_pause"])


if __name__ == "__main__":
    unittest.main()
