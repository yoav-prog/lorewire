"""Pipeline stages.

Each stage runs offline in dry-run mode (deterministic transforms on bundled
fixtures). The real implementations call external services and are gated on
env keys; they are intentionally left as clearly-marked NotImplementedError
seams to be ported from the reference scripts in /from-amir once keys are
rotated and set.
"""
from __future__ import annotations

import json
from pathlib import Path

from pipeline import config

FIXTURES = Path(__file__).resolve().parent / "fixtures"

# Anti-fabrication rule, condensed from from-amir/reaearchreddit.txt. This is
# the load-bearing instruction that keeps stories grounded in the real post.
RESEARCH_RULES = (
    "Use ONLY the provided post. Invent nothing: no facts, names, numbers, or "
    "outcomes that are not in the source. Keep quotes exact. If a detail is "
    "missing, say so rather than filling the gap."
)


def scrape(subreddit: str, limit: int, dry_run: bool) -> list[dict]:
    if dry_run:
        posts = json.loads((FIXTURES / "sample_post.json").read_text(encoding="utf-8"))
        return posts[:limit]
    miss = config.missing("scrape")
    if miss:
        raise RuntimeError(f"scrape requires env {miss}; rotate and set them in .env")
    raise NotImplementedError(
        "Real scrape: port from from-amir/redditscraperformsn.py (Decodo proxy) using DECODO_TOKEN."
    )


def make_idea(post: dict, dry_run: bool) -> dict:
    # Deterministic in dry-run; an LLM proposes the headline/angle in a real run.
    return {
        "reddit_id": post["id"],
        "category": post.get("category", "Entitled"),
        "headline": post["title"],
        "angle": "Retell as an original article in LoreWire's voice.",
    }


def research(idea: dict, post: dict, dry_run: bool) -> dict:
    if dry_run:
        return {
            "rules": RESEARCH_RULES,
            "beats": [post.get("selftext", "")[:400]],
            "quotes": [],
            "source": post.get("url", ""),
        }
    _require_llm()
    raise NotImplementedError(
        "Real research: port from from-amir/reaearchreddit.txt — LLM call with RESEARCH_RULES over the post."
    )


def write_article(idea: dict, research: dict, dry_run: bool) -> str:
    if dry_run:
        return (
            "[DRY RUN ARTICLE]\n\n"
            f"{idea['headline']}\n\n"
            f"{research['beats'][0]}\n\n"
            "(In a real run the LLM rewrites this into an original article, "
            "and later stages generate the doodle video and narration.)"
        )
    _require_llm()
    raise NotImplementedError(
        "Real article writer: port from from-amir/listscreator.txt and storycreator.txt."
    )


def _require_llm() -> None:
    miss = config.missing("llm")
    if miss:
        raise RuntimeError(f"LLM stage requires env {miss}; rotate and set them in .env")
