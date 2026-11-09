"""Clean-room story generation (CONTENT_POLICY.md).

The source goes to exactly one LLM step, premise extraction. Everything after it
works from the premise alone. A rewrite after a failed check is blind: the writer
is never told which phrase or name matched, because that would hand it source text.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from pipeline import compliance, stages

ProgressFn = Callable[[str, str, dict], None]


@dataclass(frozen=True)
class CleanRoomStory:
    idea: dict
    premise: dict
    body: str
    title: str
    synopsis: str
    report: dict
    attempts: int


def _noop_progress(_event: str, _message: str, _payload: dict) -> None:
    return None


def _source_kwargs(post: dict) -> dict:
    return {"source_title": post.get("title", ""), "source_url": post.get("url", "")}


def generate(
    post: dict,
    story_id: str,
    dry_run: bool,
    on_progress: ProgressFn = _noop_progress,
) -> CleanRoomStory:
    """Premise, then up to N blind writes, then the full check on the final text.

    A story still failing after the last attempt is returned with a failing
    report so the caller can hold it for review.
    """
    premise = stages.extract_premise(post, dry_run)
    idea = stages.make_idea(story_id, premise)
    on_progress("premise_done", "Extracted premise", {"category": idea["category"]})

    source_text = post.get("selftext", "")
    max_attempts = compliance.CONFIG.max_write_attempts
    attempts = 0
    body, title, synopsis = "", "", ""
    for attempts in range(1, max_attempts + 1):
        body = stages.write_article(premise, dry_run)
        title, synopsis = stages.make_title_and_synopsis(idea, body, dry_run)
        findings = compliance.check_deterministic(
            {"title": title, "summary": synopsis, "body": body},
            source_text,
            **_source_kwargs(post),
        )
        on_progress(
            "write_attempt",
            f"Attempt {attempts}: {len(findings)} blocking finding(s)",
            {"attempt": attempts, "checks": sorted({f["check"] for f in findings})},
        )
        if not findings:
            break

    idea["headline"] = title
    report = compliance.check_compliance(
        {"title": title, "summary": synopsis, "body": body},
        source_text,
        embed=None if dry_run else compliance.llm_embed,
        judge=None if dry_run else compliance.llm_judge,
        **_source_kwargs(post),
    )
    return CleanRoomStory(idea, premise, body, title, synopsis, report, attempts)
