"""Article shorts — render assembly.

Two consumers, one generation core:
  - LOCAL: render_short_from_db() builds props with staticFile-relative asset
    paths (staged into video/public/<id>-short/) and runs `npx remotion render`.
  - PROD:  build_short_props(remote=True) generates the assets, uploads the
    frames + audio to GCS (the existing pipeline.gcs module), and returns props
    with https:// URLs. The Vercel Python drain calls this, persists the props,
    and the /api/render_short cron POSTs them to the SAME Cloud Run /render
    endpoint the long-form video uses (DoodleShort renders any inputProps; its
    resolveSrc accepts remote URLs).

Generation: pipeline.shorts.generate_short_assets (script -> recurring character
-> gpt-image-2-i2i scenes). Voice + caption timing reuse pipeline.voice +
pipeline.video helpers. Asset id is `<story>-short` so it never clobbers the
long-form video.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from pipeline import gcs, images, media, shorts, store, video, voice

# Separate asset namespace from the long-form video so a story can have both.
SHORT_ID_SUFFIX = "-short"
# Captions sit low (~bottom third) for shorts, matching the channel reference.
SHORT_CAPTION_POSITION_Y = 0.72

ProgressFn = Callable[[str, int, int], None]


def _story_body(row: dict) -> str:
    """Text the script is written from. Prefer the body; fall back to summary."""
    return (row.get("body") or row.get("summary") or "").strip()


@dataclass
class ShortProps:
    """The DoodleShort props plus the staged asset id. `props` is the dict the
    Remotion composition consumes (local staticFile paths or remote GCS URLs)."""
    safe_id: str
    props: dict


def build_short_props(
    story_id: str,
    repo_root: Path,
    *,
    narration_style: str | None = None,
    length_preset: str | None = None,
    remote: bool = False,
    on_progress: ProgressFn | None = None,
) -> ShortProps | None:
    """Generate a short's assets and build its DoodleShort props.

    remote=False stages assets into video/public/<id>-short/ as staticFile paths
    (for a local `npx remotion render`). remote=True uploads the frames + audio
    to GCS and emits https:// URLs (for the Cloud Run /render endpoint).
    Returns None on a clean failure (logged)."""
    safe_story = media._sanitize_id(story_id)
    row = store.fetch_story(safe_story)
    if not row:
        print(f"[short id={safe_story}] no story with that id")
        return None
    title = (row.get("title") or "").strip()
    body = _story_body(row)
    if not body:
        print(f"[short id={safe_story}] story has no body/summary text; skipping")
        return None

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
        return None

    safe_id = safe_story + SHORT_ID_SUFFIX
    if remote:
        # Vercel / Cloud Run filesystems are read-only except /tmp. In remote
        # mode assets are staged to a tmp dir then uploaded to GCS, so the
        # read-only video/public tree is never touched.
        work_dir = Path(tempfile.mkdtemp(prefix=f"{safe_id}-"))
    else:
        work_dir = repo_root / video.VIDEO_PROJECT_RELATIVE / video.STATIC_DIR_RELATIVE / safe_id
        if work_dir.exists():
            shutil.rmtree(work_dir)
        work_dir.mkdir(parents=True, exist_ok=True)

    # 2) Voiceover over the spoken script + caption timing.
    progress("voice")
    spoken = re.sub(r"\s+", " ", assets.script.get("short_script", "")).strip()
    audio_path = work_dir / "voice.mp3"
    vres = voice.synthesize(spoken, audio_path)
    captions = video._chunk_alignment(vres.get("words") or [])
    if not captions:
        print(f"[short id={safe_id}] alignment produced no caption chunks; skipping")
        return None
    duration_ms = max(int(captions[-1]["end_ms"]), 1)

    # 3) Stage frames. Scene URLs are remote (kie) so download them first. For
    #    remote mode, upload each frame + the audio to GCS and use those URLs;
    #    for local mode, use staticFile-relative paths.
    progress("stage")
    frame_sources = [assets.base_url] + [s["url"] for s in assets.scenes]
    image_urls: list[str] = []
    total = len(frame_sources)
    for i, url in enumerate(frame_sources):
        fname = f"frame-{i:02d}.png"
        local = work_dir / fname
        try:
            images.download(url, local)
        except Exception as e:
            print(f"[short id={safe_id} stage] frame {i} download FAILED: {e}")
            continue
        if remote:
            image_urls.append(gcs.publish(local, f"{safe_id}/{fname}", url))
        else:
            image_urls.append(f"{safe_id}/{fname}")
        progress("stage", i + 1, total)
    if not image_urls:
        print(f"[short id={safe_id}] no frames staged; skipping")
        return None

    if remote:
        audio_ref = gcs.publish(audio_path, f"{safe_id}/voice.mp3", str(audio_path))
    else:
        audio_ref = f"{safe_id}/voice.mp3"

    doodle_frames = video._distribute_frames(image_urls, captions, duration_ms)
    caption_template = {
        **video.resolve_caption_template(store.get_setting),
        "position_y": SHORT_CAPTION_POSITION_Y,
    }
    props = {
        "config_version": 2,
        "voiceover_url": audio_ref,
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
    print(
        f"[short id={safe_id} props] {len(captions)} caption chunks, "
        f"{len(doodle_frames)} frames, {duration_ms/1000:.1f}s, remote={remote}"
    )
    return ShortProps(safe_id=safe_id, props=props)


def render_short_from_db(
    story_id: str,
    repo_root: Path,
    *,
    narration_style: str | None = None,
    length_preset: str | None = None,
    on_progress: ProgressFn | None = None,
) -> dict:
    """LOCAL path: build props (staticFile assets) + `npx remotion render` +
    publish the MP4. Returns {"video_url": ...} on success, {} on failure."""
    built = build_short_props(
        story_id, repo_root,
        narration_style=narration_style,
        length_preset=length_preset,
        remote=False,
        on_progress=on_progress,
    )
    if not built:
        return {}

    def progress(phase: str, cur: int = 0, total: int = 0) -> None:
        if on_progress:
            on_progress(phase, cur, total)

    safe_id = built.safe_id
    video_project = repo_root / video.VIDEO_PROJECT_RELATIVE
    props_dir = video_project / ".props"
    props_dir.mkdir(parents=True, exist_ok=True)
    props_path = props_dir / f"{safe_id}.json"
    props_path.write_text(json.dumps(built.props, indent=2), encoding="utf-8")

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
