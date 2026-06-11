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
    title: str, category: str, body: str, aspect_ratio: str, dry_run: bool
) -> str:
    """Build a cinematic title-baked thumbnail prompt for hero / poster art.

    Each prompt names the scene briefly (from the article's opening lines),
    appends the category's visual identity, and instructs the image model to
    render the title prominently inside the composition (gpt-image-2 handles
    short bold text well; longer titles wrap or get abbreviated). Two aspect
    ratios are supported: '3:4' for portrait posters / mobile billboards, and
    '16:9' for desktop hero strips.
    """
    style = CATEGORY_THUMBNAIL_STYLES.get(category, CATEGORY_THUMBNAIL_STYLES["Drama"])
    orientation = (
        "Vertical streaming-thumbnail composition, character focal point "
        "centered, title baked into the upper or lower band"
        if aspect_ratio == "3:4"
        else "Wide cinematic banner composition, character focal point off-center "
        "to leave room for the title, title baked into the lower-third band"
    )
    if dry_run:
        return f"[DRY] {title} cinematic {category} thumbnail at {aspect_ratio}"

    # Take just the first couple of sentences of the article as the scene cue
    # so the model gets context without re-rendering the whole body each call.
    opening = " ".join(body.split()[:60])
    return (
        f"Cinematic editorial poster for a short documentary titled \"{title}\". "
        f"{style} "
        f"Composition focused on this scene from the story: {opening} "
        f"Render the title \"{title}\" prominently in bold confident "
        f"typography, integrated into the composition (not floating on a "
        f"separate layer). {orientation}. High-resolution magazine-cover "
        f"finish. No watermarks, no signatures, no extra text beyond the title."
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
    raw = llm.chat(instruction, 4000, model="openai/gpt-5.4-mini").strip()
    prompts = _parse_prompt_list(raw, n, idea["headline"], style)
    return prompts


def _parse_prompt_list(raw: str, n: int, headline: str, style: str) -> list[str]:
    """Best-effort JSON parse of the LLM's prompt list, with a safe fallback.

    Handles the common LLM cases: pure JSON array, fenced code block, or a
    leading paragraph followed by the array. Falls back to a single-hero list
    padded with generic scene prompts if nothing parses.
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
                    return prompts[:n] if len(prompts) >= n else prompts
        except json.JSONDecodeError:
            pass

    fallback = [f"Hero illustration capturing the moment of: {headline}. {style}"]
    for i in range(1, n):
        fallback.append(f"Scene {i} from the story above. {style}")
    return fallback
