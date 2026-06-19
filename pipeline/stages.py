"""Pipeline stages.

Dry-run (no keys) uses bundled fixtures and stub transforms. With an LLM key
set, the research and article stages make real calls; the model is whatever the
admin selected (see pipeline.models), not an env var. The real scrape, image,
voice, and video stages remain env-gated seams to port from /from-amir.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from pipeline import config

FIXTURES = Path(__file__).resolve().parent / "fixtures"

RESEARCH_RULES = (
    "Use ONLY the provided post. Invent nothing: no facts, names, numbers, or "
    "outcomes that are not in the source. Keep quotes exact. If a detail is "
    "missing, say so rather than filling the gap."
)


def _clean_typography(text: str) -> str:
    """Normalize LLM punctuation to the LoreWire voice: straight quotes, no em
    dashes, no ellipsis glyphs. Keeps generated copy free of the usual AI tells."""
    text = text.replace("’", "'").replace("‘", "'")
    text = text.replace("“", '"').replace("”", '"')
    text = re.sub(r"\s*—\s*", ", ", text)  # em dash -> comma
    text = re.sub(r"\s*–\s*", "-", text)  # en dash -> hyphen
    text = text.replace("…", "...").replace(" ", " ")
    return text


# --- Reddit scrape via Decodo (ported from from-amir/redditscraperformsn) -----
# Reddit blocks datacenter IPs, so each Reddit URL is fetched through Decodo's
# residential-proxy Scraping API; our IP never touches Reddit. stdlib only.
DECODO_SCRAPE_URL = "https://scraper-api.decodo.com/v2/scrape"
DECODO_GEO = "United States"
REDDIT_BASE = "https://www.reddit.com/r"

# Rough subreddit -> LoreWire category. Editorial, so the admin can re-tag.
SUBREDDIT_CATEGORY = {
    "amitheasshole": "Entitled",
    "entitledparents": "Entitled",
    "choosingbeggars": "Entitled",
    "pettyrevenge": "Drama",
    "maliciouscompliance": "Drama",
    "tifu": "Humor",
    "relationships": "Dating",
    "relationship_advice": "Dating",
    "roommates": "Roommate",
    "mademesmile": "Wholesome",
    "humansbeingbros": "Wholesome",
}


def _decodo_scrape(reddit_url: str) -> dict:
    token = (config.env("DECODO_TOKEN") or "").strip()
    auth = token if token.lower().startswith("basic ") else f"Basic {token}"
    data = json.dumps({"url": reddit_url, "geo": DECODO_GEO}).encode("utf-8")
    req = urllib.request.Request(
        DECODO_SCRAPE_URL,
        data=data,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": auth,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:200]
        raise RuntimeError(f"Decodo HTTP {e.code}: {detail}") from e


def _scrape_subreddit(subreddit: str, limit: int) -> list[dict]:
    # Over-fetch (removed/short posts get filtered) but cap at Reddit's 100.
    params = urllib.parse.urlencode(
        {"limit": min(max(limit * 3, limit), 100), "raw_json": 1, "t": "year"}
    )
    envelope = _decodo_scrape(f"{REDDIT_BASE}/{subreddit}/top.json?{params}")
    results = envelope.get("results", [])
    if not results:
        raise RuntimeError(f"Decodo returned no results: {str(envelope)[:200]}")
    content = results[0].get("content", "")
    data = content if isinstance(content, dict) else json.loads(content)
    children = data.get("data", {}).get("children", [])

    category = SUBREDDIT_CATEGORY.get(subreddit.lower(), "Drama")
    posts: list[dict] = []
    for child in children:
        p = child.get("data", {})
        if p.get("removed_by_category"):
            continue
        selftext = (p.get("selftext") or "").strip()
        if selftext in ("[removed]", "[deleted]", "") or len(selftext) < 80:
            continue
        posts.append(
            {
                "id": p.get("id", ""),
                "category": category,
                "subreddit": subreddit,
                "title": (p.get("title") or "").strip(),
                "selftext": selftext,
                "score": p.get("score", 0),
                "num_comments": p.get("num_comments", 0),
                "url": f"https://www.reddit.com{p.get('permalink', '')}",
            }
        )
        if len(posts) >= limit:
            break
    return posts


def scrape(subreddit: str, limit: int, use_fixture: bool) -> list[dict]:
    if use_fixture:
        posts = json.loads((FIXTURES / "sample_post.json").read_text(encoding="utf-8"))
        return posts[:limit]
    miss = config.missing("scrape")
    if miss:
        raise RuntimeError(f"scrape requires env {miss}; set them in .env.local")
    return _scrape_subreddit(subreddit, limit)


def make_idea(post: dict, dry_run: bool) -> dict:
    return {
        "reddit_id": post["id"],
        "category": post.get("category", "Entitled"),
        "headline": post["title"],
        "angle": "Retell as an original article in LoreWire's voice.",
    }


def research(idea: dict, post: dict, dry_run: bool) -> dict:
    if dry_run:
        return {"rules": RESEARCH_RULES, "brief": post.get("selftext", "")[:400], "source": post.get("url", "")}
    from pipeline import llm

    prompt = (
        f"{RESEARCH_RULES}\n\n"
        "SOURCE POST\n"
        f"Title: {post['title']}\n"
        f"Body: {post.get('selftext', '')}\n\n"
        "Write a tight research brief for a writer: retell the story in order, "
        "list 3 to 6 key beats, and pull any exact quotes. Plain text."
    )
    return {"rules": RESEARCH_RULES, "brief": llm.chat(prompt, 1500), "source": post.get("url", "")}


def write_article(idea: dict, research: dict, dry_run: bool) -> str:
    if dry_run:
        return (
            "[DRY RUN ARTICLE]\n\n"
            f"{idea['headline']}\n\n"
            f"{research['brief']}\n\n"
            "(In a real run the LLM rewrites this into an original article.)"
        )
    from pipeline import llm

    prompt = (
        "You write for LoreWire, where true internet stories are retold as short, "
        "vivid narratives. Retell the story below in about 350 to 450 words: open "
        "with a hook, move scene by scene, keep it punchy and entertaining, and let "
        "the facts carry it. Do NOT analyze, moralize, or render a verdict ('it's "
        "not hard to see why...', 'the lesson here'), and do not invent anything "
        "beyond the research. Return only the article text.\n\n"
        f"Headline: {idea['headline']}\n\n"
        f"Research:\n{research['brief']}"
    )
    return _clean_typography(llm.chat(prompt, 1200))


# --- image prompts ------------------------------------------------------------

# Scene style for the Article/Gallery illustrations and the Remotion doodle
# short. Wave 2.5 shifts from pure black-ink doodle on cream paper to a
# "cinematic stick-figure doodle" — the illustrations stay drawn (not
# photographic), but pick up sparse accent color, better composition, and
# occasional realistic detail on a single focal element. The thumbnail
# (CATEGORY_THUMBNAIL_STYLES) is fully painted; the scenes meet it halfway.
# This is now the standing default for every story we upload; the admin
# `video.style` setting still overrides it per-deployment.
DEFAULT_IMAGE_STYLE = (
    "Cinematic storyboard illustration in a stylized stick-figure / loose-ink "
    "doodle aesthetic. Hand-drawn confident gesture lines, expressive but "
    "simple characters. Sparse accent color (warm reds, ochres, deep blues) "
    "used selectively on key elements, otherwise muted off-white background. "
    "Occasional realistic detail on a single focal element (a hand, an object, "
    "a face) while the rest stays loose linework. Strong narrative composition "
    "with depth and lighting suggestion. No text, no captions, no logos."
)


# --- cinematic thumbnail prompts ----------------------------------------------

# Per-category visual identity for hero / thumbnail art. Each entry is a
# style cue that gets appended to the thumbnail prompt so a Drama story
# looks different from a Wholesome story without needing per-story art
# direction. Wave 2 of the visual system.
CATEGORY_THUMBNAIL_STYLES = {
    "Entitled": (
        "Bold satirical editorial poster, dramatic theatrical lighting, "
        "expressive characters caught mid-confrontation, mid-century magazine "
        "illustration palette with saturated red and burnt-orange accents on "
        "deep neutrals, mild caricature without grotesque distortion."
    ),
    "Drama": (
        "Cinematic neo-noir poster, moody atmospheric lighting with one strong "
        "warm light source, hyperdetailed realistic illustration, deep blacks "
        "and selective color, character silhouettes integrated into the "
        "composition."
    ),
    "Humor": (
        "Punchy animated poster art, vibrant pop palette, comic-book flat "
        "illustration with confident ink outlines and halftone shading, "
        "exaggerated comedic body language."
    ),
    "Wholesome": (
        "Soft warm pastel poster, golden-hour lighting, gentle storybook "
        "illustration, hand-painted feel with cream paper texture, character "
        "moment that radiates kindness."
    ),
    "Dating": (
        "Modern romantic-comedy poster, warm cinematic tones, character-focused "
        "editorial illustration, fashion magazine aesthetic, soft rim light, "
        "intimate framing."
    ),
    "Roommate": (
        "Slice-of-life indie illustration, lived-in interior, cozy 3/4 view, "
        "muted earthy palette, hand-drawn character with quiet exasperated "
        "expression."
    ),
}


def make_thumbnail_prompt(
    title: str,
    category: str,
    body: str,
    aspect_ratio: str,
    dry_run: bool,
    *,
    character_base_url: str | None = None,
    scene_image_url: str | None = None,
) -> str:
    """Build a cinematic title-baked thumbnail prompt for hero / poster art.

    Each prompt names the scene briefly (from the article's opening lines),
    appends the category's visual identity, and instructs the image model to
    render the title prominently inside the composition (gpt-image-2 handles
    short bold text well; longer titles wrap or get abbreviated). Three
    aspect ratios are supported: '3:4' for portrait posters / mobile
    billboards, '16:9' for desktop hero strips, and '1:1' for the
    Instagram-square thumbnail variant.

    When `character_base_url` is supplied the prompt switches to a
    character-faithful redraw: the caller MUST also pass
    `image_input=[character_base_url]` to `images.generate` so the model
    sees the short's base character as an i2i reference. Without that
    handshake, the prompt change does nothing and the model still
    invents a fresh face every call.

    When `scene_image_url` is ALSO supplied (the hybrid mode used by
    `generate_hero_and_thumbnail_from_short` — see
    _plans/2026-06-19-reddit-source-auto-deliver-article-short-hero-thumbnail.md),
    the prompt names a second reference image and tells the model to
    inherit its framing / mood / lighting while still preserving the
    character's identity from the first reference. The caller MUST pass
    `image_input=[character_base_url, scene_image_url]` in that order so
    the prompt's "first reference" / "second reference" wording lines up
    with what the model sees.

    The style band stays shared across all aspects so the variants read
    as one poster series — only the composition / scene cue varies.
    """
    style = CATEGORY_THUMBNAIL_STYLES.get(category, CATEGORY_THUMBNAIL_STYLES["Drama"])
    if aspect_ratio == "3:4":
        orientation = (
            "Vertical streaming-thumbnail composition, character focal point "
            "centered, title baked into the upper or lower band"
        )
    elif aspect_ratio == "1:1":
        orientation = (
            "Square Instagram-thumbnail composition, character focal point "
            "centered with breathing room on both sides, title baked into "
            "the lower band"
        )
    else:
        orientation = (
            "Wide cinematic banner composition, character focal point off-center "
            "to leave room for the title, title baked into the lower-third band"
        )
    if dry_run:
        flags = []
        if character_base_url:
            flags.append("i2i")
        if scene_image_url:
            flags.append("scene-ref")
        suffix = f" ({'+'.join(flags)})" if flags else ""
        return f"[DRY] {title} cinematic {category} thumbnail at {aspect_ratio}{suffix}"

    # Take just the first couple of sentences of the article as the scene cue
    # so the model gets context without re-rendering the whole body each call.
    opening = " ".join(body.split()[:60])

    if character_base_url and scene_image_url:
        # Hybrid mode: two reference images. First = the character (identity
        # source), second = the chosen scene from the short (framing / mood
        # source). Tell the model EXPLICITLY which is which because gpt-image-2
        # i2i otherwise blends them; we need the face from #1 and the
        # composition from #2, not a 50/50 mash.
        return (
            f"Redraw the EXACT same character from the FIRST reference image — "
            f"same face, gender, build, hair, clothing, age — but place them in "
            f"a composition INSPIRED BY the SECOND reference image's framing, "
            f"mood, lighting, and dramatic moment. Reimagined as a cinematic "
            f"editorial poster for a short documentary titled \"{title}\". "
            f"{style} "
            f"Scene context from the story: {opening} "
            f"Render the title \"{title}\" prominently in bold confident "
            f"typography, integrated into the composition (not floating on a "
            f"separate layer). {orientation}. High-resolution magazine-cover "
            f"finish. No watermarks, no signatures, no extra text beyond the title."
        )

    if character_base_url:
        # i2i variant: the reference image carries the protagonist's identity
        # (the short's base character), so the prompt's job is (a) preserve
        # that identity verbatim and (b) restyle the composition into the
        # category's poster look. This is what keeps hero / poster
        # characters consistent with the short.
        return (
            f"Redraw the EXACT same character from the reference image — same "
            f"face, gender, build, hair, clothing, age — but reimagined as a "
            f"cinematic editorial poster for a short documentary titled "
            f"\"{title}\". {style} "
            f"Composition focused on this scene from the story: {opening} "
            f"Render the title \"{title}\" prominently in bold confident "
            f"typography, integrated into the composition (not floating on a "
            f"separate layer). {orientation}. High-resolution magazine-cover "
            f"finish. No watermarks, no signatures, no extra text beyond the title."
        )

    return (
        f"Cinematic editorial poster for a short documentary titled \"{title}\". "
        f"{style} "
        f"Composition focused on this scene from the story: {opening} "
        f"Render the title \"{title}\" prominently in bold confident "
        f"typography, integrated into the composition (not floating on a "
        f"separate layer). {orientation}. High-resolution magazine-cover "
        f"finish. No watermarks, no signatures, no extra text beyond the title."
    )


def pick_hero_and_thumbnail_scenes(
    title: str,
    body: str,
    scenes: list[dict],
    *,
    dry_run: bool = False,
) -> dict:
    """Pick a hero scene index and a (distinct) thumbnail scene index from a
    short's generated scene list.

    Used by `media.generate_hero_and_thumbnail_from_short` (see
    _plans/2026-06-19-reddit-source-auto-deliver-article-short-hero-thumbnail.md).
    The hero and thumbnail are i2i'd from the short's character_base_url PLUS
    a chosen scene image — picking which scene is what this function does.

    `scenes` is the list persisted in short_renders.props (one dict per scene
    with a `scene` description and a `url`). Returns
    `{"hero_index", "thumbnail_index", "picker_reasoning"}`. Both indexes are
    guaranteed to be within `range(len(scenes))`. Distinct whenever the list
    has >= 2 scenes; equal only when there's a single scene available.

    Deterministic fallback (used when scenes is empty, dry_run, or the LLM call
    fails / returns junk): hero = 0 (story opener establishes the character),
    thumbnail = len(scenes) // 2 (typically the climactic mid-beat). Cheap and
    predictable so tests don't need an LLM key.

    The LLM call is intentionally tiny — title + body's first 60 words + numbered
    scene descriptions — and uses the cheap `gpt-5-nano` model the title stage
    already uses. Cost target: ~$0.001 per story. Skipped entirely under
    `hero_thumbnail.scene_picker.enabled = off`.
    """
    from pipeline import llm, store

    if not scenes:
        return {"hero_index": 0, "thumbnail_index": 0, "picker_reasoning": "no scenes"}

    n = len(scenes)
    fallback_hero = 0
    fallback_thumb = n // 2 if n > 1 else 0
    fallback = {
        "hero_index": fallback_hero,
        "thumbnail_index": fallback_thumb,
        "picker_reasoning": "deterministic fallback (hero=0, thumb=mid)",
    }

    if dry_run:
        return {**fallback, "picker_reasoning": "[DRY] deterministic"}

    if (store.get_setting("hero_thumbnail.scene_picker.enabled") or "on").strip().lower() in {
        "off", "0", "false", "no",
    }:
        return {**fallback, "picker_reasoning": "picker disabled in settings"}

    # Just the description text per scene; we don't show the image URL or
    # prompt to the model — those add tokens without changing the choice.
    scene_lines = "\n".join(
        f"  {i}. {(s.get('scene') or '').strip()[:200]}"
        for i, s in enumerate(scenes)
    )
    opening = " ".join((body or "").split()[:60])
    instruction = (
        "You pick the two most visually striking scenes from a short documentary "
        "for use as poster art.\n"
        f'Article title: "{title}"\n'
        f"Article opening: {opening}\n\n"
        "Scenes (numbered, with the description that was given to the image model):\n"
        f"{scene_lines}\n\n"
        "Pick TWO scenes:\n"
        "  - hero_index: best as the article's header — establishes the protagonist clearly, "
        "calm enough that a baked-in title reads.\n"
        "  - thumbnail_index: best as the click-stopping social card — most dramatic, highest "
        "emotional charge, must be DIFFERENT from hero_index when more than one scene exists.\n\n"
        "Return ONLY a JSON object with three keys: "
        '{"hero_index": <int>, "thumbnail_index": <int>, "reasoning": "<one short sentence>"}. '
        "No prose, no fences."
    )
    try:
        raw = llm.chat(instruction, 600, model="openai/gpt-5-nano").strip()
    except Exception as e:  # noqa: BLE001 — picker must not break the pipeline
        return {**fallback, "picker_reasoning": f"llm error: {e}"[:200]}

    parsed = _parse_scene_picker(raw)
    if parsed is None:
        return {**fallback, "picker_reasoning": "llm returned unparseable JSON"}

    hero_idx = parsed.get("hero_index")
    thumb_idx = parsed.get("thumbnail_index")
    reasoning = str(parsed.get("reasoning") or "")[:200]
    if not isinstance(hero_idx, int) or not (0 <= hero_idx < n):
        hero_idx = fallback_hero
    if not isinstance(thumb_idx, int) or not (0 <= thumb_idx < n):
        thumb_idx = fallback_thumb
    # Distinctness: with 2+ scenes the two assets should look different. If the
    # model picked the same index, nudge thumbnail one slot toward the middle
    # so we don't ship two identical i2i seeds.
    if n > 1 and hero_idx == thumb_idx:
        thumb_idx = (hero_idx + 1) % n
        reasoning = (reasoning + " | nudged for distinctness").strip(" |")

    return {
        "hero_index": hero_idx,
        "thumbnail_index": thumb_idx,
        "picker_reasoning": reasoning or "llm pick",
    }


def _parse_scene_picker(raw: str) -> dict | None:
    """Mirror of `_parse_title_synopsis`: strip fences, find the outer JSON
    object, return the parsed dict. None on any failure so the caller can
    fall back deterministically."""
    snippet = raw
    if "```" in snippet:
        for part in snippet.split("```"):
            stripped = part.strip()
            if stripped.startswith(("json", "JSON")):
                stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
            if stripped.startswith("{"):
                snippet = stripped
                break
    start, end = snippet.find("{"), snippet.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        return json.loads(snippet[start : end + 1])
    except json.JSONDecodeError:
        return None


# --- prop plan (Wave 3 Phase 3 PropSlideIn) ----------------------------------

# Visual style for prop cutouts. Keeps them legible against the cinematic
# stick-figure scenes — same loose ink line, sparse accent color, transparent
# or near-white background so the slide-in feels like a sticker, not a photo.
PROP_IMAGE_STYLE = (
    "Single object cutout illustration, doodle-marker ink line aesthetic, "
    "minimal accent color (warm red or ochre), white or transparent "
    "background, centered, no people, no text, no logos. The object fills "
    "the frame so a slide-in animation feels punchy."
)


def make_prop_plan(idea: dict, body: str, n: int, dry_run: bool) -> list[dict]:
    """LLM picks N concrete objects from the article to slide in as props.

    Returns a list of `{keyword, label, side}` items. `keyword` drives the
    kie generation prompt, `label` is a short caption (for accessibility +
    future UI), `side` rotates through left/right/top/bottom by index when
    the LLM doesn't specify one. Dry-run returns deterministic stub items so
    the rest of the pipeline can run end to end without an LLM key.
    """
    from pipeline import llm

    if dry_run:
        sides = ["right", "left", "bottom", "top"]
        return [
            {"keyword": f"prop-{i + 1}", "label": f"DRY {i + 1}", "side": sides[i % len(sides)]}
            for i in range(n)
        ]

    instruction = (
        f"You design illustrated shorts for LoreWire. Read the article and "
        f"return exactly {n} prop ideas as a JSON array of objects: each "
        f"object has \"keyword\" (a concrete noun for the prop, 1-3 words, "
        f"object only — never a person, place, or action), \"label\" (a 1-2 "
        f"word display caption for accessibility), and \"side\" (one of "
        f"left, right, top, bottom — the edge the prop slides in from). "
        f"Pick objects that are mentioned in the article and feel cinematic "
        f"as a slide-in (e.g. \"envelope\", \"phone\", \"calendar\", "
        f"\"coffee cup\", \"clipboard\"). Distribute the four sides across "
        f"your picks so consecutive slide-ins don't come from the same edge. "
        f"Return ONLY the JSON array.\n\n"
        f"Headline: {idea['headline']}\n\n"
        f"Article:\n{body}"
    )
    raw = llm.chat(instruction, 2000, model="openai/gpt-5.4-mini").strip()
    return _parse_prop_plan(raw, n)


def _parse_prop_plan(raw: str, n: int) -> list[dict]:
    """Best-effort JSON parse with a safe fallback. Handles fenced code blocks
    and leading prose the LLM sometimes prepends."""
    snippet = raw
    if "```" in snippet:
        for part in snippet.split("```"):
            stripped = part.strip()
            if stripped.startswith(("json", "JSON")):
                stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
            if stripped.startswith("["):
                snippet = stripped
                break
    start, end = snippet.find("["), snippet.rfind("]")
    sides = ["right", "left", "bottom", "top"]
    if start != -1 and end != -1 and end > start:
        try:
            parsed = json.loads(snippet[start : end + 1])
            if isinstance(parsed, list):
                out: list[dict] = []
                for i, item in enumerate(parsed):
                    if not isinstance(item, dict):
                        continue
                    keyword = str(item.get("keyword", "")).strip()
                    if not keyword:
                        continue
                    label = str(item.get("label", "")).strip() or keyword
                    side = str(item.get("side", "")).strip().lower()
                    if side not in {"left", "right", "top", "bottom"}:
                        side = sides[i % len(sides)]
                    out.append({"keyword": keyword, "label": label, "side": side})
                if out:
                    return out[:n]
        except json.JSONDecodeError:
            pass
    return [
        {"keyword": "envelope", "label": "envelope", "side": sides[i % len(sides)]}
        for i in range(n)
    ]


def make_prop_image_prompt(keyword: str) -> str:
    """Wraps a keyword into a kie-ready prompt with the cutout style suffix."""
    return f"An illustration of a {keyword}. {PROP_IMAGE_STYLE}"


# --- character bust (Wave 3 Phase 3 MouthSwap) -------------------------------

# Composition rules for the talking-head bust. The MouthSwap composition
# component overlays SVG mouth shapes at a fixed anchor of (cx=0.50, cy=0.62)
# — the prompt has to land the mouth at that position or the overlay will
# float. "tight head-and-shoulders" + "mouth at approximately the lower middle
# of the frame" gets gpt-image-2 to compose to the anchor in tests; per-image
# vision detection is a follow-up (see plan's Risks).
CHARACTER_BUST_STYLE = (
    "Tight head-and-shoulders portrait of one character, doodle-marker ink "
    "aesthetic matching the article's other illustrations, neutral off-white "
    "background, single subject centered, head slightly larger than the "
    "shoulders, mouth positioned at approximately the lower-middle of the "
    "frame (around 60-65% down from the top), eyes looking forward, neutral "
    "expression with the mouth slightly open as if mid-word. No text, no "
    "captions, no logos, no second character, no hands in frame."
)


def make_character_prompt(idea: dict, body: str, dry_run: bool) -> str:
    """Build a single image prompt for the protagonist's talking-head bust.

    Used by the mouth_swap beat. The kie generation produces the original
    bust; a second kie call (images.edit_image) removes the mouth so the
    composition can overlay SVG mouth shapes. Dry-run returns a deterministic
    stub so the rest of the pipeline can run without an LLM key.

    The protagonist is identified from the article body — we ask the LLM to
    pick the single most central recurring character and give a short visual
    cue (hair, build, clothing) so the bust matches the same character that
    shows up in the scene prompts.
    """
    from pipeline import llm

    if dry_run:
        return (
            f"[DRY] tight bust shot of the protagonist of \"{idea['headline'][:80]}\". "
            f"{CHARACTER_BUST_STYLE}"
        )

    instruction = (
        "You design illustrations for LoreWire shorts. Read the article and "
        "return ONE image prompt (plain text, no JSON, no fences) for a "
        "tight head-and-shoulders portrait of the single most central "
        "recurring character in the story.\n\n"
        "Pick the character whose perspective drives the narrative (often "
        "the narrator). Give a short distinctive visual cue (hair, build, "
        "clothing) in the prompt so the bust matches the same character that "
        "appears in the other scene illustrations.\n\n"
        f"Append this composition note verbatim to the end of your prompt: "
        f"\"{CHARACTER_BUST_STYLE}\".\n\n"
        "Return ONLY the image prompt, one to three sentences, no surrounding "
        "prose.\n\n"
        f"Headline: {idea['headline']}\n\n"
        f"Article:\n{body}"
    )
    raw = llm.chat(instruction, 1200, model="openai/gpt-5.4-mini").strip()
    cleaned = _strip_prompt_wrappers(raw)
    return cleaned or (
        f"Tight bust shot of the protagonist of \"{idea['headline']}\". "
        f"{CHARACTER_BUST_STYLE}"
    )


def _strip_prompt_wrappers(raw: str) -> str:
    """Pull a plain-text prompt out of common LLM wrappers.

    Handles three layers, in order:
      1. Fenced code blocks anywhere in the response — ```...```, optionally
         tagged ```text or ```json. The first fenced block wins; surrounding
         prose ("Here is the prompt: ```...```") is dropped.
      2. Outer quote pairs (matching " or ') wrapping the whole thing.
      3. Leading / trailing whitespace.

    Returns the empty string when nothing usable remains so the caller can
    fall through to its default.
    """
    import re

    fenced = re.search(r"```(?:\w+)?\s*\n?(.*?)```", raw, re.DOTALL)
    if fenced:
        raw = fenced.group(1)
    cleaned = raw.strip()
    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in ('"', "'"):
        cleaned = cleaned[1:-1].strip()
    return cleaned


# Prompt for the kie edit pass that removes the mouth from the bust. Kept
# small and deterministic — the same string for every story — because the
# variation lives in the bust, not the edit. Verified live against the
# envelope hero on 2026-06-11; qwen2/image-edit preserved the surrounding
# composition and replaced the mouth with neutral skin in the same style.
MOUTH_REMOVAL_PROMPT = (
    "Remove the mouth from the character's face. Replace it with neutral "
    "skin in the same illustration style as the rest of the image. Do not "
    "change the eyes, hair, clothing, background, or composition — only the "
    "mouth area is edited."
)


# --- branded title + synopsis -------------------------------------------------

# Style anchors derived from the sample catalog. Future LLM calls follow this
# voice instead of leaking the raw Reddit headline (which is usually a question
# starting with "AITA for ...") into the live site.
TITLE_STYLE_EXAMPLES = [
    "THE $800 ENVELOPE",
    "THE NEIGHBOR'S FENCE",
    "SHE REPLIED ALL",
    "WRONG NUMBER, RIGHT GUY",
    "GIVE ME YOUR SEAT",
    "THE PARKING SPOT WAR",
    "IT'S MY BIRTHDAY MONTH",
    "THE WEDDING CRASHER",
    "MY ROOMMATE'S 3AM RULES",
]


def make_title_and_synopsis(idea: dict, body: str, dry_run: bool) -> tuple[str, str]:
    """Generate a branded LoreWire title + 1-sentence synopsis from the article.

    The Reddit headline ("AITA for ...") is fine in the DB as a debug trail
    but should never reach the live site. This call returns the public-facing
    title + synopsis the CMS publishes. Both are also Typography-cleaned so
    smart quotes / em dashes never sneak in. Dry-run returns deterministic
    stubs so the rest of the pipeline can run end to end without an LLM key.
    """
    from pipeline import llm

    if dry_run:
        # The dry-run stubs intentionally keep the brand voice so a screenshot
        # of dry-run output already looks like a real LoreWire piece.
        return (f"[DRY] {idea['headline'][:40].upper()}", idea["headline"][:140])

    examples = "\n".join(f"- {t}" for t in TITLE_STYLE_EXAMPLES)
    instruction = (
        "You write headlines for LoreWire, where true internet stories are "
        "retold as short, vivid pieces. Read the article below and return "
        "exactly one JSON object with two keys:\n"
        '  "title": a short branded title, ALL CAPS, 2 to 6 words, evocative, '
        "no question marks, no Reddit-isms (\"AITA\", \"WIBTA\"), no leading "
        '"THE STORY OF". The same voice as these:\n'
        f"{examples}\n"
        '  "synopsis": one sentence, 18 to 30 words, hook-y, written in the third '
        "person, tells the reader what they're about to read without spoiling the "
        "ending. No question marks, no clickbait.\n\n"
        "Return ONLY the JSON object, no surrounding prose.\n\n"
        f"Article:\n{body}"
    )
    # 2000 token budget: gpt-5-nano is a reasoning model and burns most of
    # max_completion_tokens on hidden reasoning before emitting output. A
    # 400-token cap returned empty strings; 2000 leaves ample headroom for
    # the JSON object after reasoning.
    raw = llm.chat(instruction, 2000, model="openai/gpt-5-nano").strip()
    title, synopsis = _parse_title_synopsis(raw)
    return _clean_typography(title), _clean_typography(synopsis)


def _parse_title_synopsis(raw: str) -> tuple[str, str]:
    """Best-effort JSON parse; falls back to a safe pair when the model misbehaves."""
    snippet = raw
    if "```" in snippet:
        # Strip ``` fences and an optional language tag
        for part in snippet.split("```"):
            stripped = part.strip()
            if stripped.startswith(("json", "JSON")):
                stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
            if stripped.startswith("{"):
                snippet = stripped
                break
    start, end = snippet.find("{"), snippet.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            parsed = json.loads(snippet[start : end + 1])
            title = str(parsed.get("title", "")).strip()
            synopsis = str(parsed.get("synopsis", "")).strip()
            if title and synopsis:
                return title, synopsis
        except json.JSONDecodeError:
            pass
    return "", ""


def make_image_prompts(idea: dict, body: str, dry_run: bool, n: int = 4) -> list[str]:
    """Build N image prompts grounded in the article (1 hero + n-1 scene shots).

    The instruction explicitly asks the LLM to lock in 2-4 named characters
    with short distinctive visual cues (hair, build, clothing) and to repeat
    those cues verbatim in every prompt where the character recurs — gpt-image-2
    needs the repetition because it has no memory across kie calls. Without
    this, the same character ends up rendered as a different person in each
    scene. Dry-run returns deterministic stubs so the rest of the pipeline can
    run end to end without an LLM key.
    """
    from pipeline import llm, store

    style = (store.get_setting("video.style") or DEFAULT_IMAGE_STYLE).strip()

    if dry_run:
        prompts = [f"[DRY RUN] hero illustration of {idea['headline'][:80]}. Style: {style}"]
        for i in range(1, n):
            prompts.append(f"[DRY RUN] scene {i}: a moment from the story. Style: {style}")
        return prompts

    instruction = (
        f"You design illustrations for LoreWire shorts. Read the article and return "
        f"exactly {n} image prompts as a JSON array of strings: prompt 0 is the HERO "
        f"shot (the single most striking visual that represents the story); prompts "
        f"1..{n - 1} are scene shots taken in story order.\n\n"
        f"CHARACTER CONTINUITY — this is critical. In your head, name the 2 to 4 "
        f"recurring characters in this story and give each one short, distinctive "
        f"visual cues (hair, build, clothing, accessories). Then in EVERY prompt "
        f"that includes a character, repeat those same cues verbatim so the same "
        f"characters keep showing up scene to scene. Example: if the main "
        f"character is 'a woman with a tight bun, glasses, a blue cardigan', "
        f"every prompt with her must say exactly that.\n\n"
        f"Each prompt: one to two sentences max, concrete subject and action, "
        f"describes the framing and the focal moment. NO text or captions in the "
        f"image. NO faces of identifiable real people. NO logos.\n\n"
        f"Append this style note to every prompt verbatim at the end: \"{style}\".\n\n"
        f"Return ONLY the JSON array, no surrounding prose.\n\n"
        f"Headline: {idea['headline']}\n\n"
        f"Article:\n{body}"
    )
    # gpt-5.4-mini, not nano: the character-continuity instruction + a 4+
    # prompt JSON list pushed nano past its hidden-reasoning budget and it
    # returned empty strings (verified 2026-06-11). 5.4-mini has no reasoning
    # overhead, costs ~5x more per token, but per-story we are still talking
    # sub-cent for this call. Article rewrite still uses the admin's stage
    # selection; this override is scoped to the image-prompt step.
    #
    # max_tokens=16000: a 28-prompt array at ~150 tokens each (story scene +
    # 80-token style suffix) is ~4.2k tokens of content plus JSON overhead —
    # the previous 4000 ceiling truncated mid-array on roughly 60% of bulk
    # scenes regens, so `_parse_prompt_list` fell through to the generic
    # "Scene N from the story above" fallback and kie had no story context
    # to draw from (production diagnosis 2026-06-14 on story `envelope`).
    raw = llm.chat(instruction, 16000, model="openai/gpt-5.4-mini").strip()
    prompts = _parse_prompt_list(raw, n, idea["headline"], style, body=body)
    return prompts


def _parse_prompt_list(
    raw: str, n: int, headline: str, style: str, body: str | None = None,
) -> list[str]:
    """Best-effort JSON parse of the LLM's prompt list, with a safe fallback.

    Handles the common LLM cases: pure JSON array, fenced code block, or a
    leading paragraph followed by the array. If the LLM returned a partial
    list (truncated mid-array), the partial list is padded by repeating the
    last valid prompt with a "(continued) scene N" suffix so every slot still
    carries story context — better than the old "Scene N from the story
    above" generic fallback that kie had no chance of rendering correctly.

    If nothing parses at all, falls back to a story-grounded set built from
    the headline + a body excerpt so kie still has the article in front of
    it. `body` is required for the fully-grounded fallback; pass None on
    callers that don't have it (older tests).
    """
    snippet = raw
    if "```" in snippet:
        parts = snippet.split("```")
        for part in parts:
            stripped = part.strip()
            if stripped.startswith(("json", "JSON")):
                stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
            if stripped.startswith("["):
                snippet = stripped
                break
    start, end = snippet.find("["), snippet.rfind("]")
    if start != -1 and end != -1 and end > start:
        try:
            parsed = json.loads(snippet[start : end + 1])
            if isinstance(parsed, list):
                prompts = [str(p).strip() for p in parsed if str(p).strip()]
                if prompts:
                    if len(prompts) >= n:
                        return prompts[:n]
                    # Partial list — pad by repeating the last prompt with a
                    # numbered continuation suffix so each slot still carries
                    # the story-specific imagery instead of a blank generic.
                    last = prompts[-1]
                    padded = list(prompts)
                    while len(padded) < n:
                        padded.append(f"{last} Continuation scene {len(padded)}.")
                    return padded
        except json.JSONDecodeError:
            pass

    # Total parse failure. Embed the story so kie has SOMETHING grounded to
    # draw from instead of the previous generic "Scene N from the story
    # above" which had no context at all.
    excerpt = ""
    if body:
        excerpt = " ".join(body.split())[:400]
        if excerpt:
            excerpt = f' Story context: "{excerpt}..."'
    fallback = [
        f"Hero illustration capturing the moment of: {headline}.{excerpt} {style}"
    ]
    for i in range(1, n):
        fallback.append(
            f"Scene {i}: a story moment from the article "
            f'"{headline}".{excerpt} {style}'
        )
    return fallback


# --- grounded per-scene prompts (Phase 1 of 2026-06-14 plan) -----------------
# Image prompts that follow what the narrator is actually SAYING at each
# scene, not just "the Nth visual the LLM imagined from the body." Two LLM
# calls: a character bible (cached on video_config.character_bible so we
# pay for it once per story) plus a single grounded-prompts call that
# binds each prompt to its narration line and reuses the bible cues for
# continuity. See _plans/2026-06-14-scene-prompts-grounded-in-narration.md.

# Single-narration-line cap. Captions are short by construction (they
# play in seconds), so 600 chars covers any real scene. The cap exists
# so a malformed `captions` field can't drive an unbounded LLM bill.
MAX_NARRATION_CHARS = 600


def _truncate_narration(line: str) -> str:
    """Defensive cap on a single scene's narration text so a malformed
    captions field can't push the LLM prompt to absurd size."""
    line = " ".join(line.split())
    if len(line) <= MAX_NARRATION_CHARS:
        return line
    return line[:MAX_NARRATION_CHARS].rstrip() + "..."


def _parse_character_bible(raw: str) -> dict | None:
    """Parse the bible-call response into {"characters": [...], "summary": str}.
    Returns None on any failure — the per-scene step still runs without a
    bible, just without the continuity reinforcement (logged as the
    fallback branch in media.py)."""
    snippet = raw
    if "```" in snippet:
        for part in snippet.split("```"):
            stripped = part.strip()
            if stripped.startswith(("json", "JSON")):
                stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
            if stripped.startswith("{"):
                snippet = stripped
                break
    start, end = snippet.find("{"), snippet.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        parsed = json.loads(snippet[start : end + 1])
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    chars = parsed.get("characters")
    if not isinstance(chars, list) or not chars:
        return None
    cleaned: list[dict] = []
    for c in chars:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name", "")).strip()
        cues = str(c.get("visual_cues", "")).strip()
        if not name or not cues:
            continue
        cleaned.append({"name": name, "visual_cues": cues})
    if not cleaned:
        return None
    summary = str(parsed.get("setting", "")).strip()
    return {"characters": cleaned[:4], "summary": summary}


def _bible_for_prompt(bible: dict | None) -> str:
    """Render the bible into the human-readable block the per-scene call
    embeds. Empty string when there's no usable bible — instruction
    falls back to a 'no recurring characters' branch."""
    if not bible:
        return ""
    lines = [f"- {c['name']}: {c['visual_cues']}" for c in bible["characters"]]
    block = "RECURRING CHARACTERS (repeat their visual cues verbatim every "
    block += "time they appear in a prompt):\n" + "\n".join(lines)
    if bible.get("summary"):
        block += f"\n\nSETTING: {bible['summary']}"
    return block


def build_character_bible(idea: dict, body: str, dry_run: bool) -> dict | None:
    """First half of the grounded path. One short LLM call: name the 2-4
    recurring characters and give each a distinctive visual cue. Returns
    None on dry-run or on parse failure so the caller can still proceed
    (per-scene call works without a bible, just less consistent)."""
    from pipeline import llm

    if dry_run:
        return {
            "characters": [
                {"name": "Protagonist", "visual_cues": "[DRY] tall, dark coat"},
                {"name": "Antagonist", "visual_cues": "[DRY] short, red scarf"},
            ],
            "summary": f"[DRY] setting derived from {idea['headline'][:60]}",
        }

    instruction = (
        "You design illustrations for LoreWire shorts. Read the article and "
        "identify the 2 to 4 most recurring on-screen characters. For each, "
        "give a short distinctive visual description (hair, build, clothing, "
        "accessories) that an illustrator would repeat verbatim every time "
        "the character is drawn so the same person shows up scene to scene.\n\n"
        "Also write a one-line setting summary (era, place, vibe).\n\n"
        "Return ONLY this JSON object, no fences, no prose:\n"
        '{"characters": [{"name": "...", "visual_cues": "..."}, ...], '
        '"setting": "..."}\n\n'
        f"Headline: {idea['headline']}\n\nArticle:\n{body}"
    )
    raw = llm.chat(instruction, 1500, model="openai/gpt-5.4-mini").strip()
    return _parse_character_bible(raw)


def make_grounded_scene_prompts(
    idea: dict,
    body: str,
    scene_narrations: list[str],
    dry_run: bool,
    *,
    cached_bible: dict | None = None,
) -> tuple[list[str], dict | None]:
    """Build one image prompt per scene where the prompt is grounded in the
    narration line spoken at that scene, with recurring characters from the
    bible re-stated verbatim.

    Returns (prompts, bible). `prompts` is the same length as
    `scene_narrations`. `bible` is the bible that was used — caller
    persists it on video_config.character_bible so a sibling regen on the
    same story doesn't pay for the bible call twice. `bible` is None when
    the bible step failed; the prompts still came back, just without the
    cross-scene continuity reinforcement.

    Dry-run returns deterministic stubs that EMBED the narration line so
    tests can assert binding survives without an LLM key.
    """
    from pipeline import llm, store

    style = (store.get_setting("video.style") or DEFAULT_IMAGE_STYLE).strip()
    narrations = [_truncate_narration(line or "") for line in scene_narrations]
    n = len(narrations)

    if dry_run:
        bible = cached_bible or build_character_bible(idea, body, dry_run=True)
        prompts = [
            f"[DRY] scene {i + 1} grounded in narration: \"{narrations[i][:80]}\". "
            f"Style: {style}"
            for i in range(n)
        ]
        return prompts, bible

    bible = cached_bible if cached_bible else build_character_bible(idea, body, dry_run=False)
    bible_block = _bible_for_prompt(bible)

    # Narration lines numbered the way the LLM should index them in the
    # returned array — 1-based for the human-readable prompt, but parsed
    # back to a 0-based list of length n.
    numbered = "\n".join(
        f"Scene {i + 1}: \"{narrations[i]}\"" for i in range(n)
    )

    instruction = (
        f"You design illustrations for LoreWire shorts. Below is a list of "
        f"{n} scenes from a video. Each scene shows ONE line of narration "
        f"that plays under the image at that moment.\n\n"
        f"Return a JSON array of EXACTLY {n} image prompts in the same order "
        f"as the scenes. Prompt i depicts the moment described by Scene i's "
        f"narration line — not the article in general, not the previous "
        f"scene, THAT line specifically.\n\n"
        + (bible_block + "\n\n" if bible_block else "")
        + f"Each prompt: one to two sentences max, concrete subject and "
        f"action, describes the framing and the focal moment shown by THAT "
        f"narration line. NO text or captions in the image. NO faces of "
        f"identifiable real people. NO logos.\n\n"
        f"Append this style note to every prompt verbatim at the end: "
        f'"{style}".\n\n'
        f"Return ONLY the JSON array of {n} strings, no surrounding prose.\n\n"
        f"Headline: {idea['headline']}\n\n"
        f"Scenes (one per line of narration):\n{numbered}"
    )
    # Same model + token shape as make_image_prompts — character continuity
    # instruction + N-prompt JSON list needs 5.4-mini's no-reasoning budget
    # to survive long arrays. 16000 tokens covers a 30-prompt array at
    # ~200 tokens each (narration line + bible cue + style suffix).
    raw = llm.chat(instruction, 16000, model="openai/gpt-5.4-mini").strip()
    prompts = _parse_grounded_prompts(raw, narrations, idea["headline"], style)
    return prompts, bible


def _parse_grounded_prompts(
    raw: str, narrations: list[str], headline: str, style: str,
) -> list[str]:
    """Parse the grounded-prompts LLM response with a per-scene fallback.

    Unlike `_parse_prompt_list`, a partial/failed parse here doesn't pad
    with the last prompt — we PAD with a per-scene grounded fallback that
    mentions THAT scene's narration line, because the whole point of this
    function is that prompt N targets narration line N. Padding with
    "continuation of scene 5" on scene 12 would defeat the binding."""
    n = len(narrations)
    snippet = raw
    if "```" in snippet:
        for part in snippet.split("```"):
            stripped = part.strip()
            if stripped.startswith(("json", "JSON")):
                stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
            if stripped.startswith("["):
                snippet = stripped
                break
    parsed_prompts: list[str] = []
    start, end = snippet.find("["), snippet.rfind("]")
    if start != -1 and end != -1 and end > start:
        try:
            parsed = json.loads(snippet[start : end + 1])
            if isinstance(parsed, list):
                parsed_prompts = [str(p).strip() for p in parsed if str(p).strip()]
        except json.JSONDecodeError:
            parsed_prompts = []
    out: list[str] = []
    for i in range(n):
        if i < len(parsed_prompts):
            out.append(parsed_prompts[i])
            continue
        # Per-scene grounded fallback — keeps prompt i bound to narration i
        # even when the LLM truncated mid-array.
        line = narrations[i] or ""
        if line:
            out.append(
                f"Scene {i + 1}: depict the moment described by the "
                f'narration "{line}", from the article "{headline}". {style}'
            )
        else:
            out.append(
                f"Scene {i + 1}: a story moment from the article "
                f'"{headline}". {style}'
            )
    return out


def derive_scene_narrations(
    doodle_frames: list[dict],
    captions: list[dict],
) -> list[str]:
    """For each doodle frame, return the joined caption text from
    frame[i].caption_chunk_start_index up to (frame[i+1].caption_chunk_start_index - 1).
    Last frame slices to end of captions.

    Empty list when either input is empty or shapes don't match — caller
    falls back to the legacy (article-body-only) prompt path."""
    if not doodle_frames or not captions:
        return []
    starts: list[int] = []
    for f in doodle_frames:
        if not isinstance(f, dict):
            return []
        idx = f.get("caption_chunk_start_index")
        if not isinstance(idx, int) or idx < 0:
            return []
        starts.append(idx)
    out: list[str] = []
    for i, start in enumerate(starts):
        stop = starts[i + 1] if i + 1 < len(starts) else len(captions)
        # Defensive clamp — pipeline upstream is supposed to keep these in
        # range but a half-migrated config can violate it.
        start = max(0, min(start, len(captions)))
        stop = max(start, min(stop, len(captions)))
        chunk_texts = []
        for c in captions[start:stop]:
            if isinstance(c, dict):
                text = str(c.get("text", "")).strip()
                if text:
                    chunk_texts.append(text)
        out.append(" ".join(chunk_texts))
    return out


# --- world bible (Phase 2 of 2026-06-14 plan, Option C) ----------------------
# A structured representation of a story's recurring visual entities —
# characters, sub-characters, locations, items. Scene generation pulls
# from it so every prompt restates the same visual cues verbatim, and
# `pipeline.media` generates a canonical reference image per character
# (and optionally per location) so kie's nano-banana-2 endpoint can
# condition on the same face across scenes. The shape itself lives in
# `pipeline.world_bible`; this section owns the LLM call that BUILDS the
# bible from the article body.


def build_world_bible(idea: dict, body: str, dry_run: bool) -> dict | None:
    """Single LLM call. Returns a world bible dict matching the shape
    in `pipeline.world_bible` (parsed + validated through
    `parse_world_bible` so caps and id-assignment are uniform), or
    None when the call fails to produce parseable JSON. Caller
    (`pipeline.media`) treats None as "no bible" and falls back to the
    pre-Option-C narration-only flow.

    Dry-run returns a deterministic stub with two characters, one
    location, one item so end-to-end pipeline tests run without an LLM
    key. The stub embeds the headline so tests can assert grounding
    survives.
    """
    from pipeline import llm, world_bible

    if dry_run:
        stub = {
            "characters": [
                {
                    "name": "Protagonist",
                    "role": "lead",
                    "visual_cues": (
                        f"[DRY] protagonist of \"{idea['headline'][:60]}\", "
                        "tall, dark coat"
                    ),
                },
                {
                    "name": "Antagonist",
                    "role": "supporting",
                    "visual_cues": "[DRY] antagonist, short, red scarf",
                },
            ],
            "sub_characters": [],
            "locations": [
                {
                    "name": "primary_setting",
                    "visual_cues": (
                        f"[DRY] setting from \"{idea['headline'][:60]}\""
                    ),
                },
            ],
            "items": [
                {"name": "object", "visual_cues": "[DRY] central object"},
            ],
        }
        return world_bible.parse_world_bible(stub)

    instruction = (
        "You design illustrations for LoreWire short-form videos. Read the "
        "article and return a JSON object listing the recurring visual "
        "entities a storyboard artist would need to keep consistent scene "
        "to scene. The exact shape is:\n\n"
        "{\n"
        "  \"characters\": [\n"
        "    {\"name\": \"...\", \"role\": \"lead|supporting|background\", "
        "\"visual_cues\": \"hair, build, clothing, accessories\"},\n"
        "    ...\n"
        "  ],\n"
        "  \"sub_characters\": [\n"
        "    {\"name\": \"...\", \"role\": \"background\", \"visual_cues\": \"...\"},\n"
        "    ...\n"
        "  ],\n"
        "  \"locations\": [\n"
        "    {\"name\": \"snake_case_label\", \"visual_cues\": \"era, place, vibe, lighting\"},\n"
        "    ...\n"
        "  ],\n"
        "  \"items\": [\n"
        "    {\"name\": \"snake_case_label\", \"visual_cues\": \"shape, material, distinguishing detail\"},\n"
        "    ...\n"
        "  ]\n"
        "}\n\n"
        "Rules:\n"
        f"- characters: at most {world_bible.MAX_CHARACTERS} named, recurring people. "
        "Exactly ONE has role=\"lead\".\n"
        f"- sub_characters: at most {world_bible.MAX_SUB_CHARACTERS} named background humans "
        "that appear in more than one scene. Skip nameless extras.\n"
        f"- locations: at most {world_bible.MAX_LOCATIONS} distinct settings. "
        "Use snake_case labels (open_office, dim_alley).\n"
        f"- items: at most {world_bible.MAX_ITEMS} plot-load-bearing props "
        "(the envelope, the knife). Skip scenery.\n"
        f"- Every visual_cues field: at most {world_bible.MAX_VISUAL_CUES_CHARS} chars, "
        "concrete and reusable — what a storyboard artist would draw verbatim "
        "every time the entity appears.\n"
        "- No identifiable real people; no logos.\n\n"
        "Return ONLY the JSON object, no fences, no surrounding prose.\n\n"
        f"Headline: {idea['headline']}\n\nArticle:\n{body}"
    )
    # Same model + token shape as build_character_bible: gpt-5.4-mini
    # for stability on JSON output. 3000 tokens covers a 4-char + 4-sub +
    # 3-loc + 5-item bible at ~150 tokens per entry.
    raw = llm.chat(instruction, 3000, model="openai/gpt-5.4-mini").strip()
    parsed_json = _extract_json_object(raw)
    if parsed_json is None:
        return None
    return world_bible.parse_world_bible(parsed_json)


def _extract_json_object(raw: str) -> dict | None:
    """Pull a JSON object out of the LLM's response, tolerating fenced
    code blocks, leading prose, and trailing notes. Same shape as
    `_parse_character_bible`'s extraction path but split out as a
    helper because the world-bible parse delegates JSON-to-dict
    validation to `world_bible.parse_world_bible`. Returns the raw
    parsed dict (or None) — the caller decides whether the shape is
    usable."""
    snippet = raw
    if "```" in snippet:
        for part in snippet.split("```"):
            stripped = part.strip()
            if stripped.startswith(("json", "JSON")):
                stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
            if stripped.startswith("{"):
                snippet = stripped
                break
    start, end = snippet.find("{"), snippet.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        parsed = json.loads(snippet[start : end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _format_bible_for_scene_prompt(bible: dict) -> str:
    """Render the bible into the prose block the per-scene call embeds.
    Each entity gets its id + name + visual_cues so the LLM can both
    quote the cues verbatim AND tag the scene with the right ids."""
    parts: list[str] = []

    def section(title: str, key: str) -> None:
        bucket = bible.get(key) or []
        if not bucket:
            return
        lines = [
            f"- {e['id']} ({e['name']}, {e.get('role', '?') if 'role' in e else 'entity'}): {e['visual_cues']}"
            if "role" in e
            else f"- {e['id']} ({e['name']}): {e['visual_cues']}"
            for e in bucket
            if isinstance(e, dict)
        ]
        if lines:
            parts.append(title + "\n" + "\n".join(lines))

    section("CHARACTERS", "characters")
    section("SUB-CHARACTERS", "sub_characters")
    section("LOCATIONS", "locations")
    section("ITEMS", "items")
    return "\n\n".join(parts)


def make_scene_prompts_from_bible(
    idea: dict,
    body: str,
    scene_narrations: list[str],
    bible: dict,
    dry_run: bool,
) -> list[dict]:
    """Build one image prompt per scene, tagged with the bible entity
    ids that appear on-screen for that scene. The kie scene call later
    looks the ids up in the bible to assemble the `image_input` ref
    list, so identity carries across scenes.

    Return shape: `[{"prompt": str, "entity_ids": [str, ...]}, ...]`,
    same length as `scene_narrations`. Order matches scene index.

    Dry-run returns deterministic stubs that EMBED each narration line
    so tests can assert binding survives, AND tag each scene with the
    first character's id so the refs-flowing-through test has data to
    grip.
    """
    from pipeline import llm, store, world_bible

    style = (store.get_setting("video.style") or DEFAULT_IMAGE_STYLE).strip()
    narrations = [_truncate_narration(line or "") for line in scene_narrations]
    n = len(narrations)

    if dry_run:
        first_char_id = None
        chars = bible.get("characters") or []
        if chars and isinstance(chars[0], dict):
            first_char_id = chars[0].get("id")
        return [
            {
                "prompt": (
                    f"[DRY] scene {i + 1} grounded in narration: "
                    f"\"{narrations[i][:80]}\". Style: {style}"
                ),
                "entity_ids": [first_char_id] if first_char_id else [],
            }
            for i in range(n)
        ]

    bible_block = _format_bible_for_scene_prompt(bible)
    numbered = "\n".join(
        f"Scene {i + 1}: \"{narrations[i]}\"" for i in range(n)
    )

    instruction = (
        f"You design illustrations for LoreWire shorts. Below is a world "
        f"bible of recurring entities (each with a stable id) and a list of "
        f"{n} scenes from a video. Each scene shows ONE line of narration "
        f"that plays under the image.\n\n"
        f"Return a JSON array of EXACTLY {n} objects in scene order. Each "
        f"object has TWO fields:\n"
        f"  - \"prompt\": a 1-2 sentence image prompt depicting the moment "
        f"described by THAT scene's narration line. For every bible entity "
        f"that appears in the prompt, restate its visual_cues VERBATIM "
        f"(critical for image-model consistency). Append this style note "
        f"at the end verbatim: \"{style}\". NO text in the image, no "
        f"identifiable real people, no logos.\n"
        f"  - \"entity_ids\": array of bible ids for entities visibly "
        f"on-screen in this scene. Reuse the ids exactly as listed in the "
        f"bible. Empty array if no bible entity appears (rare).\n\n"
        f"WORLD BIBLE:\n{bible_block}\n\n"
        f"Headline: {idea['headline']}\n\n"
        f"Scenes:\n{numbered}\n\n"
        f"Return ONLY the JSON array, no fences, no prose."
    )
    raw = llm.chat(instruction, 16000, model="openai/gpt-5.4-mini").strip()
    return _parse_scene_prompts_with_entities(
        raw, narrations, idea["headline"], style, bible,
    )


def _parse_scene_prompts_with_entities(
    raw: str,
    narrations: list[str],
    headline: str,
    style: str,
    bible: dict,
) -> list[dict]:
    """Parse the bible-aware scene-call response. Per-scene fallback
    pads with `{prompt: <narration-grounded text>, entity_ids: []}` so
    the binding to scene N survives a truncated LLM response. Unknown
    ids returned by the LLM get dropped against the bible's id set —
    the kie ref lookup later would silently skip them anyway, but
    dropping here keeps the persisted shape clean."""
    from pipeline import world_bible as wb

    n = len(narrations)
    known_ids = {e["id"] for e in wb.all_entities(bible)}

    snippet = raw
    if "```" in snippet:
        for part in snippet.split("```"):
            stripped = part.strip()
            if stripped.startswith(("json", "JSON")):
                stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
            if stripped.startswith("["):
                snippet = stripped
                break
    parsed_arr: list = []
    start, end = snippet.find("["), snippet.rfind("]")
    if start != -1 and end != -1 and end > start:
        try:
            candidate = json.loads(snippet[start : end + 1])
            if isinstance(candidate, list):
                parsed_arr = candidate
        except json.JSONDecodeError:
            parsed_arr = []

    out: list[dict] = []
    for i in range(n):
        entry = parsed_arr[i] if i < len(parsed_arr) and isinstance(parsed_arr[i], dict) else None
        if entry is not None:
            prompt_text = str(entry.get("prompt", "")).strip()
            raw_ids = entry.get("entity_ids")
            if isinstance(raw_ids, list):
                cleaned_ids = [
                    str(x) for x in raw_ids
                    if isinstance(x, str) and x in known_ids
                ]
            else:
                cleaned_ids = []
            if prompt_text:
                out.append({"prompt": prompt_text, "entity_ids": cleaned_ids})
                continue
        # Per-scene grounded fallback. Same pattern as
        # `_parse_grounded_prompts` — keeps prompt N bound to narration N.
        line = narrations[i] or ""
        if line:
            out.append({
                "prompt": (
                    f"Scene {i + 1}: depict the moment described by the "
                    f'narration "{line}", from the article "{headline}". {style}'
                ),
                "entity_ids": [],
            })
        else:
            out.append({
                "prompt": (
                    f"Scene {i + 1}: a story moment from the article "
                    f'"{headline}". {style}'
                ),
                "entity_ids": [],
            })
    return out
