"""Doodle image style + visual (shot) styles for shorts.

Two things live here:

1. DOODLE_SUFFIX — the dense yt-studio "Paint Explainer" doodle look (full color /
   multi-character / storybook density the user wants), but with the two clauses
   that fought our caption layer removed: the "speech bubbles ARE allowed" line
   and the "BAKED TYPOGRAPHY" block. Those contradicted the no-text rule and made
   the model draw empty bubbles + stray words. A single hard NO-TEXT-NO-BUBBLE
   rule replaces them — the player's karaoke captions are the only text.

2. VISUAL_STYLES — the "shot style": HOW each scene frame is composed relative to
   the character. The original look ("consistent") edits one base image so the
   character holds the same pose and only the environment changes (calm,
   near-static). "dynamic" and "varied" make the character actually move — new
   poses, actions and camera angles per scene.

Same idea as pipeline/shorts_narration.py: a registry the picker renders and the
pipeline resolves against; add a style by adding one entry.
"""
from __future__ import annotations

from dataclasses import dataclass

DEFAULT_VISUAL_STYLE_ID = "consistent"

# Base and variants MUST use the same image model or the editor redraws the base
# in its own style and the character drifts. nano-banana-2 for both (gpt-image-2
# is only a last-resort base fallback when nano-banana hard-fails).
IMAGE_MODEL = "kie/nano-banana-2"
IMAGE_MODEL_FALLBACK = "kie/gpt-image-2"

COMPOSITION_PREFIX = (
    "Vertical 9:16 composition. Subject placed in the middle 60% of the frame; top 10% and bottom 10% "
    "left intentionally empty for player UI / captions."
)

# The dense doodle look, verbatim from the yt-studio doodle_explainer_2 suffix
# EXCEPT: the "speech bubbles ARE allowed" sentence and the BAKED TYPOGRAPHY
# block are removed, and a hard no-text/no-bubble rule is appended.
DOODLE_SUFFIX = (
    "Hand-drawn cartoon doodle in the style of the Paint Explainer reference video — thin black ink "
    "outlines on a varied background (often white, sometimes a colored sky, sometimes a real photograph "
    "as a backdrop, sometimes a simple gradient). Characters are drawn in this hand-drawn doodle style "
    "with light clothing detail and expressive faces, but each character's specific look — hair, build, "
    "age, skin tone, clothing and any accessories — comes from the scene's character description, NOT a "
    "fixed template, so different stories show visibly different people. Multiple characters "
    "and props can share the frame when the narrative needs them — this is storybook composition, not a "
    "single-subject minimalist study. "
    "CHARACTER ANATOMY: heads are slightly imperfect circles (often with a soft cream / pale gray "
    "interior fill, not pure white), eyes are small dots or short strokes (draw glasses only when the "
    "character's description calls for them), "
    "eyebrows are short curved strokes (calm, raised in surprise, or downturned in anger), mouths range "
    "from a single line to a wide O of surprise to gritted teeth. Hands are drawn simply but naturally: "
    "small rounded hands with a few suggested fingers that clearly hold and grip objects. Do NOT draw "
    "stick-line arms ending in a dot or a featureless nub. Lines are wobbly, slightly imperfect, "
    "freehand, NOT clean vector, NOT polished. "
    "COLOR: this style uses MANY accent colors on props, clothing and atmosphere. Common palette: "
    "saturated orange/red (fire, danger, alarm), warm yellow (sun, energy, light), pale-to-saturated "
    "blue (sky, clothing, water), soft green (nature), gray (clouds, smoke, hair, lab coat fill, stone), "
    "brown / tan (paper, wood, ground), pink accents. Characters can wear lightly-colored clothing. Use "
    "color liberally — black-on-white only is too monotonous. "
    "BACKGROUND: vary by content. Default = clean white for character close-ups; soft blue sky + green or "
    "brown ground for outdoor; dark blue with stars for night; gray clouds for tension. A real photograph "
    "as a backdrop with cartoon elements on top is a powerful storytelling device. "
    "FORBIDDEN: textbook-style labeled diagrams — do NOT draw arrows pointing to written labels that name "
    "parts of the scene. That is a chart, not a story panel. NOT photorealistic, NOT 3D rendered, NOT "
    "anime, NOT manga. "
    "CRITICAL — NO TEXT, NO BUBBLES: render absolutely no text anywhere (no words, letters, numbers, "
    "labels, signs, dated calendars, or writing on any prop or screen), and NO speech bubbles or thought "
    "bubbles of any kind — not even empty ones. Show all dialogue, reactions and emotion ONLY through "
    "facial expressions, gestures and body language. The video player adds every caption separately."
)


# ---------------------------------------------------------------------------
# CLEAN style — matches the real yt-studio channel reference (ref/out.mp4):
# ONE simple stick-figure character on a PLAIN WHITE background performing ONE
# big bold ACTION per scene, generated fresh per scene (t2i). Energy comes from
# fast cuts between distinct bold actions, not from clutter or animation. The
# character is simple enough to redraw identically across totally different
# poses — so motion and consistency coexist (the dense doodle_explainer_2 look
# above could not do both). This is the default for shorts.
# ---------------------------------------------------------------------------
CLEAN_SUFFIX = (
    "Simple hand-drawn cartoon doodle in a minimalist explainer-animation style. Thick uneven black "
    "outlines, flat shadowless coloring, a 2D flat-vector / motion-graphics look, clean crisp lines. "
    "PLAIN WHITE background with lots of empty space. Exactly ONE main character plus at most one or two "
    "simple props. The character performs ONE big, clear, exaggerated ACTION (full body visible). Add a "
    "few small hand-drawn motion lines / action marks to imply movement. A few vibrant accent colors "
    "(especially warm yellow/orange). NOT photorealistic, NOT 3D, NOT a dense or cluttered scene, NOT a "
    "crowd, NOT a busy background. NO text, letters, numbers or speech bubbles anywhere (captions are "
    "added separately by the player)."
)


def build_scene_prompt(character: str, action: str) -> str:
    """One clean single-character action frame. `character` is the consistent
    character description (defined once per short, reused verbatim every scene);
    `action` is the one bold thing they do this beat."""
    return f"Vertical 9:16. {character.strip()}, {action.strip()}. {CLEAN_SUFFIX}"


@dataclass(frozen=True)
class VisualStyle:
    id: str
    label: str
    description: str
    # "i2i" edits the base frame (character identity locked by the model);
    # "t2i" draws each scene fresh (max pose/composition freedom, identity held
    # by repeating the character description).
    method: str
    # Phrasing injected into each variant prompt to control pose/framing.
    variant_instruction: str


VISUAL_STYLES: dict[str, VisualStyle] = {
    "consistent": VisualStyle(
        id="consistent",
        label="Consistent (recommended)",
        description="yt-studio's method: rock-solid same character every frame, the scene changes around them. Near-static by design — energy comes from fast cuts and dense scenes, not from re-posing. Best character consistency.",
        method="i2i",
        variant_instruction=(
            "Keep the SAME character with the SAME pose, face, headwear, clothing and the SAME hand-drawn "
            "style as the reference — treat the character as fixed. Change ONLY the environment, setting, "
            "props and any background/secondary characters around them. A calm sibling frame of the "
            "reference; do not re-pose or re-draw the main character."
        ),
    ),
    "dynamic": VisualStyle(
        id="dynamic",
        label="Dynamic (more motion, looser identity)",
        description="The character changes pose, action and camera angle each scene. More movement, but identity drifts (beanie colour, beard, proportions can shift). Use when motion matters more than a locked character.",
        method="i2i",
        variant_instruction=(
            "This is the SAME character as the reference (same face, glasses, headwear, hair, clothing and "
            "build) — but in a new pose doing a different action, framed from a different camera distance "
            "and angle. Keep the character's identity and the hand-drawn style; change the pose and framing."
        ),
    ),
    "varied": VisualStyle(
        id="varied",
        label="Varied (most motion, most drift)",
        description="Every scene drawn fresh for maximum compositional variety. Most movement, weakest character consistency.",
        method="t2i",
        variant_instruction=(
            "Draw a fresh full scene. The recurring main character — {character} — appears in a new pose, "
            "action, setting and camera framing. Keep that character description consistent."
        ),
    ),
}


def list_visual_styles() -> list[dict]:
    return [{"id": s.id, "label": s.label, "description": s.description} for s in VISUAL_STYLES.values()]


def get_visual_style(style_id: str | None) -> VisualStyle:
    return VISUAL_STYLES.get(style_id or "", VISUAL_STYLES[DEFAULT_VISUAL_STYLE_ID])


def build_base_prompt(scene: str) -> str:
    return f"{COMPOSITION_PREFIX} {scene} {DOODLE_SUFFIX}"


def build_variant_prompt(scene: str, visual_style_id: str | None, character: str = "") -> str:
    vs = get_visual_style(visual_style_id)
    instruction = vs.variant_instruction.replace("{character}", character or "the recurring main character")
    return f"{COMPOSITION_PREFIX} {scene} {instruction} {DOODLE_SUFFIX}"
