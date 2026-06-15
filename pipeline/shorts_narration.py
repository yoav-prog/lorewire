"""Narration styles for shorts — the "vibe / tone / way of telling the story".

Each style turns a source story into a 40-60s SPOKEN script with its own voice
(persona, pacing, how it opens and lands). The output JSON shape is identical
across styles, so the rest of the shorts pipeline (scene planner, image gen,
captions, render) stays style-agnostic and never branches on the chosen vibe.

The registry is the single source of truth the admin picker will render and the
pipeline resolves against (mirrors the config/models.json pattern). Add a vibe
by adding one NarrationStyle entry — no downstream changes needed.
"""
from __future__ import annotations

from dataclasses import dataclass

# Spoken-word pace used to size the script to the target duration. ~2.33 w/s is
# the rate the yt-studio shorts converged on; ElevenLabs turbo runs a touch
# faster, Google Chirp3-HD a touch slower, so the +20% cap absorbs the spread.
WORDS_PER_SECOND = 2.33

DEFAULT_STYLE_ID = "suspense"


@dataclass(frozen=True)
class NarrationStyle:
    id: str
    label: str
    description: str
    # The persona + tone instructions. The shared contract (length, banned
    # clichés, JSON shape) is appended by build_extraction_prompt so each entry
    # only has to express its voice.
    persona: str
    # Hint for the voice layer so delivery matches the words (used later when we
    # wire per-style voice settings; harmless until then).
    suggested_voice_mood: str


# Order = display order in the picker.
NARRATION_STYLES: dict[str, NarrationStyle] = {
    "storyteller": NarrationStyle(
        id="storyteller",
        label="Storyteller",
        description="Warm, cinematic narrative. Sets a scene, introduces the people, builds to the turn. Feels like a great short documentary.",
        suggested_voice_mood="warm, measured, expressive",
        persona=(
            "You are a masterful narrative storyteller — the warm, cinematic voice of a great short "
            "documentary. Tell the source as an ACTUAL STORY: set the scene, introduce the people, let a "
            "little tension build, then deliver the turn. Pull the listener in with a concrete human "
            "opening — a moment, a detail, a person — not a thesis or a stat. Use vivid but economical "
            "detail and a real sense of time and place. Let sentence length vary, some short and some "
            "flowing, so it breathes like spoken narration rather than a list. Make the listener feel "
            "they are being told something that truly happened to real people. End on a resonant beat "
            "that lingers."
        ),
    ),
    "suspense": NarrationStyle(
        id="suspense",
        label="Suspense / Mystery",
        description="True-crime tension. Opens on the unsettling fact, withholds, teases, builds to a twist. Made for whodunit stories.",
        suggested_voice_mood="low, tense, deliberate",
        persona=(
            "You are a gripping true-mystery narrator. Open on the single unsettling fact and let it "
            "hang. Withhold and tease — surface the question the listener now has to have answered. Use "
            "short, ominous sentences and clean cliffhanger beats. Imply more than you state. Build dread "
            "or curiosity steadily toward a twist or an unanswered question. End on the beat that makes "
            "them rewatch or comment their theory — never a generic 'subscribe' or 'like'."
        ),
    ),
    "punchy": NarrationStyle(
        id="punchy",
        label="Punchy Explainer",
        description="Fast, high-retention shorts voice. Bold hook, one sharp takeaway, teaser-payoff. The original style.",
        suggested_voice_mood="energetic, confident, fast",
        persona=(
            "You are a viral YouTube Shorts writer with elite retention instincts. Voice: fast, "
            "confident, punchy. Open on a bold claim or a striking fact that works even without sound. "
            "Pick ONE sharp takeaway, not a recap. Sentences are short, roughly 8 to 12 words, with "
            "deliberate fragments and one beat per line. Build a quick teaser then a payoff. Close on a "
            "line that reframes the opening or invites a specific comment."
        ),
    ),
    "conversational": NarrationStyle(
        id="conversational",
        label="Conversational",
        description="Casual and human, like a sharp friend telling you what just happened. Light humor, second person, voice-note energy.",
        suggested_voice_mood="casual, friendly, dry-witty",
        persona=(
            "You are a sharp, funny friend telling someone what just happened. Casual, human, second "
            "person. Natural speech with small asides and a little dry humor and real reactions. No "
            "corporate tone, no sales energy. It should sound like a voice note, not a script. Lead them "
            "in, then land the kicker like you are leaning over to say 'and here is the wild part'."
        ),
    ),
    "documentary": NarrationStyle(
        id="documentary",
        label="Documentary",
        description="Measured, authoritative, factual. Context then significance. Lets the facts carry the weight.",
        suggested_voice_mood="calm, authoritative, restrained",
        persona=(
            "You are a measured, authoritative documentary narrator. Calm, credible, weighty. Give the "
            "listener the context first, then the significance — why this matters. Restrained language, "
            "no hype, no clickbait, precision over punch. Let the facts carry the tension. Close on a "
            "quiet, pointed observation."
        ),
    ),
}


def list_styles() -> list[dict]:
    """id / label / description for the admin picker (no prompt text)."""
    return [
        {"id": s.id, "label": s.label, "description": s.description}
        for s in NARRATION_STYLES.values()
    ]


def get_style(style_id: str | None) -> NarrationStyle:
    """Resolve a style id, falling back to the default so a bad/empty id never
    crashes a generation (it just gets the house storyteller voice)."""
    return NARRATION_STYLES.get(style_id or "", NARRATION_STYLES[DEFAULT_STYLE_ID])


def _shared_contract(target_seconds: int) -> str:
    target_words = round(target_seconds * WORDS_PER_SECOND)
    return (
        f"\n\nThis is a {target_seconds}-second vertical Short — about {target_words} words at "
        f"~{WORDS_PER_SECOND} words per second; hard cap at +20% over that.\n"
        "The short_script is the SPOKEN narration, word for word. No stage directions, no visual notes, "
        "no markers, no on-screen-text instructions — only what the narrator actually says.\n"
        "Write like a human. Vary sentence length. Avoid clichés and AI tells: no 'have you ever "
        "wondered', 'in today's video', 'buckle up', 'let's dive in', 'without further ado', "
        "'game-changer', 'navigate', 'realm', 'at the end of the day'.\n"
        "Output STRICTLY this JSON and nothing else:\n"
        '{"title": "<~6-8 word title>", "hook": "<the literal opening line>", '
        '"short_script": "<the full spoken narration>", "payoff": "<the literal closing line>", '
        '"word_count": <integer word count of short_script>}'
    )


def build_extraction_prompt(
    style_id: str | None,
    source: str,
    target_seconds: int = 50,
    elaborate: bool = False,
) -> str:
    """Compose the full extraction prompt (persona + shared contract + source)
    for a single llm.chat() call. Returns one string because pipeline/llm.py's
    chat() sends a single user message.

    `elaborate` (set by the longer length preset) tells the writer to develop the
    story more — more setup, context and a fuller middle — without padding."""
    style = get_style(style_id)
    system = style.persona + _shared_contract(target_seconds)
    if elaborate:
        system += (
            "\n\nThis is a LONGER cut: take time to develop the story — a little more setup, context and a "
            "fuller middle — while keeping every line propulsive. More story, not filler."
        )
    user = (
        f"Source story:\n\"\"\"\n{source.strip()}\n\"\"\"\n\n"
        f"Write the {target_seconds}-second Short now in your voice as described. Output JSON only."
    )
    return f"{system}\n\n---\n\n{user}"
