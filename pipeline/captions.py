"""Map TTS-provider word timings back onto the source script tokens.

The provider's `words` array carries reliable per-word timings, but on
STT-derived providers (the Google path runs Speech-to-Text on its own
TTS output to recover word timings, see voice.py:_google_align) the
text can be wrong: homophones ("Read" for "Red"), dropped or inserted
words, no punctuation, lowercased. The source script is what the voice
is actually reading, so it is the source of truth for caption text.

This module performs a monotonic word-level alignment between the
script and the provider's word array and rewrites each timing's `.word`
field to the matching script token. ElevenLabs already produces word
text from the script's characters (voice.py:_chars_to_words), so its
path is a no-op trust pass; only STT-based providers actually run the
alignment.

Public API:
    tokenize_script(script: str) -> list[str]
    align_script_to_words(script, words, provider) -> list[dict]
"""
from __future__ import annotations

import re

# Stem regex: a token's matchable identity for alignment is its
# alphanumeric core, lowercased, with surrounding punctuation/apostrophes
# stripped. "Red," and "red" both stem to "red"; "don't" and "dont" both
# stem to "dont". Substitutions still get caught by the DP, but a more
# tolerant stem keeps the alignment from fragmenting on punctuation noise.
_STEM_STRIP_RE = re.compile(r"[^\w]")
_WORD_SPLIT_RE = re.compile(r"\S+")

# Drift guard: when the edit distance is dominant relative to script length
# the alignment is no longer reliable (e.g. the script was edited after the
# render). We still emit the script-aligned form because the alternative
# is the original STT homophones, but the log line flags it so a render
# that surprises an admin can be traced.
_DRIFT_WARN_RATIO = 0.5


def tokenize_script(script: str) -> list[str]:
    """Split the script into whitespace-separated tokens.

    Trailing punctuation glues to the word it touches so the downstream
    chunker's punctuation break (`video.PUNCTUATION_BREAK_RE`, which
    fires on tokens ending in `.!?,;:`) can hit on caption text that
    originated from STT, where punctuation was missing entirely.

    Example: "Red, the barn was old." -> ["Red,", "the", "barn", "was", "old."].
    """
    return _WORD_SPLIT_RE.findall(script)


def align_script_to_words(
    script: str, words: list[dict], provider: str
) -> list[dict]:
    """Return `words` with each `.word` field rewritten to the matching
    script token.

    - Timing fields (`start`, `end`) are preserved from the provider.
    - When a script token has no STT word (the speech ran together and
      STT collapsed two tokens), a zero-duration wedge is inserted at
      the prior word's end so the word still appears in the caption.
    - When STT inserts a phantom word the script doesn't have, it is
      dropped — the caption only ever shows words that exist in the
      script.

    On the ElevenLabs path the provider's words are already script-derived
    (voice._chars_to_words), so this is a no-op trust pass that only logs.
    """
    script_tokens = tokenize_script(script)

    if not words or not script_tokens:
        print(
            f"[captions align provider={provider}] no-op: "
            f"words={len(words)} script_tokens={len(script_tokens)}"
        )
        return words

    if provider == "elevenlabs":
        # ElevenLabs returns character-level alignment of the input
        # script; `_chars_to_words` already yields script-authoritative
        # tokens. Trust it and log so the dispatch is visible in logs.
        print(
            f"[captions align provider=elevenlabs] trusted "
            f"provider-supplied words (words={len(words)}, "
            f"script_tokens={len(script_tokens)})"
        )
        return words

    return _graft_script_onto_stt_words(script_tokens, words, provider)


# --- internals ---------------------------------------------------------------


def _stem(token: str) -> str:
    return _STEM_STRIP_RE.sub("", token).lower()


def _graft_script_onto_stt_words(
    script_tokens: list[str], words: list[dict], provider: str
) -> list[dict]:
    """Monotonic edit-distance alignment between script and STT words,
    then rewrite STT word text to the matched script token.

    O(N*M) Python with N,M ≈ 100-500 tokens for a 1-3 minute narration
    — sub-millisecond on the worker, no GPU, no model.
    """
    script_stems = [_stem(t) for t in script_tokens]
    stt_stems = [_stem(w.get("word", "")) for w in words]

    rows = len(script_stems) + 1
    cols = len(stt_stems) + 1
    dp = [[0] * cols for _ in range(rows)]
    for i in range(rows):
        dp[i][0] = i
    for j in range(cols):
        dp[0][j] = j
    for i in range(1, rows):
        for j in range(1, cols):
            cost = 0 if script_stems[i - 1] == stt_stems[j - 1] else 1
            dp[i][j] = min(
                dp[i - 1][j - 1] + cost,  # match or substitute
                dp[i - 1][j] + 1,         # script token has no STT word
                dp[i][j - 1] + 1,         # STT word is phantom
            )
    edit_distance = dp[-1][-1]

    # Trace back. Each step is one of:
    #   ("match", si, wi)  same stem, copy STT timing, replace text with script
    #   ("sub",   si, wi)  different stem, copy STT timing, replace text with script
    #   ("ins",   si, None) script token absent from STT, wedge it in
    #   ("del",   None, wi) STT phantom, drop it
    ops: list[tuple] = []
    i, j = len(script_stems), len(stt_stems)
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            cost = 0 if script_stems[i - 1] == stt_stems[j - 1] else 1
            if dp[i][j] == dp[i - 1][j - 1] + cost:
                ops.append(("match" if cost == 0 else "sub", i - 1, j - 1))
                i -= 1
                j -= 1
                continue
        if i > 0 and dp[i][j] == dp[i - 1][j] + 1:
            ops.append(("ins", i - 1, None))
            i -= 1
            continue
        # j > 0 must be true here (the loop guard ensures it).
        ops.append(("del", None, j - 1))
        j -= 1
    ops.reverse()

    out_words: list[dict] = []
    matched = subs = phantoms = missing = 0
    for op, si, wi in ops:
        if op in ("match", "sub"):
            w = words[wi]
            out_words.append(
                {
                    "word": script_tokens[si],
                    "start": float(w.get("start", 0.0)),
                    "end": float(w.get("end", 0.0)),
                }
            )
            if op == "match":
                matched += 1
            else:
                subs += 1
        elif op == "ins":
            # Wedge a zero-duration token at the prior word's end so the
            # script word still appears in the caption. If we are at the
            # very start, anchor to the first STT word's start.
            if out_words:
                anchor = out_words[-1]["end"]
            else:
                anchor = float(words[0].get("start", 0.0)) if words else 0.0
            out_words.append(
                {"word": script_tokens[si], "start": anchor, "end": anchor}
            )
            missing += 1
        else:  # del
            phantoms += 1

    drift_ratio = edit_distance / max(len(script_tokens), 1)
    drift_flag = " DRIFT" if drift_ratio >= _DRIFT_WARN_RATIO else ""
    print(
        f"[captions align provider={provider}] script_tokens={len(script_tokens)} "
        f"stt_words={len(words)} matched={matched} subs={subs} "
        f"phantoms={phantoms} missing={missing} edit_distance={edit_distance} "
        f"drift_ratio={drift_ratio:.2f}{drift_flag}"
    )
    return out_words
