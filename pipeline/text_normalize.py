"""Pre-normalize a narration script into spoken form before TTS.

Rationale (Phase 2 of _plans/2026-06-18-caption-accuracy-and-naturalness.md):
the TTS voice reads "$1,000,000" as "one million dollars", but if the
caption text shows "$1,000,000" the karaoke highlight cannot land on the
word the ear hears. We pre-expand the script with the same canonical
spoken form so:

  1. The voice reads the script as written (no provider normalization
     surprise — ElevenLabs's own normalizer becomes a no-op).
  2. The captions show the same words the voice says, so the per-word
     highlight always matches the audio.

Rules are deliberately conservative — only patterns we can normalize
with high precision (per the "do no harm" principle of TTS text
normalization). Anything ambiguous (raw "St.", "1.5M" without a `$`,
ISO dates) is left untouched and falls through to the provider's
own normalizer, which is still on.

Public API:
    normalize_for_tts(text: str) -> str
"""
from __future__ import annotations

import re

from num2words import num2words


# Order matters. Each rule replaces digits with words, so later rules
# see fewer digit clusters. Currency / percent / time / ordinals must
# fire before bare cardinals (which would otherwise eat the digits in
# "$5", "50%", "6:30", "1st"). Years fire before bare cardinals so 2026
# becomes "twenty twenty-six" instead of "two thousand twenty-six".


# --- helpers -----------------------------------------------------------------


def _spoken_int(n: int) -> str:
    # num2words sometimes returns commas ("one thousand, two hundred and
    # thirty-four") which the downstream chunker treats as phrase breaks.
    # Strip them so the spoken form reads as one continuous span.
    return num2words(n).replace(",", "")


def _spoken_float(n: float) -> str:
    return num2words(n).replace(",", "")


def _spoken_amount(amount_str: str) -> str:
    """Render a numeric string (with optional commas / decimal) as words."""
    raw = amount_str.replace(",", "")
    try:
        if "." in raw:
            return _spoken_float(float(raw))
        return _spoken_int(int(raw))
    except (ValueError, NotImplementedError):
        return amount_str


# --- currency: $X / $X.YY / $5K / $1.5M -------------------------------------

_CURRENCY_SUFFIXES = {"k": "thousand", "m": "million", "b": "billion", "t": "trillion"}
_CURRENCY_RE = re.compile(
    r"\$([\d]{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)([KkMmBbTt])?(?![\w])"
)


def _currency_sub(m: re.Match) -> str:
    raw = m.group(1)
    suffix = (m.group(2) or "").lower()

    if suffix in _CURRENCY_SUFFIXES:
        # "$5M" / "$1.5B": spoken number + multiplier + "dollars"
        spoken = _spoken_amount(raw)
        return f"{spoken} {_CURRENCY_SUFFIXES[suffix]} dollars"

    if "." in raw:
        # "$1.50": use the currency form for the dollar/cent split.
        try:
            amount = float(raw.replace(",", ""))
            return num2words(
                amount, to="currency", currency="USD", separator=" and"
            ).replace(",", "")
        except (ValueError, NotImplementedError):
            return m.group(0)

    # "$5" / "$1,000": whole-dollar.
    return f"{_spoken_amount(raw)} dollars"


# --- percent: 50% / 12.5% ---------------------------------------------------

_PERCENT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%")


def _percent_sub(m: re.Match) -> str:
    return f"{_spoken_amount(m.group(1))} percent"


# --- time: 6:30PM / 6:30 / 12:00 AM -----------------------------------------

_TIME_RE = re.compile(
    r"\b(\d{1,2}):(\d{2})\s*(AM|PM|am|pm|A\.M\.|P\.M\.)?\b"
)


def _time_sub(m: re.Match) -> str:
    try:
        hour = int(m.group(1))
        minute = int(m.group(2))
    except ValueError:
        return m.group(0)
    # 0:30 (midnight thirty) is a valid 24-hour time. Without 0 in
    # range the cardinal pass would later mangle "0:30AM" into
    # "zero:30AM" — silent garbage in a caption.
    if not (0 <= hour <= 23) or not (0 <= minute <= 59):
        return m.group(0)

    if minute == 0:
        spoken = _spoken_int(hour)
    elif 1 <= minute <= 9:
        # "6:05" reads as "six oh five", not "six five".
        spoken = f"{_spoken_int(hour)} oh {_spoken_int(minute)}"
    else:
        spoken = f"{_spoken_int(hour)} {_spoken_int(minute)}"

    period_raw = (m.group(3) or "").upper().replace(".", "")
    if period_raw:
        spoken += f" {period_raw}"
    return spoken


# --- ordinals: 1st / 21st / 3rd ---------------------------------------------

_ORDINAL_RE = re.compile(r"\b(\d+)(st|nd|rd|th)\b", re.IGNORECASE)


def _ordinal_sub(m: re.Match) -> str:
    try:
        n = int(m.group(1))
    except ValueError:
        return m.group(0)
    try:
        return num2words(n, to="ordinal").replace(",", "")
    except (NotImplementedError, OverflowError):
        return m.group(0)


# --- years: 1500-2099 -------------------------------------------------------

_YEAR_RE = re.compile(r"\b(1[5-9]\d{2}|20\d{2})\b")


def _year_sub(m: re.Match) -> str:
    try:
        n = int(m.group(1))
        return num2words(n, to="year").replace(",", "")
    except (ValueError, NotImplementedError):
        return m.group(0)


# --- title abbreviations: Dr. Mr. Mrs. Ms. vs. e.g. i.e. etc. ----------------

# Each rule expects the abbreviation followed by space + capital letter for
# the personal titles (so "Dr." in a sentence like "back to the Dr." is
# left alone — it's not a title there). Lowercase Latin abbreviations
# (vs., i.e., e.g., etc.) match anywhere because their expansion is
# always safe.
_ABBREVIATION_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bDr\.\s+(?=[A-Z])"), "Doctor "),
    (re.compile(r"\bMr\.\s+(?=[A-Z])"), "Mister "),
    (re.compile(r"\bMrs\.\s+(?=[A-Z])"), "Missus "),
    (re.compile(r"\bMs\.\s+(?=[A-Z])"), "Miss "),
    (re.compile(r"\bvs\.\s+", re.IGNORECASE), "versus "),
    (re.compile(r"\be\.g\.,?\s+", re.IGNORECASE), "for example "),
    (re.compile(r"\bi\.e\.,?\s+", re.IGNORECASE), "that is "),
    (re.compile(r"\betc\."), "etcetera"),
]


# --- bare cardinals: catch-all ----------------------------------------------

# Number not preceded by `$` or `:` (already eaten by currency/time) and
# not embedded in a word (no leading word-char, no trailing word-char).
# Accepts comma-separated thousands and optional decimal.
_CARDINAL_RE = re.compile(
    # The leading `-` in the lookbehind class is what keeps "GPT-4" alone:
    # the digit's previous char is `-` so the regex declines the match
    # and the alphanumeric token survives. A truly negative number like
    # "-5" appears after whitespace, so its `-` sits at a position whose
    # own lookbehind sees a space and the consumption still fires.
    # The trailing `(?!\.\d)` keeps version-like dotted numbers ("3.14.2",
    # IP addresses, sub-section ids) intact — without it the float
    # branch would eat "3.14" and leave a stranded ".2" behind.
    r"(?<![\w$.:\-])(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)(?![\w\-]|\.\d)"
)


def _cardinal_sub(m: re.Match) -> str:
    return _spoken_amount(m.group(1))


# --- ampersand: " & " -> " and " --------------------------------------------

_AMP_RE = re.compile(r"(?<=\s)&(?=\s)")


# --- public ------------------------------------------------------------------


def normalize_for_tts(text: str) -> str:
    """Expand currency, percents, times, ordinals, years, common
    abbreviations, and bare cardinals into their spoken form.

    Order: currency -> percent -> time -> ordinals -> years -> bare
    cardinals -> abbreviations -> ampersand. Each rule's pattern is
    bounded so it does not re-match its own output.
    """
    if not text:
        return text

    original_len = len(text)
    out = text
    out = _CURRENCY_RE.sub(_currency_sub, out)
    out = _PERCENT_RE.sub(_percent_sub, out)
    out = _TIME_RE.sub(_time_sub, out)
    out = _ORDINAL_RE.sub(_ordinal_sub, out)
    out = _YEAR_RE.sub(_year_sub, out)
    out = _CARDINAL_RE.sub(_cardinal_sub, out)
    for pattern, replacement in _ABBREVIATION_RULES:
        out = pattern.sub(replacement, out)
    out = _AMP_RE.sub("and", out)

    if out != text:
        print(
            f"[text_normalize] expanded narration: "
            f"{original_len} -> {len(out)} chars"
        )
    return out
