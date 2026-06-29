"""Per-scene regenerate handler for article shorts.

Phase 1 of _plans/2026-06-16-short-editor-full-parity.md. Image renders
queued with `owner_kind = 'short_scene'` route here. The flow:

    image_renders row queued ──► pipeline.image_render_worker
                                  │
                                  ▼
                            shorts_scene_regen.regen_short_scene(
                                story_id, asset='frame:<id>', repo_root,
                            )
                                  │
                                  ▼
              read stories.short_config → find frame by id
              kie gpt-image-2-i2i (image_prompt + character_base_url)
              download → publish to GCS
              update frame {url, prev_image, is_pinned=True}
              update_story_short_config(...)
              return (public_url, cost_cents)

We deliberately reuse the same _generate_with_retry helper media.py uses
for video frames, so the retry + log shape is identical to the
established surface. The cost figure also matches the per-image gpt-image-2
rate captured in media._per_image_cost_cents().

The is_pinned=True stamp is the load-bearing flag that protects an
admin's manual edit from a future full Regenerate (force=true) — the
enqueueShortRender path checks it before clearing props.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pipeline import gcs, images, media, store


def regen_short_scene(
    story_id: str,
    asset: str,
    repo_root: Path,
) -> tuple[str, int]:
    """Regenerate one scene image inside a short_config.

    `asset` slug is `frame:<frame_id>` — we mirror the video-pipeline
    convention so the queue + worker layers don't need a special case.
    Raises ValueError on any malformed input (config missing / unparseable,
    frame id not found, no image_prompt persisted, no character_base_url).
    The worker catches these and writes them as the failed row's error
    string so the admin UI surfaces a useful message.
    """
    if not asset.startswith("frame:"):
        raise ValueError(
            f"shorts_scene_regen expects 'frame:<id>' asset slug, got {asset!r}"
        )
    _, _, frame_id = asset.partition(":")
    if not frame_id:
        raise ValueError(f"asset {asset!r} missing frame id after colon")

    safe_id = media._sanitize_id(story_id)
    story = store.fetch_story(story_id)
    if story is None:
        raise ValueError(f"story {story_id!r} not found")

    config = _load_short_config(story, safe_id)

    frames = config.get("doodle_frames")
    if not isinstance(frames, list):
        raise ValueError(
            f"story {safe_id} short_config.doodle_frames is not a list"
        )

    frame_idx: int | None = None
    for i, f in enumerate(frames):
        if isinstance(f, dict) and f.get("id") == frame_id:
            frame_idx = i
            break
    if frame_idx is None:
        raise ValueError(
            f"frame id {frame_id!r} not found in story {safe_id} short_config"
        )

    frame = frames[frame_idx]
    prompt = (frame.get("image_prompt") or "").strip()
    if not prompt:
        raise ValueError(
            f"frame {frame_id!r} on story {safe_id} has no image_prompt to "
            f"regenerate from — set one in the editor first"
        )

    character_base_url = (config.get("character_base_url") or "").strip()
    if not character_base_url:
        raise ValueError(
            f"story {safe_id} short_config.character_base_url missing — "
            f"i2i needs the base character image to keep identity stable"
        )

    # Multi-ref input: prefer the SAME ordered ref list the original
    # generation used (base + this scene's supporting chars / locations /
    # items), so a regen preserves the world-bible consistency the initial
    # render established. Fall back to base-only for legacy frames that
    # pre-date the world-bible feature and have no `image_input_urls`
    # field — they still get a regen, just without the multi-ref boost.
    frame_refs = frame.get("image_input_urls")
    if isinstance(frame_refs, list) and frame_refs:
        ref_urls = [u for u in frame_refs if isinstance(u, str) and u.strip()]
        if not ref_urls or ref_urls[0] != character_base_url:
            # Force the base character to lead the input list so identity
            # stays anchored — the documented strongest method is base-first
            # then supporting refs. A malformed persisted list (missing or
            # wrong-position base) would otherwise drift identity on regen.
            ref_urls = [character_base_url] + [
                u for u in ref_urls if u != character_base_url
            ]
    else:
        ref_urls = [character_base_url]

    out_dir = media._regen_out_dir(repo_root, f"shorts-{safe_id}")
    out_dir.mkdir(parents=True, exist_ok=True)

    filename = f"short-{safe_id}-frame-{frame_id}.png"
    public_url = f"{media.PUBLIC_URL_PREFIX}/{safe_id}/{filename}"
    label = f"short-frame-{frame_id}"

    print(
        f"[short scene regen start] id={safe_id} frame={frame_id} "
        f"prompt_chars={len(prompt)} refs={len(ref_urls)}"
    )

    # gpt-image-2-i2i: identity locked by the base + world-bible refs in
    # input_urls. 9:16 aspect to match the rest of the short's frames.
    kie_url = media._generate_with_retry(
        prompt,
        f"id={safe_id} {label} per-scene regen",
        aspect_ratio="9:16",
        image_input=ref_urls,
        model="kie/gpt-image-2-i2i",
    )
    if kie_url is None:
        raise RuntimeError(f"kie returned no URL for {label}")

    local_path = out_dir / filename
    images.download(kie_url, local_path)
    stored_url = gcs.publish(local_path, f"{safe_id}/{filename}", public_url)

    # Snapshot the prior frame so the editor can offer a one-click Revert
    # without paying for another kie call. ISO now for the timestamp.
    prev_image = {
        "url": frame.get("url"),
        "image_prompt": frame.get("image_prompt"),
        "replaced_at": store._now_iso(),
    }
    new_frame = {
        **frame,
        "url": stored_url,
        "is_pinned": True,
        "prev_image": prev_image,
    }
    new_frames = [dict(f) if isinstance(f, dict) else f for f in frames]
    new_frames[frame_idx] = new_frame
    new_config = {**config, "doodle_frames": new_frames}
    store.update_story_short_config(story_id, new_config)

    cents = media._per_image_cost_cents()
    print(f"[short scene regen done] id={safe_id} frame={frame_id} cents={cents}")
    return stored_url, cents


def _load_short_config(story: dict, safe_id: str) -> dict[str, Any]:
    raw = story.get("short_config")
    if not raw:
        raise ValueError(
            f"story {safe_id} has no short_config — open the editor first "
            f"to seed it from the most recent successful short_render"
        )
    try:
        config = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as e:
        raise ValueError(
            f"story {safe_id} short_config is malformed JSON: {e}"
        ) from e
    if not isinstance(config, dict):
        raise ValueError(
            f"story {safe_id} short_config is not a JSON object"
        )
    return config
