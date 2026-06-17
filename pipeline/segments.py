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
from pipeline.aspect import LEGACY_DEFAULT_ASPECT, is_video_aspect

# Output contract for normalize() and splice(). Must match the Remotion body
# output exactly so the concat filter produces a stream without resamples.
# Phase 3 of _plans/2026-06-12-video-aspect-ratio.md: the target dimensions
# now branch on the segment's `aspect` so a 16:9 segment is normalized to
# 1920x1080 and a 9:16 segment is normalized to 1080x1920. fps + audio
# rate + channel count are aspect-invariant.
TARGET_FPS = 30
TARGET_AUDIO_RATE = 48000
TARGET_AUDIO_CHANNELS = 2

# Legacy width/height retained for downstream callers that import them by
# name. New code should call `_target_dims(aspect)` for the right pair.
TARGET_WIDTH = 1080
TARGET_HEIGHT = 1920

# Per-aspect target pixel dims. 9:16 stays at 1080x1920 (the orientation
# the pipeline shipped with — every legacy normalized segment fits this
# shape byte-for-byte). 16:9 is 1920x1080.
_DIMS_BY_ASPECT: dict[str, tuple[int, int]] = {
    "9:16": (1080, 1920),
    "16:9": (1920, 1080),
}


def _resolve_segment_aspect(aspect: str | None) -> str:
    """Normalize a string from the wire / a row / a caller into a valid
    aspect. Anything we don't recognize falls through to the legacy
    9:16 floor so a missing column / typo doesn't crash the worker."""
    if is_video_aspect(aspect):
        return aspect  # type: ignore[return-value]
    return LEGACY_DEFAULT_ASPECT


def _target_dims(aspect: str | None) -> tuple[int, int]:
    return _DIMS_BY_ASPECT[_resolve_segment_aspect(aspect)]


def _normalize_video_filter(aspect: str | None) -> str:
    """Build the ffmpeg `vf` filter graph for the target aspect.

    `scale=...:force_original_aspect_ratio=increase` scales so both target
    dimensions are covered (so we never letterbox), then `crop=W:H` takes
    the center window. This is the "center-crop" fit the admin picked when
    portrait segments first shipped; landscape segments use the same fit
    against the wider target. Pinned in code — picking a different fit
    per segment is out of scope for v1.
    """
    w, h = _target_dims(aspect)
    return (
        f"scale={w}:{h}:force_original_aspect_ratio=increase,"
        f"crop={w}:{h},"
        f"setsar=1,fps={TARGET_FPS}"
    )


# Backwards-compatible default — same string as the pre-Phase-3 portrait
# graph. Held for any external importer; the runtime path is
# `_normalize_video_filter(aspect)`.
NORMALIZE_VIDEO_FILTER = _normalize_video_filter(LEGACY_DEFAULT_ASPECT)

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

DEFAULT_OUTRO_LEAD_IN_MS = 1500
"""Silent gap inserted between body and outro by default. 1.5s gives
the narrator's last syllable a beat to breathe before the outro audio
cuts in. Tunable via the `video.outro_lead_in_ms` setting; 0 disables."""


def resolve_outro_lead_in_sec(get_setting: Callable[[str], Optional[str]]) -> float:
    """Read `video.outro_lead_in_ms` from settings and return seconds.

    Defaults to `DEFAULT_OUTRO_LEAD_IN_MS / 1000` when unset; clamps to
    [0, 10] so a typo can't produce a half-hour silent gap or a negative
    pad. Unparseable values fall back to the default rather than failing
    the render.
    """
    raw = (get_setting("video.outro_lead_in_ms") or "").strip()
    if not raw:
        return DEFAULT_OUTRO_LEAD_IN_MS / 1000.0
    try:
        ms = float(raw)
    except ValueError:
        return DEFAULT_OUTRO_LEAD_IN_MS / 1000.0
    # Bound to a sane range — defense against a fat-finger setting that
    # would otherwise stretch every short to half an hour.
    ms = max(0.0, min(ms, 10_000.0))
    return ms / 1000.0


def _ffmpeg_normalize_cmd(
    source: Path,
    output: Path,
    aspect: str | None = None,
) -> list[str]:
    """Build the ffmpeg argv that normalizes a raw upload to the target
    contract. Pure — no side effects — so tests can assert the shape without
    running ffmpeg.

    `aspect` defaults to the legacy 9:16 portrait so any caller that hasn't
    been updated produces the same argv as before Phase 3.
    """
    return [
        "ffmpeg",
        "-y",
        "-i", str(source),
        "-vf", _normalize_video_filter(aspect),
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
    inputs: list[Path],
    output: Path,
    has_audio: bool = True,
    *,
    body_index: int | None = None,
    body_tail_pad_sec: float = 0.0,
) -> list[str]:
    """Build the ffmpeg argv that concatenates 2+ inputs with the concat
    filter. All inputs are assumed normalized (same res/fps/codec). Pure.

    When `body_index` is supplied AND `body_tail_pad_sec > 0`, the body
    input gets a tail-pad inserted before the concat: `tpad=stop_mode=clone`
    holds the last video frame for the pad duration, and `apad` extends
    the audio track with silence for the same duration. The padded
    streams feed into the concat in place of the raw body streams, so
    everything that comes AFTER the body (typically the outro) starts
    `body_tail_pad_sec` later — giving the narration a beat to land
    before the outro audio cuts in.

    Designed so the body is at one position in the inputs list (e.g.
    index 1 when an intro precedes it; index 0 when not), and only the
    body's streams get the pad — the intro / outro inputs are passed
    through unchanged.
    """
    if len(inputs) < 2:
        raise ValueError("splice needs at least 2 inputs")
    pad_active = (
        body_index is not None
        and body_tail_pad_sec > 0.0
        and 0 <= body_index < len(inputs)
        # No point padding the body when nothing follows it (no outro).
        and body_index < len(inputs) - 1
    )
    argv: list[str] = ["ffmpeg", "-y"]
    for p in inputs:
        argv += ["-i", str(p)]

    # Filter graph. Without pad: [0:v][0:a][1:v][1:a]...concat=...
    # With pad applied to body at index B:
    #   [B:v:0]tpad=stop_mode=clone:stop_duration=S[bv];
    #   [B:a:0]apad=pad_dur=S[ba];
    #   [0:v:0][0:a:0]...[bv][ba]...concat=...
    streams = ""
    if pad_active:
        # Format with `g` to avoid trailing zeros — ffmpeg's filter parser
        # is happy with either, but a clean number reads easier in logs.
        pad_s = format(body_tail_pad_sec, "g")
        streams += (
            f"[{body_index}:v:0]tpad=stop_mode=clone:stop_duration={pad_s}[bv];"
        )
        if has_audio:
            streams += f"[{body_index}:a:0]apad=pad_dur={pad_s}[ba];"
    for i in range(len(inputs)):
        if pad_active and i == body_index:
            streams += "[bv]"
            if has_audio:
                streams += "[ba]"
        else:
            streams += f"[{i}:v:0]"
            if has_audio:
                streams += f"[{i}:a:0]"
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
      4. `video.active_<kind>_id_<aspect>` points at an enabled row -> that row.
      5. Otherwise -> None.

    2026-06-15 (_plans/2026-06-15-intro-outro-per-aspect-active.md): the global
    active pointer is keyed by the story's aspect, so a 9:16 and a 16:9 segment
    can both be live and each render reads its own slot.

    Phase 3 of _plans/2026-06-12-video-aspect-ratio.md adds an aspect
    filter: each candidate's `aspect` must match the story's resolved
    aspect or we drop it with a warning. The concat filter at splice time
    refuses to glue clips of different resolutions, so an aspect mismatch
    would either fail the render or silently letterbox; better to skip
    here and emit a body-only render until the admin uploads a matching-
    aspect segment. The filter is redundant for the per-aspect global path
    (the slot is keyed by aspect) but load-bearing for the pinned path and
    for a slot left stale by a worker re-probe.

    Pure: callers inject `get_setting` and `fetch_segment` so tests can stub
    a fake store.
    """
    if kind not in ("intro", "outro"):
        raise ValueError(f"pick_segment kind must be 'intro' or 'outro', got {kind!r}")

    row = story_row or {}

    # Step 1: hard skip.
    if row.get(f"skip_{kind}"):
        return None

    # Resolve the story's aspect once — both the pinned path and the global
    # active path filter against it, and the global active pointer is keyed by
    # it. Late import to avoid circular imports: pipeline.aspect imports
    # pipeline.store inside `_global_default_aspect`, so importing it at module
    # top from segments.py would touch the lazy store initialiser before tests
    # get a chance to stub it.
    from pipeline.aspect import (
        active_segment_setting_key,
        resolve_aspect_for_story,
    )

    story_aspect = resolve_aspect_for_story(story_row)

    # Step 2: per-story pinned id.
    pinned_id = row.get(f"{kind}_segment_id")
    if pinned_id:
        seg = fetch_segment(pinned_id)
        return _accept_if_aspect_matches(seg, story_aspect, kind, "pinned")

    # Step 3: global master switch (defaults to ON when unset).
    if _explicitly_off(get_setting("video.intro_outro_enabled")):
        return None

    # Step 4: global active id for this story's aspect.
    active_id = (get_setting(active_segment_setting_key(kind, story_aspect)) or "").strip()
    if not active_id:
        return None
    seg = fetch_segment(active_id)
    if not seg or not seg.get("enabled"):
        return None
    return _accept_if_aspect_matches(seg, story_aspect, kind, "global-active")


def _accept_if_aspect_matches(
    seg: dict | None,
    story_aspect: str,
    kind: str,
    source: str,
) -> dict | None:
    """Drop a picked segment whose aspect doesn't match the story's.

    Logs a single-line warning naming the segment + the mismatch source so
    the admin can grep the render log. Returns None on a mismatch; returns
    `seg` unchanged otherwise. A segment row without an aspect column is
    treated as 9:16 (the legacy default the column defaults to). `story_aspect`
    is the already-resolved story aspect (the caller resolves it once).
    """
    if not seg:
        return None
    seg_aspect = _resolve_segment_aspect(seg.get("aspect"))
    if seg_aspect == story_aspect:
        return seg
    print(
        f"[segment pick] SKIP aspect-mismatch kind={kind} source={source} "
        f"seg_id={seg.get('id')!r} seg_aspect={seg_aspect} "
        f"story_aspect={story_aspect}"
    )
    return None


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


def probe_video_dims(path: Path) -> tuple[int, int] | None:
    """ffprobe the video stream's width and height in pixels. Returns
    `(width, height)` on success or `None` on any failure (missing
    ffprobe binary, no video stream, garbled output). Same fail-soft
    convention as `_probe_duration_ms` — the caller (segments worker)
    is expected to log the None case and fall back to the declared
    aspect rather than crashing the loop."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
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
        return None
    raw = (result.stdout or "").strip()
    # ffprobe prints width then height on separate lines with this -of
    # template. Anything else (blank, single line, non-numeric) is a
    # signal that the file isn't a video we can normalize.
    parts = [p for p in raw.split() if p]
    if len(parts) < 2:
        return None
    try:
        w = int(parts[0])
        h = int(parts[1])
    except ValueError:
        return None
    if w <= 0 or h <= 0:
        return None
    return w, h


def normalize(
    source_path: Path,
    output_path: Path,
    segment_id: str = "",
    aspect: str | None = None,
) -> dict:
    """Re-encode `source_path` to the target contract and write to `output_path`.

    Returns `{"duration_ms": int}` on success. Raises RuntimeError on ffmpeg
    failure with the last lines of stderr in the message so the admin sees
    why an upload didn't take. `aspect` defaults to 9:16 portrait so any
    caller that hasn't been updated produces byte-identical output to the
    pre-Phase-3 normalize.
    """
    resolved_aspect = _resolve_segment_aspect(aspect)
    w, h = _target_dims(resolved_aspect)
    tag = f"[segment normalize id={segment_id or '?'} aspect={resolved_aspect}]"
    if not source_path.exists():
        raise RuntimeError(f"{tag} source missing: {source_path}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    argv = _ffmpeg_normalize_cmd(source_path, output_path, aspect=resolved_aspect)
    print(
        f"{tag} start target={w}x{h} cmd={' '.join(argv[:8])} "
        f"... -> {output_path.name}"
    )
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
    *,
    outro_lead_in_sec: float = 0.0,
) -> dict:
    """Glue intro + body + outro into `output_path` with one re-encode pass.

    Either or both of `intro_path` / `outro_path` may be None; if both are
    None this is a no-op file copy (atomic rename when the caller controls
    the temp dir). Returns `{"duration_ms": int}` on the final spliced file.
    Raises on ffmpeg failure.

    `outro_lead_in_sec` (2026-06-17 fix) inserts a held-frame + silent
    audio pad on the body's tail when an outro is present, so the
    narrator's last word doesn't get stepped on by the outro cue.
    Defaults to 0 for back-compat; callers that want the user-facing
    default (1.5s) read `resolve_outro_lead_in_sec(store.get_setting)`.
    """
    tag = f"[video splice id={context_id or '?'}]"
    if not body_path.exists():
        raise RuntimeError(f"{tag} body missing: {body_path}")
    inputs: list[Path] = []
    body_index = 0
    if intro_path:
        if not intro_path.exists():
            raise RuntimeError(f"{tag} intro missing: {intro_path}")
        inputs.append(intro_path)
        body_index = 1
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

    # Only pad when there's an outro to separate from the narration;
    # tail-padding before just an intro-then-body chain would extend the
    # output for no reason.
    pad_sec = outro_lead_in_sec if outro_path is not None else 0.0
    argv = _ffmpeg_splice_cmd(
        inputs, output_path, body_index=body_index, body_tail_pad_sec=pad_sec,
    )
    parts_desc = "+".join(
        ["intro" if intro_path else ""] +
        ["body"] +
        (["outro"] if outro_path else [])
    ).strip("+")
    if pad_sec > 0:
        parts_desc = parts_desc.replace("body", f"body+{pad_sec:g}s-pad")
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
