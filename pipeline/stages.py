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
