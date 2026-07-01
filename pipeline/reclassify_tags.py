"""Retire-Drama reclassification into the multi-tag taxonomy.

PR3 of _plans/2026-07-01-category-taxonomy-multitag.md. The pure
`build_reclassification_report` classifies every story and aggregates a
coverage report WITHOUT writing, so the admin can review what the run WOULD
do — and whether the 17 categories cover the corpus — before a single row
changes. `run` is the thin IO wrapper: it reads the active categories +
stories from the store, feeds the classifier, and prints the report.

Writing story_tags (the APPLY step) is deliberately gated: `run(dry_run=False)`
raises until the dry-run report has been reviewed and the apply is enabled in
a follow-up. The reclassification is reversible regardless — it only ever
writes story_tags, and stories.category is left untouched as the anchor the
old tags can be rebuilt from.

Run the dry-run:  python -m pipeline.reclassify_tags
"""
from __future__ import annotations

from typing import Callable

# A story whose best tag is below this lands in the review queue instead of
# being auto-assigned. Tunable; surfaced in the report so the admin sees how
# many stories it affects.
DEFAULT_CONFIDENCE_FLOOR = 0.6


def _bucket(confidence: float) -> str:
    if confidence >= 0.8:
        return ">=0.8"
    if confidence >= 0.6:
        return "0.6-0.8"
    return "<0.6"


def build_reclassification_report(
    stories: list[dict],
    categories: list[dict],
    classify_fn: Callable[[str, str, list[dict]], list[dict]],
    *,
    confidence_floor: float = DEFAULT_CONFIDENCE_FLOOR,
) -> dict:
    """Classify each story and aggregate a report without writing.

    ``stories``: [{id, title, body, category}]. ``categories``: the active set
    [{slug, label, description}]. ``classify_fn(title, body, categories)``
    returns [{slug, confidence}] most-confident first (the caller passes
    ``stages.classify_story_tags`` or a stub).

    A story lands in the review queue when the classifier returns nothing OR
    the primary's confidence is below ``confidence_floor`` — those are NOT
    auto-assigned, they are surfaced for a human (who confirms, re-tags, or
    adds a new category). The report is the artifact the admin approves before
    any write, and its coverage numbers double as a taxonomy-fit check.
    """
    primary_counts: dict[str, int] = {}
    tag_counts: dict[str, int] = {}
    buckets = {">=0.8": 0, "0.6-0.8": 0, "<0.6": 0}
    review_queue: list[dict] = []
    proposals: list[dict] = []

    for s in stories:
        tags = classify_fn(s.get("title") or "", s.get("body") or "", categories)
        primary = tags[0] if tags else None
        primary_conf = float(primary["confidence"]) if primary else 0.0
        needs_review = (not tags) or (primary_conf < confidence_floor)

        proposal = {
            "id": s.get("id"),
            "title": s.get("title"),
            "old_category": s.get("category"),
            "tags": tags,
            "primary": primary["slug"] if primary else None,
            "primary_confidence": primary_conf,
            "needs_review": needs_review,
        }
        proposals.append(proposal)

        if needs_review:
            review_queue.append(proposal)
            continue

        buckets[_bucket(primary_conf)] += 1
        for t in tags:
            tag_counts[t["slug"]] = tag_counts.get(t["slug"], 0) + 1
        primary_counts[primary["slug"]] = primary_counts.get(primary["slug"], 0) + 1

    return {
        "total": len(stories),
        "auto_tagged": len(stories) - len(review_queue),
        "review_queue": len(review_queue),
        "primary_counts": primary_counts,
        "tag_counts": tag_counts,
        "confidence_buckets": buckets,
        "proposals": proposals,
        "confidence_floor": confidence_floor,
    }


def _print_summary(report: dict, *, dry_run: bool) -> None:
    mode = "DRY RUN (no writes)" if dry_run else "APPLY"
    print(
        f"[reclassify] {mode}: {report['total']} stories, "
        f"{report['auto_tagged']} auto-tagged, "
        f"{report['review_queue']} to review (floor {report['confidence_floor']})"
    )
    print(f"[reclassify] confidence: {report['confidence_buckets']}")
    print("[reclassify] primary category coverage:")
    top = sorted(report["primary_counts"].items(), key=lambda kv: kv[1], reverse=True)
    for slug, n in top:
        print(f"    {slug}: {n}")
    if not report["primary_counts"]:
        print("    (none — check the classifier / active categories)")


def run(
    *,
    dry_run: bool = True,
    confidence_floor: float = DEFAULT_CONFIDENCE_FLOOR,
    limit: int | None = None,
) -> dict:
    """Read the active categories + stories from the store, classify, and
    return the coverage report. ``dry_run=True`` (the default) writes NOTHING.

    Applying the tags (``dry_run=False``) is gated behind the report review —
    it raises until the apply step is deliberately enabled in a follow-up.
    """
    from pipeline import stages, store

    categories = store.active_categories()
    stories = store.stories_for_reclassify()
    if limit is not None:
        stories = stories[:limit]

    def classify(title: str, body: str, cats: list[dict]) -> list[dict]:
        return stages.classify_story_tags(title, body, cats)

    report = build_reclassification_report(
        stories, categories, classify, confidence_floor=confidence_floor
    )
    _print_summary(report, dry_run=dry_run)
    if not dry_run:
        raise NotImplementedError(
            "Applying tags is gated: review the dry-run report first. The apply "
            "step (writing story_tags) is enabled in a follow-up once approved."
        )
    return report


if __name__ == "__main__":
    run(dry_run=True)
