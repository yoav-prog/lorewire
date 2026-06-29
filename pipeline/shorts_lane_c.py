"""Lane C builder: per-scene + assembly partial re-render.

Phase 4 of _plans/2026-06-16-short-editor-full-parity.md.

Flow:
  TS Lane C action ──► insert short_renders row
                       (status='queued', props=NULL, lane='C',
                        lane_inputs={touched_frame_ids:[...],
                                     source_render_id})
                       │
                       ▼
              generation drain claims it (filter: props IS NULL)
                       │
                       ▼
              build_short_props_lane_c(claimed, ...)
                  1. read lane_inputs
                  2. load baseline short_render's props (frames + voice +
                     captions stay; only touched frames change)
                  3. for each touched frame_id:
                       shorts_scene_regen.regen_short_scene(story_id,
                                                            f"frame:<id>")
                       — this updates stories.short_config in place
                       (new url + prev_image + is_pinned=true)
                  4. read the updated short_config to pull the new urls
                  5. merge: baseline frames with new urls swapped in;
                     everything else (voice, captions, character) from
                     the baseline
                  6. return BuiltPropsResult; drain stores props and
                     nulls lane → render drain claims the row

We regen touched scenes IN-BAND on the drain tick (one Vercel cron tick,
~300s budget). With ~10s per kie i2i call this fits ~30 scenes per tick
— well above the typical short's 10-14 scenes.

Errors raise; the drain handler catches them and marks the row failed
with a useful message in the error column.
"""
from __future__ import annotations

import json
import tempfile
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from pipeline import shorts_scene_regen, store, voice

# Mirror of pipeline.shorts_render.SHORT_END_HOLD_MS — the post-roll hold on the
# final scene. Lane C copies through baseline props; baselines rendered before
# end_hold_ms existed do not carry the field, so this constant backfills it on
# every Lane C build. Defensive: a missing end_hold_ms used to mean the outro
# spliced in immediately after the body, clipping the closing word.
SHORT_END_HOLD_MS = 1500


@dataclass(frozen=True)
class LaneCBuilt:
    props: dict[str, Any]
    regen_count: int


ProgressFn = Callable[..., None]


def _cache_bust(url: str, token: str) -> str:
    """Append `?v=<token>` so the editor's image cache misses for this render.
    Mirror of pipeline.shorts_render._cache_bust — see that docstring for why
    the underlying GCS object is addressable regardless of the query string."""
    if not isinstance(url, str) or not url:
        return url
    if not token:
        return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}v={token}"


def _probe_baseline_audio_ms(voice_url: str) -> int:
    """Download the baseline's voice MP3 to a temp file and probe its real
    duration in milliseconds. Returns 0 on any failure (HTTP / file / parse) so
    the caller can fall back to the baseline's caption-derived duration.

    Lane C reuses the baseline's voice + captions verbatim, but baselines
    rendered before pipeline.voice.audio_duration_ms existed may carry a
    duration_ms that doesn't match the actual audio (last caption padded past
    audio end, or audio runs past last caption — both happen with different
    TTS providers). Re-probing here lets Lane C sanitize stale baseline data
    so the new MP4 isn't poisoned by inherited bugs."""
    if not isinstance(voice_url, str) or not voice_url:
        return 0
    # Strip cache-bust query before fetching; the underlying object is at the
    # bare URL. Some HTTP clients are picky about unknown query params.
    fetch_url = voice_url.split("?", 1)[0] if "?" in voice_url else voice_url
    if not fetch_url.startswith(("http://", "https://")):
        # Local staticFile-style path; the caller's repo_root tree carries the
        # MP3 directly. Caller can probe by path; we only support remote here.
        return 0
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp3") as tmp:
            tmp_path = Path(tmp.name)
        with urllib.request.urlopen(fetch_url, timeout=15) as resp:
            tmp_path.write_bytes(resp.read())
        try:
            return voice.audio_duration_ms(tmp_path)
        finally:
            try:
                tmp_path.unlink()
            except OSError:
                pass
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as e:
        print(f"[short laneC audio_probe] {fetch_url!r} FAILED: {e}")
        return 0


def _sanitize_baseline_audio_metadata(
    baseline_props: dict[str, Any], voice_url: str
) -> tuple[list[dict], int, int]:
    """Reconcile the baseline's captions + duration with the actual voice file.

    Returns `(captions, duration_ms, audio_ms)` where:
    - `captions` is the baseline caption list with any chunks past the actual
      audio length dropped, and the last surviving chunk's end_ms clamped to
      the audio length (so the on-screen caption stays present until the audio
      finishes — no padded "phantom captions" describing words that aren't in
      the audio).
    - `duration_ms` is `max(captions[-1].end_ms, audio_ms, 1)` — the body
      length the renderer should use. Always covers all spoken content.
    - `audio_ms` is the probe value, 0 when the probe couldn't reach the URL
      (caller should treat that as "trust baseline duration, do nothing").

    Falls back to baseline-as-is on probe failure — never makes things worse.
    """
    raw_captions = baseline_props.get("captions") or []
    if not isinstance(raw_captions, list):
        raw_captions = []
    captions = [c for c in raw_captions if isinstance(c, dict)]
    audio_ms = _probe_baseline_audio_ms(voice_url)
    if audio_ms <= 0:
        # Probe failed — trust the baseline and keep the original duration.
        # This is the safe fallback: we can't make things worse, only better.
        baseline_duration = int(baseline_props.get("duration_ms") or 0)
        if captions:
            baseline_caption_end = int(captions[-1].get("end_ms") or 0)
        else:
            baseline_caption_end = 0
        duration_ms = max(baseline_caption_end, baseline_duration, 1)
        return captions, duration_ms, 0
    # Phantom-caption guard: drop any chunks that START past the actual audio.
    # The user reads them but never hears them — feels like "captions don't
    # match the narration". Keep at least one caption so the renderer has
    # something to display.
    trimmed: list[dict] = []
    for c in captions:
        start = int(c.get("start_ms") or 0)
        if start < audio_ms:
            trimmed.append(c)
    if not trimmed and captions:
        trimmed = [captions[0]]
    # Clamp the last surviving caption's end_ms to the actual audio length so
    # the on-screen text stays present until the audio finishes but doesn't
    # extend past the silence + outro boundary.
    if trimmed:
        last = trimmed[-1]
        last_end = int(last.get("end_ms") or 0)
        if last_end != audio_ms:
            trimmed[-1] = {**last, "end_ms": audio_ms}
    caption_end_ms = int(trimmed[-1]["end_ms"]) if trimmed else 0
    duration_ms = max(caption_end_ms, audio_ms, 1)
    return trimmed, duration_ms, audio_ms


def build_short_props_lane_c(
    claimed: dict,
    repo_root: Path,
    *,
    remote: bool = True,
    on_progress: ProgressFn | None = None,
) -> LaneCBuilt:
    """Run the Lane C path for the claimed short_renders row.

    Raises ValueError on any user-visible misconfiguration (lane_inputs
    missing or malformed, source baseline unknown, baseline props
    unparseable, touched_frame_ids empty). Raises whatever
    shorts_scene_regen raises on a per-frame failure — we surface the
    first failure rather than partial-success the row, so the admin can
    re-queue after fixing the underlying problem.
    """
    inputs = _parse_lane_inputs(claimed)
    source_render_id = inputs["source_render_id"]
    touched: list[str] = list(inputs["touched_frame_ids"])

    if not touched:
        raise ValueError(
            "Lane C lane_inputs has empty touched_frame_ids — nothing to regen"
        )

    baseline = store.get_short_render(source_render_id)
    if not baseline:
        raise ValueError(f"baseline render {source_render_id!r} not found")
    if not baseline.get("props"):
        raise ValueError(
            f"baseline render {source_render_id!r} has no props — "
            f"can't reuse frames for Lane C"
        )
    try:
        baseline_props = json.loads(baseline["props"])
    except (json.JSONDecodeError, TypeError) as e:
        raise ValueError(
            f"baseline render {source_render_id!r} props is malformed: {e}"
        ) from e
    if not isinstance(baseline_props, dict):
        raise ValueError(
            f"baseline render {source_render_id!r} props is not a JSON object"
        )

    baseline_frames = baseline_props.get("doodle_frames")
    if not isinstance(baseline_frames, list):
        raise ValueError(
            f"baseline render {source_render_id!r} props.doodle_frames is not a list"
        )

    story_id = claimed["story_id"]

    # Regen each touched scene inline. Progress reports on every scene so
    # the editor's progress bar advances mid-Lane-C.
    total = len(touched)
    for i, frame_id in enumerate(touched):
        if on_progress is not None:
            try:
                on_progress("scene", i, total)
            except Exception:
                pass
        # shorts_scene_regen reads image_prompt + character_base_url off
        # the persisted short_config and writes the new url +
        # is_pinned=true + prev_image back. We don't need its return
        # value; the merge step below reads from short_config.
        shorts_scene_regen.regen_short_scene(
            story_id, f"frame:{frame_id}", repo_root,
        )

    if on_progress is not None:
        try:
            on_progress("stage")
        except Exception:
            pass

    # Read the post-regen short_config to pull the new URLs.
    story = store.fetch_story(story_id)
    if not story or not story.get("short_config"):
        raise RuntimeError(
            f"story {story_id!r} short_config missing after Lane C regens"
        )
    try:
        short_config = json.loads(story["short_config"])
    except (json.JSONDecodeError, TypeError) as e:
        raise RuntimeError(
            f"story {story_id!r} short_config malformed after Lane C regens: {e}"
        ) from e
    sc_frames = short_config.get("doodle_frames") or []
    sc_map = {
        f["id"]: f for f in sc_frames if isinstance(f, dict) and "id" in f
    }

    # Per-Lane-C cache-bust token: every URL the editor displays (each frame
    # plus the voice URL) carries `?v=<token>` so the browser sees fresh URLs
    # the moment this build lands. The underlying GCS objects keep their
    # stable paths — Cloud Run resolves them normally. Without the bust the
    # editor shows the previous render's cached bytes even though the new
    # short was successfully rendered.
    cache_token = uuid.uuid4().hex[:8]

    # Merge: walk baseline frames in order (preserves caption_chunk_start_index
    # + any per-frame metadata the renderer cares about). Swap url to the
    # short_config value for every id that has one — including ids the admin
    # didn't touch this session (a frame regenerated in a prior session via
    # the Scenes tab is also pinned in short_config; reuse that work too).
    new_frames: list[dict[str, Any]] = []
    for bf in baseline_frames:
        if not isinstance(bf, dict):
            new_frames.append(bf)
            continue
        fid = bf.get("id")
        sc = sc_map.get(fid) if isinstance(fid, str) else None
        if sc and isinstance(sc.get("url"), str):
            merged = {**bf, "url": sc["url"]}
        else:
            merged = dict(bf)
        if isinstance(merged.get("url"), str):
            merged["url"] = _cache_bust(merged["url"], cache_token)
        new_frames.append(merged)

    # Caption style: read the editor's short_config.caption_style override
    # and merge it onto the baseline's caption_template so a style edit
    # bundled with a per-scene regen rolls into the same Lane C MP4.
    # Same merge contract as Lane A (TS) and Lane B (Python).
    style_override = store.read_short_caption_style(story) if story else {}
    baseline_template = baseline_props.get("caption_template") or {}
    if not isinstance(baseline_template, dict):
        baseline_template = {}

    # Sanitize baseline audio metadata: re-probe the baseline's voice MP3 and
    # reconcile duration_ms + captions against the real audio length. This
    # closes the failure mode where a baseline rendered BEFORE the audio-
    # duration floor existed carries a stale duration / phantom captions
    # past the audio end — Lane C used to inherit those bugs verbatim. The
    # probe is best-effort: on failure we trust the baseline as-is.
    baseline_voice_url = str(baseline_props.get("voiceover_url") or "")
    sanitized_captions, sanitized_duration_ms, audio_ms = (
        _sanitize_baseline_audio_metadata(baseline_props, baseline_voice_url)
    )
    print(
        f"[short laneC audio] story={story_id} baseline_duration="
        f"{baseline_props.get('duration_ms')}ms audio_probe={audio_ms}ms "
        f"sanitized_duration={sanitized_duration_ms}ms "
        f"captions_before={len(baseline_props.get('captions') or [])} "
        f"captions_after={len(sanitized_captions)}"
    )

    new_props = {
        **baseline_props,
        "doodle_frames": new_frames,
        "duration_ms": sanitized_duration_ms,
        "captions": sanitized_captions,
        # end_hold_ms wasn't in baselines rendered before 61a4ba0 / 6775c13
        # cherry-pick; backfill so the post-roll hold always applies and the
        # outro can't splice in immediately at body end.
        "end_hold_ms": int(baseline_props.get("end_hold_ms") or SHORT_END_HOLD_MS),
        # Cache-bust the baseline's voice URL too, so the editor's audio
        # preview refetches when this build lands.
        "voiceover_url": _cache_bust(baseline_voice_url, cache_token),
    }
    if style_override:
        new_props["caption_template"] = {**baseline_template, **style_override}
    return LaneCBuilt(props=new_props, regen_count=total)


def _parse_lane_inputs(claimed: dict) -> dict[str, Any]:
    raw = claimed.get("lane_inputs")
    if not raw:
        raise ValueError("Lane C row has no lane_inputs payload")
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as e:
        raise ValueError(f"Lane C lane_inputs is malformed JSON: {e}") from e
    if not isinstance(parsed, dict):
        raise ValueError("Lane C lane_inputs is not a JSON object")
    if "source_render_id" not in parsed or not isinstance(
        parsed["source_render_id"], str
    ):
        raise ValueError(
            "Lane C lane_inputs missing 'source_render_id' (or wrong type)"
        )
    tf = parsed.get("touched_frame_ids")
    if not isinstance(tf, list) or not all(isinstance(x, str) for x in tf):
        raise ValueError(
            "Lane C lane_inputs 'touched_frame_ids' must be a list of strings"
        )
    return parsed


def clear_lane(render_id: str) -> None:
    """Flip lane: 'C' -> NULL once the build finishes so the render drain
    picks up the row on its next tick. lane_inputs is kept for audit."""
    if store._is_postgres():
        with store._pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE short_renders SET lane = NULL WHERE id = %s",
                    (render_id,),
                )
            conn.commit()
        return
    with store._sqlite_conn() as c:
        c.execute(
            "UPDATE short_renders SET lane = NULL WHERE id = ?", (render_id,),
        )
