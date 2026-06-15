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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from pipeline import shorts_scene_regen, store


@dataclass(frozen=True)
class LaneCBuilt:
    props: dict[str, Any]
    regen_count: int


ProgressFn = Callable[..., None]


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
            new_frames.append({**bf, "url": sc["url"]})
        else:
            new_frames.append(bf)

    new_props = {**baseline_props, "doodle_frames": new_frames}
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
