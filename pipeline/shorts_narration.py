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


# --- Voice codification (code fallback for the shorts narrator) --------------
# These are the CODE FALLBACK only. The live shorts voice is whatever the admin
# selects in /admin/voiceovers (a per-category preset, then the global default);
# the pipeline resolves that and only drops to these constants when no preset is
# set (see pipeline/voiceovers.resolve_voiceover).
#
# Default is Gemini-2.5-flash-TTS (GA): unlike Chirp 3 HD's fixed character, the
# delivery is steered by SHORTS_STYLE_PROMPT, which is how we get a lively
# young-creator read instead of a flat narrator. On the Gemini path the pace is
# carried by the prompt (Gemini ignores Chirp's speakingRate) and the hook pause
# uses Gemini's `[long pause]` markup; SHORTS_SPEAKING_RATE only takes effect if a
# preset uses a Chirp 3 HD provider.
SHORTS_VOICE_PROVIDER = "google/gemini-25-flash-tts"
SHORTS_VOICE_NAME = "en-US-Chirp3-HD-Leda"  # youthful female; Gemini reads the bare "Leda"
SHORTS_SPEAKING_RATE = 1.2   # Chirp-only pace knob; no-op on the Gemini path
SHORTS_HOOK_PAUSE = True      # a beat after the cold-open hook before the rewind
SHORTS_STYLE_PROMPT = (
    "You are a lively young social-media creator talking straight to camera. "
    "Upbeat, expressive, fast-paced and casual, with natural emphasis and warmth. "
    "Hook the viewer in the first second. Sound like a real person, not a narrator."
)


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
        "INSIDE the highest-stakes moment a STRANGER with zero context can feel — a loss, "
        "a discovery, a confrontation, a transgression caught in the act, a rupture, a "
        "betrayal. NOT just 'an event that happened.' The hook IS the catch of the story — "
        "the thing that makes someone outside it lean in. If a stranger heard only this one "
        "line, they must think 'WAIT, WHAT?' — not 'huh, why?' and not 'OK, and?'.\n"
        "     NAME THE THING DIRECTLY, NOT THE ARTIFACT OF IT. The hook must name the "
        "WORST/MOST CHARGED thing about the story directly — the specific loss, the specific "
        "transgression, the specific betrayal. Not a symptom, not a side effect, not what "
        "you SAW. What you FELT. An empty envelope is what you see; missing money is what "
        "you feel. The hook goes for the felt thing — no decoding required.\n"
        "     CONCRETE TEST — same source, weak to strong:\n"
        "       Source: a coworker collected $800 in cash for a boss's retirement gift, the "
        "envelope vanished over the weekend, they then invoiced colleagues for their share.\n"
        "       WEAK (routine action, stakes invisible): 'She emailed invoices to the floor.' "
        "Office life — a stranger has no reason to care.\n"
        "       STILL WEAK (artifact, not the loss itself): 'The envelope was empty Monday "
        "morning.' The empty envelope is the SYMPTOM. A stranger has to mentally connect "
        "'empty envelope' to '$800 is gone' — that mental step is one step too many.\n"
        "       STRONG (names the loss directly): 'Eight hundred dollars in cash. Gone.' "
        "The amount, the medium, the fact. The punch is on the line, no decoding required.\n"
        "     Action or sensory detail only. No setup, no judgment, no 'imagine if', no "
        "question. The line must work even from a viewer who has zero context — they should "
        "think 'I need to know how we got here', NOT 'I don't get it' AND NOT 'I get it "
        "but I don't care'.\n"
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


def _pov_block() -> str:
    """How the narrator speaks. Lorewire shorts are TOLD by an outside
    storyteller — the narrator is never the protagonist. Source posts are
    mostly written in first person; the script must translate that into
    third person. Added 2026-06-28 after a render's narrator spoke as 'I'."""
    return (
        "POV — narrator is a third-person storyteller, never the character:\n"
        "  - The narrator TELLS the story. The narrator is NEVER the "
        "protagonist. Even when the source post is written in first person "
        "('I did X, my coworker did Y'), the script translates every "
        "'I/me/my' into third person.\n"
        "  - Use 'she', 'he', or 'they' depending on what the source "
        "establishes about the person. When gender is not established, "
        "default to 'they' or a role-noun ('the coworker', 'the poster', "
        "'the office admin', 'the wife'). NEVER guess a gender.\n"
        "  - The CTA / poll handoff (beat 5) is the ONLY place the narrator "
        "may speak to the viewer directly ('Would you do the same?', "
        "'Vote on the handoff'). The body of the script is observational — "
        "third-person past tense, no first-person 'I'.\n"
    )


def _clarity_block() -> str:
    """Bar the script as a whole must clear, on top of the hook-first
    structure. See _plans/2026-06-28-content-clarity-bar.md. The cold open
    still opens on the climax (owned by _structure_block); this block makes
    the LLM responsible for the viewer being able to retell the plot by the
    time the return beat lands. Kept in sync with the article prompt in
    stages._build_article_prompt — change both together."""
    return (
        "CLARITY — the script as a whole, not beat by beat:\n"
        "  - The COLD OPEN still opens on the climax (see STRUCTURE). Clarity "
        "does NOT mean leading with context. It means that by the end of the "
        "RETURN beat, an everyday viewer with no background on the story — "
        "not online in this niche, not following the source community — could "
        "retell what happened in plain words. The hook earns the climax; the "
        "build delivers the plot.\n"
        "  - Always anchor the script to a concrete event that HAPPENED — a "
        "specific action, moment, or reveal. Never abstract reflection, never "
        "'people are talking about'. The viewer must finish knowing exactly "
        "what occurred.\n"
        "  - Always plant a real curiosity question the viewer needs answered. "
        "Cold open raises it; build pays it off; CTA hands it to the poll. "
        "If a beat doesn't deepen the question or move toward the answer, cut it.\n"
        "  - If the source is dry or procedural, lift it with sharp specifics: "
        "a vivid sensory detail, a real quote, a small human moment FROM the "
        "source. Defendable against the source — never invented drama.\n"
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


def _poster_text_block() -> str:
    """Instructions for the social-cover poster line. The poster is a
    STATIC tile (1080x1920 PNG) shown in the social grid before the
    video ever plays. It's read in isolation, at thumb-scroll speed,
    by a stranger who hasn't heard a syllable of the script — a
    completely different audience situation than the spoken cold-open
    hook (beat 1). Per
    _plans/2026-06-28-phase-2-social-poster-render.md, scope addition
    locked 2026-06-29."""
    return (
        "POSTER TEXT — for the social-cover grid tile (NOT the spoken hook):\n"
        "  The cover poster is the STATIC image a stranger sees on an IG / FB / "
        "YouTube grid BEFORE the video plays. It's read once, at thumb-scroll "
        "speed, with zero context. The spoken hook (beat 1, the COLD OPEN) is "
        "designed to be MYSTERIOUS — to lure a viewer who's already pressed "
        "play to keep watching. The poster line is the OPPOSITE: it must name "
        "the dramatic moment CLEARLY so a stranger on the grid instantly "
        "understands the stakes and clicks.\n"
        "  Length: 8-14 words. One or two short sentences. Will render in ALL "
        "CAPS so avoid idioms that lose meaning in caps.\n"
        "  CONTRAST WITH THE SPOKEN HOOK — concrete examples from the same "
        "source:\n"
        "    Source: bride's wedding dress is destroyed the morning of the "
        "ceremony by the mother-in-law.\n"
        "      Spoken hook (beat 1, oblique): \"Her wedding dress was destroyed.\"\n"
        "      Poster text (clear, climax-revealing): \"Her wedding dress was "
        "destroyed the morning of the ceremony.\"\n"
        "    Source: woman refuses husband's ultimatum, he empties the joint "
        "account.\n"
        "      Spoken hook: \"Her refusal ended everything.\"\n"
        "      Poster text: \"She refused. He emptied their joint account by "
        "morning.\"\n"
        "  THE TEST: a stranger reading ONLY this line on a grid tile must "
        "instantly know (a) what specific event happened and (b) who is "
        "involved. They should NOT know the resolution — curiosity stays "
        "intact. \"She found out…\" + the discovery is good. \"Everything "
        "changed\" or \"Nothing was the same\" is BAD (abstract metaphor "
        "tells the stranger nothing).\n"
        "  SAME BRAND-SAFETY + ANTI-INVENTION RULES as the script: no "
        "all-caps shock language inside the line (the renderer adds caps), "
        "no profanity, no PII, no fabrication beyond the source. If a fact "
        "in the poster line isn't in the source story, do not write it.\n"
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
        '  "poster_text": "<8-14 word climax-revealing line for the static social grid tile, written for a stranger reading at scroll speed; SEPARATE from the spoken hook>",\n'
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
        _pov_block(),
        _clarity_block(),
        _brand_safety_block(),
        _poll_block(),
        _tone_block(),
        _poster_text_block(),
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
