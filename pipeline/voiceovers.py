"""Resolve which voiceover preset a short should narrate with.

Resolution order (mirrors shorts_auto.resolve_short_auto_config's per-category
pattern):
  1. The category's assigned voiceover (setting ``voiceovers.category.<cat>``).
  2. The global default voiceover (setting ``voiceovers.default``).
  3. The shorts_narration code constants — a last-resort fallback so a render
     never fails just because no DB preset is set.

Returns a plain dict the shorts paths hand to ``narration.render_narration``:
``{provider, voice_id, style_prompt, speaking_rate, hook_pause}``.
"""
from __future__ import annotations

from typing import Callable

from pipeline import shorts_narration as sn
from pipeline import store

GetSetting = Callable[[str], "str | None"]
GetVoiceover = Callable[[str], "dict | None"]


def _code_fallback() -> dict:
    return {
        "provider": sn.SHORTS_VOICE_PROVIDER,
        "voice_id": sn.SHORTS_VOICE_NAME,
        "style_prompt": sn.SHORTS_STYLE_PROMPT,
        "speaking_rate": sn.SHORTS_SPEAKING_RATE,
        "hook_pause": sn.SHORTS_HOOK_PAUSE,
    }


def _preset_to_voiceover(p: dict) -> dict:
    """Map a stored preset row onto the render kwargs, filling any blank field
    from the code fallback so a half-filled preset still renders."""
    rate = p.get("speaking_rate")
    return {
        "provider": (p.get("provider") or sn.SHORTS_VOICE_PROVIDER),
        "voice_id": (p.get("voice_id") or sn.SHORTS_VOICE_NAME),
        "style_prompt": (p.get("style_prompt") or sn.SHORTS_STYLE_PROMPT),
        "speaking_rate": (rate if rate is not None else sn.SHORTS_SPEAKING_RATE),
        "hook_pause": bool(p.get("hook_pause")),
    }


def resolve_voiceover(
    category: str | None,
    *,
    get_setting: GetSetting = store.get_setting,
    get_voiceover: GetVoiceover = store.get_voiceover,
) -> dict:
    """Resolve the voiceover for a story's category, falling back to the global
    default and then the code constants. Never raises — a lookup miss degrades to
    the next tier so a short can always render."""
    cat = (category or "").strip()
    candidate_ids: list[str] = []
    if cat:
        cid = (get_setting(f"voiceovers.category.{cat}") or "").strip()
        if cid:
            candidate_ids.append(cid)
    default_id = (get_setting("voiceovers.default") or "").strip()
    if default_id and default_id not in candidate_ids:
        candidate_ids.append(default_id)
    for vid in candidate_ids:
        try:
            preset = get_voiceover(vid)
        except Exception:
            preset = None
        if preset:
            return _preset_to_voiceover(preset)
    return _code_fallback()
