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

from pipeline import gcs, media, segments
from pipeline.aspect import resolve_aspect_for_story

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

# --- caption template (Wave 3 Phase 1) ---------------------------------------
# Field -> (parser, default). Parser is responsible for clamping; a malformed
# value falls back to the default and emits a warning so a render that surprises
# the admin can be traced back to which field misbehaved.
_CAPTION_DEFAULTS: dict = {
    "position_y": 0.55,
    "size_scale": 1.0,
    "padding_x": 64,
    "text_transform": "uppercase",
    "letter_spacing": -0.5,
    "line_height": 1.05,
    "font_weight": 900,
    "color": "#facc15",
    "outline_color": "#0f172a",
    "outline_width": 6,
    "active_word_color": "#ffffff",
    "spoken_word_color": "rgba(250, 204, 21, 0.45)",
    "entry_effect": "fade",
    "word_highlight": "karaoke",
}

_CAPTION_ENUMS: dict = {
    "text_transform": {"uppercase", "none", "lowercase"},
    "entry_effect": {"none", "fade", "pop", "slide-up"},
    "word_highlight": {"none", "karaoke", "color", "scale", "background"},
}

# (field, low, high) for numeric clamping.
_CAPTION_NUMERIC_RANGES: dict = {
    "position_y": (0.0, 1.0),
    "size_scale": (0.1, 3.0),
    "padding_x": (0, 200),
    "letter_spacing": (-10, 10),
    "line_height": (0.5, 3.0),
    "font_weight": (100, 900),
    "outline_width": (0, 12),
}


def _coerce_caption_field(field: str, raw: str | None):
    """Parse a raw setting string into a typed value, clamped to range. Returns
    the default + logs a warning on any parse failure so the operator can see
    which field misbehaved."""
    if raw is None or raw == "":
        return _CAPTION_DEFAULTS[field]
    default = _CAPTION_DEFAULTS[field]
    if field in _CAPTION_ENUMS:
        v = str(raw).strip().lower()
        if v in _CAPTION_ENUMS[field]:
            return v
        print(f"[caption template] {field!r} invalid enum value {raw!r}, using default {default!r}")
        return default
    if field in _CAPTION_NUMERIC_RANGES:
        try:
            v = float(raw)
        except (TypeError, ValueError):
            print(f"[caption template] {field!r} non-numeric value {raw!r}, using default {default!r}")
            return default
        low, high = _CAPTION_NUMERIC_RANGES[field]
        v = max(low, min(high, v))
        # font_weight + padding_x + outline_width are integers; keep them whole.
        if field in ("font_weight", "padding_x", "outline_width"):
            return int(round(v))
        return v
    # Color / string passthrough. Defensive: a few obvious bad inputs fall back.
    s = str(raw).strip()
    if len(s) > 80 or "javascript:" in s.lower() or "<" in s:
        print(f"[caption template] {field!r} rejected value (length/format), using default {default!r}")
        return default
    return s


def resolve_caption_template(get_setting) -> dict:
    """Walk the 14 `caption.*` settings keys, parse each, return a dict suitable
    for the Remotion composition's `config.caption_template` prop.

    `get_setting` is injected (function: key -> str | None) so tests can stub
    a fake store without touching the real DB.
    """
    return {
        field: _coerce_caption_field(field, get_setting(f"caption.{field}"))
        for field in _CAPTION_DEFAULTS
    }


def _aspect_segment(aspect: str | None) -> str | None:
    """Settings-key segment for an aspect. Colons aren't legal anywhere
    else in the dotted key namespace, so 16:9 / 9:16 become 16x9 / 9x16.
    Anything else returns None so the resolver simply skips the per-aspect
    tier."""
    if aspect == "16:9":
        return "16x9"
    if aspect == "9:16":
        return "9x16"
    return None


def resolve_caption_template_for(
    story_id: str | None,
    category: str | None,
    get_setting,
    aspect: str | None = None,
) -> dict:
    """Same shape as `resolve_caption_template`, but walks a three-tier scope
    chain so a per-story override beats a per-category override beats the
    global default.

    Phase 5 of _plans/2026-06-12-video-aspect-ratio.md adds an aspect
    dimension to the chain. When `aspect` is None the lookup is exactly
    the pre-Phase-5 three-tier chain — every existing render stays
    byte-identical. When an aspect is supplied each tier first looks for
    its aspect-specific subkey, then falls back to the aspect-agnostic
    key at the same tier:

      story-aspect: caption.story.<story_id>.<aspect>.<field>
      story:        caption.story.<story_id>.<field>
      cat-aspect:   caption.cat.<category>.<aspect>.<field>
      cat:          caption.cat.<category>.<field>
      global-aspect: caption.<aspect>.<field>
      global:       caption.<field>

    Within a tier, an empty string means "unset" so the resolver falls
    through to the next tier. That keeps the admin UX simple — clearing
    a field in the story-scope form unsets the override and the category/
    global value takes over without the admin having to delete the row
    by hand. The aspect segment in the key uses the safe transform from
    `_aspect_segment` (16x9 / 9x16) so the dotted namespace stays
    unambiguous.
    """
    aspect_segment = _aspect_segment(aspect)

    def pick(field: str) -> str | None:
        candidates: list[str | None] = []
        # story tier
        if story_id and aspect_segment:
            candidates.append(
                f"caption.story.{story_id}.{aspect_segment}.{field}"
            )
        if story_id:
            candidates.append(f"caption.story.{story_id}.{field}")
        # category tier
        if category and aspect_segment:
            candidates.append(
                f"caption.cat.{category}.{aspect_segment}.{field}"
            )
        if category:
            candidates.append(f"caption.cat.{category}.{field}")
        # global tier
        if aspect_segment:
            candidates.append(f"caption.{aspect_segment}.{field}")
        candidates.append(f"caption.{field}")

        for prefix in candidates:
            if prefix is None:
                continue
            v = get_setting(prefix)
            if v is not None and v != "":
                return v
        return None

    return {field: _coerce_caption_field(field, pick(field)) for field in _CAPTION_DEFAULTS}


def generate_video(
    story_id: str,
    title: str,
    image_urls: list[str],
    audio_url: str,
    alignment: list[dict],
    repo_root: Path,
    category: str | None = None,
    props_list: list[dict] | None = None,
    character_image_mouth_removed: str | None = None,
    story_row: dict | None = None,
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

    # Wave 3 Phase 3 PropSlideIn: stage each prop PNG alongside the other
    # static assets so the composition can resolve them via staticFile().
    # Each prop already has a url (GCS or /generated/ path); we copy the
    # backing file and rewrite the url to the relative staticFile-friendly
    # path. Empty list = nothing to stage, no work done.
    static_props: list[dict] = []
    for i, p in enumerate(props_list or []):
        url = p.get("url")
        if not url:
            continue
        try:
            src = _public_url_to_filesystem_path(repo_root, url, safe_id)
            if not src.exists():
                print(f"[video id={safe_id} prop {i + 1}] missing on disk: {src}")
                continue
            dst_dir = video_project / STATIC_DIR_RELATIVE / safe_id
            dst_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst_dir / src.name)
            static_props.append({
                "url": f"{safe_id}/{src.name}",
                "label": p.get("label"),
                "side": p.get("side"),
            })
        except Exception as e:
            print(f"[video id={safe_id} prop {i + 1}] stage FAILED: {e}")
    if static_props:
        print(f"[video id={safe_id} props] staged {len(static_props)} prop(s)")

    # Read the Ken-Burns toggle from settings (Wave 2). Default off so the
    # existing doodle look doesn't change without an admin explicitly turning
    # it on. Accepts '1', 'true', 'on', 'yes' (case-insensitive) as truthy.
    from pipeline import store as _store
    ken_burns_raw = (_store.get_setting("video.ken_burns") or "").strip().lower()
    ken_burns = ken_burns_raw in {"1", "true", "on", "yes"}

    # Wave 3 Phase 3: three composition-only motion beats. Each is off by
    # default so renders are byte-identical to today's output when the admin
    # hasn't touched the toggles. The composition reads each flag and skips
    # the layer entirely when off (no work done, no extra render cost).
    def _truthy(raw: str | None) -> bool:
        return (raw or "").strip().lower() in {"1", "true", "on", "yes"}

    motion = {
        "micro_wiggle": _truthy(_store.get_setting("video.micro_wiggle")),
        "label_pop": _truthy(_store.get_setting("video.label_pop")),
        "scribble_draw": _truthy(_store.get_setting("video.scribble_draw")),
        "prop_slide": _truthy(_store.get_setting("video.prop_slide")),
        "mouth_swap": _truthy(_store.get_setting("video.mouth_swap")),
    }
    print(
        f"[video id={safe_id} motion] micro_wiggle={motion['micro_wiggle']} "
        f"label_pop={motion['label_pop']} scribble_draw={motion['scribble_draw']} "
        f"prop_slide={motion['prop_slide']} mouth_swap={motion['mouth_swap']}"
    )

    # Wave 3 Phase 3 MouthSwap: stage the mouth-removed character bust as a
    # static asset so the composition can resolve it via staticFile(). We only
    # stage when the beat is enabled AND the row has a URL — keeps the file
    # work proportional to the actual render.
    static_character: str | None = None
    if motion["mouth_swap"] and character_image_mouth_removed:
        try:
            src = _public_url_to_filesystem_path(repo_root, character_image_mouth_removed, safe_id)
            if not src.exists():
                print(f"[video id={safe_id} mouth_swap] missing on disk: {src}")
            else:
                dst_dir = video_project / STATIC_DIR_RELATIVE / safe_id
                dst_dir.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst_dir / src.name)
                static_character = f"{safe_id}/{src.name}"
                print(f"[video id={safe_id} mouth_swap] staged {src.name}")
        except Exception as e:
            print(f"[video id={safe_id} mouth_swap] stage FAILED: {e}")

    # Phase 0/2 of _plans/2026-06-12-video-aspect-ratio.md: resolve the
    # canvas aspect for this render. Moved ahead of the caption template
    # resolver in Phase 5 so the per-aspect tier keys can be walked when
    # the admin has tuned a 16:9-specific caption layout.
    # We stamp it onto the props file so the renderer's calculateMetadata
    # picks it up AND onto the persisted video_config so re-runs preserve
    # the editor's choice without needing the lock map.
    resolved_aspect = resolve_aspect_for_story(story_row)
    print(f"[video id={safe_id} aspect] resolved={resolved_aspect}")

    # Wave 3 Phase 2 caption template resolution, extended by Phase 5 of
    # the aspect plan to walk an aspect dimension on top of the existing
    # three-tier scope chain. When the admin hasn't tuned anything per-
    # aspect, the resolver falls through to the aspect-agnostic tiers and
    # the rendered caption is byte-identical to today's output.
    caption_template = resolve_caption_template_for(
        safe_id,
        category,
        _store.get_setting,
        aspect=resolved_aspect,
    )
    print(
        f"[video id={safe_id} caption-template] {len(caption_template)} fields "
        f"resolved (scope chain: story={safe_id!r}, cat={category!r}, "
        f"aspect={resolved_aspect})"
    )

    config = {
        "voiceover_url": static_audio,
        "title": _truncate_title(title),
        "channel_name": "lorewire",
        "aspect": resolved_aspect,
        "duration_ms": duration_ms,
        "doodle_frames": doodle_frames,
        "captions": captions,
        "ken_burns": ken_burns,
        "caption_template": caption_template,
        "motion": motion,
        "props_list": static_props,
        "character_image_mouth_removed": static_character,
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

    # Wave 3 Phase 4 intro/outro splice. Resolve through the same store this
    # process already uses; the splice writes a temp sibling and atomically
    # renames over out_mp4 so gcs.publish always uploads the final file. A
    # splice failure logs and falls through to the body-only render rather
    # than aborting — better to ship a bare video than no video.
    try:
        intro_seg = segments.pick_segment(
            "intro", story_row, _store.get_setting, _store.fetch_segment
        )
        outro_seg = segments.pick_segment(
            "outro", story_row, _store.get_setting, _store.fetch_segment
        )
        print(
            f"[segment pick id={safe_id}] "
            f"intro={(intro_seg or {}).get('id') or 'none'} "
            f"outro={(outro_seg or {}).get('id') or 'none'}"
        )
        intro_local = segments.fetch_to_cache(intro_seg, repo_root) if intro_seg else None
        outro_local = segments.fetch_to_cache(outro_seg, repo_root) if outro_seg else None
        if intro_local or outro_local:
            tmp_out = out_mp4.with_name(out_mp4.stem + ".spliced.mp4")
            outro_lead_in_sec = segments.resolve_outro_lead_in_sec(_store.get_setting)
            segments.splice(
                out_mp4, intro_local, outro_local, tmp_out,
                context_id=safe_id,
                outro_lead_in_sec=outro_lead_in_sec,
            )
            tmp_out.replace(out_mp4)
    except Exception as e:
        print(f"[video splice id={safe_id}] FAILED: {e}; using body-only render")

    size_mb = out_mp4.stat().st_size / (1024 * 1024) if out_mp4.exists() else 0.0
    local_url = f"{media.PUBLIC_URL_PREFIX}/{safe_id}/video.mp4"
    stored_url = gcs.publish(out_mp4, f"{safe_id}/video.mp4", local_url)
    print(
        f"[video id={safe_id} render] done in {elapsed:.1f}s "
        f"({size_mb:.1f} MB at {stored_url})"
    )
    # 2026-06-11 video editor: lock-aware merge over any existing config so
    # this re-run doesn't clobber human edits. `current` is the parsed JSON
    # from the row (if any); merge_with_locks preserves every path the editor
    # stamped into `_locks` and carries `_edit_session` forward verbatim. A
    # brand-new row falls through to a straight write of the new config.
    from pipeline.video_config import merge_with_locks

    fresh_config = {**config, "config_version": 2}
    current_config: dict | None = None
    if story_row is not None:
        raw = story_row.get("video_config")
        if isinstance(raw, str) and raw:
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                print(
                    f"[video id={safe_id} config persist] existing video_config "
                    f"is not valid JSON; clobbering (likely first run after migration)"
                )
                parsed = None
            if isinstance(parsed, dict):
                current_config = parsed
        elif isinstance(raw, dict):
            current_config = raw

    persisted_config = merge_with_locks(current_config, fresh_config)
    lock_count = len((current_config or {}).get("_locks") or {})
    print(
        f"[video id={safe_id} config persist] writing video_config "
        f"(version=2, locked_fields={lock_count}, "
        f"{len(json.dumps(persisted_config))} bytes)"
    )
    return {"video_url": stored_url, "video_config": persisted_config}


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


def _public_url_to_filesystem_path(repo_root: Path, public_url: str, safe_id: str | None = None) -> Path:
    """Resolve the on-disk path that backs a story media URL.

    Three URL shapes are handled:
      - `/generated/<id>/<file>` — legacy local-only path, just join to public/.
      - `https://storage.googleapis.com/.../<id>/<file>?v=...` — GCS-hosted
        URL with a possible cache-bust query string. Strip query, take the
        basename, look in `lorewire-app/public/generated/<safe_id>/<basename>`
        since pipeline always writes the local copy first.
      - file:// or any other scheme — fall through to the legacy join, may
        produce a bogus path; caller logs and continues.
    """
    import urllib.parse
    parsed = urllib.parse.urlparse(public_url)
    if parsed.scheme in {"http", "https"}:
        # Remote URL: take the path basename and place under the story dir.
        basename = Path(parsed.path).name
        if safe_id:
            return (repo_root / media.PUBLIC_DIR_RELATIVE / safe_id / basename).resolve()
        # Without an id, try to derive it from the second-to-last path segment.
        parts = [p for p in parsed.path.split("/") if p]
        if len(parts) >= 2:
            return (repo_root / media.PUBLIC_DIR_RELATIVE / parts[-2] / basename).resolve()
        return (repo_root / media.PUBLIC_DIR_RELATIVE / basename).resolve()
    # Legacy local-only path. lstrip leading slashes so the join works.
    relative = parsed.path.lstrip("/")
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

    audio_src = _public_url_to_filesystem_path(repo_root, audio_url, safe_id)
    audio_filename = audio_src.name
    shutil.copy2(audio_src, static_dir / audio_filename)
    static_audio = f"{safe_id}/{audio_filename}"

    static_images: list[str] = []
    for url in image_urls:
        src = _public_url_to_filesystem_path(repo_root, url, safe_id)
        if not src.exists():
            print(f"[video stage] skipping missing image {src}")
            continue
        shutil.copy2(src, static_dir / src.name)
        static_images.append(f"{safe_id}/{src.name}")
    return {"audio": static_audio, "images": static_images}


# --- re-render CLI ------------------------------------------------------------

def rerender_from_db(story_id: str, repo_root: Path) -> dict:
    """Re-render an existing story's video from its persisted media columns.

    Reads `hero_image`, `images`, `audio_url`, and `alignment` from the
    `stories` row, calls `generate_video`, and writes `video_url` + a new
    `updated_at` back to the same row. Spends no API money — only CPU and
    disk. Returns the new column dict (`{}` on a clean failure).

    Reads through the store abstraction so it works against whichever driver
    the env points at (SQLite locally, Postgres when DATABASE_URL is set).
    """
    import datetime
    from pipeline import config, store

    safe_id = media._sanitize_id(story_id)
    row = store.fetch_story(safe_id)
    if not row:
        driver = "Postgres" if config.env("DATABASE_URL") else f"SQLite ({config.DB_PATH})"
        print(f"[video id={safe_id}] no story with that id in {driver}")
        return {}

    hero = row.get("hero_image")
    try:
        scenes = json.loads(row.get("images") or "[]")
    except json.JSONDecodeError:
        scenes = []
    image_urls = ([hero] if hero else []) + list(scenes)
    try:
        alignment = json.loads(row.get("alignment") or "[]")
    except json.JSONDecodeError:
        alignment = []

    try:
        props_list = json.loads(row.get("props") or "[]")
    except json.JSONDecodeError:
        props_list = []
    cols = generate_video(
        safe_id,
        row.get("title") or "",
        image_urls,
        row.get("audio_url") or "",
        alignment,
        repo_root=repo_root,
        category=row.get("category"),
        props_list=props_list,
        character_image_mouth_removed=row.get("character_image_mouth_removed"),
        story_row=row,
    )
    if "video_url" in cols:
        # Merge the new video_url back through the same store the row came
        # from so the write lands in whichever driver is active. We re-upsert
        # only the columns the video stage owns; everything else is preserved
        # by the upsert's ON CONFLICT clause writing only the named columns.
        # 2026-06-11: also persist video_config so the editor and renderer
        # share one source of truth (see _plans/2026-06-11-video-editor.md).
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        merged = {**row, "video_url": cols["video_url"], "updated_at": now}
        if "video_config" in cols:
            merged["video_config"] = cols["video_config"]
        store.upsert_story(merged)
    return cols


def _cli() -> None:
    import argparse
    ap = argparse.ArgumentParser(
        description="Re-render the doodle short for an existing story.",
    )
    ap.add_argument("story_id", help="The stories.id to re-render (e.g. 'envelope').")
    args = ap.parse_args()
    cols = rerender_from_db(args.story_id, Path(__file__).resolve().parent.parent)
    if not cols:
        raise SystemExit(1)


if __name__ == "__main__":
    _cli()
