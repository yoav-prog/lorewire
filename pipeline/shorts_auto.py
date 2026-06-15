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
  shorts.auto.daily_cap       integer             global 24h cap on AUTO shorts
                                                  (default 50; 0/blank = default)

Default OFF so turning the feature on is an explicit, cost-aware choice (rule 8).
Idempotent: enqueue is on (story_id, config_hash) and the hash matches the TS
button's hashShortConfig, so the auto path and a manual click coalesce.

Cost guard: the per-story cap on the manual button can't protect the auto path,
which fires at most one short per story but across EVERY story a busy category
produces. So the auto path enforces a GLOBAL rolling-24h cap on rows it requested
(requested_by='auto') before enqueuing — a backfill of 200 stories can't quietly
fire 200 paid generations (~$0.70 each).
"""
from __future__ import annotations

import datetime
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

# Global rolling-24h ceiling on auto-generated shorts. Overridable via the
# shorts.auto.daily_cap setting; a non-positive / unparseable override falls
# back to this default.
DEFAULT_AUTO_DAILY_CAP = 50


def _resolve_auto_daily_cap(get_setting: GetSetting) -> int:
    raw = (get_setting("shorts.auto.daily_cap") or "").strip()
    if not raw:
        return DEFAULT_AUTO_DAILY_CAP
    try:
        val = int(float(raw))
    except ValueError:
        return DEFAULT_AUTO_DAILY_CAP
    return val if val > 0 else DEFAULT_AUTO_DAILY_CAP


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
    force: bool = False,
) -> bool:
    """Enqueue a short for the story if auto-generate is on for its category.
    Returns True if a row was enqueued (or already existed idempotently), False
    when auto-generate is off. Safe to call on every story completion.

    `force=True` is the Reddit-import "output: short" path
    (see _plans/2026-06-16-reddit-default-to-shorts.md): the admin
    explicitly picked short-as-the-video for this row, so the
    shorts.auto.enabled / per-category gate is bypassed. The rolling-24h
    cap is still enforced — the cap is a cost safety net, not an opt-in
    toggle, and the admin can raise it via shorts.auto.daily_cap when
    they want a bigger import wave. Narration vibe + length still come
    from the shorts.auto.narration / shorts.auto.length settings so the
    forced short matches the admin's preferred style.
    """
    cfg = resolve_short_auto_config(category, get_setting)
    if not cfg["enabled"] and not force:
        return False

    # Global cost guard: cap auto-requested shorts over a rolling 24h window.
    # Counts only requested_by='auto' rows so manual admin clicks never eat into
    # (or block) the auto budget. Once the cap is hit we skip entirely; a story
    # whose auto short was already enqueued in-window is unaffected because its
    # row already exists and will render regardless.
    cap = _resolve_auto_daily_cap(get_setting)
    since = (
        datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=24)
    ).isoformat()
    recent = store.count_short_renders_since(since, requested_by=requested_by)
    if recent >= cap:
        print(
            f"[shorts_auto cap] story={story_id} forced={force} skipped: "
            f"{recent} auto shorts in last 24h >= cap {cap} "
            f"(raise shorts.auto.daily_cap to lift)"
        )
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
