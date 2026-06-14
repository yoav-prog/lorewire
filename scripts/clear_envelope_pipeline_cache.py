"""One-shot: NULL stories.pipeline_cache for the envelope story.

Run with:
    python scripts/clear_envelope_pipeline_cache.py

Why: the cached scene_prompts (marker world_bible_v1) were built when
doodle_frames was in its broken state. Clearing them forces the next
"Regenerate all images" click to rebuild against the now-monotonic ci
array, so the world_bible / grounded path can bind each scene's prompt
to the correct narration line.

Safe to delete this file after running.
"""
from __future__ import annotations

import os
import sys

from dotenv import load_dotenv

load_dotenv(".env.local")
import psycopg

STORY_ID = "envelope"


def main() -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL not set; aborting", file=sys.stderr)
        return 1
    with psycopg.connect(url) as con:
        with con.cursor() as cur:
            cur.execute(
                "UPDATE stories SET pipeline_cache = NULL, updated_at = NOW() "
                "WHERE id = %s",
                (STORY_ID,),
            )
            print(f"rows updated: {cur.rowcount}")
        con.commit()
    print(f"pipeline_cache cleared for story {STORY_ID!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
