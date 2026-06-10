"""Run the LoreWire content pipeline.

Dry run (no keys, offline, stub transforms on a fixture):
    python -m pipeline.run --dry-run
    python -m pipeline.run --dry-run --media         # exercise media wiring too

Real rewrite of the fixture post (needs an LLM key in .env, no scrape):
    python -m pipeline.run --fixture
    python -m pipeline.run --fixture --media         # + real images + voice

Full real run (needs scrape + LLM keys):
    python -m pipeline.run --subreddit AmItheAsshole --limit 5
    python -m pipeline.run --subreddit AmItheAsshole --limit 1 --media
"""
from __future__ import annotations

import argparse
import datetime
from pathlib import Path

from pipeline import llm, media, stages, store

REPO_ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    ap = argparse.ArgumentParser(description="LoreWire content pipeline")
    ap.add_argument("--dry-run", action="store_true", help="offline, stub transforms, no keys")
    ap.add_argument("--fixture", action="store_true", help="fixture input but REAL LLM rewrite (needs an LLM key)")
    ap.add_argument("--subreddit", default="AmItheAsshole")
    ap.add_argument("--limit", type=int, default=3)
    ap.add_argument(
        "--media",
        action="store_true",
        help="also generate images + narration (kie.ai + voice provider). Costs real money.",
    )
    args = ap.parse_args()

    dry = args.dry_run
    use_fixture = args.dry_run or args.fixture
    mode = "DRY RUN (stub)" if dry else ("FIXTURE + real LLM" if args.fixture else "REAL RUN")
    media_note = " + MEDIA" if args.media else ""
    print(f"LoreWire pipeline: {mode}{media_note}")

    store.init()
    posts = stages.scrape(args.subreddit, args.limit, use_fixture)

    processed = 0
    for post in posts:
        before = llm.totals["total_tokens"]
        idea = stages.make_idea(post, dry)
        research = stages.research(idea, post, dry)
        body = stages.write_article(idea, research, dry)
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        row = {
            "id": idea["reddit_id"],
            "reddit_id": idea["reddit_id"],
            "slug": idea["reddit_id"],
            "category": idea["category"],
            "title": idea["headline"],
            "summary": post.get("selftext", "")[:160],
            "body": body,
            # Fresh articles land in the review queue, not live.
            "status": "draft" if dry else "review",
            "source_url": post.get("url", ""),
            "tokens": llm.totals["total_tokens"] - before,
            "created_at": now,
            "updated_at": now,
            "payload": {"idea": idea, "research": research},
        }
        if args.media:
            media_cols = media.generate_media(
                idea["reddit_id"], idea, body, dry, repo_root=REPO_ROOT
            )
            row.update(media_cols)
            # Token spend from this story includes the image-prompt LLM call.
            row["tokens"] = llm.totals["total_tokens"] - before
        store.upsert_story(row)
        processed += 1
        if not dry:
            print(f"\n--- {idea['headline']} ---\n{body}\n")

    rows = store.all_stories()
    print(f"Processed {processed} post(s). Stories in DB: {len(rows)}")
    for r in rows[:10]:
        print(f"  [{r['status']}] {r['category']}: {r['title']}")
    if not dry and llm.totals["calls"]:
        t = llm.totals
        print(
            f"\nLLM usage: {t['calls']} calls, {t['prompt_tokens']} in + "
            f"{t['completion_tokens']} out = {t['total_tokens']} tokens"
        )
    if args.media and not dry:
        from pipeline import images, voice
        print(
            f"Media usage: {images.totals['images']} images, "
            f"google_tts={voice.totals['google_tts_characters']} chars, "
            f"elevenlabs={voice.totals['elevenlabs_characters']} chars, "
            f"google_stt={voice.totals['google_stt_seconds']:.1f}s"
        )


if __name__ == "__main__":
    main()
