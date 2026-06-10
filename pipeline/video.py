"""Render a doodle short for a story.

Reads the columns 3.1 populated (`hero_image`, `images`, `audio_url`,
`alignment`), assembles them into the props shape `video/src/Root.tsx`
expects, and shells out to `npx remotion render`. The MP4 lands under
`lorewire-app/public/generated/<id>/video.mp4`, the same public/ tree the
other media writes to, and the public URL goes back to the DB as `video_url`.

The composition is `video/src/DoodleShort.tsx`, ported from yt-studio's
DoodleShortVideo (see _plans/2026-06-10-video-stage.md).
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
from pathlib import Path

from pipeline import media

VIDEO_PROJECT_RELATIVE = Path("video")
ENTRY_POINT = "src/Root.tsx"
COMPOSITION_ID = "DoodleShort"
# Remotion bundles the project's `public/` directory and serves assets through
# its `staticFile()` API. The pipeline copies each story's media into
# `video/public/<id>/` before render so the composition can resolve them via
# `staticFile('<id>/hero.png')`. file:// URIs don't work because Remotion's
# asset download pipeline rejects that scheme (verified in QA on 2026-06-10).
STATIC_DIR_RELATIVE = Path("public")

# Caption chunking thresholds — these are the same numbers yt-studio's chunker
# converged on after watching real Shorts: chunks longer than 4 words feel like
# reading; pauses over 400ms read as a sentence break; punctuation forces a cut
# even mid-phrase so the karaoke matches the cadence of the narration.
MAX_WORDS_PER_CHUNK = 4
PAUSE_BREAK_MS = 400
PUNCTUATION_BREAK_RE = re.compile(r"[.!?,;:]$")


def generate_video(
    story_id: str,
    title: str,
    image_urls: list[str],
    audio_url: str,
    alignment: list[dict],
    repo_root: Path,
) -> dict:
    """Render the doodle short and return DB columns for the story row.

    Returns `{"video_url": "/generated/<id>/video.mp4"}` on success; an empty
    dict on a clean failure (logged). The caller merges into upsert_story.
    """
    safe_id = media._sanitize_id(story_id)
    print(f"[video id={safe_id}] start")

    if not alignment:
        print(f"[video id={safe_id}] no alignment available; skipping render")
        return {}
    if not image_urls:
        print(f"[video id={safe_id}] no images available; skipping render")
        return {}
    if not audio_url:
        print(f"[video id={safe_id}] no audio_url available; skipping render")
        return {}

    captions = _chunk_alignment(alignment)
    if not captions:
        print(f"[video id={safe_id}] alignment produced no caption chunks; skipping")
        return {}

    duration_ms = max(int(captions[-1]["end_ms"]), 1)
    video_project = repo_root / VIDEO_PROJECT_RELATIVE
    static_paths = _stage_assets(repo_root, video_project, safe_id, audio_url, image_urls)
    static_audio = static_paths["audio"]
    static_images = static_paths["images"]
    doodle_frames = _distribute_frames(static_images, captions, duration_ms)

    config = {
        "voiceover_url": static_audio,
        "title": _truncate_title(title),
        "channel_name": "lorewire",
        "duration_ms": duration_ms,
        "doodle_frames": doodle_frames,
        "captions": captions,
    }

    props_dir = video_project / ".props"
    props_dir.mkdir(parents=True, exist_ok=True)
    props_path = props_dir / f"{safe_id}.json"
    props_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    print(
        f"[video id={safe_id} props] wrote {props_path.name} "
        f"({len(captions)} caption chunks, {len(doodle_frames)} frames, "
        f"{duration_ms / 1000:.1f}s)"
    )

    out_dir = repo_root / media.PUBLIC_DIR_RELATIVE / safe_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_mp4 = out_dir / "video.mp4"

    cmd = [
        "npx",
        "remotion",
        "render",
        ENTRY_POINT,
        COMPOSITION_ID,
        str(out_mp4),
        f"--props={props_path}",
    ]
    print(f"[video id={safe_id} render] launching {' '.join(cmd[:5])} -> {out_mp4.name}")
    started = time.time()
    try:
        # shell=True on Windows so PATHEXT finds `npx.cmd` without a manual
        # extension. encoding/errors pinned: Remotion writes ANSI color codes
        # and the occasional non-ASCII glyph to stderr, and the host's default
        # codec on some Windows installs (e.g. cp1255 on a Hebrew locale)
        # crashes the stderr reader thread before the process returncode lands.
        result = subprocess.run(
            cmd,
            cwd=video_project,
            check=False,
            capture_output=True,
            text=True,
            shell=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError as e:
        print(f"[video id={safe_id} render] npx not on PATH: {e}")
        return {}

    elapsed = time.time() - started
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").splitlines()[-12:]
        print(f"[video id={safe_id} render] FAILED in {elapsed:.1f}s")
        for line in tail:
            print(f"  remotion: {line}")
        return {}

    size_mb = out_mp4.stat().st_size / (1024 * 1024) if out_mp4.exists() else 0.0
    print(
        f"[video id={safe_id} render] done in {elapsed:.1f}s "
        f"({size_mb:.1f} MB at {out_mp4})"
    )
    return {"video_url": f"{media.PUBLIC_URL_PREFIX}/{safe_id}/video.mp4"}


# --- pure helpers (covered by pipeline/tests/test_video.py) -------------------

def _chunk_alignment(words: list[dict]) -> list[dict]:
    """Group word timings into 2-4 word caption chunks.

    Breaks on: 4-word cap, pause >= PAUSE_BREAK_MS, trailing punctuation. Each
    chunk carries the word list with start/end times in ms (the karaoke
    highlight uses the per-word boundaries).
    """
    if not words:
        return []
    chunks: list[dict] = []
    current: list[dict] = []
    prev_end_ms: float | None = None
    for w in words:
        token = (w.get("word") or "").strip()
        if not token:
            continue
        start_ms = float(w.get("start", 0.0)) * 1000.0
        end_ms = float(w.get("end", start_ms)) * 1000.0
        pause = start_ms - prev_end_ms if prev_end_ms is not None else 0.0
        if current and (len(current) >= MAX_WORDS_PER_CHUNK or pause >= PAUSE_BREAK_MS):
            chunks.append(_finalize_chunk(current))
            current = []
        current.append({"word": token, "start_ms": start_ms, "end_ms": end_ms})
        prev_end_ms = end_ms
        if PUNCTUATION_BREAK_RE.search(token) and current:
            chunks.append(_finalize_chunk(current))
            current = []
            prev_end_ms = end_ms
    if current:
        chunks.append(_finalize_chunk(current))
    return chunks


def _finalize_chunk(words: list[dict]) -> dict:
    text = " ".join(w["word"] for w in words)
    return {
        "start_ms": int(round(words[0]["start_ms"])),
        "end_ms": int(round(words[-1]["end_ms"])),
        "text": text,
        "words": [
            {
                "word": w["word"],
                "start_ms": int(round(w["start_ms"])),
                "end_ms": int(round(w["end_ms"])),
            }
            for w in words
        ],
    }


def _distribute_frames(
    image_urls: list[str], captions: list[dict], duration_ms: int
) -> list[dict]:
    """Distribute frames across the audio, snapped to caption boundaries.

    Hero (index 0) holds for the first ~20% of the duration; scenes split the
    rest evenly. Each frame's start is snapped to the closest caption chunk's
    start so cuts land on phrase breaks. With more frames than chunks, each
    extra frame falls on its own chunk; with no chunks the frames stack at 0.
    """
    if not image_urls or not captions:
        return [{"url": u, "caption_chunk_start_index": 0} for u in image_urls]

    n = len(image_urls)
    if n == 1:
        return [{"url": image_urls[0], "caption_chunk_start_index": 0}]

    hero_share_ms = duration_ms * 0.20
    scene_count = n - 1
    scene_share_ms = (duration_ms - hero_share_ms) / scene_count

    target_starts_ms: list[float] = [0.0]
    for i in range(1, n):
        target_starts_ms.append(hero_share_ms + (i - 1) * scene_share_ms)

    chunk_starts = [float(c["start_ms"]) for c in captions]
    used_indexes: set[int] = set()
    frames: list[dict] = []
    for i, target in enumerate(target_starts_ms):
        idx = _nearest_chunk_index(chunk_starts, target, used_indexes)
        used_indexes.add(idx)
        frames.append({"url": image_urls[i], "caption_chunk_start_index": idx})

    # Sequence windows in the composition assume frames are in start order.
    frames.sort(key=lambda f: f["caption_chunk_start_index"])
    return frames


def _nearest_chunk_index(
    chunk_starts: list[float], target_ms: float, used: set[int]
) -> int:
    """Return the index of the chunk whose start_ms is closest to `target_ms`
    and isn't already taken. Falls back to the closest if every chunk is used."""
    best_idx = 0
    best_dist = float("inf")
    for i, s in enumerate(chunk_starts):
        if i in used:
            continue
        dist = abs(s - target_ms)
        if dist < best_dist:
            best_dist = dist
            best_idx = i
    if best_dist == float("inf"):
        # Every chunk is used; just pick the closest regardless of used set.
        for i, s in enumerate(chunk_starts):
            dist = abs(s - target_ms)
            if dist < best_dist:
                best_dist = dist
                best_idx = i
    return best_idx


def _truncate_title(title: str, max_chars: int = 70) -> str:
    """Keep the title chip on one visual line. yt-studio's chip wraps but reads
    cluttered past ~70 chars at the doodle size."""
    title = (title or "").strip()
    if len(title) <= max_chars:
        return title
    return title[: max_chars - 1].rstrip() + "..."


def _public_url_to_filesystem_path(repo_root: Path, public_url: str) -> Path:
    """Resolve the on-disk path that backs a /generated/... public URL."""
    relative = public_url.lstrip("/")
    return (repo_root / media.PUBLIC_DIR_RELATIVE.parent / relative).resolve()


def _stage_assets(
    repo_root: Path,
    video_project: Path,
    safe_id: str,
    audio_url: str,
    image_urls: list[str],
) -> dict:
    """Copy the story's media into video/public/<id>/ for Remotion's staticFile().

    Returns the URL-style relative paths the composition resolves through
    `staticFile()` (forward slashes, no leading slash). Overwrites prior runs
    of the same id so re-rendering is deterministic.
    """
    static_dir = video_project / STATIC_DIR_RELATIVE / safe_id
    if static_dir.exists():
        shutil.rmtree(static_dir)
    static_dir.mkdir(parents=True, exist_ok=True)

    audio_src = _public_url_to_filesystem_path(repo_root, audio_url)
    audio_filename = audio_src.name
    shutil.copy2(audio_src, static_dir / audio_filename)
    static_audio = f"{safe_id}/{audio_filename}"

    static_images: list[str] = []
    for url in image_urls:
        src = _public_url_to_filesystem_path(repo_root, url)
        if not src.exists():
            print(f"[video stage] skipping missing image {src}")
            continue
        shutil.copy2(src, static_dir / src.name)
        static_images.append(f"{safe_id}/{src.name}")
    return {"audio": static_audio, "images": static_images}
