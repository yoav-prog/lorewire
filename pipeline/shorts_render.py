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
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from pipeline import gcs, images, media, narration, shorts, shorts_narration, store, video, voice
from pipeline.question_card import (
    QUESTION_CARD_MS,
    build_question_card,
)

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


def _cache_bust(url: str, token: str) -> str:
    """Append `?v=<token>` so a regenerated short surfaces to the editor with
    a fresh URL the browser doesn't have cached. GCS objects keep the same
    underlying path (the renderer overwrites `frame-NN.png` per render so the
    GCS bucket doesn't accumulate orphans), but the browser caches by URL —
    without the bust, the editor shows the previous render's bytes from cache
    even though GCS now serves the new ones. Query strings don't affect GCS
    object resolution or signed URL semantics; the token is opaque metadata.
    Returns the url unchanged on empty / non-string input."""
    if not isinstance(url, str) or not url:
        return url
    if not token:
        return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}v={token}"


@dataclass
class ShortProps:
    """The DoodleShort props plus the staged asset id. `props` is the dict the
    Remotion composition consumes (local staticFile paths or remote GCS URLs)."""
    safe_id: str
    props: dict


# Question-card resolver lives in pipeline.question_card so both the
# short and the long-form video render paths use one source of truth.
# Re-exported as private names below to preserve the existing test
# call sites that reach in through `shorts_render._build_question_card`.
_build_question_card = build_question_card


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
            "image_input_urls": f.get("image_input_urls") or [],
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
        if it.get("image_input_urls"):
            frame["image_input_urls"] = it["image_input_urls"]
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

    # Plant the bundled poll draft from the narration pass (hook-first
    # restructure, _plans/2026-06-21-shorts-hook-first-restructure.md §5.3).
    # The script LLM produces a poll alongside the script so the cold-open
    # phrasing, the CTA line and the on-page poll all reinforce one phrase.
    # We only plant the draft when the story has no poll yet — an admin-saved
    # poll (or a previous render's draft) is never silently clobbered. The
    # burnt-in question card (_build_question_card below) picks the row up
    # on the same render, so the user gets a working poll on the article
    # AND in the video without any admin step.
    poll_draft = assets.script.get("poll") if isinstance(assets.script.get("poll"), dict) else None
    if poll_draft:
        wrote = store.upsert_poll_if_absent(
            safe_story,
            poll_draft.get("question", ""),
            poll_draft.get("option_a", ""),
            poll_draft.get("option_b", ""),
            category=row.get("category"),
        )
        if wrote:
            print(
                f"[shorts poll] drafted story={safe_story} "
                f"question={poll_draft.get('question')!r}"
            )
        else:
            print(
                f"[shorts poll] skipped story={safe_story}: poll already exists "
                "(admin-edited or earlier draft preserved)"
            )

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
        # 2) Voiceover over the spoken script + caption timing. Goes through
        #    `narration.render_narration` so the normalize -> TTS -> script-graft
        #    contract is applied (homophones / missing punctuation / dropped
        #    words on the Google STT path are corrected here).
        progress("voice")
        spoken = re.sub(r"\s+", " ", assets.script.get("short_script", "")).strip()
        audio_path = work_dir / "voice.mp3"
        # Pin the codified house voice + delivery (Autonoe, 1.2x pace, hook
        # pause). Passing the voice explicitly means the global DB voice setting
        # can't change the shorts narrator; the editor's Lane B re-render is the
        # per-short override path.
        vres = narration.render_narration(
            spoken,
            audio_path,
            override_provider=shorts_narration.SHORTS_VOICE_PROVIDER,
            override_voice_id=shorts_narration.SHORTS_VOICE_NAME,
            speaking_rate=shorts_narration.SHORTS_SPEAKING_RATE,
            hook_pause=shorts_narration.SHORTS_HOOK_PAUSE,
            hook_text=assets.script.get("hook"),
        )
        caption_chunks = video._chunk_alignment(vres.get("words") or [])
        if not caption_chunks:
            print(f"[short id={safe_id}] alignment produced no caption chunks; skipping")
            return None
        # The composition body MUST cover the WHOLE narration MP3, or the
        # concatenated outro clips the closing words. The last caption's end_ms
        # is a proxy that undershoots on some providers (it tracks the last
        # aligned word, not the file's real length), so floor the duration at
        # the actual audio length. end_hold_ms then adds the post-roll on top.
        caption_end_ms = int(caption_chunks[-1]["end_ms"])
        audio_ms = voice.audio_duration_ms(audio_path)
        duration_ms = max(caption_end_ms, audio_ms, 1)
        # When audio runs past the last caption (TTS provider's word timings
        # undershoot the real file), extend the last caption's end_ms to match
        # the audio. Otherwise the user sees the last caption disappear while
        # the narrator keeps talking — feels like "captions don't match the
        # narration" when the gap is more than a fraction of a second. The
        # text doesn't change: the trailing audio is the same closing phrase
        # the last caption already shows; we're just keeping it on-screen
        # until the audio actually ends.
        if audio_ms > caption_end_ms:
            print(
                f"[short id={safe_id} duration] audio={audio_ms}ms > "
                f"caption_end={caption_end_ms}ms — extending body + last "
                f"caption so the outro doesn't clip the narration"
            )
            caption_chunks[-1] = {**caption_chunks[-1], "end_ms": audio_ms}

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
                # The ordered ref list the original i2i call received (base
                # first, then this scene's supporting characters / locations /
                # items). Carried into doodle_frames so a per-scene regen can
                # replay the SAME multi-ref input instead of falling back to
                # base-only (which loses world-bible consistency for the wife /
                # kitchen / envelope etc. on regen).
                "image_input_urls": list(s.get("image_input_urls") or []),
            }
            for s in assets.scenes
        ]
        # One cache-bust token per render: frame + audio + character_base +
        # supporting refs all carry the same `?v=<token>` so the editor sees
        # a coherent set of fresh URLs the moment the new render lands. The
        # underlying GCS objects keep their stable paths (frame-NN.png /
        # voice.mp3) so Cloud Run's fetcher resolves them normally.
        cache_token = uuid.uuid4().hex[:8]
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
                "url": _cache_bust(url, cache_token),
                "planned": src["planned"],
                "image_prompt": src.get("image_prompt") or None,
                "image_input_urls": src.get("image_input_urls") or [],
            })
            progress("stage", i + 1, len(sources))
        if not staged:
            print(f"[short id={safe_id}] no frames staged; skipping")
            return None

        audio_ref = _cache_bust(
            gcs.publish(audio_path, f"{safe_id}/voice.mp3", str(audio_path))
            if remote else f"{safe_id}/voice.mp3",
            cache_token,
        )

        # 4) Map planned indices onto the actual caption space + dedup + add ids.
        planning_count = max(
            1, len(shorts.chunk_for_planning(assets.script.get("short_script", "")))
        )
        doodle_frames = _map_frames(staged, len(caption_chunks), planning_count)

        caption_template = {
            **video.resolve_caption_template(store.get_setting),
            "position_y": SHORT_CAPTION_POSITION_Y,
        }

        # Phase 3 of _plans/2026-06-17-engagement-polls.md. Resolve the
        # burnt-in question end card and extend the composition's
        # duration_ms so the card has its own tail beyond the narration.
        # Missing poll -> None -> no card and no duration extension; the
        # render is byte-identical to a pre-poll short.
        question_card = _build_question_card(row)
        rendered_duration_ms = duration_ms + (
            question_card["card_ms"] if question_card else 0
        )

        props = {
            "config_version": 2,
            "voiceover_url": audio_ref,
            "title": video._truncate_title(title),
            "channel_name": "lorewire",
            "aspect": "9:16",
            "duration_ms": rendered_duration_ms,
            # Post-roll hold (ms) on the final scene: the last frame lingers
            # this much past the narration before the outro splices on. The
            # body length + this hold define when the outro audio is allowed
            # to start. Combined with the audio-duration floor on duration_ms
            # below this guarantees the closing word always finishes before
            # the outro music cuts in.
            "end_hold_ms": SHORT_END_HOLD_MS,
            # The i2i character reference. Persisted (NOT as a visible frame)
            # so defaultShortConfig seeds short_config.character_base_url and
            # Lane C per-scene regen can re-pose the SAME character. The base
            # itself never appears in the video.
            "character_base_url": assets.base_url,
            # World-bible reference gallery — t2i'd once per short, used as
            # i2i `input_urls` for per-scene generation so the SAME wife /
            # kitchen / envelope is redrawn every appearance. Same "i2i
            # references only, never visible" contract as character_base_url:
            # the renderer walks `doodle_frames` only, so these URLs are
            # invisible in the rendered video. Empty dicts when the story
            # has no recurring supporting cast / locations / items.
            "supporting_character_refs": dict(assets.reference_gallery.supporting_chars),
            "location_refs": dict(assets.reference_gallery.locations),
            "item_refs": dict(assets.reference_gallery.items),
            "doodle_frames": doodle_frames,
            "captions": caption_chunks,
            "ken_burns": False,
            "caption_template": caption_template,
            "motion": {"micro_wiggle": False, "label_pop": False, "scribble_draw": False,
                       "prop_slide": False, "mouth_swap": False},
            "props_list": [],
            "character_image_mouth_removed": None,
        }
        if question_card:
            props["question_card"] = question_card
        print(
            f"[short id={safe_id} props] {len(caption_chunks)} caption chunks, "
            f"{len(doodle_frames)} frames, {rendered_duration_ms/1000:.1f}s "
            f"(narration {duration_ms/1000:.1f}s + card "
            f"{(rendered_duration_ms - duration_ms)/1000:.1f}s), "
            f"remote={remote}, has_poll={question_card is not None}"
        )
        return ShortProps(safe_id=safe_id, props=props)
    finally:
        # Remote staging is in /tmp and disposable once uploaded to GCS; remove it
        # so the Vercel drain's /tmp doesn't fill across ticks. Local mode keeps
        # work_dir (video/public/<id>) because the local render reads from it.
        if remote:
            shutil.rmtree(work_dir, ignore_errors=True)


def sync_short_config_from_lane_a(story_id: str, props: dict) -> bool:
    """Mirror a Lane A render's fresh assets back into the editor's
    short_config so the Scenes / Captions tabs and the editor's live preview
    stop showing the stale baseline frames after a full re-render. The MP4
    already reads the render row's props and is correct; this only closes
    the editor-display gap (the editor reads short_config, which a full
    regen otherwise never updates — only the FIRST seed via
    defaultShortConfig populates it).

    Wider surface than Lane B's caption sync because Lane A regenerates
    everything: doodle_frames (URLs + prompts + ids), character_base_url,
    captions, voiceover_url, duration_ms, narration script.

    Pinned frames are PRESERVED — the ShortFrame schema marks a frame
    `is_pinned` when the admin has manually swapped or edited it, and the
    short-config schema doc says a full Regenerate "MUST preserve pinned
    frames so the admin's work isn't blown away." Frames in the new render
    that share an id with a pinned frame in short_config keep the old
    url + image_prompt + alt + prev_image; everything else takes the new
    values.

    Best-effort: returns False (and never raises on a missing/malformed
    config) so a sync miss can't fail an otherwise-good render. Mirrors
    `shorts_lane_b.sync_short_config_captions`.
    """
    existing = store.fetch_story(story_id)
    if not existing or not existing.get("short_config"):
        return False
    try:
        config = json.loads(existing["short_config"])
    except (json.JSONDecodeError, TypeError):
        return False
    if not isinstance(config, dict):
        return False

    pinned_by_id: dict[str, dict] = {}
    for f in config.get("doodle_frames") or []:
        if isinstance(f, dict) and f.get("is_pinned") and isinstance(f.get("id"), str):
            pinned_by_id[f["id"]] = f

    new_frames: list[dict] = []
    for raw in props.get("doodle_frames") or []:
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
            continue
        frame_id = raw["id"]
        kept = pinned_by_id.get(frame_id)
        if kept is not None:
            # Preserve the pinned URL + prompt + alt + prev_image; refresh
            # only the caption index so a re-render that re-mapped frames to
            # different captions doesn't desync the pin from the narration.
            merged = {**kept}
            if isinstance(raw.get("caption_chunk_start_index"), int):
                merged["caption_chunk_start_index"] = raw["caption_chunk_start_index"]
            new_frames.append(merged)
            continue
        out: dict = {
            "id": frame_id,
            "url": str(raw.get("url", "")),
            "caption_chunk_start_index": int(raw.get("caption_chunk_start_index") or 0),
        }
        if isinstance(raw.get("image_prompt"), str):
            out["image_prompt"] = raw["image_prompt"]
        if isinstance(raw.get("alt"), str):
            out["alt"] = raw["alt"]
        if isinstance(raw.get("image_input_urls"), list):
            # Carry the per-scene multi-ref list (base + world-bible refs)
            # so Lane C regen on this frame replays the same input set.
            out["image_input_urls"] = [
                u for u in raw["image_input_urls"] if isinstance(u, str)
            ]
        new_frames.append(out)
    config["doodle_frames"] = new_frames
    # Mirror the world-bible reference gallery (NOT visible frames — i2i
    # inputs only) so the editor + Lane C regen can resolve recurring
    # entities the same way the initial render did. Schema parity: these
    # keys live alongside character_base_url at the top level.
    for key in ("supporting_character_refs", "location_refs", "item_refs"):
        if isinstance(props.get(key), dict):
            config[key] = {
                k: v for k, v in props[key].items()
                if isinstance(k, str) and isinstance(v, str)
            }

    config["captions"] = [
        {
            "start_ms": int(c["start_ms"]),
            "end_ms": int(c["end_ms"]),
            "text": str(c.get("text", "")),
        }
        for c in (props.get("captions") or [])
        if isinstance(c, dict) and "start_ms" in c and "end_ms" in c
    ]
    if isinstance(props.get("character_base_url"), str):
        config["character_base_url"] = props["character_base_url"]
    if isinstance(props.get("voiceover_url"), str):
        config["voiceover_url"] = props["voiceover_url"]
    if isinstance(props.get("duration_ms"), (int, float)) and props["duration_ms"]:
        config["duration_ms"] = int(props["duration_ms"])
    if isinstance(props.get("script"), str):
        config["script"] = props["script"]

    store.update_story_short_config(story_id, config)
    return True


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
