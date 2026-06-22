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

from pipeline import gcs, narration, shorts_narration, store, video, voice

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
    # `narration.render_narration` applies the normalize -> TTS ->
    # script-graft pipeline so Lane B's voice swap inherits the same
    # caption-accuracy fix as the baseline render.
    # Same codified delivery as the full-generation path (1.2x pace + hook
    # pause) so a voice re-render matches the original short's feel. The voice
    # itself stays the editor's pick (provider/voice_id from lane_inputs);
    # unset falls back to the global Autonoe default. No structured hook here,
    # so the pause anchors on the first sentence (render_narration fallback).
    vres = narration.render_narration(
        script,
        audio_path,
        override_provider=provider,
        override_voice_id=voice_id,
        speaking_rate=shorts_narration.SHORTS_SPEAKING_RATE,
        hook_pause=shorts_narration.SHORTS_HOOK_PAUSE,
    )
    caption_chunks = video._chunk_alignment(vres.get("words") or [])
    if not caption_chunks:
        raise RuntimeError(
            "Lane B voice synthesis produced no caption chunks "
            "(empty alignment)"
        )
    # Floor the body length at the real MP3 duration so the re-rendered short's
    # concatenated outro can't clip the new narration's closing words — the
    # last caption end_ms undershoots the real audio on some providers. Mirror
    # of the full-render path in shorts_render.build_short_props. Also extend
    # the last caption's end_ms to cover the trailing audio so the on-screen
    # text stays present until the audio actually ends.
    caption_end_ms = int(caption_chunks[-1]["end_ms"])
    audio_ms = voice.audio_duration_ms(audio_path)
    duration_ms = max(caption_end_ms, audio_ms, 1)
    if audio_ms > caption_end_ms:
        print(
            f"[short laneB duration] audio={audio_ms}ms > "
            f"caption_end={caption_end_ms}ms — extending body + last caption"
        )
        caption_chunks[-1] = {**caption_chunks[-1], "end_ms": audio_ms}

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
        "captions": caption_chunks,
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


def sync_short_config_captions(story_id: str, props: dict[str, Any]) -> bool:
    """Mirror a Lane B render's regenerated voice fields back into the editor's
    short_config so the editor's live preview + Captions tab match the new
    voiceover. The rendered MP4 already reads the render row's props and is
    correct; this only closes the editor-display gap (the editor reads
    short_config, which a voice re-render otherwise never updates).

    Only the three fields the new voiceover drives are synced — captions,
    voiceover_url, duration_ms — so it can't clobber pinned frames, caption
    style, or pending manual caption edits (those flow through Lane A, which
    writes short_config first). Captions are normalised to the
    ShortCaptionChunk shape ({start_ms,end_ms,text}) the TS schema validates;
    the per-word boundaries the render carries are dropped (short_config
    doesn't store them).

    Best-effort: returns False (and never raises on a missing/malformed config)
    so a sync miss can't fail an otherwise-good render.
    """
    story = store.fetch_story(story_id)
    if not story or not story.get("short_config"):
        return False
    try:
        config = json.loads(story["short_config"])
    except (json.JSONDecodeError, TypeError):
        return False
    if not isinstance(config, dict):
        return False
    config["captions"] = [
        {
            "start_ms": int(c["start_ms"]),
            "end_ms": int(c["end_ms"]),
            "text": str(c.get("text", "")),
        }
        for c in (props.get("captions") or [])
        if isinstance(c, dict) and "start_ms" in c and "end_ms" in c
    ]
    if props.get("voiceover_url"):
        config["voiceover_url"] = props["voiceover_url"]
    if props.get("duration_ms"):
        config["duration_ms"] = int(props["duration_ms"])
    store.update_story_short_config(story_id, config)
    return True


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
