"""Lock-aware merge of pipeline-emitted video config over a user-edited
existing one.

The /admin/videos/[id] editor (see _plans/2026-06-11-video-editor.md) writes
edits directly into `stories.video_config` and stamps each edited path into
the same JSON's `_locks` map. When the pipeline re-runs (better narration,
new motion beats, a corrected image), it derives a fresh config from raw
inputs as today — but BEFORE persisting, it overlays that fresh output onto
the existing config so user-locked fields survive.

`merge_with_locks` is the entire enforcement point. Without it, the pipeline
silently clobbers human edits on every re-run, which is the lost-edit bug
the LLM Council called out as the highest-trust risk in the design.

Path syntax mirrors the editor's:

    title                       top-level scalar
    music.url                   nested object field
    motion.micro_wiggle         nested boolean
    captions[3].text            array element field
    doodle_frames[0].url        array element field, different array

Bracket indices are decimal integers; identifiers are [a-zA-Z_][a-zA-Z0-9_]*.
Unknown paths in the lock map are no-ops, never errors — the editor and the
pipeline can ship at slightly different schema versions without one silently
clobbering the other (the council's schema-bifurcation guardrail).
"""
from __future__ import annotations

import re
from typing import Any

# ─── path parser ──────────────────────────────────────────────────────────────

_PATH_TOKEN_RE = re.compile(r"([a-zA-Z_][a-zA-Z0-9_]*)|\[(\d+)\]")


def _parse_path(path: str) -> list[str | int]:
    """Split 'captions[3].text' -> ['captions', 3, 'text'].

    A path that fails to parse to at least one token returns []; the caller
    treats that as "skip this lock entry" so a malformed editor input cannot
    corrupt the merge.
    """
    tokens: list[str | int] = []
    consumed = 0
    for match in _PATH_TOKEN_RE.finditer(path):
        # Detect garbage between tokens (e.g. "foo..bar"): if the match
        # doesn't start where the previous one ended (modulo a single '.'),
        # bail out.
        gap = path[consumed : match.start()]
        if gap and gap != "." and not (consumed == 0 and gap == ""):
            return []
        if match.group(1) is not None:
            tokens.append(match.group(1))
        elif match.group(2) is not None:
            tokens.append(int(match.group(2)))
        consumed = match.end()
    # Trailing garbage after the last token = malformed path.
    if consumed != len(path):
        return []
    return tokens


def _get_path(obj: Any, path: str) -> tuple[bool, Any]:
    """Walk `obj` along `path`. Returns (found, value).

    `found=False` is the only signal that a lock should be ignored — `None`
    is a valid stored value (e.g. character_image_mouth_removed when the
    mouth_swap beat is off).
    """
    tokens = _parse_path(path)
    if not tokens:
        return False, None
    cursor: Any = obj
    for t in tokens:
        if isinstance(t, int):
            if not isinstance(cursor, list) or t < 0 or t >= len(cursor):
                return False, None
            cursor = cursor[t]
        else:
            if not isinstance(cursor, dict) or t not in cursor:
                return False, None
            cursor = cursor[t]
    return True, cursor


def _set_path(obj: Any, path: str, value: Any) -> bool:
    """Write `value` into `obj` at `path`. Creates intermediate dicts when
    needed but never grows or reshapes a list — if a path indexes past the
    end of an array, the write is dropped (returns False).

    Dropping (rather than padding with None) is deliberate: the only legitimate
    reason a locked array path doesn't exist in the new pipeline output is that
    the pipeline shortened the array. In that case the user's lock is moot —
    the position no longer exists. Padding would resurrect ghost array
    entries and break the renderer.
    """
    tokens = _parse_path(path)
    if not tokens:
        return False
    cursor: Any = obj
    for i, t in enumerate(tokens[:-1]):
        if isinstance(t, int):
            if not isinstance(cursor, list) or t < 0 or t >= len(cursor):
                return False
            cursor = cursor[t]
        else:
            if not isinstance(cursor, dict):
                return False
            if t not in cursor or not isinstance(cursor[t], (dict, list)):
                # The next token decides what shape to create: if it's an int
                # we need a list; otherwise a dict. The pipeline output is
                # supposed to already have this shape, so missing intermediates
                # are exceptional but recoverable.
                next_token = tokens[i + 1]
                cursor[t] = [] if isinstance(next_token, int) else {}
            cursor = cursor[t]
    last = tokens[-1]
    if isinstance(last, int):
        if not isinstance(cursor, list) or last < 0 or last >= len(cursor):
            return False
        cursor[last] = value
        return True
    if not isinstance(cursor, dict):
        return False
    cursor[last] = value
    return True


# ─── public API ───────────────────────────────────────────────────────────────


# Sentinel for `locks` distinguishing "caller didn't pass" from "caller
# explicitly passed None/{}". Lets the editor unlock fields by passing
# `locks={}` and have that empty map win over a stale `_locks` in `current`.
_LOCKS_DEFAULT: object = object()


def merge_with_locks(
    current: dict | None,
    new_from_pipeline: dict,
    locks: dict | None | object = _LOCKS_DEFAULT,
) -> dict:
    """Overlay `new_from_pipeline` on `current`, preserving locked fields.

    Inputs:
      current             — the existing stories.video_config (parsed JSON),
                            or None if the row has never had a config.
      new_from_pipeline   — the freshly-derived config from this run.
      locks               — explicit lock map override. Defaults to lifting
                            `current["_locks"]`. Pass `{}` to explicitly
                            ignore stale locks (e.g. when the editor just
                            unlocked everything in a single action).

    Returns a brand-new dict — never mutates the inputs.

    Editor-only metadata (`_locks`, `_edit_session`) always travels with
    `current` and is never overwritten by the pipeline. If `current` is None
    the result has no editor metadata, which is the right behavior for a
    first render.
    """
    if current is None:
        # Brand new row, nothing to preserve. Deep copy so the caller can
        # mutate freely without aliasing back into the pipeline's working
        # state.
        return _deep_copy(new_from_pipeline)

    # Resolve which lock map to apply. The sentinel sentinel-vs-None split
    # matters because the editor needs a way to say "no locks" that wins
    # over a stale lock map persisted in `current`.
    if locks is _LOCKS_DEFAULT:
        raw_locks = current.get("_locks")
        effective_locks: dict | None = (
            raw_locks if isinstance(raw_locks, dict) else None
        )
    else:
        # Type-narrow: explicit caller arg is either dict or None.
        effective_locks = locks if isinstance(locks, dict) else None

    # Start fresh from the pipeline output. Anything not locked takes the
    # pipeline's new value — including fields the pipeline removed.
    result: dict = _deep_copy(new_from_pipeline)

    if effective_locks:
        for path, locked in effective_locks.items():
            if locked is not True or not isinstance(path, str):
                continue
            found, value = _get_path(current, path)
            if not found:
                continue
            _set_path(result, path, value)

    # Stamp the resolved lock map onto the result.
    #   explicit empty {} → write {} (clears any stale lock map)
    #   explicit non-empty → write it
    #   implicit (sentinel) + current has valid map → carry it forward
    #   implicit + current has nothing → omit (result has no _locks)
    if locks is not _LOCKS_DEFAULT:
        # Caller's explicit value wins, even if {}.
        if effective_locks is not None:
            result["_locks"] = effective_locks
    elif effective_locks is not None:
        result["_locks"] = effective_locks

    if isinstance(current.get("_edit_session"), dict):
        result["_edit_session"] = current["_edit_session"]

    return result


def _deep_copy(value: Any) -> Any:
    """Lightweight deep copy that handles the dict/list/scalar shapes our
    config uses. Avoids the `copy` module's overhead and side-steps any
    weirdness if the input contains unexpected object types — anything not a
    dict or list is passed through by reference (safe because the schema is
    all primitives + nested dicts/lists)."""
    if isinstance(value, dict):
        return {k: _deep_copy(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_deep_copy(v) for v in value]
    return value
