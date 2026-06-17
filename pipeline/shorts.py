"""Article shorts — generation core.

Turns an article (title + body) into the image + script assets for a vertical
doodle short: a recurring MAIN CHARACTER who appears in many different places,
poses and moods (identity held by kie gpt-image-2 image-to-image), drawn in the
doodle_explainer_2 style, plus supporting characters when the story needs them.

This module is the validated recipe from the _spike, promoted to real code:
  narration script  → pipeline.shorts_narration (vibe presets)
  character + scenes → build_plan_prompt (this file)
  base frame         → kie/gpt-image-2 text-to-image
  scene frames       → kie/gpt-image-2 image-to-image (input_urls=[base]) — the
                       model that keeps the character identical across scenes;
                       nano-banana drifted. See shorts_image_style.DOODLE_SUFFIX.

It returns plain data (script + image URLs); voiceover, caption timing and the
Remotion render config are assembled by the render path (mirrors pipeline.video),
so this stays a pure, testable generation step the queue worker can drive
tick-by-tick within Vercel's 300s budget.
"""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Callable

from pipeline import images, llm, models, shorts_image_style as sis, shorts_narration

# Same establishing-shot model for the base; gpt-image-2 i2i for every scene so
# the character holds. Kept here (not hard-coded below) so the build can swap it.
BASE_MODEL = "kie/gpt-image-2"
SCENE_MODEL = "kie/gpt-image-2-i2i"

# Concurrent scene (i2i) generations. Variants only depend on the base, so they
# parallelize cleanly; ~8 keeps a ~14-scene short inside the Vercel drain's
# ~300s budget (sequential would not fit).
SCENE_CONCURRENCY = 8

# Words/second the narration is sized against (shared with shorts_narration).
WORDS_PER_SECOND = shorts_narration.WORDS_PER_SECOND


@dataclass(frozen=True)
class LengthPreset:
    id: str
    label: str
    target_seconds: int
    max_scenes: int
    elaborate: bool


# Creation-time length options. "standard" is the punchy ~45s short; "extended"
# is the ~1-minute cut that develops the story more (more narration + more cuts).
LENGTH_PRESETS: dict[str, LengthPreset] = {
    "standard": LengthPreset("standard", "Standard (~45s)", 45, 12, elaborate=False),
    "extended": LengthPreset("extended", "Extended (~1 min, more detail)", 62, 16, elaborate=True),
}
DEFAULT_LENGTH_ID = "standard"


def list_length_presets() -> list[dict]:
    """id / label for the admin picker."""
    return [{"id": p.id, "label": p.label} for p in LENGTH_PRESETS.values()]


def get_length_preset(preset_id: str | None) -> LengthPreset:
    return LENGTH_PRESETS.get(preset_id or "", LENGTH_PRESETS[DEFAULT_LENGTH_ID])


def extract_json(raw: str) -> dict:
    """Tolerant JSON extraction — strips ``` fences, grabs the outer {...}."""
    text = re.sub(r"^```(?:json)?\s*", "", raw.strip())
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError(f"no JSON object in LLM response: {raw[:160]!r}")
    return json.loads(text[start : end + 1])


def chunk_for_planning(script: str, max_words: int = 6) -> list[str]:
    """Approximate the renderer's caption chunking just enough to give the scene
    planner stable indices to anchor each scene to. Strips any [VISUAL] markers,
    breaks on sentence-end punctuation, caps at max_words. The real timed caption
    chunks come later from forced alignment in the render path."""
    spoken = re.sub(r"\[[^\]]*\]", " ", script)
    chunks: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+", spoken):
        words = [w for w in sentence.split() if w.strip()]
        for i in range(0, len(words), max_words):
            piece = " ".join(words[i : i + max_words]).strip()
            if piece:
                chunks.append(piece)
    return chunks


def build_plan_prompt(
    script: str,
    hook: str,
    payoff: str,
    captions: list[str],
    max_scenes: int,
    *,
    source_body: str = "",
) -> str:
    """Design ONE recurring main character + N varied scene frames. The same
    character appears in every frame (identity carried by i2i); each scene puts
    them in a different place / pose / mood, with supporting characters when the
    beat needs them.

    `source_body` is the full LoreWire article (= the retold Reddit post). The
    character planner uses it as ground truth for the protagonist's
    identity: pronouns, age/gender flair ("42M", "17F", "single dad"),
    and any explicit role markers. Without this the LLM was inventing the
    character from the short script alone — which often loses the original
    gender, leaving a male protagonist's short with a female lead (or vice
    versa) and the hero / poster art compounding the mismatch downstream.
    """
    n = max(1, min(max_scenes, len(captions)))
    cap_lines = "\n".join(f"[{i}] {c}" for i, c in enumerate(captions))
    system = (
        "You are the art director for a vertical hand-drawn cartoon short. Design ONE recurring MAIN "
        "CHARACTER and a set of scene frames in which that SAME character appears in many DIFFERENT "
        "places, poses and moods.\n\n"
        "PROTAGONIST IDENTITY IS NON-NEGOTIABLE. Before you pick anything else, read the SOURCE ARTICLE "
        "below and lock in the protagonist's:\n"
        "  - GENDER (look for pronouns 'he/him', 'she/her', 'they/them'; explicit flair like '42M', "
        "'17F', '34NB'; role words like 'mom', 'dad', 'husband', 'wife', 'brother', 'sister', 'son', "
        "'daughter', 'boyfriend', 'girlfriend', 'OP's wife', 'my boss').\n"
        "  - APPROX AGE BAND (teen / 20s / 30s / 40s / 50s / 60s+) from any age cues in the source.\n"
        "  - ROLE/RELATIONSHIP to the story (employee, parent, tenant, dater, roommate, customer, etc.).\n"
        "If the source contains explicit markers (e.g. '42M', 'I (29F)'), the protagonist's gender and "
        "approximate age MUST match those markers verbatim. Never invent a different gender from what "
        "the source describes.\n\n"
        "MAIN CHARACTER: a vivid, specific, repeatable description (gender, age band, hair, face, "
        "glasses or not, exact clothing with colors, build) — specific enough that an artist redraws "
        "the identical person every time. 1-2 sentences. Open the description with the gender + age "
        "band (e.g. 'A mid-40s man with...', 'A young woman in her late 20s with...').\n\n"
        f"SCENE FRAMES ({n} frames): each frame shows the SAME main character (identity unchanged) "
        "visualizing its caption beat, but in a DIFFERENT setting, body pose, facial expression and mood "
        "from the others — standing / sitting / crouching / walking / reacting, close-up vs wide, "
        "happy / sneaky / worried / shocked / anxious, across varied locations. Bring in SUPPORTING "
        "characters (coworkers, a boss, a friend) when the beat needs them and describe them briefly. "
        "Each scene 60-200 chars. Spread the chunk indices evenly across the whole script.\n"
        "FIRST SCENE MUST set caption_chunk_start_index=0 — it is the opener and must illustrate the "
        "hook line the narrator says first, in a real setting (NOT a neutral pose, NOT a blank "
        "background). Pick a vivid moment that lands the hook visually.\n\n"
        "Output STRICTLY this JSON:\n"
        '{\n  "character": "<vivid repeatable main-character description, opens with gender + age band>",\n'
        '  "scenes": [\n    { "caption_chunk_start_index": <int 0-' + str(max(0, len(captions) - 1)) +
        '>, "scene": "<the same character in a new place/pose/mood for this beat>" }\n  ]\n}\n\n'
        "Return ONLY valid JSON."
    )
    # The source body is the strongest signal for protagonist identity — the
    # short script is a condensed retelling and the LLM rewriter sometimes
    # drops gender markers. Falls back to script-only when no body is passed
    # so legacy callers stay compatible.
    source_block = (
        f"SOURCE ARTICLE (ground truth for the protagonist's identity):\n\"\"\"\n{source_body}\n\"\"\"\n\n"
        if source_body.strip()
        else ""
    )
    user = (
        f"{source_block}"
        f"Hook: {hook}\nPayoff: {payoff}\n\nShort script:\n\"\"\"\n{script}\n\"\"\"\n\n"
        f"Pre-chunked captions (use these indices):\n{cap_lines}\n\n"
        f"Design ONE main character + {n} varied scene frames. JSON only."
    )
    return f"{system}\n\n---\n\n{user}"


def _scene_prompt(character: str, scene: str) -> str:
    """Per-scene i2i edit prompt: re-pose the SAME character into a new scene,
    in the doodle_explainer_2 look, no text/bubbles, natural hands."""
    return (
        f"{sis.COMPOSITION_PREFIX} The EXACT same character from the reference image ({character}) — now "
        f"{scene}. Keep the character's identity identical; only the place, pose, expression and mood "
        f"change. {sis.DOODLE_SUFFIX}"
    )


@dataclass
class ShortAssets:
    narration_style: str
    length_preset: str
    script: dict                      # {title, hook, short_script, payoff, word_count}
    character: str
    base_url: str
    # Full prompt that generated base_url. Persisted onto the base doodle frame
    # (frame-00) so the short editor's textarea shows what the model actually
    # saw, and a per-scene regen replays the same wrapped prompt instead of a
    # naked scene description.
    base_prompt: str
    # Each scene now carries `image_prompt` (the FULL wrapped prompt sent to
    # the model) alongside the raw `scene` text so the editor can surface the
    # exact bytes the model received without rebuilding them on the fly.
    scenes: list[dict]                # [{caption_chunk_start_index, scene, url, image_prompt}]
    cost_credits: float


def generate_short_assets(
    title: str,
    body: str,
    *,
    narration_style_id: str | None = None,
    length_preset_id: str | None = None,
    on_progress: Callable[[str, int, int], None] | None = None,
) -> ShortAssets:
    """Run the full asset generation: narration script → character + scene plan →
    base frame (gpt-image-2) → scene frames (gpt-image-2 i2i, identity-locked).

    `on_progress(phase, current, total)` is called per step so the queue worker
    can persist progress between cron ticks. A scene that fails image generation
    is skipped (partial success) rather than sinking the whole short.
    """
    length = get_length_preset(length_preset_id)
    narration = shorts_narration.get_style(narration_style_id)
    llm_model = models.default_model("llm")

    def progress(phase: str, cur: int = 0, total: int = 0) -> None:
        if on_progress:
            on_progress(phase, cur, total)

    progress("script")
    source = f"{title}\n\n{body}".strip()
    script = extract_json(
        llm.chat(
            shorts_narration.build_extraction_prompt(
                narration.id, source, length.target_seconds, elaborate=length.elaborate
            ),
            max_tokens=4000,
            model=llm_model,
        )
    )

    caps = chunk_for_planning(script["short_script"])
    progress("plan")
    plan = extract_json(
        llm.chat(
            build_plan_prompt(
                script["short_script"],
                script.get("hook", ""),
                script.get("payoff", ""),
                caps,
                length.max_scenes,
                source_body=body,
            ),
            max_tokens=3600,
            model=llm_model,
        )
    )
    character = plan["character"].strip()
    planned = [s for s in plan.get("scenes", []) if (s.get("scene") or "").strip()]

    progress("base")
    base_prompt = (
        f"{sis.COMPOSITION_PREFIX} {character} Full body, neutral standing pose, "
        f"plain white background. {sis.DOODLE_SUFFIX}"
    )
    base_url = images.generate(
        base_prompt,
        aspect_ratio="9:16",
        resolution="1K",
        model=BASE_MODEL,
    )

    # Variants are independent edits of the base, so generate them concurrently
    # to fit the Vercel drain's ~300s budget (sequential 14x i2i would blow it).
    # Order is restored by the planned index after collection. Partial success:
    # a failed scene is dropped, not fatal.
    char_ref = character[:200]
    total = len(planned)
    done = 0
    results: dict[int, dict] = {}

    # Returns the FULL prompt sent to the model so build_short_props can
    # persist it on the doodle frame. The editor's Scenes tab uses it as
    # the textarea default + the per-scene regen action sends it back as-is
    # — that's why we want the wrapped version, not the raw s["scene"]:
    # editing scene text alone would lose the doodle styling + char ref the
    # original generation used.
    def _gen_one(i: int, s: dict) -> tuple[int, dict, str, str]:
        prompt = _scene_prompt(char_ref, s["scene"].strip())
        url = images.generate(
            prompt,
            aspect_ratio="9:16",
            resolution="1K",
            image_input=[base_url],
            model=SCENE_MODEL,
        )
        return i, s, url, prompt

    with ThreadPoolExecutor(max_workers=SCENE_CONCURRENCY) as ex:
        futures = [ex.submit(_gen_one, i, s) for i, s in enumerate(planned)]
        for fut in as_completed(futures):
            done += 1
            progress("scene", done, total)
            try:
                i, s, url, prompt = fut.result()
            except Exception:
                continue  # one bad scene shouldn't sink the short
            results[i] = {
                "caption_chunk_start_index": int(s.get("caption_chunk_start_index", i) or 0),
                "scene": s["scene"].strip(),
                "url": url,
                "image_prompt": prompt,
            }

    scenes = [results[i] for i in sorted(results)]

    progress("done", total, total)
    return ShortAssets(
        narration_style=narration.id,
        length_preset=length.id,
        script=script,
        character=character,
        base_url=base_url,
        base_prompt=base_prompt,
        scenes=scenes,
        cost_credits=float(images.totals.get("credits", 0) or 0),
    )
