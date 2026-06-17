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
# Post-roll hold (ms) on the final scene: the last frame lingers this much past
# the narration so the closing word finishes before the outro splices on. The
# DoodleShort composition reads `end_hold_ms` and grows both its duration and
# the last frame's window. Mirror of SHORT_END_HOLD_MS in the TS render route
# (lorewire-app/src/app/api/render_short/route.ts), which re-injects the same
# value for the Cloud Run path; this constant covers the local `npx remotion
# render` path.
SHORT_END_HOLD_MS = 1500

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


def _map_frames(staged: list[dict], caption_count: int, planning_count: int) -> list[dict]:
    """Turn staged frames into DoodleFrame dicts. Each frame carries the caption
    index its scene was PLANNED against (in the planner's chunk space); map that
    proportionally onto the actual alignment-caption space so a scene lands near
    the beat it illustrates, then dedup-shift so no two frames share a start
    index (a shared start renders as a 1-frame flash in DoodleShort). Each frame
    gets a stable `id` (the TS DoodleFrame type requires it).

    Carries `image_prompt` through when staged supplies it so the editor's
    Scenes tab textarea can pre-fill with the exact bytes the model saw on
    first generation. Frames missing image_prompt (e.g. a partial-success
    short where one scene failed generation) emit no key — the editor falls
    back to an empty textarea and the per-scene regen action surfaces the
    "no image_prompt to regenerate from" error so the admin sees what's
    missing instead of regenerating from nothing.
    """
    span = max(1, caption_count - 1)
    pspan = max(1, planning_count - 1)
    mapped = []
    for f in staged:
        idx = max(0, min(caption_count - 1, round(f["planned"] * span / pspan)))
        mapped.append({
            "id": f["id"],
            "url": f["url"],
            "idx": idx,
            "image_prompt": f.get("image_prompt"),
        })
    mapped.sort(key=lambda x: x["idx"])
    frames: list[dict] = []
    used = -1
    for it in mapped:
        idx = it["idx"] if it["idx"] > used else used + 1
        idx = min(idx, caption_count - 1)
        used = idx
        frame: dict = {
            "id": it["id"],
            "url": it["url"],
            "caption_chunk_start_index": idx,
        }
        if it.get("image_prompt"):
            frame["image_prompt"] = it["image_prompt"]
        frames.append(frame)
    # The opening scene must cover t=0 — DoodleShort windows frame 0 from its
    # caption's start_ms, so a first scene planned against a later beat would
    # leave the start blank. The base reference frame used to absorb this gap;
    # now that it is no longer a visible frame, pin the first real scene to the
    # first caption.
    if frames:
        frames[0]["caption_chunk_start_index"] = 0
    return frames


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

    try:
        # 2) Voiceover over the spoken script + caption timing.
        progress("voice")
        spoken = re.sub(r"\s+", " ", assets.script.get("short_script", "")).strip()
        audio_path = work_dir / "voice.mp3"
        vres = voice.synthesize(spoken, audio_path)
        captions = video._chunk_alignment(vres.get("words") or [])
        if not captions:
            print(f"[short id={safe_id}] alignment produced no caption chunks; skipping")
            return None
        # The composition body MUST cover the WHOLE narration MP3, or the
        # concatenated outro clips the closing words. The last caption's end_ms
        # is a proxy that undershoots on some providers (it tracks the last
        # aligned word, not the file's real length), so floor the duration at
        # the actual audio length. end_hold_ms then adds the post-roll on top.
        caption_end_ms = int(captions[-1]["end_ms"])
        audio_ms = voice.audio_duration_ms(audio_path)
        duration_ms = max(caption_end_ms, audio_ms, 1)
        if audio_ms > caption_end_ms:
            print(
                f"[short id={safe_id} duration] audio={audio_ms}ms > "
                f"caption_end={caption_end_ms}ms — using audio length so the "
                f"outro doesn't clip the narration"
            )

        # 3) Stage frames. Scene URLs are remote (kie) so download first. Track
        #    each frame's PLANNED caption index so a partial-download skip can't
        #    misalign the rest.
        #    remote -> upload to GCS (https URLs); local -> staticFile paths.
        #    image_prompt carries the FULL wrapped prompt that generated each
        #    source URL so it survives into doodle_frames; editors see the
        #    exact bytes the model received and per-scene regen replays them
        #    verbatim.
        #    The base frame is the i2i CHARACTER REFERENCE only — a neutral
        #    standing pose on a plain background, not a story beat. It must
        #    NOT be staged as a visible frame (it used to lead every short).
        #    We keep it solely as props.character_base_url (step 4) so the
        #    editor + Lane C per-scene regen still have the identity anchor.
        progress("stage")
        sources = [
            {
                "url": s["url"],
                "planned": int(s.get("caption_chunk_start_index", 0) or 0),
                "image_prompt": s.get("image_prompt") or "",
            }
            for s in assets.scenes
        ]
        staged: list[dict] = []
        for i, src in enumerate(sources):
            fname = f"frame-{i:02d}.png"
            local = work_dir / fname
            try:
                images.download(src["url"], local)
            except Exception as e:
                print(f"[short id={safe_id} stage] frame {i} download FAILED: {e}")
                continue
            url = (
                gcs.publish(local, f"{safe_id}/{fname}", src["url"])
                if remote else f"{safe_id}/{fname}"
            )
            staged.append({
                "id": f"frame-{i:02d}",
                "url": url,
                "planned": src["planned"],
                "image_prompt": src.get("image_prompt") or None,
            })
            progress("stage", i + 1, len(sources))
        if not staged:
            print(f"[short id={safe_id}] no frames staged; skipping")
            return None

        audio_ref = (
            gcs.publish(audio_path, f"{safe_id}/voice.mp3", str(audio_path))
            if remote else f"{safe_id}/voice.mp3"
        )

        # 4) Map planned indices onto the actual caption space + dedup + add ids.
        planning_count = max(
            1, len(shorts.chunk_for_planning(assets.script.get("short_script", "")))
        )
        doodle_frames = _map_frames(staged, len(captions), planning_count)

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
            "end_hold_ms": SHORT_END_HOLD_MS,
            # The i2i character reference. Persisted (NOT as a visible frame)
            # so defaultShortConfig seeds short_config.character_base_url and
            # Lane C per-scene regen can re-pose the SAME character. The base
            # itself never appears in the video.
            "character_base_url": assets.base_url,
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
    finally:
        # Remote staging is in /tmp and disposable once uploaded to GCS; remove it
        # so the Vercel drain's /tmp doesn't fill across ticks. Local mode keeps
        # work_dir (video/public/<id>) because the local render reads from it.
        if remote:
            shutil.rmtree(work_dir, ignore_errors=True)


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
