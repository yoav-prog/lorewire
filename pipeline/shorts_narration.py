"""Narration style for shorts — the hook-first cold-open structure.

Every short opens on the climax beat, rewinds to the start, builds back, lands
on the same climax with full context, then hands the viewer the poll question
that the story has been daring them to answer. One structure, no presets —
the old five-vibe registry was replaced 2026-06-21 (see
_plans/2026-06-21-shorts-hook-first-restructure.md).

Tone variance lives inside the one structure: the LLM picks a `tone_knob`
(`calm-curious`, `tense`, `wry`, `warm-sad`) per story from the source text;
admin can override per-short. The voice layer reads `suggested_voice_mood`
through `tone_to_voice_mood` to keep TTS delivery in sync with the writing.

The output JSON shape is additive over the old shape — every old key
(`title`, `hook`, `short_script`, `payoff`, `word_count`) is still present so
the downstream scene planner, renderer and caption builder keep working
untouched. New keys (`rewind`, `build`, `return`, `cta`,
`cold_open_visual_brief`, `tone_knob`, `poll`) drive the new structure +
poll coupling without forcing a downstream rewrite.
"""
from __future__ import annotations

from dataclasses import dataclass

# Spoken-word pace used to size the script to the target duration. ~2.33 w/s is
# the rate the yt-studio shorts converged on; ElevenLabs turbo runs a touch
# faster, Google Chirp3-HD a touch slower, so the +20% cap absorbs the spread.
WORDS_PER_SECOND = 2.33

# The single style id. Kept as a constant because shorts_auto.py + the queue
# hash + the TS picker all reference it by name; a rename here would orphan
# in-flight queue rows.
DEFAULT_STYLE_ID = "hook-first"

# Tone-knob vocabulary. The LLM must emit one of these in `tone_knob`; an
# unknown / missing value falls back to `tense` (the closest replacement for
# the old `suspense` default). The voice layer maps these to TTS mood hints.
TONE_KNOBS: tuple[str, ...] = ("calm-curious", "tense", "wry", "warm-sad")
DEFAULT_TONE_KNOB = "tense"

_TONE_TO_VOICE_MOOD: dict[str, str] = {
    "calm-curious": "calm, curious, measured",
    "tense": "low, tense, deliberate",
    "wry": "dry-witty, casual, conversational",
    "warm-sad": "warm, slow, reflective",
}


def tone_to_voice_mood(tone_knob: str | None) -> str:
    """Voice-layer hint for a given tone knob. Unknown / empty falls back to
    the default tone's mood so the TTS stage never receives an empty string.
    """
    return _TONE_TO_VOICE_MOOD.get(
        (tone_knob or "").strip(), _TONE_TO_VOICE_MOOD[DEFAULT_TONE_KNOB],
    )


# --- Voice codification (locked in code, not DB settings) --------------------
# The house shorts voice + delivery, pinned here so an admin's global
# `voice.google_voice_name` setting can't silently change the sound of every
# short. The full-generation path (shorts_render) passes these straight to
# narration.render_narration; the editor's Lane B re-render still lets an admin
# override the voice per-short. Chirp 3 HD only — the rate + pause map onto its
# native speakingRate + markup controls (see pipeline/voice._build_chirp_payload).
SHORTS_VOICE_PROVIDER = "google/chirp3-hd"
SHORTS_VOICE_NAME = "en-US-Chirp3-HD-Autonoe"  # warm, even-paced female narrator
SHORTS_SPEAKING_RATE = 1.2   # 20% faster than natural — punchier, retention-first
SHORTS_HOOK_PAUSE = True     # a [pause long] beat after the cold-open hook lands


@dataclass(frozen=True)
class NarrationStyle:
    """One row in the picker. Kept as a dataclass (not a bare dict) so the
    type system catches a missing field if we ever add a second style. The
    `persona` field is unused for hook-first (the prompt is built fresh in
    build_extraction_prompt) but kept for shape compatibility with any caller
    that still introspects it."""
    id: str
    label: str
    description: str
    persona: str
    suggested_voice_mood: str


# The single hook-first style. The picker shows one row; the worker resolves
# any unknown id to this style.
HOOK_FIRST_STYLE = NarrationStyle(
    id=DEFAULT_STYLE_ID,
    label="Hook-first (cold-open climax)",
    description=(
        "Opens on the climax beat, rewinds to the start, builds back to the "
        "climax, then hands the viewer the poll. Tone adapts per story."
    ),
    persona="",  # not used; the hook-first prompt is built whole.
    suggested_voice_mood=_TONE_TO_VOICE_MOOD[DEFAULT_TONE_KNOB],
)


# Registry contract preserved: id -> NarrationStyle. Other modules iterate
# this dict (the admin picker, shorts_auto) so it must keep this shape even
# when it holds a single entry.
NARRATION_STYLES: dict[str, NarrationStyle] = {
    DEFAULT_STYLE_ID: HOOK_FIRST_STYLE,
}


def list_styles() -> list[dict]:
    """id / label / description for the admin picker (no prompt text)."""
    return [
        {"id": s.id, "label": s.label, "description": s.description}
        for s in NARRATION_STYLES.values()
    ]


def get_style(style_id: str | None) -> NarrationStyle:
    """Resolve a style id, falling back to the default so an old/unknown id
    never crashes a generation — it just gets the hook-first style."""
    return NARRATION_STYLES.get(style_id or "", NARRATION_STYLES[DEFAULT_STYLE_ID])


# Per-beat word budgets. Hard cap on beat 1 (decision D5 in the plan); the
# remaining beats are guidance the LLM is told to respect but the validator
# only enforces total length, not per-beat (gives the model room to breathe
# inside the structure).
COLD_OPEN_MAX_WORDS = 8
COLD_OPEN_MIN_WORDS = 4
REWIND_MIN_WORDS = 2
REWIND_MAX_WORDS = 5
RETURN_MIN_WORDS = 10
RETURN_MAX_WORDS = 14
CTA_MIN_WORDS = 5
CTA_MAX_WORDS = 10

# Total-length hard cap as a fraction over the target word count. Mirrors the
# old +20% cap so the renderer's caption budget assumptions are unchanged.
LENGTH_OVERRUN_FRACTION = 0.20

# Poll-field caps. Mirror the TS validator in lorewire-app/src/lib/polls.ts
# so a Python-drafted poll never gets rejected by the TS save action.
POLL_QUESTION_MAX_CHARS = 80
POLL_OPTION_MAX_CHARS = 24


def _structure_block(target_seconds: int) -> str:
    """The five-beat structure the LLM must produce. Word budgets are surfaced
    inline so the model sees the constraint at every beat."""
    target_words = round(target_seconds * WORDS_PER_SECOND)
    return (
        "STRUCTURE — five beats, every short, in this order:\n"
        f"  1. COLD OPEN ({COLD_OPEN_MIN_WORDS}-{COLD_OPEN_MAX_WORDS} words). Drop the viewer "
        "INSIDE the climax. Action or sensory detail only. No setup, no judgment, no "
        "'imagine if', no question. The line must work even from a viewer who has zero "
        "context — they should think 'I need to know how we got here', NOT 'I don't get it'.\n"
        f"  2. REWIND CUE ({REWIND_MIN_WORDS}-{REWIND_MAX_WORDS} words). One short spoken "
        "pivot that signals time-jump. Examples: 'This started six days earlier.' "
        "'Here's how she got there.' 'Twelve hours before that text.' Concrete time anchor "
        "preferred over abstract phrasing.\n"
        "  3. BUILD (the bulk of the script). Tell the story from the top, tightly. "
        "Every sentence earns its place by raising stakes or planting a detail the climax "
        "will pay off. Vary sentence length. No filler context.\n"
        f"  4. RETURN TO CLIMAX ({RETURN_MIN_WORDS}-{RETURN_MAX_WORDS} words). Land on the "
        "same beat the cold open showed — now with the full weight of context behind it. "
        "The emotional hit is the RE-ENCOUNTER, not a new event. Echo the cold-open "
        "phrasing without copying it verbatim.\n"
        f"  5. CTA / POLL HANDOFF ({CTA_MIN_WORDS}-{CTA_MAX_WORDS} words). One line that "
        "names the dilemma in the viewer's own words and points to the poll. Must echo "
        "(not duplicate) the poll question's framing so the on-screen end card feels "
        "like the continuation, not a reset.\n\n"
        f"TOTAL LENGTH: ~{target_words} words across all five beats "
        f"(~{WORDS_PER_SECOND} words / second × {target_seconds}s). "
        f"HARD CAP at {round(target_words * (1 + LENGTH_OVERRUN_FRACTION))} words "
        "(+20% ceiling). Going over is rejected.\n"
    )


def _brand_safety_block() -> str:
    """The four locked guardrails from plan §4. Layer 1 of the defense; the
    validator in pipeline/shorts_safety.py is layer 2."""
    return (
        "BRAND SAFETY — hard rules, no exceptions:\n"
        "  - NO all-caps shock language. Bad: 'YOU WON'T BELIEVE WHAT HE DID.' "
        "Good: 'He read the message twice, then deleted it.' Drama through specifics, "
        "not volume. Acronyms (FBI, OK) and 1-2 letter words are fine; substantive "
        "words 3+ chars in ALL CAPS are not.\n"
        "  - NO moralizing or villain-naming in the cold open. Beat 1 SHOWS the conflict; "
        "it must not TELL the viewer who is wrong. The poll asks the viewer to judge — "
        "the short must not pre-answer. (Build / return beats may surface character "
        "judgments because the viewer has context by then.)\n"
        "  - NO financial, medical, or identity specifics that could ID real people. "
        "Round dollar amounts above $1,000 to the nearest thousand; never name employers, "
        "schools, or exact locations beyond a city. No medical diagnoses by name. Mirrors "
        "the article-level redaction.\n"
        "  - NO profanity in VO or burnt-in text. Required for YouTube / TikTok "
        "monetization and IG / FB reach. If the source uses profanity, soften it "
        "('she lost it', not the literal word).\n\n"
        "AVOID AI TELLS in every beat: no 'have you ever wondered', 'in today's video', "
        "'buckle up', 'let's dive in', 'without further ado', 'game-changer', "
        "'navigate', 'realm', 'at the end of the day', em dashes, smart quotes.\n"
    )


def _poll_block() -> str:
    """Instructions for the bundled poll draft. The script LLM produces the
    poll in the same call as the script so the cold-open phrasing, the CTA
    line, and the poll question stay aligned."""
    return (
        "BUNDLED POLL — draft the question + two sides in the SAME pass as the script.\n"
        "  - The CTA line (beat 5) and the poll question MUST reinforce one phrase. "
        "Reader sees them seconds apart — they should feel like one thought.\n"
        "  - Neutral framing: the question asks the viewer to pick a side, never "
        f"signals an answer. No words like 'right', 'wrong', 'guilty', 'innocent' "
        f"inside the option labels.\n"
        f"  - Question: ≤{POLL_QUESTION_MAX_CHARS} chars. Plain English. Ends in '?'.\n"
        f"  - Option A label: ≤{POLL_OPTION_MAX_CHARS} chars. A role / name / position "
        "the viewer can identify with ('The poster', 'The brother', 'Refund').\n"
        f"  - Option B label: ≤{POLL_OPTION_MAX_CHARS} chars. The opposing side, "
        "phrased symmetrically with A.\n"
    )


def _tone_block() -> str:
    """How the LLM picks a tone knob. Stated as a routing decision based on
    the source's dominant emotional register — not a preset the writer picks
    arbitrarily."""
    return (
        "TONE KNOB — pick ONE based on the SOURCE's dominant emotional register:\n"
        "  - 'calm-curious' — for 'is this a big deal or not' stories. Softer narration, "
        "lower emotional ceiling.\n"
        "  - 'tense' — for stories with withheld information or building dread. Short "
        "sentences, deliberate pacing. (Default when uncertain.)\n"
        "  - 'wry' — for stories with an absurd or darkly funny edge. Light dry humor in "
        "the build beat only; the cold open and return stay straight.\n"
        "  - 'warm-sad' — for stories where the dilemma is grief-adjacent. Slower pacing, "
        "more sensory detail, no humor.\n"
        f"Emit the chosen knob as `tone_knob` in the JSON. One of: {', '.join(TONE_KNOBS)}.\n"
    )


def _output_schema_block() -> str:
    """The JSON the LLM must return. `short_script` and `payoff` are preserved
    for back-compat with downstream code that already reads them."""
    return (
        "OUTPUT — STRICTLY this JSON, nothing else:\n"
        "{\n"
        '  "title": "<6-8 word title>",\n'
        '  "hook": "<the cold-open words, beat 1>",\n'
        '  "rewind": "<the rewind cue, beat 2>",\n'
        '  "build": "<the build narration, beat 3>",\n'
        '  "return": "<the return-to-climax line, beat 4>",\n'
        '  "cta": "<the closing line, beat 5>",\n'
        '  "short_script": "<beats 1-5 concatenated with single spaces — the canonical spoken text>",\n'
        '  "cold_open_visual_brief": "<one sentence describing the climax frame the cold open implies — what is happening, who is there, what the camera sees>",\n'
        '  "payoff": "<return line followed by CTA line, single space between — kept for downstream back-compat>",\n'
        '  "word_count": <integer word count of short_script>,\n'
        '  "tone_knob": "<one of: calm-curious | tense | wry | warm-sad>",\n'
        '  "poll": {\n'
        '    "question": "<≤80 chars, ends in ?, neutral framing>",\n'
        '    "option_a": "<≤24 chars>",\n'
        '    "option_b": "<≤24 chars>"\n'
        "  }\n"
        "}\n"
        "No prose before or after. No code fences. No markdown."
    )


def build_extraction_prompt(
    style_id: str | None,
    source: str,
    target_seconds: int = 50,
    elaborate: bool = False,
) -> str:
    """Compose the full extraction prompt for a single llm.chat() call. Returns
    one string because pipeline/llm.py's chat() sends a single user message.

    `style_id` is accepted for back-compat with the old multi-vibe API — any
    value resolves to the single hook-first style. The hook-first prompt is
    built whole here, not from a per-style persona, because the structure IS
    the style.

    `elaborate` (set by the longer length preset) tells the writer to develop
    the BUILD beat more — more setup, context and a fuller middle — while
    keeping the cold open / rewind / return / CTA beat budgets unchanged.
    """
    # style is resolved (and unused below) so a future second style can hook
    # in without changing call sites. Today every call resolves to HOOK_FIRST.
    _style = get_style(style_id)

    system_parts = [
        "You are a viral shorts writer with elite retention instincts AND editorial "
        "discipline. Lorewire shorts open on the climax beat to win the first 1.5 "
        "seconds, then rewind and earn the climax with context. Every line you write "
        "has to survive social-platform safety review while feeling emotionally honest. "
        "You never manufacture drama — the source stories already have it; your job is "
        "to surface it sharply.",
        _structure_block(target_seconds),
        _brand_safety_block(),
        _poll_block(),
        _tone_block(),
        _output_schema_block(),
    ]
    if elaborate:
        system_parts.append(
            "LONGER CUT: this is the extended length preset. Develop the BUILD beat more "
            "— a little more setup, context, and a fuller middle — without padding. The "
            "cold open, rewind, return-to-climax and CTA beats stay inside their original "
            "word budgets. More story, not filler."
        )

    system = "\n\n".join(system_parts)
    user = (
        f"Source story:\n\"\"\"\n{source.strip()}\n\"\"\"\n\n"
        f"Write the {target_seconds}-second hook-first short now. Output JSON only."
    )
    return f"{system}\n\n---\n\n{user}"
