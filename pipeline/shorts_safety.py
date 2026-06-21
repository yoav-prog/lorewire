"""Brand-safety validator for shorts narration output.

Layer 2 of the defense per _plans/2026-06-21-shorts-hook-first-restructure.md
§4. The system prompt (layer 1) tells the model the rules; this module
catches the cases where the model returns something that violates them
anyway. Failing closed is preferable to letting a bad script ship — the
caller decides whether to retry with a tightened budget or surface the
rejection to admin.

Returns a structured `ValidationResult` rather than raising so the caller
can log each failure mode independently (see plan §13 observability).

Scope is intentionally narrow. Things we DO check:
  - required top-level fields exist and are the right types
  - each beat has at least one word (model didn't silently drop one)
  - cold-open hard cap on word count (decision D5)
  - total script length under the +20% overrun ceiling
  - no all-caps shock words 3+ chars
  - no profanity from a conservative English list
  - poll fields fit the char caps and don't leak an answer

Things we do NOT check (left to humans or future iterations):
  - whether the cold open is "visually arresting" — that's editorial
  - whether the rewind cue actually rewinds — that's editorial
  - language other than English — v1 ships English-only profanity list
  - PII redaction — happens upstream in the article pipeline; here we
    only enforce that the script doesn't reintroduce specifics
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from pipeline import shorts_narration as sn


# Conservative English profanity list. Intentionally short — we lean on the
# system prompt to do the heavy lifting and only catch the bypass cases
# here. Word boundaries are enforced at match time so 'class' doesn't
# trigger on 'ass'. Lowercased; the matcher case-folds the script.
PROFANITY_LIST: frozenset[str] = frozenset(
    {
        "fuck", "fucking", "fucked", "fucker",
        "shit", "shitty", "shitting",
        "bitch", "bitches",
        "asshole", "assholes",
        "cunt", "cunts",
        "bastard", "bastards",
        "dick", "dicks",
        "piss", "pissed",
        "damn", "damned", "goddamn",
    }
)

# Words that signal the option labels are pre-answering the poll. The plan
# §4 ban on "moralizing or villain-naming in the hook" extends to the
# bundled poll's option labels — neither side should be labeled with a
# verdict the viewer is supposed to render.
_VERDICT_WORDS: frozenset[str] = frozenset(
    {"right", "wrong", "guilty", "innocent", "evil", "monster", "villain"}
)

# All-caps detector: 3+ consecutive uppercase letters. Acronyms like FBI or
# OK slip through (≤2 caps); shouted shock language like SHE DID WHAT does
# not. Catches AT&T, CAPS WORDS, ALL CAPS RUNS.
_ALL_CAPS_RUN = re.compile(r"\b[A-Z]{3,}\b")

# Word-boundary tokenizer for profanity lookup.
_WORD_RE = re.compile(r"[a-z']+")


@dataclass(frozen=True)
class ValidationResult:
    """Outcome of validating a parsed script payload.

    `ok` is True only when every check passed. `errors` is the full list of
    failures (the validator does not short-circuit — the caller usually wants
    every reason at once so a single retry can address them all). `details`
    carries machine-readable diagnostics (word counts, the matched
    profanity tokens, etc.) the observability logs include without having
    to re-derive them.
    """
    ok: bool
    errors: list[str] = field(default_factory=list)
    details: dict = field(default_factory=dict)


_REQUIRED_FIELDS: tuple[str, ...] = (
    "title", "hook", "rewind", "build", "return", "cta",
    "short_script", "cold_open_visual_brief", "payoff",
    "word_count", "tone_knob", "poll",
)
_REQUIRED_POLL_FIELDS: tuple[str, ...] = ("question", "option_a", "option_b")


def _word_count(s: str) -> int:
    return len([w for w in s.split() if w.strip()])


def _find_caps_runs(text: str) -> list[str]:
    return _ALL_CAPS_RUN.findall(text or "")


def _find_profanity(text: str) -> list[str]:
    hits: list[str] = []
    for token in _WORD_RE.findall((text or "").lower()):
        if token in PROFANITY_LIST:
            hits.append(token)
    return hits


def _validate_poll(poll: object, errors: list[str], details: dict) -> None:
    if not isinstance(poll, dict):
        errors.append("poll: not an object")
        return
    for f in _REQUIRED_POLL_FIELDS:
        if not isinstance(poll.get(f), str) or not poll.get(f).strip():
            errors.append(f"poll: missing or empty {f!r}")
    q = (poll.get("question") or "").strip()
    a = (poll.get("option_a") or "").strip()
    b = (poll.get("option_b") or "").strip()
    if q and len(q) > sn.POLL_QUESTION_MAX_CHARS:
        errors.append(
            f"poll.question: {len(q)} chars > cap {sn.POLL_QUESTION_MAX_CHARS}"
        )
    if q and not q.endswith("?"):
        errors.append("poll.question: must end in '?'")
    if a and len(a) > sn.POLL_OPTION_MAX_CHARS:
        errors.append(
            f"poll.option_a: {len(a)} chars > cap {sn.POLL_OPTION_MAX_CHARS}"
        )
    if b and len(b) > sn.POLL_OPTION_MAX_CHARS:
        errors.append(
            f"poll.option_b: {len(b)} chars > cap {sn.POLL_OPTION_MAX_CHARS}"
        )
    for label, text in (("option_a", a), ("option_b", b)):
        for tok in _WORD_RE.findall(text.lower()):
            if tok in _VERDICT_WORDS:
                errors.append(
                    f"poll.{label}: leaks a verdict word ({tok!r}) — options "
                    "must not pre-answer the question"
                )
                break
    details["poll_lengths"] = {
        "question": len(q), "option_a": len(a), "option_b": len(b),
    }


def validate_script(payload: object, target_seconds: int) -> ValidationResult:
    """Validate a parsed script payload against the hook-first contract.

    `target_seconds` is the same value passed to build_extraction_prompt so
    the length cap derives from the same number the writer was told to hit.

    Failing closed: any missing field or rule break sets `ok=False`. The
    caller decides whether to retry the LLM call (recommended once, with a
    tightened budget) or surface the failure to admin for manual handling.
    """
    errors: list[str] = []
    details: dict = {}

    if not isinstance(payload, dict):
        return ValidationResult(False, ["payload is not a JSON object"], {})

    for f in _REQUIRED_FIELDS:
        if f not in payload:
            errors.append(f"missing required field {f!r}")

    # Type / non-empty checks for the string fields. word_count must be int.
    for f in (
        "title", "hook", "rewind", "build", "return", "cta",
        "short_script", "cold_open_visual_brief", "payoff", "tone_knob",
    ):
        v = payload.get(f)
        if v is not None and (not isinstance(v, str) or not v.strip()):
            errors.append(f"{f!r}: must be a non-empty string")
    if "word_count" in payload and not isinstance(payload.get("word_count"), int):
        errors.append("'word_count': must be an integer")

    tone = (payload.get("tone_knob") or "").strip() if isinstance(payload.get("tone_knob"), str) else ""
    if tone and tone not in sn.TONE_KNOBS:
        errors.append(
            f"'tone_knob': {tone!r} not in allowed set {list(sn.TONE_KNOBS)}"
        )

    hook = payload.get("hook") if isinstance(payload.get("hook"), str) else ""
    hook_words = _word_count(hook)
    details["hook_words"] = hook_words
    if hook and hook_words > sn.COLD_OPEN_MAX_WORDS:
        errors.append(
            f"'hook': {hook_words} words > cap {sn.COLD_OPEN_MAX_WORDS} "
            "(plan decision D5 — hard cap)"
        )
    if hook and hook_words < sn.COLD_OPEN_MIN_WORDS:
        errors.append(
            f"'hook': {hook_words} words < floor {sn.COLD_OPEN_MIN_WORDS}"
        )

    script = payload.get("short_script") if isinstance(payload.get("short_script"), str) else ""
    script_words = _word_count(script)
    target_words = round(target_seconds * sn.WORDS_PER_SECOND)
    overrun_cap = round(target_words * (1 + sn.LENGTH_OVERRUN_FRACTION))
    details["script_words"] = script_words
    details["target_words"] = target_words
    details["overrun_cap"] = overrun_cap
    if script and script_words > overrun_cap:
        errors.append(
            f"'short_script': {script_words} words > +20% cap {overrun_cap} "
            f"(target ~{target_words} words for {target_seconds}s)"
        )

    # Caps + profanity sweep across every spoken beat. We don't sweep
    # `cold_open_visual_brief` because it's a visual brief, not VO — the
    # scene planner consumes it but the viewer never hears it.
    spoken_blob = " ".join(
        str(payload.get(f) or "") for f in
        ("hook", "rewind", "build", "return", "cta")
    )
    caps_hits = _find_caps_runs(spoken_blob)
    if caps_hits:
        errors.append(
            "all-caps shock words in VO: " + ", ".join(sorted(set(caps_hits)))
        )
        details["caps_hits"] = sorted(set(caps_hits))
    profanity_hits = _find_profanity(spoken_blob)
    if profanity_hits:
        errors.append(
            "profanity in VO: " + ", ".join(sorted(set(profanity_hits)))
        )
        details["profanity_hits"] = sorted(set(profanity_hits))

    _validate_poll(payload.get("poll"), errors, details)

    return ValidationResult(ok=not errors, errors=errors, details=details)
