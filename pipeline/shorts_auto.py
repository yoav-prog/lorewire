"""Auto-generate shorts: decide whether a freshly-produced story should also get
a short, and enqueue it. Driven by admin settings (a global default plus a
per-category override). Called from the story pipeline right after the long-form
video is auto-enqueued (pipeline/story_jobs_worker.py).

Settings keys (read via store.get_setting):
  shorts.auto.enabled         "on" | "off"        global default (default off)
  shorts.auto.narration       narration vibe id   (default suspense)
  shorts.auto.length          length preset id    (default standard)
  shorts.auto.category.<cat>  "on" | "off" | ""   per-category override
                                                  ("" / missing = inherit global)

Default OFF so turning the feature on is an explicit, cost-aware choice (rule 8).
Idempotent: enqueue is on (story_id, config_hash) and the hash matches the TS
button's hashShortConfig, so the auto path and a manual click coalesce.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from typing import Callable

from pipeline import store
from pipeline.shorts import DEFAULT_LENGTH_ID
from pipeline.shorts_narration import DEFAULT_STYLE_ID

GetSetting = Callable[[str], "str | None"]

_ON = {"on", "1", "true", "yes"}
_OFF = {"off", "0", "false", "no"}


def hash_short_config(narration_style: str | None, length_preset: str | None) -> str:
    """Mirror of lorewire-app/src/lib/short-render-queue.ts hashShortConfig: a
    SHA-256 over the same compact JSON (fixed key order, no spaces) so the auto
    path and the manual button produce the same config_hash and coalesce."""
    canonical = json.dumps(
        {"narration_style": narration_style or "", "length_preset": length_preset or ""},
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def resolve_short_auto_config(
    category: str | None, get_setting: GetSetting = store.get_setting
) -> dict:
    """Resolve {enabled, narration, length} for a story's category. A per-category
    override ('on'/'off') wins; otherwise the global default applies."""
    cat = (category or "").strip()
    override = get_setting(f"shorts.auto.category.{cat}") if cat else None
    ov = (override or "").strip().lower()
    if ov in _ON:
        enabled = True
    elif ov in _OFF:
        enabled = False
    else:
        enabled = (get_setting("shorts.auto.enabled") or "").strip().lower() in _ON
    return {
        "enabled": enabled,
        "narration": get_setting("shorts.auto.narration") or DEFAULT_STYLE_ID,
        "length": get_setting("shorts.auto.length") or DEFAULT_LENGTH_ID,
    }


def maybe_enqueue_short_for_story(
    story_id: str,
    category: str | None,
    *,
    requested_by: str = "auto",
    get_setting: GetSetting = store.get_setting,
) -> bool:
    """Enqueue a short for the story if auto-generate is on for its category.
    Returns True if a row was enqueued (or already existed idempotently), False
    when auto-generate is off. Safe to call on every story completion."""
    cfg = resolve_short_auto_config(category, get_setting)
    if not cfg["enabled"]:
        return False
    config_hash = hash_short_config(cfg["narration"], cfg["length"])
    store.enqueue_short_render(
        str(uuid.uuid4()),
        story_id,
        config_hash,
        cfg["narration"],
        cfg["length"],
        requested_by,
    )
    return True
