"""Lane B builder: voice + assembly re-render for an existing short.

Phase 3 of _plans/2026-06-16-short-editor-full-parity.md.

Flow:
  TS Lane B action ──► insert short_renders row
                       (status='queued', props=NULL, lane='B',
                        lane_inputs={script, voice, source_render_id})
                       │
                       ▼
              generation drain claims it (filter: props IS NULL)
                       │
                       ▼
              build_short_props_lane_b(claimed, repo_root, ...)
                  1. read lane_inputs
                  2. read baseline short_render's props (frames + character)
                  3. voice.synthesize(script, override_provider=voice.provider,
                                       override_voice_id=voice.voice_id)
                  4. video._chunk_alignment(words) → new captions
                  5. assemble props: baseline frames + new voice + new captions
                  6. return BuiltPropsResult; drain calls store_short_props
                     and nulls the lane column so render drain picks it up

We reuse video.gcs.publish for the new audio file (so the URL is stable
across the render drain's Cloud Run POST). The baseline's frame URLs are
left untouched — Lane B's whole point is "everything except audio +
captions stays."

Errors raise; the drain handler catches them and marks the row failed
with a useful message in the error column.
"""
from __future__ import annotations

import json
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from pipeline import gcs, store, video, voice

# Shared with shorts_render.SHORT_ID_SUFFIX so the staged files end up in the
# same GCS prefix that the original short uses. Keeps Cloud Run's render
# observability sane: one folder per story-short, not one per re-render.
SHORT_ID_SUFFIX = "-short"


@dataclass(frozen=True)
class LaneBBuilt:
    props: dict[str, Any]


ProgressFn = Callable[..., None]


def _safe_id(story_id: str) -> str:
    # Mirror video._sanitize_id without re-importing media.py at module load
    # (media.py pulls in heavy deps). Story ids are already URL-safe by
    # convention; this is belt-and-braces.
    return re.sub(r"[^A-Za-z0-9_\-]", "-", story_id)


def build_short_props_lane_b(
    claimed: dict,
    repo_root: Path,
    *,
    remote: bool = True,
    on_progress: ProgressFn | None = None,
) -> LaneBBuilt:
    """Run the Lane B path for the claimed short_renders row.

    Raises ValueError on any user-visible misconfiguration (lane_inputs
    missing or malformed, source_render_id unknown, baseline props
    unparseable). Raises RuntimeError on synthesis / staging failures.
    """
    inputs = _parse_lane_inputs(claimed)
    script = inputs["script"].strip()
    if not script:
        raise ValueError("Lane B inputs missing 'script' (or it is blank)")
    # Min-length floor (defense in depth — TS action also checks). A
    # 1-character script burns a TTS call for nothing useful; 10 chars
    # is roughly two words, the smallest size where alignment chunking
    # yields a usable caption.
    if len(script) < 10:
        raise ValueError(
            f"Lane B script is too short for synthesis "
            f"({len(script)}/10 chars minimum)"
        )

    source_render_id = inputs["source_render_id"]
    baseline = store.get_short_render(source_render_id)
    if not baseline:
        raise ValueError(f"baseline render {source_render_id!r} not found")
    if not baseline.get("props"):
        raise ValueError(
            f"baseline render {source_render_id!r} has no props — "
            f"can't reuse frames for Lane B"
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

    story_id = claimed["story_id"]
    safe_story = _safe_id(story_id)
    safe_id = safe_story + SHORT_ID_SUFFIX

    if on_progress is not None:
        try:
            on_progress("voice")
        except Exception:
            pass

    voice_override = inputs.get("voice") or {}
    provider = voice_override.get("provider") or None
    voice_id = voice_override.get("voice_id") or None

    if remote:
        work_dir = Path(tempfile.mkdtemp(prefix=f"{safe_id}-laneB-"))
    else:
        work_dir = repo_root / video.VIDEO_PROJECT_RELATIVE / video.STATIC_DIR_RELATIVE / safe_id
        work_dir.mkdir(parents=True, exist_ok=True)

    audio_path = work_dir / "voice.mp3"
    vres = voice.synthesize(
        script,
        audio_path,
        override_provider=provider,
        override_voice_id=voice_id,
    )
    captions = video._chunk_alignment(vres.get("words") or [])
    if not captions:
        raise RuntimeError(
            "Lane B voice synthesis produced no caption chunks "
            "(empty alignment)"
        )
    duration_ms = max(int(captions[-1]["end_ms"]), 1)

    if on_progress is not None:
        try:
            on_progress("stage")
        except Exception:
            pass

    # Re-uploading the audio under a Lane-B-suffixed path keeps the original
    # short's voice MP3 retrievable for an A/B compare. The render drain
    # POSTs the new URL to Cloud Run.
    audio_ref = (
        gcs.publish(audio_path, f"{safe_id}/voice-laneB.mp3", str(audio_path))
        if remote else f"{safe_id}/voice.mp3"
    )

    # Merge: keep everything from the baseline EXCEPT voiceover_url +
    # captions + duration_ms (the three fields the new audio drives). The
    # caller (drain handler) flips lane -> NULL so the render drain claims
    # the row immediately after this returns. Caption style: if the editor
    # has any short_config.caption_style override, merge it onto the
    # baseline's caption_template so the render reflects the picked
    # colors / highlight / animation / position. Editor-side wires the same
    # merge into Lane A; Lane C does it from a single helper too.
    story = store.fetch_story(story_id)
    style_override = store.read_short_caption_style(story) if story else {}
    baseline_template = baseline_props.get("caption_template") or {}
    if not isinstance(baseline_template, dict):
        baseline_template = {}
    new_props = {
        **baseline_props,
        "voiceover_url": audio_ref,
        "captions": captions,
        "duration_ms": duration_ms,
    }
    if style_override:
        new_props["caption_template"] = {**baseline_template, **style_override}

    if on_progress is not None:
        try:
            on_progress("render")
        except Exception:
            pass

    return LaneBBuilt(props=new_props)


def _parse_lane_inputs(claimed: dict) -> dict[str, Any]:
    raw = claimed.get("lane_inputs")
    if not raw:
        raise ValueError("Lane B row has no lane_inputs payload")
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as e:
        raise ValueError(f"Lane B lane_inputs is malformed JSON: {e}") from e
    if not isinstance(parsed, dict):
        raise ValueError("Lane B lane_inputs is not a JSON object")
    if "source_render_id" not in parsed or not isinstance(
        parsed["source_render_id"], str
    ):
        raise ValueError(
            "Lane B lane_inputs missing 'source_render_id' (or wrong type)"
        )
    if "script" not in parsed or not isinstance(parsed["script"], str):
        raise ValueError(
            "Lane B lane_inputs missing 'script' (or wrong type)"
        )
    if "voice" in parsed and parsed["voice"] is not None:
        v = parsed["voice"]
        if not isinstance(v, dict) or not isinstance(
            v.get("provider"), str
        ) or not isinstance(v.get("voice_id"), str):
            raise ValueError(
                "Lane B lane_inputs 'voice' must be "
                "{provider:string, voice_id:string} or null"
            )
    return parsed


def clear_lane(render_id: str) -> None:
    """Flip lane: 'B' -> NULL once the build finishes so the render drain
    picks up the row on its next tick. lane_inputs is kept for audit; the
    builder never reads it again."""
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
