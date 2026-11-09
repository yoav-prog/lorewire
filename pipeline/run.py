"""Run the LoreWire content pipeline.

Dry run (no keys, offline, stub transforms on a fixture):
    python -m pipeline.run --dry-run
    python -m pipeline.run --dry-run --media         # exercise media wiring too

Real clean-room generation from the fixture post (needs an LLM key in .env):
    python -m pipeline.run --fixture
    python -m pipeline.run --fixture --media         # + real images + voice
    python -m pipeline.run --fixture --media --video # + render the doodle MP4

Production stories come from the reddit_source queue (pipeline.story_jobs_worker).
"""
from __future__ import annotations

import argparse
import datetime
import json
from pathlib import Path

from pipeline import clean_room, llm, media, stages, store, video

REPO_ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    ap = argparse.ArgumentParser(description="LoreWire content pipeline")
    ap.add_argument("--dry-run", action="store_true", help="offline, stub transforms, no keys")
    ap.add_argument("--fixture", action="store_true", help="fixture input but REAL LLM rewrite (needs an LLM key)")
    ap.add_argument("--limit", type=int, default=3)
    ap.add_argument(
        "--media",
        action="store_true",
        help="also generate images + narration (kie.ai + voice provider). Costs real money.",
    )
    ap.add_argument(
        "--video",
        action="store_true",
        help="render the doodle short MP4 via Remotion. Requires --media in the same run.",
    )
    args = ap.parse_args()
    if not (args.dry_run or args.fixture):
        ap.error("choose --dry-run or --fixture")
    if args.video and not args.media:
        ap.error("--video requires --media in the same run (no rerender flag yet)")

    dry = args.dry_run
    mode = "DRY RUN (stub)" if dry else "FIXTURE + real LLM"
    media_note = " + MEDIA" if args.media else ""
    print(f"LoreWire pipeline: {mode}{media_note}")

    store.init()
    posts = stages.load_fixture_posts(args.limit)

    processed = 0
    for post in posts:
        before = llm.totals["total_tokens"]
        story_id = store.story_id_for_reddit_source(post["id"]) or store.new_story_id()
        clean = clean_room.generate(post, story_id, dry)
        idea, body = clean.idea, clean.body
        branded_title, branded_syn = clean.title, clean.synopsis
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        row = {
            "id": story_id,
            "reddit_id": post["id"],
            "slug": story_id,
            "category": idea["category"],
            "title": branded_title or idea["headline"],
            "summary": branded_syn or body[:160],
            "body": body,
            # Fresh articles land in the review queue, not live.
            "status": "draft" if dry else "review",
            "source_url": "",
            "content_origin": store.CONTENT_ORIGIN_ORIGINAL,
            "compliance_status": clean.report["status"],
            "tokens": llm.totals["total_tokens"] - before,
            "created_at": now,
            "updated_at": now,
            "payload": {"idea": idea},
        }
        if args.media:
            media_cols = media.generate_media(
                idea["reddit_id"], idea, body, branded_title or idea["headline"],
                dry, repo_root=REPO_ROOT,
            )
            row.update(media_cols)
            # Token spend from this story includes the image-prompt LLM call.
            row["tokens"] = llm.totals["total_tokens"] - before
            if args.video and not dry:
                # Pull the just-written image URLs + alignment back out of the
                # row, in the same shape the video stage expects (the columns
                # were serialized to JSON for storage; deserialize here).
                hero = row.get("hero_image")
                scenes_raw = row.get("images") or "[]"
                try:
                    scenes = json.loads(scenes_raw) if isinstance(scenes_raw, str) else scenes_raw
                except json.JSONDecodeError:
                    scenes = []
                image_urls = ([hero] if hero else []) + list(scenes)
                alignment_raw = row.get("alignment") or "[]"
                try:
                    alignment = json.loads(alignment_raw) if isinstance(alignment_raw, str) else alignment_raw
                except json.JSONDecodeError:
                    alignment = []
                props_raw = row.get("props") or "[]"
                try:
                    props_list = json.loads(props_raw) if isinstance(props_raw, str) else props_raw
                except json.JSONDecodeError:
                    props_list = []
                video_cols = video.generate_video(
                    idea["reddit_id"],
                    idea["headline"],
                    image_urls,
                    row.get("audio_url") or "",
                    alignment,
                    repo_root=REPO_ROOT,
                    category=idea.get("category"),
                    props_list=props_list,
                    character_image_mouth_removed=row.get("character_image_mouth_removed"),
                    story_row=row,
                )
                row.update(video_cols)
        store.upsert_story(row)
        store.save_story_source(
            story_id=story_id,
            source_kind="reddit",
            source_ref=post["id"],
            source_title=post.get("title", ""),
            source_text=post.get("selftext", ""),
            source_url=post.get("url", ""),
            premise=clean.premise["premise"],
            compliance_report=clean.report,
        )
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
