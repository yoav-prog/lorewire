"""Run the LoreWire content pipeline.

Dry run (no keys, offline, uses fixtures):
    python -m pipeline.run --dry-run

Real run (needs rotated keys set in the environment):
    python -m pipeline.run --subreddit AmItheAsshole --limit 5
"""
from __future__ import annotations

import argparse
import time

from pipeline import stages, store


def main() -> None:
    ap = argparse.ArgumentParser(description="LoreWire content pipeline")
    ap.add_argument("--dry-run", action="store_true", help="run offline on fixtures, no keys")
    ap.add_argument("--subreddit", default="AmItheAsshole")
    ap.add_argument("--limit", type=int, default=3)
    args = ap.parse_args()

    mode = "DRY RUN (fixtures, no external calls)" if args.dry_run else "REAL RUN"
    print(f"LoreWire pipeline: {mode}")

    store.init()
    posts = stages.scrape(args.subreddit, args.limit, args.dry_run)

    processed = 0
    for post in posts:
        idea = stages.make_idea(post, args.dry_run)
        research = stages.research(idea, post, args.dry_run)
        body = stages.write_article(idea, research, args.dry_run)
        store.upsert_story(
            {
                "id": idea["reddit_id"],
                "reddit_id": idea["reddit_id"],
                "category": idea["category"],
                "title": idea["headline"],
                "summary": post.get("selftext", "")[:160],
                "body": body,
                "status": "dry-run" if args.dry_run else "scripted",
                "source_url": post.get("url", ""),
                "created_at": time.time(),
                "payload": {"idea": idea, "research": research},
            }
        )
        processed += 1

    rows = store.all_stories()
    print(f"\nProcessed {processed} post(s). Stories in DB: {len(rows)}")
    for r in rows[:10]:
        print(f"  [{r['status']}] {r['category']}: {r['title']}")


if __name__ == "__main__":
    main()
