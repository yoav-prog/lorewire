"""Intro/outro segment library.

Each row in `video_segments` is one normalized clip (1080x1920 @ 30fps,
H.264 + AAC). The admin uploads a raw file; this module normalizes it once
via ffmpeg and stores the normalized result in GCS alongside the source.
The render pipeline asks `pick_segment` for the right intro/outro per story
(per-story pin > global active > none), then `splice` glues intro + body +
outro with one ffmpeg pass (concat filter).

Why ffmpeg post-concat instead of doing this inside Remotion: a single
re-encode pass through the concat filter is cheap (~5-10s for a 90s short)
and keeps the Remotion composition unaware of intros/outros — the body
render stays identical whether or not segments are configured.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, Optional

from pipeline import media

# Output contract for normalize() and splice(). Must match the Remotion body
# output exactly so the concat filter produces a stream without resamples.
TARGET_WIDTH = 1080
TARGET_HEIGHT = 1920
TARGET_FPS = 30
TARGET_AUDIO_RATE = 48000
TARGET_AUDIO_CHANNELS = 2

# scale=...:force_original_aspect_ratio=increase scales so both target
# dimensions are covered (so we never letterbox), then crop=1080:1920 takes
# the center 9:16 window. This is the "center-crop landscape" path the admin
# picked. Pinned in code (not a settings knob) — picking a different fit per
# segment is out of scope for v1.
NORMALIZE_VIDEO_FILTER = (
    f"scale={TARGET_WIDTH}:{TARGET_HEIGHT}:force_original_aspect_ratio=increase,"
    f"crop={TARGET_WIDTH}:{TARGET_HEIGHT},"
    f"setsar=1,fps={TARGET_FPS}"
)

# Audio normalization: resample to 48 kHz stereo so concat doesn't have to
# splice mismatched rates. afade-in is not applied here so the admin's source
# audio plays unchanged (any fade lives in the source file itself).
NORMALIZE_AUDIO_FILTER = (
    f"aformat=sample_rates={TARGET_AUDIO_RATE}:channel_layouts=stereo"
)

# Re-encode settings. CRF 20 is "visually lossless" for short-form video at
# this resolution. preset=fast keeps normalize under ~5s for a 4-second clip
# on a modern laptop; concat is a similar order of magnitude per second of
# combined output.
H264_PRESET = "fast"
H264_CRF = "20"
AAC_BITRATE = "192k"

# Cache for downloaded normalized segments so re-renders of different stories
# don't redownload the same GCS object. Lives under .props/ alongside the
# Remotion props dir so it gets cleaned up with the rest of the temp tree.
_SEGMENT_CACHE_RELATIVE = Path("video") / ".segments-cache"

# A safe id pattern for segment ids — we hand-build the ones we create, so
# this is mainly a defense-in-depth check before forming a filesystem path.
_SAFE_SEGMENT_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


# --- pure helpers (covered by pipeline/tests/test_segments.py) ---------------

def _ffmpeg_normalize_cmd(source: Path, output: Path) -> list[str]:
    """Build the ffmpeg argv that normalizes a raw upload to the target
    contract. Pure — no side effects — so tests can assert the shape without
    running ffmpeg."""
    return [
        "ffmpeg",
        "-y",
        "-i", str(source),
        "-vf", NORMALIZE_VIDEO_FILTER,
        "-af", NORMALIZE_AUDIO_FILTER,
        "-r", str(TARGET_FPS),
        "-c:v", "libx264",
        "-preset", H264_PRESET,
        "-crf", H264_CRF,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", AAC_BITRATE,
        "-ar", str(TARGET_AUDIO_RATE),
        "-ac", str(TARGET_AUDIO_CHANNELS),
        "-movflags", "+faststart",
        str(output),
    ]


def _ffmpeg_splice_cmd(
    inputs: list[Path], output: Path, has_audio: bool = True
) -> list[str]:
    """Build the ffmpeg argv that concatenates 2+ inputs with the concat
    filter. All inputs are assumed normalized (same res/fps/codec). Pure."""
    if len(inputs) < 2:
        raise ValueError("splice needs at least 2 inputs")
    argv: list[str] = ["ffmpeg", "-y"]
    for p in inputs:
        argv += ["-i", str(p)]
    # Build the filter graph: [0:v][0:a][1:v][1:a]...concat=n=N:v=1:a=1[v][a]
    streams = ""
    for i in range(len(inputs)):
        streams += f"[{i}:v:0]" + (f"[{i}:a:0]" if has_audio else "")
    a = 1 if has_audio else 0
    streams += f"concat=n={len(inputs)}:v=1:a={a}[v]"
    if has_audio:
        streams += "[a]"
    argv += ["-filter_complex", streams]
    argv += ["-map", "[v]"]
    if has_audio:
        argv += ["-map", "[a]"]
    argv += [
        "-r", str(TARGET_FPS),
        "-c:v", "libx264",
        "-preset", H264_PRESET,
        "-crf", H264_CRF,
        "-pix_fmt", "yuv420p",
    ]
    if has_audio:
        argv += [
            "-c:a", "aac",
            "-b:a", AAC_BITRATE,
            "-ar", str(TARGET_AUDIO_RATE),
            "-ac", str(TARGET_AUDIO_CHANNELS),
        ]
    argv += ["-movflags", "+faststart", str(output)]
    return argv


def _truthy(raw: str | None) -> bool:
    """Settings values are strings; this is the same predicate the video stage
    already uses (`video.ken_burns` etc.). Empty/None reads as falsy here."""
    return (raw or "").strip().lower() in {"1", "true", "on", "yes"}


def _explicitly_off(raw: str | None) -> bool:
    """Distinct from "not truthy" so the master switch can default to ON
    when unset: only an explicit "0"/"false"/"off" disables."""
    if raw is None:
        return False
    return raw.strip().lower() in {"0", "false", "off", "no"}


def pick_segment(
    kind: str,
    story_row: dict | None,
    get_setting: Callable[[str], Optional[str]],
    fetch_segment: Callable[[str], Optional[dict]],
) -> dict | None:
    """Resolve which segment to splice for this story + kind.

    Chain (first match wins):
      1. Story has `skip_<kind>` truthy            -> None (explicit opt-out).
      2. Story has `<kind>_segment_id` pinned      -> that row (even if
         disabled — pinning is a strong statement; if the row is missing
         entirely we still return None rather than falling back, so the
         admin's intent is respected and never silently overridden by the
         global active pick).
      3. `video.intro_outro_enabled` is explicitly 0/false/off -> None.
      4. `video.active_<kind>_id` points at an enabled row     -> that row.
      5. Otherwise -> None.

    Pure: callers inject `get_setting` and `fetch_segment` so tests can stub
    a fake store.
    """
    if kind not in ("intro", "outro"):
        raise ValueError(f"pick_segment kind must be 'intro' or 'outro', got {kind!r}")

    row = story_row or {}

    # Step 1: hard skip.
    if row.get(f"skip_{kind}"):
        return None

    # Step 2: per-story pinned id.
    pinned_id = row.get(f"{kind}_segment_id")
    if pinned_id:
        seg = fetch_segment(pinned_id)
        return seg if seg else None

    # Step 3: global master switch (defaults to ON when unset).
    if _explicitly_off(get_setting("video.intro_outro_enabled")):
        return None

    # Step 4: global active id.
    active_id = (get_setting(f"video.active_{kind}_id") or "").strip()
    if not active_id:
        return None
    seg = fetch_segment(active_id)
    if not seg or not seg.get("enabled"):
        return None
    return seg


# --- ffmpeg invocations -------------------------------------------------------

def _run_ffmpeg(argv: list[str], context: str) -> subprocess.CompletedProcess:
    """Run ffmpeg with the same encoding/error handling pattern the Remotion
    render uses in pipeline/video.py — utf-8 stderr with errors=replace so a
    Windows host with a non-UTF-8 locale doesn't crash the reader thread."""
    try:
        return subprocess.run(
            argv,
            check=False,
            capture_output=True,
            text=True,
            shell=False,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError as e:
        raise RuntimeError(f"[{context}] ffmpeg not on PATH: {e}") from e


def _probe_duration_ms(path: Path) -> int:
    """ffprobe the duration of a file in ms. Returns 0 on failure rather
    than raising — the duration is metadata for the admin UI, not load-bearing
    for splice. Uses the same encoding pattern as the ffmpeg subprocess."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError:
        return 0
    raw = (result.stdout or "").strip()
    try:
        return int(round(float(raw) * 1000))
    except (TypeError, ValueError):
        return 0


def normalize(source_path: Path, output_path: Path, segment_id: str = "") -> dict:
    """Re-encode `source_path` to the target contract and write to `output_path`.

    Returns `{"duration_ms": int}` on success. Raises RuntimeError on ffmpeg
    failure with the last lines of stderr in the message so the admin sees
    why an upload didn't take.
    """
    tag = f"[segment normalize id={segment_id or '?'}]"
    if not source_path.exists():
        raise RuntimeError(f"{tag} source missing: {source_path}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    argv = _ffmpeg_normalize_cmd(source_path, output_path)
    print(f"{tag} start cmd={' '.join(argv[:8])} ... -> {output_path.name}")
    started = time.time()
    result = _run_ffmpeg(argv, context=f"segment normalize id={segment_id}")
    elapsed = time.time() - started
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").splitlines()[-12:]
        msg = f"{tag} FAILED rc={result.returncode} in {elapsed:.1f}s"
        print(msg)
        for line in tail:
            print(f"  ffmpeg: {line}")
        raise RuntimeError(msg + " (see logs for ffmpeg stderr tail)")
    duration_ms = _probe_duration_ms(output_path)
    size_mb = output_path.stat().st_size / (1024 * 1024) if output_path.exists() else 0.0
    print(
        f"{tag} done in {elapsed:.1f}s output={size_mb:.1f} MB duration={duration_ms}ms"
    )
    return {"duration_ms": duration_ms}


def splice(
    body_path: Path,
    intro_path: Path | None,
    outro_path: Path | None,
    output_path: Path,
    context_id: str = "",
) -> dict:
    """Glue intro + body + outro into `output_path` with one re-encode pass.

    Either or both of `intro_path` / `outro_path` may be None; if both are
    None this is a no-op file copy (atomic rename when the caller controls
    the temp dir). Returns `{"duration_ms": int}` on the final spliced file.
    Raises on ffmpeg failure.
    """
    tag = f"[video splice id={context_id or '?'}]"
    if not body_path.exists():
        raise RuntimeError(f"{tag} body missing: {body_path}")
    inputs: list[Path] = []
    if intro_path:
        if not intro_path.exists():
            raise RuntimeError(f"{tag} intro missing: {intro_path}")
        inputs.append(intro_path)
    inputs.append(body_path)
    if outro_path:
        if not outro_path.exists():
            raise RuntimeError(f"{tag} outro missing: {outro_path}")
        inputs.append(outro_path)

    output_path.parent.mkdir(parents=True, exist_ok=True)

    if len(inputs) == 1:
        # No segments to splice — copy the body through unchanged so the
        # caller's downstream code (gcs.publish, atomic rename) sees the same
        # shape as a real splice. shutil.copy2 preserves mtime so cache
        # invalidation downstream behaves identically either way.
        shutil.copy2(body_path, output_path)
        duration_ms = _probe_duration_ms(output_path)
        print(f"{tag} no segments active; copied body through ({duration_ms}ms)")
        return {"duration_ms": duration_ms}

    argv = _ffmpeg_splice_cmd(inputs, output_path)
    parts_desc = "+".join(
        ["intro" if intro_path else ""] +
        ["body"] +
        (["outro"] if outro_path else [])
    ).strip("+")
    print(f"{tag} start parts={parts_desc} inputs={len(inputs)} -> {output_path.name}")
    started = time.time()
    result = _run_ffmpeg(argv, context=f"video splice id={context_id}")
    elapsed = time.time() - started
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").splitlines()[-12:]
        msg = f"{tag} FAILED rc={result.returncode} in {elapsed:.1f}s"
        print(msg)
        for line in tail:
            print(f"  ffmpeg: {line}")
        raise RuntimeError(msg + " (see logs for ffmpeg stderr tail)")
    duration_ms = _probe_duration_ms(output_path)
    size_mb = output_path.stat().st_size / (1024 * 1024) if output_path.exists() else 0.0
    print(
        f"{tag} done in {elapsed:.1f}s parts={parts_desc} "
        f"output={size_mb:.1f} MB duration={duration_ms}ms"
    )
    return {"duration_ms": duration_ms}


# --- segment download (GCS or local) -----------------------------------------

def cache_dir(repo_root: Path) -> Path:
    """The per-repo cache for downloaded normalized segments."""
    d = repo_root / _SEGMENT_CACHE_RELATIVE
    d.mkdir(parents=True, exist_ok=True)
    return d


def fetch_to_cache(segment_row: dict, repo_root: Path) -> Path:
    """Resolve a segment's normalized_url to a local Path the splice can read.

    Three URL shapes (mirrors pipeline/video.py:_public_url_to_filesystem_path):
      - https://storage.googleapis.com/...  -> download to cache once, reuse.
      - /generated/<id>/<file>              -> resolve under lorewire-app/public/.
      - file:// or anything else            -> treat as a local path; raise if
        it doesn't exist.

    The cache key is the segment id (defense-checked) so we never collide and
    never need to re-download for renders of different stories.
    """
    seg_id = str(segment_row.get("id") or "")
    if not _SAFE_SEGMENT_ID_RE.match(seg_id):
        raise RuntimeError(f"unsafe segment id: {seg_id!r}")
    url = str(segment_row.get("normalized_url") or "")
    if not url:
        raise RuntimeError(f"segment {seg_id} has no normalized_url")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme in ("http", "https"):
        dest = cache_dir(repo_root) / f"{seg_id}.mp4"
        if dest.exists() and dest.stat().st_size > 0:
            return dest
        print(f"[segment fetch id={seg_id}] downloading {url} -> {dest.name}")
        started = time.time()
        with urllib.request.urlopen(url, timeout=120) as resp:
            payload = resp.read()
        dest.write_bytes(payload)
        elapsed = time.time() - started
        size_mb = len(payload) / (1024 * 1024)
        print(f"[segment fetch id={seg_id}] cached {size_mb:.1f} MB in {elapsed:.1f}s")
        return dest
    # Local /generated/... or any other path. Drop the leading slash and join
    # under lorewire-app/public/, the same shape pipeline/video.py uses.
    relative = parsed.path.lstrip("/")
    local = (repo_root / media.PUBLIC_DIR_RELATIVE.parent / relative).resolve()
    if not local.exists():
        raise RuntimeError(f"segment {seg_id} local file missing: {local}")
    return local
