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

from pipeline import gcs, image_safety, images, media, narration, shorts, store, video, voice, voiceovers
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

# Hook-first splice (per _plans/2026-06-28-hook-before-brand-intro.md). The
# splice in `pipeline/segments.py` / `video/server/render.ts` reorders to
# [body_hook][intro][body_rest][outro] when `props["hook_end_ms"]` is set to
# a positive value. We compute it by aligning the script's `hook` field to
# the TTS word timestamps so the body splits exactly on the last syllable
# of the cold-open line.
#
# HOOK_END_PAD_MS: tiny trailing pad after the last hook word so the syllable
# fully lands before the brand stinger jumps in. 80ms = ~2-3 frames at 30fps;
# small enough to feel like a clean break, large enough to absorb the
# alignment provider's typical end-of-word jitter.
HOOK_END_PAD_MS = 80
# HOOK_FALLBACK_MS: used only when alignment can't be matched to the hook
# tokens (drift, homophone correction, empty alignment but non-empty hook).
# Sized to the cold-open word budget in shorts_narration.py — beat 1 caps at
# 8 words and ~2.33 w/s = ~3.4s, so 2500ms is the midpoint of the 1.5-3s
# target range. Logged loudly when used so the operator can tune the prompt.
HOOK_FALLBACK_MS = 2500
# Hook-first audio tail-hold (per _plans/2026-06-29-hook-first-clean-pacing.md).
# After the body splits at the hook's caption edge, the hook clip's AUDIO holds
# a little longer (over a frozen frame) so the last word finishes before the
# fade. The hold is sized PER VIDEO to the real gap before the next spoken word
# and capped here — some hooks have a pause after them, others butt straight up
# against the next sentence (gap 0 -> no hold, so the hold never bleeds into the
# next line). Mirrors HOOK_FIRST_TAIL_HOLD_SEC in pipeline/segments.py /
# video/server/ffmpeg.ts (the splice's fallback when a render carries no value).
HOOK_TAIL_HOLD_MAX_MS = 300

ProgressFn = Callable[[str, int, int], None]


def _story_body(row: dict) -> str:
    """Text the script is written from. Prefer the body; fall back to summary."""
    return (row.get("body") or row.get("summary") or "").strip()


_HOOK_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize_for_hook_match(text: str) -> list[str]:
    """Lowercased word tokens with all non-alphanumeric stripped. Mirrors what
    every TTS alignment provider normalizes to in the `word` field, so a
    naive equality compare matches across "Hook." vs "hook" vs "Hook?" and
    survives the "don't"/"dont" apostrophe-parity gap (the apostrophe is
    removed BEFORE the alphanumeric split so "don't" lowercases to "dont"
    as one token, not "don" + "t"). Pure."""
    if not text:
        return []
    # Strip apostrophes (smart + plain) first so contractions become one
    # token. Without this, "don't" → ["don", "t"] (two tokens) and a hook
    # like "DON'T LOOK" wouldn't match alignment word "dont" (one token).
    no_apos = text.lower().replace("'", "").replace("’", "")
    return _HOOK_TOKEN_RE.findall(no_apos)


def compute_hook_end_ms(
    hook: str | None,
    words: list[dict] | None,
    *,
    pad_ms: int = HOOK_END_PAD_MS,
    fallback_ms: int = HOOK_FALLBACK_MS,
) -> tuple[int, str]:
    """Find the millisecond timestamp at which the spoken cold-open hook ends
    in the narration. Returns `(hook_end_ms, source)` where `source` is one
    of:
      - ``"aligned"``: every hook token matched a TTS word in order; the
        timestamp is the last matched word's end + `pad_ms`.
      - ``"fallback"``: hook had tokens but the alignment couldn't be matched
        (drift, homophone, empty alignment); returns `fallback_ms`.
      - ``"empty"``: no hook tokens (missing / blank); returns 0 so callers
        can gate the splice reorder off (splice falls through to legacy
        [intro][body][outro]).

    The matcher walks the alignment in order. Each hook token must appear in
    the same order to count as a match — partial alignment (3 of 4 hook
    tokens matched) falls back rather than picking a wrong word, because a
    too-early cut clips the hook mid-syllable.

    Pure. The caller (`build_short_props`) decides whether to write the
    value to `props["hook_end_ms"]` and how to log the `source`.

    Per _plans/2026-06-28-hook-before-brand-intro.md.
    """
    hook_tokens = _tokenize_for_hook_match(hook or "")
    if not hook_tokens:
        return 0, "empty"
    if not words:
        return fallback_ms, "fallback"

    # Walk alignment in order, matching hook tokens. The alignment's `word`
    # field carries the TTS provider's spoken-form word (e.g. "Eight" or
    # "eight,") so normalize the same way the hook is normalized. A
    # candidate match only counts when the alignment entry carries a valid
    # `end` timestamp — without it we can't compute a real boundary, and
    # silently falling back to a stale `last_end_ms` would cut the body
    # at a wrong frame. So missing/garbled `end` ⇒ the entry is skipped
    # ⇒ the hook token stays unmatched ⇒ we fall back at the end.
    last_end_ms: int | None = None
    hook_idx = 0
    for w in words:
        if hook_idx >= len(hook_tokens):
            break
        if not isinstance(w, dict):
            continue
        end_sec = w.get("end")
        if not isinstance(end_sec, (int, float)):
            continue
        norm = _tokenize_for_hook_match(w.get("word") or "")
        # Some alignment providers return multi-syllable strings; flatten so
        # one alignment entry can satisfy one hook token at a time.
        for piece in norm:
            if hook_idx >= len(hook_tokens):
                break
            if piece == hook_tokens[hook_idx]:
                hook_idx += 1
                last_end_ms = int(round(end_sec * 1000))

    if hook_idx >= len(hook_tokens) and last_end_ms is not None:
        return max(0, last_end_ms + pad_ms), "aligned"
    return fallback_ms, "fallback"


def next_word_start_after_hook_ms(
    hook: str | None,
    words: list[dict] | None,
) -> int | None:
    """Alignment START (ms) of the first spoken word AFTER the hook line.

    Returns None when the hook can't be matched against the alignment, or when
    the hook is the last thing spoken (no following word). Used to size the
    hook-first audio tail-hold to the real gap before the next sentence: a hook
    that runs straight into the next line has a ~0 gap (so no hold, the splice
    never bleeds the next sentence's first word into the pre-intro clip), while
    a hook followed by a pause can hold up to the cap. Walks the alignment the
    same way compute_hook_end_ms does so the two agree on where the hook ends.
    """
    hook_tokens = _tokenize_for_hook_match(hook or "")
    if not hook_tokens or not words:
        return None
    hook_idx = 0
    for w in words:
        if hook_idx >= len(hook_tokens):
            # Hook fully matched on a previous entry; `w` is the first word
            # after it. Its start is the front edge of the next sentence.
            if isinstance(w, dict):
                start_sec = w.get("start")
                if isinstance(start_sec, (int, float)):
                    return int(round(start_sec * 1000))
            return None
        if not isinstance(w, dict):
            continue
        if not isinstance(w.get("end"), (int, float)):
            continue
        for piece in _tokenize_for_hook_match(w.get("word") or ""):
            if hook_idx >= len(hook_tokens):
                break
            if piece == hook_tokens[hook_idx]:
                hook_idx += 1
    return None


def compute_hook_tail_hold_ms(
    hook: str | None,
    words: list[dict] | None,
    hook_end_ms: int,
    *,
    max_ms: int = HOOK_TAIL_HOLD_MAX_MS,
) -> int:
    """Per-video hook-first audio tail-hold (ms).

    How long the hook clip's audio holds past the splice cut (`hook_end_ms`, the
    snapped caption edge) so the last hook word finishes before the fade —
    WITHOUT the hold reaching into the next sentence. Sized to the real gap
    between the cut and the next spoken word, capped at `max_ms`:

      * Hook runs straight into the next line (gap <= 0) -> 0 (no hold; the
        splice cuts cleanly at the word boundary, never clipping the next line).
      * Hook followed by a pause -> the pause, up to `max_ms`.
      * Next word can't be located (no alignment match) -> `max_ms` (the legacy
        constant hold; rare fallback).

    Per _plans/2026-06-29-hook-first-clean-pacing.md.
    """
    next_word_ms = next_word_start_after_hook_ms(hook, words)
    if next_word_ms is None:
        return max_ms
    return max(0, min(max_ms, next_word_ms - hook_end_ms))


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


def _extend_first_scene_over_hook(
    doodle_frames: list[dict],
    caption_chunks: list[dict],
    hook_end_ms: int,
) -> tuple[list[dict], int]:
    """Force the FIRST doodle scene to span the entire spoken hook, and return the
    caption-aligned boundary where scene 2 begins so the hook-first splice cuts on
    a scene edge instead of mid-scene.

    The hook-first splice (_plans/2026-06-28-hook-before-brand-intro.md) cuts the
    body at the returned boundary and inserts the brand intro there. When a later
    scene's `caption_chunk_start_index` falls inside the hook — e.g. the hook
    sentence's last word lands on scene 2 — that scene's burnt-in caption shows
    before the intro AND again after it, and there is no frame where the full hook
    has played and scene 2 is not already on screen. Shift every frame after the
    first so it starts at or after the first caption chunk that begins on/after
    `hook_end_ms`, preserving the strictly-increasing index invariant `_map_frames`
    established (so no two scenes share a start and render as a 1-frame flash).

    Returns `(frames, split_ms)`. `split_ms` is the start_ms of the first caption
    chunk that begins on/after `hook_end_ms` (where scene 2 now starts) so the
    splice lands exactly on the scene edge; it falls back to the original
    `hook_end_ms` when there is nothing to do. Mutates frames in place. No-op when
    there is no hook (`hook_end_ms <= 0`), fewer than two scenes, or no caption
    chunk begins after the hook (the hook spans the whole clip). The frame indices
    point into the same `caption_chunks` list the props carry as `captions`. Per
    _plans/2026-06-29-hook-first-clean-pacing.md.
    """
    if hook_end_ms <= 0 or len(doodle_frames) < 2 or not caption_chunks:
        return doodle_frames, hook_end_ms
    last_idx = len(caption_chunks) - 1
    # The hook ends on a caption boundary (its last word's end). HOOK_END_PAD_MS
    # pushes hook_end_ms a few frames PAST that boundary, which can land it inside
    # the NEXT line's caption — so "first chunk starting at/after hook_end_ms"
    # would skip the real boundary and leave the next line's caption before the
    # intro. Instead, find the hook's last caption by the chunk whose END is
    # nearest hook_end_ms; scene 2 and the splice start at the chunk AFTER it.
    last_hook_chunk = min(
        range(len(caption_chunks)),
        key=lambda i: abs(int(caption_chunks[i].get("end_ms", 0) or 0) - hook_end_ms),
    )
    first_post_hook = last_hook_chunk + 1
    # No chunk after the hook -> the hook covers the whole clip; leave the frames
    # untouched rather than collapse every scene onto the last caption.
    if not (0 < first_post_hook <= last_idx):
        return doodle_frames, hook_end_ms
    used = int(doodle_frames[0]["caption_chunk_start_index"])
    for n, frame in enumerate(doodle_frames[1:]):
        # The first scene after the opener must clear the hook; the rest only
        # need to stay strictly increasing (they already sit past the hook).
        lower = first_post_hook if n == 0 else used + 1
        new_idx = min(
            max(int(frame["caption_chunk_start_index"]), used + 1, lower),
            last_idx,
        )
        frame["caption_chunk_start_index"] = new_idx
        used = new_idx
    # The split is the scene/caption edge where the post-hook line begins. It can
    # sit a few frames BEFORE the padded hook_end_ms (the pad overshoots the
    # boundary), which is correct — we want the cut on the caption edge.
    split_ms = int(caption_chunks[first_post_hook].get("start_ms", hook_end_ms) or hook_end_ms)
    return doodle_frames, split_ms


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

    # Image-output safety (Phase 4): the AI generates the character + scene images
    # from user-submitted text, which text moderation never sees. For a
    # submission-origin story, moderate the visible frames here; a flagged image
    # raises ImageSafetyError, which the short-render worker catches and fails the
    # render — so a problem image never publishes under the brand. Admin Reddit
    # renders are unaffected (no submission_id). Plan:
    # _plans/2026-06-29-user-submitted-stories.md (Phase 4).
    if store.story_submission_id(safe_story):
        frame_urls = [assets.base_url, *(s.get("url") for s in assets.scenes)]
        image_safety.check_images_safe([u for u in frame_urls if u])

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
        # Resolve the voiceover for this story's category (admin-managed preset
        # -> global default -> code fallback). Passing it explicitly means the
        # global DB voice setting can't change the shorts narrator out from under
        # the chosen preset; the editor's Lane B re-render is the per-short path.
        voiceover = voiceovers.resolve_voiceover(row.get("category"))
        vres = narration.render_narration(
            spoken,
            audio_path,
            override_provider=voiceover["provider"],
            override_voice_id=voiceover["voice_id"],
            speaking_rate=voiceover["speaking_rate"],
            hook_pause=voiceover["hook_pause"],
            hook_text=assets.script.get("hook"),
            style_prompt=voiceover["style_prompt"],
        )
        caption_chunks = video._chunk_alignment(vres.get("words") or [])
        if not caption_chunks:
            print(f"[short id={safe_id}] alignment produced no caption chunks; skipping")
            return None

        # Compute the cold-open hook boundary so the splice can reorder to
        # [body_hook][intro][body_rest][outro] — the manager directive in
        # _plans/2026-06-28-hook-before-brand-intro.md. The dispatcher reads
        # `hook_end_ms` off `props`, converts to seconds, and POSTs it to
        # Cloud Run as `segments.hookEndSec`. Computed here (not in the
        # dispatcher) because the alignment data is only in scope at this
        # point of the pipeline. Zero means "splice falls through to legacy
        # ordering" — preserves back-compat for rows with no hook or no
        # alignment.
        hook_end_ms, hook_end_source = compute_hook_end_ms(
            assets.script.get("hook"),
            vres.get("words") or [],
        )
        print(
            f"[short id={safe_id} hook_boundary] computed "
            f"hook_end_ms={hook_end_ms} source={hook_end_source}"
        )
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

        # Stage the base image too — uploaded for the editor's i2i regen surface
        # (props.character_base_url) and used as the on-screen fallback only
        # when zero scenes staged successfully. Local mode keeps it under
        # video/public/<id>-short/ so per-scene re-renders can re-read it.
        base_fname = "base.png"
        base_local = work_dir / base_fname
        character_base_ref: str | None = None
        try:
            images.download(assets.base_url, base_local)
            character_base_ref = (
                gcs.publish(base_local, f"{safe_id}/{base_fname}", assets.base_url)
                if remote else f"{safe_id}/{base_fname}"
            )
        except Exception as e:
            print(f"[short id={safe_id} stage] base image staging FAILED: {e}")

        if not staged:
            # Every scene failed generation/download. Fall back to the base
            # image as a single doodle frame so the short still renders rather
            # than aborting the whole render.
            if not character_base_ref:
                print(f"[short id={safe_id}] no frames staged and base missing; skipping")
                return None
            print(
                f"[short id={safe_id}] no scene frames staged; "
                f"falling back to base image as the only doodle frame"
            )
            staged.append({
                "id": "frame-00",
                "url": character_base_ref,
                "planned": 0,
                "image_prompt": getattr(assets, "base_prompt", "") or None,
            })

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
        # Defensive: even with the planner prompt pinning the first scene at
        # caption 0, an off-spec LLM response can land scene-1 at a later
        # chunk. Force the surviving first frame back to caption 0 so the
        # opener never plays with no image on screen during the hook line.
        if doodle_frames and doodle_frames[0]["caption_chunk_start_index"] > 0:
            print(
                f"[short id={safe_id}] first scene planned at "
                f"caption {doodle_frames[0]['caption_chunk_start_index']}; "
                f"pinning to 0 so the hook line has a visual"
            )
            doodle_frames[0]["caption_chunk_start_index"] = 0

        # Make the opening scene span the WHOLE hook so the hook-first splice can
        # separate hook from rest without scene 2's burnt-in caption bleeding
        # across the intro (e.g. the hook's last word "child" landing on scene 2).
        # Per _plans/2026-06-29-hook-first-clean-pacing.md.
        before_idx = [f["caption_chunk_start_index"] for f in doodle_frames]
        doodle_frames, hook_split_ms = _extend_first_scene_over_hook(
            doodle_frames, caption_chunks, hook_end_ms
        )
        after_idx = [f["caption_chunk_start_index"] for f in doodle_frames]
        if before_idx != after_idx or hook_split_ms != hook_end_ms:
            print(
                f"[short id={safe_id} hook_scene] first scene spans hook; "
                f"frames {before_idx}->{after_idx}, "
                f"split {hook_end_ms}->{hook_split_ms}ms"
            )
        # The splice cuts at hook_end_ms; snap it to the scene edge so the intro
        # lands exactly between scene 1 (the hook) and scene 2 (the rest).
        hook_end_ms = hook_split_ms

        # Size the hook-first audio tail-hold to the REAL gap before the next
        # spoken word so the hold finishes the hook word without bleeding into
        # the next sentence (the dispatcher forwards it as
        # `segments.hookTailHoldSec`). hook_end_ms here is already snapped to the
        # caption edge. Per _plans/2026-06-29-hook-first-clean-pacing.md.
        hook_tail_hold_ms = compute_hook_tail_hold_ms(
            assets.script.get("hook"), vres.get("words") or [], hook_end_ms
        )
        print(
            f"[short id={safe_id} hook_tail] cut @{hook_end_ms}ms -> "
            f"tail_hold={hook_tail_hold_ms}ms (cap {HOOK_TAIL_HOLD_MAX_MS}ms)"
        )

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
            # Hook-first splice boundary (ms). The Vercel dispatcher reads
            # this off `props`, converts to seconds, and POSTs it as
            # `segments.hookEndSec` to Cloud Run so the splice can reorder
            # to [body_hook][intro][body_rest][outro]. Cloud Run also strips
            # this key from inputProps before handing them to Remotion so
            # the composition never sees a phantom prop. Zero means "no
            # reorder, splice falls through to legacy [intro][body][outro]".
            # See _plans/2026-06-28-hook-before-brand-intro.md.
            "hook_end_ms": hook_end_ms,
            # Hook-first audio tail-hold (ms): how long the hook clip's audio
            # holds past the splice cut (over a frozen frame) so the last hook
            # word finishes before the fade — sized per video to the gap before
            # the next spoken word (0 when the hook butts straight into the next
            # line, so the hold never clips into it). The dispatcher reads this
            # off `props`, converts to seconds, and POSTs it as
            # `segments.hookTailHoldSec`; Cloud Run strips it from inputProps
            # before Remotion. Absent/zero -> splice uses its own fallback hold.
            # See _plans/2026-06-29-hook-first-clean-pacing.md.
            "hook_tail_hold_ms": hook_tail_hold_ms,
            # The spoken cold-open hook line (beat 1 of the script, capped
            # at 8 words at generation time). Preserved here as a fallback
            # source for the social-poster renderer when the deliberate
            # `short_config.poster_text` field hasn't been generated yet
            # (the helper's LLM call lazy-generates on first publish; this
            # field is the cheap fallback for legacy rows). See
            # _plans/2026-06-28-phase-2-social-poster-render.md.
            # The dispatcher strips this key before it reaches the
            # DoodleShort composition (Remotion would treat it as a
            # phantom prop); the poster path is the only consumer.
            "hook": (assets.script.get("hook") or "").strip(),
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
            # Persist the base image URL so the editor's per-scene regen can
            # find the i2i seed even though the base is no longer one of the
            # doodle_frames. Lane B / C and shorts_scene_regen read this key
            # directly off short_config.
            "character_base_url": character_base_ref,
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
