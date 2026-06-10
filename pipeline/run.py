"""Run the LoreWire content pipeline.

Dry run (no keys, offline, stub transforms on a fixture):
    python -m pipeline.run --dry-run

Real rewrite of the fixture post (needs an LLM key in pipeline/.env, no scrape):
    python -m pipeline.run --fixture

Full real run (needs scrape + LLM keys):
    python -m pipeline.run --subreddit AmItheAsshole --limit 5
"""
from __future__ import annotations

import argparse
import time

from pipeline import stages, store


def main() -> None:
    ap = argparse.ArgumentParser(description="LoreWire content pipeline")
    ap.add_argument("--dry-run", action="store_true", help="offline, stub transforms, no keys")
    ap.add_argument("--fixture", action="store_true", help="fixture input but REAL LLM rewrite (needs an LLM key)")
    ap.add_argument("--subreddit", default="AmItheAsshole")
    ap.add_argument("--limit", type=int, default=3)
    args = ap.parse_args()

    dry = args.dry_run
    use_fixture = args.dry_run or args.fixture
    mode = "DRY RUN (stub)" if dry else ("FIXTURE + real LLM" if args.fixture else "REAL RUN")
    print(f"LoreWire pipeline: {mode}")

    store.init()
    posts = stages.scrape(args.subreddit, args.limit, use_fixture)

    processed = 0
    for post in posts:
        idea = stages.make_idea(post, dry)
        research = stages.research(idea, post, dry)
        body = stages.write_article(idea, research, dry)
        store.upsert_story(
            {
                "id": idea["reddit_id"],
                "reddit_id": idea["reddit_id"],
                "category": idea["category"],
                "title": idea["headline"],
                "summary": post.get("selftext", "")[:160],
                "body": body,
                "status": "dry-run" if dry else "scripted",
                "source_url": post.get("url", ""),
                "created_at": time.time(),
                "payload": {"idea": idea, "research": research},
            }
        )
        processed += 1
        if not dry:
            print(f"\n--- {idea['headline']} ---\n{body[:600]}\n")

    rows = store.all_stories()
    print(f"Processed {processed} post(s). Stories in DB: {len(rows)}")
    for r in rows[:10]:
        print(f"  [{r['status']}] {r['category']}: {r['title']}")


if __name__ == "__main__":
    main()
