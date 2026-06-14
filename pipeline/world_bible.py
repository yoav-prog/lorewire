"""World bible schema, validation, and persistence helpers.

The world bible is a structured representation of a story's recurring
visual entities — characters, sub-characters, locations, items — that
gets persisted on `stories.video_config.world_bible`. Scene generation
reads it to (a) embed entity descriptions verbatim in each prompt, and
(b) pass the relevant reference images to kie's nano-banana-2 endpoint
so faces stay recognizably the same scene to scene.

Pure module — no LLM calls, no kie calls, no DB writes. The LLM-driven
bible BUILD lives in `pipeline.stages.build_world_bible`; the kie
ref-image gen + persistence live in `pipeline.media`. Keeping this file
pure lets every shape/cap/parser branch be unit-tested without
mocking the network.

Schema (mirror lives in `lorewire-app/src/lib/world-bible.ts`):
    Character    {id, name, role, visual_cues, reference_image_url}
    Location     {id, name, visual_cues, reference_image_url}
    Item         {id, name, visual_cues}
    WorldBible   {built_with, characters, sub_characters, locations, items}

IDs are name-derived (sha1(role + name)[:8]) so the same character keeps
the same id across rebuilds — `doodle_frames[i].bible_entity_ids`
references survive a "regenerate bible" click as long as the name
sticks. A renamed character becomes a new entity, which matches the
intuition: a different name is a different character.

Caps cover the realistic on-screen entity count for short-form video.
Above those caps the prompt loses coherence and kie's image_input
soft-caps at 14 anyway. Defaults:
    characters       <= 4   (lead + up to 3 supporting)
    sub_characters   <= 4   (background humans the LLM names)
    locations        <= 3   (most short videos use 1-2 settings)
    items            <= 5   (plot-load-bearing props only)
    visual_cues      <= 600 chars per entity
"""
from __future__ import annotations

import hashlib
import json
from typing import Iterable, Literal

# Cache shape marker. Bumped whenever the bible JSON shape changes in a
# way that should evict every previously-cached bible — same pattern as
# `scene_prompts_built_with`. Stories with a different marker get a
# fresh build on next regen.
WORLD_BIBLE_BUILT_WITH = "world_bible_v1"

# Per-entity caps. Tuned for short-form vertical video; bumped if a
# longer-form pipeline ever ships.
MAX_CHARACTERS = 4
MAX_SUB_CHARACTERS = 4
MAX_LOCATIONS = 3
MAX_ITEMS = 5
MAX_VISUAL_CUES_CHARS = 600

CharacterRole = Literal["lead", "supporting", "background"]
_VALID_ROLES: tuple[CharacterRole, ...] = ("lead", "supporting", "background")


def _stable_id(kind: str, name: str) -> str:
    """Name-derived deterministic id. `kind` namespaces it so a
    character named "Maya" and a location named "Maya" can never
    collide. sha1[:8] gives 16M-entry collision domain — plenty for a
    per-story bible that holds <20 entities."""
    h = hashlib.sha1(f"{kind}:{name.strip().lower()}".encode("utf-8")).hexdigest()[:8]
    return f"{kind}_{h}"


def _clamp_cues(raw: object) -> str:
    """Coerce a visual_cues field into a bounded, single-line string."""
    if not isinstance(raw, str):
        return ""
    cleaned = " ".join(raw.split())
    if len(cleaned) > MAX_VISUAL_CUES_CHARS:
        return cleaned[:MAX_VISUAL_CUES_CHARS].rstrip() + "..."
    return cleaned


def _norm_role(raw: object, default: CharacterRole) -> CharacterRole:
    if isinstance(raw, str):
        lower = raw.strip().lower()
        for r in _VALID_ROLES:
            if lower == r:
                return r
    return default


def parse_character(raw: object, *, default_role: CharacterRole = "supporting") -> dict | None:
    """Parse one character entry from the LLM's JSON output. Returns
    None when the entry is malformed past the point of usefulness
    (missing name, missing cues — without those, the rest of the
    pipeline can't ground a prompt or generate a reference). Caller
    drops Nones and reports a partial-bible warning."""
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name", "")).strip()
    cues = _clamp_cues(raw.get("visual_cues"))
    if not name or not cues:
        return None
    role = _norm_role(raw.get("role"), default_role)
    ref = raw.get("reference_image_url")
    ref_url = ref.strip() if isinstance(ref, str) and ref.strip() else None
    return {
        "id": _stable_id("char" if default_role != "background" else "sub", name),
        "name": name,
        "role": role,
        "visual_cues": cues,
        "reference_image_url": ref_url,
    }


def parse_location(raw: object) -> dict | None:
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name", "")).strip()
    cues = _clamp_cues(raw.get("visual_cues"))
    if not name or not cues:
        return None
    ref = raw.get("reference_image_url")
    ref_url = ref.strip() if isinstance(ref, str) and ref.strip() else None
    return {
        "id": _stable_id("loc", name),
        "name": name,
        "visual_cues": cues,
        "reference_image_url": ref_url,
    }


def parse_item(raw: object) -> dict | None:
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name", "")).strip()
    cues = _clamp_cues(raw.get("visual_cues"))
    if not name or not cues:
        return None
    return {
        "id": _stable_id("item", name),
        "name": name,
        "visual_cues": cues,
    }


def _dedupe_by_id(entries: Iterable[dict]) -> list[dict]:
    """First occurrence wins on id collision (same name → same id).
    A practical case: the LLM lists the same character twice with a
    slightly different role; we keep the first and drop the duplicate.
    Preserves input order so the bible's persisted shape is
    deterministic given the same input."""
    seen: set[str] = set()
    out: list[dict] = []
    for e in entries:
        if e["id"] in seen:
            continue
        seen.add(e["id"])
        out.append(e)
    return out


def parse_world_bible(raw: object) -> dict | None:
    """Coerce the LLM's JSON output into the canonical world-bible
    shape. Returns None when the input isn't a dict at all — caller
    treats that as a build failure and falls back to the legacy
    narration-only flow with a logged warning.

    Each entity list is independently parsed: a malformed locations
    list does NOT kill the characters list. The marker is stamped
    regardless of which lists came back populated so the cache layer
    treats the result as "the bible we have" rather than re-firing
    the LLM on every regen.
    """
    if not isinstance(raw, dict):
        return None

    chars_raw = raw.get("characters")
    chars: list[dict] = []
    if isinstance(chars_raw, list):
        for entry in chars_raw:
            parsed = parse_character(entry, default_role="supporting")
            if parsed:
                chars.append(parsed)
    chars = _dedupe_by_id(chars)[:MAX_CHARACTERS]
    # Promote the first character to "lead" when the LLM didn't mark
    # anyone — every story needs an identifiable protagonist for the
    # hero image and ref selection logic.
    if chars and not any(c["role"] == "lead" for c in chars):
        chars[0]["role"] = "lead"

    sub_raw = raw.get("sub_characters")
    subs: list[dict] = []
    if isinstance(sub_raw, list):
        for entry in sub_raw:
            parsed = parse_character(entry, default_role="background")
            if parsed:
                # Sub-character ids are "sub_<hex>" by virtue of
                # parse_character's namespacing on default_role.
                subs.append(parsed)
    subs = _dedupe_by_id(subs)[:MAX_SUB_CHARACTERS]

    locs_raw = raw.get("locations")
    locs: list[dict] = []
    if isinstance(locs_raw, list):
        for entry in locs_raw:
            parsed = parse_location(entry)
            if parsed:
                locs.append(parsed)
    locs = _dedupe_by_id(locs)[:MAX_LOCATIONS]

    items_raw = raw.get("items")
    items: list[dict] = []
    if isinstance(items_raw, list):
        for entry in items_raw:
            parsed = parse_item(entry)
            if parsed:
                items.append(parsed)
    items = _dedupe_by_id(items)[:MAX_ITEMS]

    return {
        "built_with": WORLD_BIBLE_BUILT_WITH,
        "characters": chars,
        "sub_characters": subs,
        "locations": locs,
        "items": items,
    }


def lead_character(bible: dict | None) -> dict | None:
    """Return the lead character entry, or None when the bible has no
    characters at all. Used by hero gen so the cover image picks up
    the same identity that scenes will reference."""
    if not bible:
        return None
    chars = bible.get("characters") or []
    for c in chars:
        if isinstance(c, dict) and c.get("role") == "lead":
            return c
    return chars[0] if chars else None


def all_entities(bible: dict | None) -> list[dict]:
    """Flat list of every entity across all four categories. Used by
    the per-scene resolver to look up entities by id without caring
    which bucket they came from."""
    if not bible:
        return []
    out: list[dict] = []
    for key in ("characters", "sub_characters", "locations", "items"):
        bucket = bible.get(key) or []
        if isinstance(bucket, list):
            for e in bucket:
                if isinstance(e, dict) and e.get("id"):
                    out.append(e)
    return out


def entities_by_ids(bible: dict | None, ids: Iterable[str]) -> list[dict]:
    """Resolve a list of entity ids to their entries, preserving the
    input order. Unknown ids are silently dropped (caller logs)."""
    if not bible:
        return []
    by_id = {e["id"]: e for e in all_entities(bible)}
    out: list[dict] = []
    for i in ids:
        if i in by_id:
            out.append(by_id[i])
    return out


def reference_urls(entries: Iterable[dict]) -> list[str]:
    """Pull the `reference_image_url` off a list of entity entries.
    Drops None/empty so a partial bible (e.g. char with no ref yet)
    still produces a clean refs list for the kie call."""
    out: list[str] = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        url = e.get("reference_image_url")
        if isinstance(url, str) and url.strip():
            out.append(url.strip())
    return out


def read_world_bible(story: dict | None) -> dict | None:
    """Read `video_config.world_bible` off a story row. Returns None
    on missing / malformed / wrong-marker so the caller falls back to
    a fresh build. Marker mismatch is a hard miss — the same eviction
    pattern as `scene_prompts_built_with`."""
    if story is None:
        return None
    raw = story.get("video_config")
    if not raw:
        return None
    try:
        config = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(config, dict):
        return None
    bible = config.get("world_bible")
    if not isinstance(bible, dict):
        return None
    if bible.get("built_with") != WORLD_BIBLE_BUILT_WITH:
        return None
    return bible
