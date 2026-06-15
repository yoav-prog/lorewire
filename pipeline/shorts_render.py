"""Article shorts — render assembly.

Turns a story into a finished vertical short MP4:
  read story text  -> pipeline.shorts.generate_short_assets (script + frames)
  voiceover        -> pipeline.voice.synthesize
  caption timing   -> pipeline.video._chunk_alignment (shared chunker)
  stage frames     -> download the kie-hosted frames into video/public/<id>-short/
  props + render   -> the DoodleShort composition (bottom captions, no in-frame
                      motion) via `npx remotion render`
  publish          -> pipeline.gcs.publish

Mirrors pipeline.video.generate_video but sourced from the shorts generator and
written under a separate `<id>-short` asset namespace so it never clobbers the
long-form video. The queue worker (pipeline.short_render_worker) calls
render_short_from_db; on_progress lets it persist per-phase progress between
Vercel cron ticks.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Callable

from pipeline import gcs, images, media, shorts, store, video, voice

# Separate asset id from the long-form video so a story can have both.
SHORT_ID_SUFFIX = "-short"

ProgressFn = Callable[[str, int, int], None]


def _story_body(row: dict) -> str:
    """The text the script is written from. Prefer the full body; fall back to
    the summary so a story without a body can still produce a short."""
    return (row.get("body") or row.get("summary") or "").strip()


def render_short_from_db(
    story_id: str,
    repo_root: Path,
    *,
    narration_style: str | None = None,
    length_preset: str | None = None,
    on_progress: ProgressFn | None = None,
) -> dict:
    """Generate + render a short for an existing story. Returns
    `{"video_url": ...}` on success, `{}` on a clean failure (logged)."""
    safe_story = media._sanitize_id(story_id)
    row = store.fetch_story(safe_story)
    if not row:
        print(f"[short id={safe_story}] no story with that id")
        return {}
    title = (row.get("title") or "").strip()
    body = _story_body(row)
    if not body:
        print(f"[short id={safe_story}] story has no body/summary text; skipping")
        return {}

    def progress(phase: str, cur: int = 0, total: int = 0) -> None:
        if on_progress:
            on_progress(phase, cur, total)

    # 1) Script + character + scene frames (kie-hosted image URLs).
    assets = shorts.generate_short_assets(
        title, body,
        narration_style_id=narration_style,
        length_preset_id=length_preset,
        on_progress=on_progress,
    )
    if not assets.scenes:
        print(f"[short id={safe_story}] generator returned no scenes; skipping")
        return {}

    safe_id = safe_story + SHORT_ID_SUFFIX
    video_project = repo_root / video.VIDEO_PROJECT_RELATIVE
    static_dir = video_project / video.STATIC_DIR_RELATIVE / safe_id
    if static_dir.exists():
        shutil.rmtree(static_dir)
    static_dir.mkdir(parents=True, exist_ok=True)

    # 2) Voiceover over the spoken script + caption timing.
    progress("voice")
    spoken = re.sub(r"\s+", " ", assets.script.get("short_script", "")).strip()
    audio_dest = static_dir / "voice.mp3"
    vres = voice.synthesize(spoken, audio_dest)
    alignment = vres.get("words") or []
    captions = video._chunk_alignment(alignment)
    if not captions:
        print(f"[short id={safe_id}] alignment produced no caption chunks; skipping")
        return {}
    duration_ms = max(int(captions[-1]["end_ms"]), 1)

    # 3) Stage frames: the scene URLs are remote (kie) so download them into the
    #    static dir as staticFile-friendly relative paths. Base frame first.
    progress("stage")
    frame_sources = [assets.base_url] + [s["url"] for s in assets.scenes]
    static_images: list[str] = []
    for i, url in enumerate(frame_sources):
        fname = f"frame-{i:02d}.png"
        try:
            images.download(url, static_dir / fname)
        except Exception as e:
            print(f"[short id={safe_id} stage] frame {i} download FAILED: {e}")
            continue
        static_images.append(f"{safe_id}/{fname}")
    if not static_images:
        print(f"[short id={safe_id}] no frames staged; skipping")
        return {}
    static_audio = f"{safe_id}/{audio_dest.name}"
    doodle_frames = video._distribute_frames(static_images, captions, duration_ms)

    # 4) Bottom-positioned karaoke captions (the shorts default), built on the
    #    same resolved template as the long-form path so admin tuning still
    #    applies. No in-frame motion: the variety is the varied scenes.
    caption_template = {**video.resolve_caption_template(store.get_setting), "position_y": 0.72}
    config = {
        "config_version": 2,
        "voiceover_url": static_audio,
        "title": video._truncate_title(title),
        "channel_name": "lorewire",
        "aspect": "9:16",
        "duration_ms": duration_ms,
        "doodle_frames": doodle_frames,
        "captions": captions,
        "ken_burns": False,
        "caption_template": caption_template,
        "motion": {"micro_wiggle": False, "label_pop": False, "scribble_draw": False,
                   "prop_slide": False, "mouth_swap": False},
        "props_list": [],
        "character_image_mouth_removed": None,
    }
    props_dir = video_project / ".props"
    props_dir.mkdir(parents=True, exist_ok=True)
    props_path = props_dir / f"{safe_id}.json"
    props_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    print(
        f"[short id={safe_id} props] wrote {props_path.name} "
        f"({len(captions)} caption chunks, {len(doodle_frames)} frames, {duration_ms/1000:.1f}s)"
    )

    # 5) Render via the same Remotion composition + entry point as long-form.
    progress("render")
    out_dir = repo_root / media.PUBLIC_DIR_RELATIVE / safe_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_mp4 = out_dir / "short.mp4"
    cmd = ["npx", "remotion", "render", video.ENTRY_POINT, video.COMPOSITION_ID,
           str(out_mp4), f"--props={props_path}"]
    started = time.time()
    try:
        result = subprocess.run(cmd, cwd=video_project, check=False, capture_output=True,
                                text=True, shell=True, encoding="utf-8", errors="replace")
    except FileNotFoundError as e:
        print(f"[short id={safe_id} render] npx not on PATH: {e}")
        return {}
    if result.returncode != 0:
        for line in (result.stderr or result.stdout or "").splitlines()[-12:]:
            print(f"  remotion: {line}")
        return {}

    local_url = f"{media.PUBLIC_URL_PREFIX}/{safe_id}/short.mp4"
    stored_url = gcs.publish(out_mp4, f"{safe_id}/short.mp4", local_url)
    print(f"[short id={safe_id} render] done in {time.time()-started:.1f}s at {stored_url}")
    progress("done")
    return {"video_url": stored_url}
