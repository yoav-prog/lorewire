"""Aspect-ratio resolver for the LoreWire video pipeline.

Phase 2 of `_plans/2026-06-12-video-aspect-ratio.md`. Mirrors the TypeScript
helper at `video/src/aspect.ts` so the renderer and the pipeline share one
canonical aspect chain:

    1. per-story override -> `story.video_config.aspect`
    2. global default     -> `settings_kv` key `video.default_aspect`
    3. legacy fallback    -> "9:16" (portrait — the orientation the pipeline
                                     shipped with, so any row predating this
                                     feature renders byte-identical)

The pipeline uses this in two places:

    - fresh-run media generation, where there is no story row yet so we fall
      back to the global default + legacy floor.
    - regen paths (full-set + per-image), where the story exists and an
      explicit aspect on `video_config` wins.

Per-asset aspect mapping lives in `scene_aspect_for()` / friends so the kie
calls request the right `aspect_ratio` for each asset. Hero stays double-
generated (the pipeline always emits a 3:4 portrait AND a 16:9 landscape
hero so both video orientations and the article reader work). Mouth-swap
bust stays 3:4 (a portrait of a person, regardless of video shape). Props
stay 1:1 (square cutouts slide in cleanly on both canvases). Scenes are
the only video-side asset that follow the video aspect.

Pure module — no I/O outside the `store.get_setting` call inside
`global_default_aspect()`. Safe to import anywhere in the pipeline.
"""
from __future__ import annotations

import json
from typing import Literal

VideoAspect = Literal["9:16", "16:9"]

LEGACY_DEFAULT_ASPECT: VideoAspect = "9:16"

# The two supported aspects. Used by validation + any settings UI.
VIDEO_ASPECTS: tuple[VideoAspect, ...] = ("16:9", "9:16")


def is_video_aspect(value: object) -> bool:
    """Type guard for runtime values coming from JSON / settings / form data."""
    return value == "9:16" or value == "16:9"


def infer_aspect_from_dims(width: int, height: int) -> VideoAspect:
    """Derive the project's aspect enum from a probed file's pixel
    dimensions. Used by the segments worker so a 3840x2160 source
    always lands as 16:9 in the DB regardless of what the client
    upload form claimed (production diagnosis 2026-06-14: form
    defaulted to 9:16 and silently stamped that on landscape uploads).

    Rule is intentionally narrow — the renderer only emits 9:16 and
    16:9, so any other shape collapses to one of those:
        width >  height  -> 16:9 (landscape)
        width <= height  -> 9:16 (portrait, the legacy default)
    Square (width == height) collapses to 9:16 so the legacy default
    holds, since the pipeline shipped portrait first.

    Non-positive dims (probe failure leaked through) also fall to the
    legacy default — callers should log the bad probe at the call
    site so a real shape regression doesn't hide behind this fallback.
    """
    if not isinstance(width, int) or not isinstance(height, int):
        return LEGACY_DEFAULT_ASPECT
    if width <= 0 or height <= 0:
        return LEGACY_DEFAULT_ASPECT
    return "16:9" if width > height else LEGACY_DEFAULT_ASPECT


def resolve_aspect(
    config_aspect: object,
    global_default: object,
) -> VideoAspect:
    """Walk the resolution chain to pick the aspect for one render.

    Both arguments are typed loosely so callers can pass whatever
    `dict.get()` / `store.get_setting()` returned — invalid values fall
    through to the legacy default instead of raising. That keeps the
    pipeline tolerant to typo / NULL / forgotten-migration cases.
    """
    if is_video_aspect(config_aspect):
        return config_aspect  # type: ignore[return-value]
    if is_video_aspect(global_default):
        return global_default  # type: ignore[return-value]
    return LEGACY_DEFAULT_ASPECT


def resolve_aspect_for_story(story: dict | None) -> VideoAspect:
    """Resolve the aspect for a story we already have a row for.

    The story dict comes from `store.get_story(id)`. `video_config` is
    a JSON-encoded string column on the row; we parse it defensively so a
    malformed blob (which the editor shouldn't write but might if a save
    races a render) falls through to the global default instead of raising.

    Reads `video.default_aspect` from settings as the second tier. The
    final fallback is the legacy 9:16 portrait so stories that predate the
    aspect field render byte-identical.
    """
    config_aspect: object = None
    if story is not None:
        raw = story.get("video_config")
        cfg: dict | None = None
        if isinstance(raw, str) and raw:
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    cfg = parsed
            except json.JSONDecodeError:
                cfg = None
        elif isinstance(raw, dict):
            cfg = raw
        if cfg is not None:
            config_aspect = cfg.get("aspect")
    return resolve_aspect(config_aspect, _global_default_aspect())


def resolve_aspect_for_fresh_run() -> VideoAspect:
    """Resolve the aspect for a fresh pipeline run with no story row yet.

    Only the global default + legacy floor matter at this point — the
    story row gets written from this run's outputs, so the editor's
    per-story aspect field doesn't exist until later.
    """
    return resolve_aspect(None, _global_default_aspect())


def _global_default_aspect() -> object:
    """Read `settings.video.default_aspect`. Imported lazily so this module
    stays cheap to import in tests / dry-run paths that don't touch
    settings. Returns whatever `store.get_setting` gave us; the caller's
    resolver validates."""
    # Late import to avoid circular imports + keep this module self-contained
    # when consumers want only the pure helpers.
    from pipeline import store

    try:
        return store.get_setting("video.default_aspect")
    except Exception:
        # Settings table missing (first run before init()) — fall through
        # to the legacy default. Matches the get_setting docstring.
        return None


# ─── Per-aspect intro/outro active pointer keys ──────────────────────────────
# 2026-06-15 (_plans/2026-06-15-intro-outro-per-aspect-active.md): the segment
# library used a single global active pointer per kind
# (`video.active_intro_id` / `video.active_outro_id`), so only one intro and one
# outro could be live and the aspect filter then dropped it on every mismatched
# render. "Active" is now per-aspect: each kind has one active pointer per canvas
# shape. These helpers are the single source of truth for the key strings;
# pick_segment, the segments worker auto-activate, and the seed migration all
# route through them. MIRROR of lorewire-app/src/lib/aspect.ts:
# activeSegmentSettingKey — the two MUST emit identical strings or the Python
# writer and the TS reader would point at different settings rows.
#
# Suffix uses "x" not ":" — the colon is valid in a settings value but reads
# poorly in a key, and "16x9" / "9x16" are unambiguous.
_ASPECT_KEY_SUFFIX: dict[str, str] = {
    "16:9": "16x9",
    "9:16": "9x16",
}


def active_segment_setting_key(kind: str, aspect: object) -> str:
    """Settings key for the active intro/outro pointer of a kind + aspect.

    The aspect is coalesced to the legacy 9:16 floor when unrecognized (NULL
    column / typo) so it routes to the same slot the resolver reads — same
    fallback `_resolve_segment_aspect` uses in segments.py.
    """
    safe_aspect = aspect if is_video_aspect(aspect) else LEGACY_DEFAULT_ASPECT
    return f"video.active_{kind}_id_{_ASPECT_KEY_SUFFIX[safe_aspect]}"


def legacy_active_segment_setting_key(kind: str) -> str:
    """The pre-2026-06-15 single global active pointer. Read once by the seed
    migration to populate the per-aspect slots, then vestigial."""
    return f"video.active_{kind}_id"


# ─── Per-asset aspect mapping ────────────────────────────────────────────────
# Each asset can have its own aspect strategy. Kept in one place so the
# pipeline never inlines a magic string and so admin-facing cost estimates
# can enumerate the call set deterministically.


def scene_aspect_for(video_aspect: VideoAspect) -> str:
    """Aspect kie should generate scene images at.

    Scenes are full-bleed inside the composition — they fill the canvas
    with objectFit:cover. For portrait video we want portrait scenes (3:4
    is what the pipeline shipped with); for landscape video we want 16:9
    so the wider canvas isn't cropping the subject.
    """
    return "16:9" if video_aspect == "16:9" else "3:4"


def prop_aspect_for(_video_aspect: VideoAspect) -> str:
    """Aspect kie should generate prop cutouts at.

    Squares (1:1) work cleanly in either composition — the PropSlideIn
    motion beat lays them out as fixed-size cards regardless of video
    aspect. Constant.
    """
    return "1:1"


def mouth_swap_aspect_for(_video_aspect: VideoAspect) -> str:
    """Aspect kie should generate the talking-head bust + edit at.

    The MouthSwap composition lays the bust into a 3:4 card overlay
    regardless of video aspect (the card is a sub-overlay, not the main
    canvas). Generating the bust at 3:4 means objectFit:cover doesn't
    crop the face. Constant.
    """
    return "3:4"
