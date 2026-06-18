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
from dataclasses import dataclass, field
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


# World bible caps for shorts. Looser than world_bible.py's MAX_CHARACTERS (used
# by the long-form pipeline with reference images): shorts ground on text alone,
# so beyond ~4 supporting characters the prompt gets too long for the model to
# hold every entity. Item cap is generous because props change scene to scene.
MAX_SUPPORTING_CHARS = 4
MAX_LOCATIONS = 3
MAX_ITEMS = 5


def build_plan_prompt(
    script: str,
    hook: str,
    payoff: str,
    captions: list[str],
    max_scenes: int,
    source: str = "",
) -> str:
    """Design ONE recurring main character + a small world bible + N varied
    scene frames. The same main character appears in every frame (identity
    carried by i2i); supporting characters / locations / items appear by name
    in the scenes and their verbatim visual cues get appended to the scene
    prompt so the SAME wife, SAME kitchen, SAME envelope is redrawn every time.

    `source` is the full original article (title + body). The planner uses it to
    GROUND the character in the actual narrator/protagonist instead of inventing
    a generic one — without it, the LLM defaults to the same stereotypical
    "diverse" archetype every story (Asian woman, chin-length dark hair with a
    gray streak, round glasses, teal button-up) which made every short look the
    same person.
    """
    n = max(1, min(max_scenes, len(captions)))
    cap_lines = "\n".join(f"[{i}] {c}" for i, c in enumerate(captions))
    last_cap_idx = max(0, len(captions) - 1)
    system = (
        "You are the art director for a vertical hand-drawn cartoon short. Design ONE recurring MAIN "
        "CHARACTER, a small WORLD BIBLE of the supporting cast / locations / items that recur, and a set "
        "of scene frames in which the same main character appears in many DIFFERENT places, poses and "
        "moods alongside those recurring entities.\n\n"
        "MAIN CHARACTER — GROUND IT IN THE SOURCE:\n"
        "First read the SOURCE ARTICLE below. Identify who the story is actually about (the narrator in "
        "first-person posts, the named protagonist otherwise) and extract every explicit and implied "
        "demographic clue: age (kid / teen / 20s / 30s / 40s / 50s / 60s+), gender, ethnicity / skin "
        "tone, occupation, body type, clothing context (uniform, suit, hoodie, scrubs, apron). Reddit "
        "posts almost always reveal age, gender and job in the first paragraph — USE THEM. Then describe "
        "that real person, NOT an idealised stand-in.\n\n"
        "ANTI-DEFAULT — do NOT fall back to: middle-aged East Asian woman, chin-length straight dark "
        "hair with a gray / white streak, round wire-frame glasses, teal or blue button-up shirt, white "
        "apron. That archetype is your trained default and it has been producing IDENTICAL-LOOKING "
        "characters across totally different stories. When the source does not pin a detail, ROTATE: "
        "rotate age bracket, gender, ethnicity, body type, hair length / colour / texture, facial hair, "
        "and accessories. Glasses are OPTIONAL — only include them when the source implies them or "
        "you have rotated to them deliberately. The character must look like a plausibly random human, "
        "not a Studio Ghibli protagonist.\n\n"
        "VIVID, REPEATABLE: 1-2 sentences, specific enough that an artist redraws the identical person "
        "every frame — exact age band, gender, ethnicity / skin tone, hair (length, colour, texture), "
        "facial features, clothing with colours, build. No vague words ('attractive', 'nondescript').\n\n"
        "WORLD BIBLE — supporting cast, locations, items must stay CONSISTENT scene to scene:\n"
        "Beyond the main character, identify every recurring entity that appears in more than ONE scene "
        "and would otherwise drift visually (the wife who looks different in every frame; the kitchen "
        "that's a new kitchen each time; the envelope that's a different envelope). For each, give a "
        "short snake_case NAME (\"wife\", \"office_kitchen\", \"red_envelope\") and a vivid 1-sentence "
        "visual description an artist could redraw identically every time. Then in EVERY scene that "
        "includes the entity, list its name in the per-scene \"characters\" / \"locations\" / \"items\" "
        "arrays. Names MUST match exactly between the bible and the scene references.\n"
        f"Caps: at most {MAX_SUPPORTING_CHARS} supporting characters, {MAX_LOCATIONS} locations, "
        f"{MAX_ITEMS} items. Skip background extras and one-off props (a glass on a table that's never "
        "seen again does NOT need a bible entry). When a supporting character or location is unnamed "
        "in the source, give it a descriptive name (\"older_brother\", \"diner_booth\"). Apply the "
        "same ANTI-DEFAULT rule to supporting characters — vary them, do not produce four versions of "
        "the main-character archetype.\n\n"
        f"SCENE FRAMES ({n} frames): each frame shows the SAME main character (identity unchanged) "
        "visualizing its caption beat, but in a DIFFERENT setting, body pose, facial expression and mood "
        "from the others — standing / sitting / crouching / walking / reacting, close-up vs wide, "
        "happy / sneaky / worried / shocked / anxious, across varied locations. Bring in SUPPORTING "
        "characters (coworkers, a boss, a friend) when the beat needs them — when you do, name the "
        "entity in the scene text AND in the matching per-scene array so its bible cues attach. "
        "Each scene 60-200 chars. Spread the chunk indices evenly across the whole script.\n\n"
        "Output STRICTLY this JSON:\n"
        "{\n"
        '  "character": "<vivid repeatable main-character description, grounded in the source>",\n'
        '  "supporting_characters": [\n'
        '    { "name": "<snake_case>", "visual_cues": "<one vivid sentence>" }\n'
        "  ],\n"
        '  "locations": [\n'
        '    { "name": "<snake_case>", "visual_cues": "<one vivid sentence>" }\n'
        "  ],\n"
        '  "items": [\n'
        '    { "name": "<snake_case>", "visual_cues": "<one vivid sentence>" }\n'
        "  ],\n"
        '  "scenes": [\n'
        "    {\n"
        f'      "caption_chunk_start_index": <int 0-{last_cap_idx}>,\n'
        '      "scene": "<the main character in a new place/pose/mood for this beat>",\n'
        '      "characters": ["<names from supporting_characters that appear in this scene; if the scene is visually FRAMED on a supporting character, list THAT character FIRST>"],\n'
        '      "locations": ["<names from locations>"],\n'
        '      "items": ["<names from items>"]\n'
        "    }\n"
        "  ]\n"
        "}\n\n"
        "supporting_characters / locations / items may be empty arrays when the story genuinely has no "
        "recurring entities of that kind. Per-scene reference arrays may also be empty. Return ONLY "
        "valid JSON."
    )
    source_block = (
        f"\nSOURCE ARTICLE (mine this for the protagonist's real demographics):\n"
        f"\"\"\"\n{source.strip()}\n\"\"\"\n\n"
        if source.strip()
        else ""
    )
    user = (
        f"Hook: {hook}\nPayoff: {payoff}\n"
        f"{source_block}"
        f"Narration script:\n\"\"\"\n{script}\n\"\"\"\n\n"
        f"Pre-chunked captions (use these indices):\n{cap_lines}\n\n"
        f"Design ONE main character + a world bible + {n} varied scene frames, grounded in the source. "
        f"JSON only."
    )
    return f"{system}\n\n---\n\n{user}"


def _entity_lookup(entries: object, cap: int) -> dict[str, str]:
    """Normalise the planner's supporting_characters / locations / items list
    into a {name: cues} map. Drops malformed entries, lowercases names,
    enforces the per-list cap. Returning a dict lets the scene builder do a
    cheap lookup per referenced entity without re-scanning the list.
    """
    out: dict[str, str] = {}
    if not isinstance(entries, list):
        return out
    for raw in entries:
        if not isinstance(raw, dict):
            continue
        name = raw.get("name")
        cues = raw.get("visual_cues")
        if not isinstance(name, str) or not isinstance(cues, str):
            continue
        name = name.strip().lower()
        cues = " ".join(cues.split())
        if not name or not cues:
            continue
        out.setdefault(name, cues)
        if len(out) >= cap:
            break
    return out


# gpt-image-2-i2i hard cap on input_urls — verified against kie's published
# OpenAPI spec (maxItems: 16). We never approach this in practice (~13 max
# from our world-bible caps) but enforcing it defensively means a planner
# returning more entities than expected can't blow up the i2i call.
INPUT_URLS_MAX = 16


def _build_supporting_char_ref_prompt(cues: str) -> str:
    """t2i prompt for a supporting-character reference. Same composition + style
    suffix as the main-character base so all references share visual DNA — when
    they're all stacked into a scene's input_urls, the model blends them as one
    coherent set rather than three differently-styled inputs."""
    return (
        f"{sis.COMPOSITION_PREFIX} {cues} Full body portrait, neutral standing pose, plain white "
        f"background. {sis.DOODLE_SUFFIX}"
    )


def _build_location_ref_prompt(cues: str) -> str:
    """t2i prompt for a location reference. Empty establishing shot (no people)
    so the scene's i2i pass uses it as a place anchor without character
    interference from the ref itself."""
    return (
        f"{sis.COMPOSITION_PREFIX} Empty establishing shot of {cues}. No characters or people in "
        f"frame — only the setting. {sis.DOODLE_SUFFIX}"
    )


def _build_item_ref_prompt(cues: str) -> str:
    """t2i prompt for a prop / item reference. Studio-clean shot on a neutral
    background so the prop's silhouette + colour + materials are unambiguous to
    the i2i model when it composes the prop into a scene."""
    return (
        f"{sis.COMPOSITION_PREFIX} A {cues} centered on a neutral pale background, clean studio "
        f"composition, no other objects or characters in frame. {sis.DOODLE_SUFFIX}"
    )


@dataclass(frozen=True)
class ReferenceGallery:
    """t2i'd reference images keyed by entity name. Per-scene generation reads
    this and passes the relevant URLs into kie's gpt-image-2-i2i `input_urls`
    array so the SAME wife / kitchen / envelope is redrawn every appearance —
    the documented strongest method for multi-entity consistency. Replaces the
    older approach of pasting verbatim descriptions into every scene prompt
    (which the literature ranks as the weakest method).
    """
    supporting_chars: dict[str, str]   # name -> ref image URL
    locations: dict[str, str]
    items: dict[str, str]


def build_reference_gallery(
    supporting_chars: dict[str, str],
    locations: dict[str, str],
    items: dict[str, str],
) -> ReferenceGallery:
    """t2i one reference image per recurring entity. Runs concurrent t2i calls
    inside the planning budget so a 4-supporting + 3-location + 5-item bible
    stays inside the Vercel drain's ~300s window. A failed reference is logged
    and dropped (scene generation falls back to base-only for that entity);
    we never fail the whole short on a ref miss.

    Per CLAUDE.md rule 14: every reference logs `[shorts ref ...]` so a future
    "the wife is still drifting" report can see which refs were generated +
    which failed, instead of having to dig into the kie call log.
    """
    ref_supp: dict[str, str] = {}
    ref_loc: dict[str, str] = {}
    ref_item: dict[str, str] = {}
    jobs: list[tuple[str, str, str, str]] = []  # (kind, name, prompt, target_key)
    for name, cues in supporting_chars.items():
        jobs.append(("character", name, _build_supporting_char_ref_prompt(cues), name))
    for name, cues in locations.items():
        jobs.append(("location", name, _build_location_ref_prompt(cues), name))
    for name, cues in items.items():
        jobs.append(("item", name, _build_item_ref_prompt(cues), name))
    if not jobs:
        return ReferenceGallery({}, {}, {})

    def _gen(job: tuple[str, str, str, str]) -> tuple[str, str, str]:
        kind, name, prompt, _ = job
        url = images.generate(
            prompt, aspect_ratio="9:16", resolution="1K", model=BASE_MODEL,
        )
        return kind, name, url

    print(f"[shorts ref] generating {len(jobs)} reference images")
    # SCENE_CONCURRENCY is the same ceiling the scene loop uses; a 12-entity
    # gallery fits cleanly. A failed ref doesn't block its peers.
    with ThreadPoolExecutor(max_workers=SCENE_CONCURRENCY) as ex:
        futures = {ex.submit(_gen, j): j for j in jobs}
        for fut in as_completed(futures):
            job = futures[fut]
            kind, name, *_ = job
            try:
                _kind, _name, url = fut.result()
            except Exception as e:  # noqa: BLE001 — best-effort gallery
                print(f"[shorts ref FAIL] kind={kind} name={name!r} error={e}")
                continue
            print(f"[shorts ref ok] kind={kind} name={name!r}")
            if kind == "character":
                ref_supp[name] = url
            elif kind == "location":
                ref_loc[name] = url
            elif kind == "item":
                ref_item[name] = url
    return ReferenceGallery(
        supporting_chars=ref_supp, locations=ref_loc, items=ref_item,
    )


def _redistribute_chunk_indices(scenes: list[dict], total_chunks: int) -> None:
    """Force-distribute `caption_chunk_start_index` evenly across the
    script. Mutates `scenes` in place. The planner is told to "spread
    chunk indices evenly" but the LLM ignores it on the tail — THE STEAK
    STANDOFF render hit 12 scenes with indices [0,1,3,4,6,7,8,10,11,13,14,15]
    over 33 captions, leaving the last frame to hold for 21 seconds while
    the narrator finished out. Trust the planner for SCENE ORDER + content;
    override for TIMING so per-frame visible duration is roughly even.

    Round-down placement: frame i starts at `(i * total_chunks) // n`.
    Frame 0 always starts at chunk 0; the last frame's gap to the end is
    bounded by `total_chunks // n + 1`. Idempotent on a re-run.
    """
    if not scenes or total_chunks <= 0:
        return
    n = len(scenes)
    for i, s in enumerate(scenes):
        s["caption_chunk_start_index"] = (i * total_chunks) // n


def _resolve_scene_refs(
    scene: dict,
    base_url: str,
    gallery: ReferenceGallery,
) -> list[str]:
    """Build the input_urls list for ONE scene's i2i call. Order matters —
    the model's documented behaviour treats earlier images as stronger
    anchors so identity holds even when many references stack.

    Default ordering: base (main character identity) first, then supporting
    characters, then locations, then items. Capped at INPUT_URLS_MAX
    (gpt-image-2 hard limit).

    Focal-character heuristic: when `scene["characters"]` lists a known
    supporting char as its FIRST entry, treat that sub-character as the
    visual focus of the scene and promote her ref to position 1 ahead of
    `base_url`. The protagonist stays in the ref set (still locked at
    position 2) but cedes the strongest anchor. Without this, scenes
    framed on the wife / boss / brother get kie-drifted because the
    protagonist's position-1 ref dominates.

    Heuristic vs LLM-emitted field: the planner is asked to list focal
    sub-characters FIRST in `scene["characters"]` (mirroring how artists
    name their subject before background figures). This avoids a separate
    `focal_character` field the LLM tended to omit silently — an unset
    field meant the reorder never fired. The first-listed convention is
    a single rule the planner already follows for compositional ordering.
    """
    refs: list[str] = []
    seen: set[str] = set()
    def _push(url: str | None) -> None:
        if url and url not in seen and len(refs) < INPUT_URLS_MAX:
            refs.append(url)
            seen.add(url)

    char_names = [str(n).strip().lower() for n in (scene.get("characters") or []) if isinstance(n, str)]
    focal_ref: str | None = None
    for name in char_names:
        ref = gallery.supporting_chars.get(name)
        if ref:
            focal_ref = ref
            break
    if focal_ref:
        _push(focal_ref)
        _push(base_url)
    else:
        _push(base_url)

    for name in char_names:
        _push(gallery.supporting_chars.get(name))
    for name in scene.get("locations") or []:
        _push(gallery.locations.get(str(name).strip().lower()))
    for name in scene.get("items") or []:
        _push(gallery.items.get(str(name).strip().lower()))
    return refs


def _scene_prompt(character: str, scene: str) -> str:
    """Per-scene i2i edit prompt. Minimal style — heavy lifting is in the
    reference images passed via input_urls, which lock identity for the main
    character and every recurring supporting character / location / prop. The
    text only describes the action / mood / framing change for this beat.
    Research basis: the field-standard ranking puts "reference image passing"
    above "verbose prompt re-description" for multi-entity consistency.

    Cast bounding: when multiple human refs + a domestic location ref are
    stacked, image models drift toward inventing additional unnamed people
    to populate the scene. The "no other people" line below is a general
    constraint that ties the cast strictly to whatever the bible passed in;
    it stays story-agnostic so it works whether the bible is a 1-person
    monologue or a 4-character ensemble."""
    return (
        f"{sis.COMPOSITION_PREFIX} {scene} The recurring main character, supporting characters, "
        f"locations and props all appear in the reference images — preserve their EXACT identity "
        f"(face, hair, clothing, setting details, prop shape and colour). Only the pose, expression, "
        f"action, mood and camera framing change for this beat. CAST: the only people in this frame "
        f"are those passed as reference images. Do not invent or add any other people. Main character "
        f"cue: {character}. {sis.DOODLE_SUFFIX}"
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
    # `image_input_urls` is the exact ordered list of refs the i2i call
    # received — base first, then any supporting characters / locations /
    # items the scene referenced. Persisting it means a per-scene regen can
    # replay the SAME multi-ref input the original generation used, instead
    # of falling back to a base-only regen that loses world-bible consistency.
    scenes: list[dict]                # [{caption_chunk_start_index, scene, url, image_prompt, image_input_urls}]
    cost_credits: float
    # Reference gallery — t2i'd ONCE per short, used as i2i inputs only.
    # These URLs MUST NOT be staged as visible doodle frames. They live on
    # props (supporting_character_refs / location_refs / item_refs) so the
    # editor + Lane C regen know the gallery exists, but the renderer only
    # walks doodle_frames so the refs never appear in the video.
    # Defaults to an empty gallery so existing call sites (and tests that
    # pre-date the world-bible feature) keep working without modification —
    # the only behavioural change is that scenes with empty gallery use
    # base-only refs, identical to pre-world-bible behaviour.
    reference_gallery: ReferenceGallery = field(default_factory=lambda: ReferenceGallery({}, {}, {}))


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
            build_plan_prompt(script["short_script"], script.get("hook", ""), script.get("payoff", ""),
                              caps, length.max_scenes, source=source),
            max_tokens=3600,
            model=llm_model,
        )
    )
    character = plan["character"].strip()
    # Surfaced so the "every short is the same person" debugging loop can read
    # exactly which character the planner picked for this story. Without this
    # the only way to inspect the chosen character is to re-render and inspect
    # the props blob — too late, too expensive.
    print(f"[shorts plan] character chosen: {character!r}")

    # World bible — parse the planner's supporting cast / locations / items
    # so the reference-gallery pass can t2i one ref per entity. Names are
    # lowercased + capped here so the per-scene lookup is O(1) and a planner
    # over-producing entities can't blow past kie's input_urls limit downstream.
    supporting_chars_cues = _entity_lookup(plan.get("supporting_characters"), MAX_SUPPORTING_CHARS)
    locations_cues = _entity_lookup(plan.get("locations"), MAX_LOCATIONS)
    items_cues = _entity_lookup(plan.get("items"), MAX_ITEMS)
    print(
        f"[shorts plan] world bible: {len(supporting_chars_cues)} supporting char(s), "
        f"{len(locations_cues)} location(s), {len(items_cues)} item(s)"
    )

    planned = [s for s in plan.get("scenes", []) if (s.get("scene") or "").strip()]
    _redistribute_chunk_indices(planned, len(caps))

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

    # Reference gallery — one t2i per recurring entity (supporting characters,
    # locations, items). These URLs feed into per-scene i2i `input_urls` so the
    # SAME wife / kitchen / envelope is redrawn every appearance — the
    # documented strongest method for multi-entity consistency. The refs are
    # NEVER staged as visible frames; shorts_render.py walks `scenes` only and
    # the gallery URLs live on a separate props key.
    progress("refs")
    gallery = build_reference_gallery(
        supporting_chars_cues, locations_cues, items_cues,
    )

    # Variants are independent edits of the base, so generate them concurrently
    # to fit the Vercel drain's ~300s budget (sequential 14x i2i would blow it).
    # Order is restored by the planned index after collection. Partial success:
    # a failed scene is dropped, not fatal.
    char_ref = character[:200]
    total = len(planned)
    done = 0
    results: dict[int, dict] = {}

    # Returns the FULL prompt sent to the model + the exact ordered ref list
    # so build_short_props can persist both. The editor's Scenes tab uses the
    # prompt as the textarea default + the per-scene regen action sends both
    # back so a regen replays the SAME multi-ref i2i input the original
    # generation used (otherwise the regen would lose world-bible consistency
    # and the wife / kitchen / envelope would drift back to a fresh take).
    def _gen_one(i: int, s: dict) -> tuple[int, dict, str, str, list[str]]:
        prompt = _scene_prompt(char_ref, s["scene"].strip())
        refs = _resolve_scene_refs(s, base_url, gallery)
        # Surface focal-priority decisions so a "wife still drifting" debug
        # session can see whether the reorder fired and which ref ended up
        # in position 1 for each scene. Heuristic: the FIRST listed
        # supporting char in scene["characters"] (if any) is the anchor.
        focal_name = ""
        for n in s.get("characters") or []:
            cand = str(n).strip().lower() if isinstance(n, str) else ""
            if cand and gallery.supporting_chars.get(cand):
                focal_name = cand
                break
        anchor = "supporting" if focal_name else "main"
        print(
            f"[shorts ref order] scene={i} focal={focal_name or '-'} "
            f"anchor={anchor} ref_count={len(refs)}"
        )
        url = images.generate(
            prompt,
            aspect_ratio="9:16",
            resolution="1K",
            image_input=refs,
            model=SCENE_MODEL,
        )
        return i, s, url, prompt, refs

    with ThreadPoolExecutor(max_workers=SCENE_CONCURRENCY) as ex:
        futures = [ex.submit(_gen_one, i, s) for i, s in enumerate(planned)]
        for fut in as_completed(futures):
            done += 1
            progress("scene", done, total)
            try:
                i, s, url, prompt, refs = fut.result()
            except Exception:
                continue  # one bad scene shouldn't sink the short
            results[i] = {
                "caption_chunk_start_index": int(s.get("caption_chunk_start_index", i) or 0),
                "scene": s["scene"].strip(),
                "url": url,
                "image_prompt": prompt,
                "image_input_urls": refs,
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
        reference_gallery=gallery,
        cost_credits=float(images.totals.get("credits", 0) or 0),
    )
