"""Per-story media orchestration.

Called from `pipeline.run` when `--media` is set. After the article is written
this module:

  1. Asks the LLM for N image prompts (hero + scenes), grounded in the article.
  2. Generates each image through the active kie.ai model and saves it under
     `lorewire-app/public/generated/<id>/`.
  3. Renders narration through the active voice model (Google or ElevenLabs)
     and folds word-level timings for the read-along.
  4. Rolls per-story cost estimates into `cost_cents` so the CMS dashboard can
     show real spend, and logs a running daily total against `budget.daily_usd`.

Failures inside a single story are logged but do not abort the run. The article
text columns are already stored before this runs, so the worst case is an
article that ships without media.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from pipeline import config, gcs, images, models, stages, store, voice
from pipeline.aspect import (
    resolve_aspect_for_fresh_run,
    resolve_aspect_for_story,
    scene_aspect_for,
)

# Output goes under the Next app's public/ so it serves as /generated/<id>/...
# The pipeline runs from the repo root; this is the relative path it writes to.
PUBLIC_DIR_RELATIVE = Path("lorewire-app") / "public" / "generated"
PUBLIC_URL_PREFIX = "/generated"


def _staging_dir(safe_id: str, repo_root: Path) -> Path:
    """Where intermediate PNG/MP3/etc. files land before GCS upload.

    On Vercel (and any environment with VERCEL=1 in the env), the
    function code dir `repo_root` resolves to `/var/task/api/_lib/`
    which is READ-ONLY at runtime. `lorewire-app/public/generated/`
    doesn't even exist there. We route to /tmp/lorewire/ instead —
    Vercel's only writable mount, ~500 MB capacity, plenty for one
    story's worth of frames + audio.

    In local dev the legacy `lorewire-app/public/generated/<id>/` path
    stays so Next.js can serve files at `/generated/<id>/...` without a
    GCS round trip — useful when GCS_BUCKET isn't configured locally.

    GCS_BUCKET being unset on Vercel would be a config error; we still
    return /tmp so the in-pipeline writes don't crash, but the
    fallback URL would be a `/generated/...` path that nothing
    actually serves. gcs.publish raises in that case which the worker
    surfaces as story_jobs.error — the admin sees the missing GCS
    env var, not an opaque "ReadOnly filesystem" trace.
    """
    import os
    if os.environ.get("VERCEL"):
        from tempfile import gettempdir
        return Path(gettempdir()) / "lorewire" / "generated" / safe_id
    return repo_root / PUBLIC_DIR_RELATIVE / safe_id

# Reddit ids are short alphanumerics with the occasional underscore. Anything
# outside this set should never form a filesystem path: it would be either a
# bug or a hostile input.
SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")

# Scene count target. Wave 2 raised this from 3 to 30 so the video doesn't
# hold each frame for 30+ seconds. Admin can override via `media.scene_count`
# in /admin/settings. Clamped to [6, 60] to keep runaway costs bounded:
# 60 scenes at ~$0.05/image = $3.00 per story before voice + video.
DEFAULT_SCENE_COUNT = 30
SCENE_COUNT_MIN = 6
SCENE_COUNT_MAX = 60

# Auto-derived scene count target. The default of one new scene every
# ~5 seconds of voiceover puts a 60-second short at ~12 scenes (2-second
# average shot) and a 3-minute long-form story at ~36 scenes. Lifted
# from yt-studio's Doodle Short pacing — they cap variant count at
# captions × pacing; we do the same kind of thing but from total
# duration so the regen path doesn't need to re-chunk alignment.
SCENE_TARGET_SECONDS_PER_SCENE_DEFAULT = 5.0
SCENE_TARGET_SECONDS_PER_SCENE_MIN = 1.0
SCENE_TARGET_SECONDS_PER_SCENE_MAX = 30.0

# Legacy alias for old call sites that haven't been updated yet. Removed in a
# follow-up once nothing imports it.
DEFAULT_IMAGE_COUNT = 4


def _parse_duration_to_seconds(duration: str | None) -> float | None:
    """Parse a `M:SS` or `H:MM:SS` duration string into seconds. Returns
    None on missing / malformed input so the caller can fall through to
    a coarser estimate."""
    if not duration:
        return None
    parts = duration.strip().split(":")
    if not parts:
        return None
    try:
        nums = [int(p) for p in parts]
    except (TypeError, ValueError):
        return None
    if any(n < 0 for n in nums):
        return None
    if len(nums) == 2:
        return float(nums[0] * 60 + nums[1])
    if len(nums) == 3:
        return float(nums[0] * 3600 + nums[1] * 60 + nums[2])
    return None


def _estimate_duration_seconds(body: str | None, duration_str: str | None) -> float:
    """Pick the best duration estimate we can: the persisted M:SS string
    if present, otherwise a word-count estimate at ~150 wpm. Falls back
    to 0 so the caller treats it as "unknown" and uses the configured
    default scene count."""
    parsed = _parse_duration_to_seconds(duration_str)
    if parsed and parsed > 0:
        return parsed
    if body:
        words = len(body.split())
        if words > 0:
            # 150 wpm is a typical TTS / audiobook narration cadence.
            # Tuned slightly slow on purpose — over-estimating scene
            # count is cheaper to fix than under-estimating it (the
            # video feels static).
            return words / 2.5
    return 0.0


def _read_scene_target_per_scene() -> float:
    raw = store.get_setting("media.scene_count_target_seconds_per_scene")
    if raw is None:
        return SCENE_TARGET_SECONDS_PER_SCENE_DEFAULT
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return SCENE_TARGET_SECONDS_PER_SCENE_DEFAULT
    return max(
        SCENE_TARGET_SECONDS_PER_SCENE_MIN,
        min(SCENE_TARGET_SECONDS_PER_SCENE_MAX, v),
    )


def _auto_scene_count(duration_seconds: float) -> int:
    """Derive a scene count from voiceover duration so the video doesn't
    hold each frame too long on a short clip or pile too many on a long
    one. Mirrors yt-studio's Doodle Short pacing — one new scene every
    `target` seconds, clamped to the absolute [SCENE_COUNT_MIN, MAX]
    bounds so a wildly off duration can't trigger a runaway cost."""
    target = _read_scene_target_per_scene()
    if duration_seconds <= 0:
        return DEFAULT_SCENE_COUNT
    n = round(duration_seconds / target)
    return max(SCENE_COUNT_MIN, min(SCENE_COUNT_MAX, int(n)))


def _scene_count_mode() -> str:
    """`auto` (default) or `manual`. Anything else falls through to auto."""
    raw = (store.get_setting("media.scene_count_mode") or "").strip().lower()
    if raw == "manual":
        return "manual"
    return "auto"


def _resolve_scene_count(
    override: int | None,
    *,
    story: dict | None = None,
    body: str | None = None,
) -> int:
    """Order of precedence:
        1. explicit override (e.g. the legacy `image_count` arg)
        2. mode=manual + media.scene_count setting
        3. mode=auto + duration-derived count (fall through if duration
           unknown — covers fresh runs before TTS lands)

    `story` is the persisted row dict; we pull `body` + `duration` off
    of it when present. `body` overrides the row when the caller already
    has a fresher copy (fresh-run path)."""
    if override is not None:
        return max(SCENE_COUNT_MIN, min(SCENE_COUNT_MAX, int(override)))
    if _scene_count_mode() == "manual":
        raw = store.get_setting("media.scene_count")
        if raw is not None:
            try:
                return max(SCENE_COUNT_MIN, min(SCENE_COUNT_MAX, int(raw)))
            except (ValueError, TypeError):
                pass
        return DEFAULT_SCENE_COUNT
    # mode == auto (default)
    body_text = body if body is not None else ((story or {}).get("body") or "")
    duration_str = (story or {}).get("duration") if story else None
    duration_s = _estimate_duration_seconds(body_text, duration_str)
    n = _auto_scene_count(duration_s)
    print(
        f"[scene count auto] mode=auto duration_s={duration_s:.1f} "
        f"target_per_scene={_read_scene_target_per_scene()} -> {n} scenes"
    )
    return n

# Rough USD cost bands per image (model -> avg). These are sized for budget
# math, not invoiced totals. Refined when kie publishes a stable per-credit
# rate or the user wants to wire real billing.
#
# Last verified 2026-06-13 against kie.ai pricing pages + corroborating
# market write-ups:
#   - gpt-image-2: no kie.ai-published per-image rate; renderful's mirror
#     prices it at $0.0300. Keeping the $0.05 over-estimate so the daily
#     budget cap fires conservatively.
#   - nano-banana-2: starts at $0.04 / image. Matches.
#   - nano-banana-pro: $0.09 at 1K / 2K, $0.12 at 4K. Pipeline asks for 1K
#     in `images.py:generate` so the 1K rate is the right one.
IMAGE_COST_USD = {
    "kie/gpt-image-2": 0.05,
    "kie/nano-banana-2": 0.04,
    "kie/nano-banana-pro": 0.09,
}

# USD per character. Sized from each provider's public pricing as of 2026-06.
# ElevenLabs Starter ~$0.30/1k, Google HD tier published as a chars/min rate;
# values below are conservative single-number stand-ins. Gemini-TTS pricing is
# token-based on the invoice and translates roughly to the per-char rates below
# (sourced from yt-studio's cost.ts, verified against Google's own pricing page
# kept timing out 2026-05-26). Treat Gemini rows as estimates until a real GCP
# invoice reconciles.
TTS_COST_PER_CHAR = {
    "google/chirp3-hd":           30e-6,   # ~$30 / 1M chars (HD)
    "google/gemini-25-flash-tts": 16e-6,   # ~$16 / 1M chars (input + style prompt)
    "google/gemini-31-flash-tts": 33e-6,   # ~$33 / 1M chars (preview, input + style prompt)
    "google/neural2":             16e-6,   # ~$16 / 1M chars
    "google/standard":             4e-6,   # ~$4  / 1M chars
    "elevenlabs/default":        300e-6,   # ~$0.30 / 1k chars
}

# Google STT (alignment) per second of audio. Used only on Google voices.
STT_COST_PER_SECOND = 0.024 / 60.0


# kie.ai sometimes takes longer than its short default (180s) on busy hours;
# the 240s ceiling cleared timeouts on the QA fixture run without burning the
# whole pipeline on a stuck job.
IMAGE_POLL_TIMEOUT = 240


def _generate_with_retry(
    prompt: str,
    label: str,
    attempts: int = 2,
    aspect_ratio: str = "3:4",
    image_input: list[str] | None = None,
    model: str | None = None,
) -> str | None:
    """Call `images.generate` with one retry on transient failure.

    Returns the kie-hosted URL or None when both attempts fail. Logging is
    routed through the same namespace as the caller so a human reading the
    log sees the retry + outcome inline. `aspect_ratio` is passed through so
    callers can render a landscape variant of the same prompt.

    `image_input` (2026-06-14 world-bible plan) is an optional list of
    reference image URLs. Forwarded to `images.generate`, where the kie
    call shape branches on the active model: nano-banana-{2,pro} include
    the refs in `input.image_input`, gpt-image-2 ignores them silently
    (no image_input field on its endpoint). Logging surfaces the ref
    count so a "wrong face" diagnosis can see whether refs were used.

    `model` (2026-06-14) optionally overrides the registry-active image
    model just for this call. The scenes path uses it to pin
    nano-banana-2 (ref-image support) while leaving hero / props on the
    admin's global selection.
    """
    last: Exception | None = None
    ref_count = len([u for u in (image_input or []) if u])
    for attempt in range(1, attempts + 1):
        try:
            return images.generate(
                prompt,
                aspect_ratio=aspect_ratio,
                resolution="1K",
                poll_timeout=IMAGE_POLL_TIMEOUT,
                image_input=image_input,
                model=model,
            )
        except Exception as e:
            last = e
            if attempt < attempts:
                print(
                    f"[media image retry] {label} attempt {attempt} "
                    f"refs={ref_count} model={model or 'global'} "
                    f"failed ({e}); retrying once"
                )
    print(
        f"[media image] {label} refs={ref_count} model={model or 'global'} "
        f"FAILED after {attempts} attempts: {last}"
    )
    return None


# Wave 3 Phase 3 PropSlideIn budgets. Default 5 props per story; admin can
# tune via media.prop_count between 3 and 10. Costs ~$0.05/prop on the
# default kie/gpt-image-2 model.
DEFAULT_PROP_COUNT = 5
PROP_COUNT_MIN = 3
PROP_COUNT_MAX = 10


def _prop_slide_enabled() -> bool:
    raw = (store.get_setting("video.prop_slide") or "").strip().lower()
    return raw in {"1", "true", "on", "yes"}


def _mouth_swap_enabled() -> bool:
    """Mirror of `_prop_slide_enabled` for the MouthSwap motion beat. Off by
    default so the character + mouth-removed kie calls (~$0.10/story) are
    opt-in. Truthy parity with the other motion flags: 1/true/on/yes."""
    raw = (store.get_setting("video.mouth_swap") or "").strip().lower()
    return raw in {"1", "true", "on", "yes"}


def _prop_count() -> int:
    raw = store.get_setting("media.prop_count")
    if raw is None:
        return DEFAULT_PROP_COUNT
    try:
        return max(PROP_COUNT_MIN, min(PROP_COUNT_MAX, int(raw)))
    except (TypeError, ValueError):
        return DEFAULT_PROP_COUNT


def _mouth_swap_block(
    char_prompt: str, safe_id: str, out_dir: Path, url_prefix: str
) -> tuple[str | None, str | None]:
    """Generate the character bust + the mouth-removed edited copy.

    Returns `(character_url, character_mouth_removed_url)`. Either or both
    may be None when the underlying kie calls fail; the caller persists
    only what came back. Lives outside generate_media() so the two-step
    sequence is testable in isolation.
    """
    # Step 1: generate the bust at 3:4 portrait (same aspect as the cinematic
    # hero so the kie credits map predictably).
    started = time.time()
    bust_url = _generate_with_retry(
        char_prompt, f"id={safe_id} character bust", aspect_ratio="3:4"
    )
    if bust_url is None:
        print(f"[media id={safe_id} mouth_swap] bust generation FAILED, skipping")
        return None, None
    local_bust = out_dir / "character.png"
    try:
        images.download(bust_url, local_bust)
    except Exception as e:
        print(f"[media id={safe_id} mouth_swap] bust download FAILED: {e}")
        return None, None
    public_bust = f"{url_prefix}/character.png"
    stored_bust = gcs.publish(local_bust, f"{safe_id}/character.png", public_bust)
    elapsed = time.time() - started
    print(
        f"[media id={safe_id} mouth_swap] bust "
        f"({models.get_selected('images')}, 3:4) -> {stored_bust} ({elapsed:.1f}s)"
    )

    # Step 2: kie edit pass that removes the mouth. We pass the kie-hosted URL
    # (bust_url, not stored_bust) — kie's edit endpoint downloads the source
    # over the public internet and our GCS bucket might require auth on the
    # public URL. Re-fetching from kie's CDN sidesteps that entirely.
    started = time.time()
    try:
        edit_url = images.edit_image(
            bust_url, stages.MOUTH_REMOVAL_PROMPT, aspect_ratio="3:4",
            poll_timeout=IMAGE_POLL_TIMEOUT,
        )
    except Exception as e:
        print(f"[media id={safe_id} mouth_swap] edit FAILED: {e}")
        return stored_bust, None
    local_edit = out_dir / "character-mouth-removed.png"
    try:
        images.download(edit_url, local_edit)
    except Exception as e:
        print(f"[media id={safe_id} mouth_swap] edit download FAILED: {e}")
        return stored_bust, None
    public_edit = f"{url_prefix}/character-mouth-removed.png"
    stored_edit = gcs.publish(
        local_edit, f"{safe_id}/character-mouth-removed.png", public_edit
    )
    elapsed = time.time() - started
    print(
        f"[media id={safe_id} mouth_swap] mouth-removed "
        f"(qwen2/image-edit, 3:4) -> {stored_edit} ({elapsed:.1f}s)"
    )
    return stored_bust, stored_edit


def _sanitize_id(story_id: str) -> str:
    if not SAFE_ID_RE.match(story_id or ""):
        raise ValueError(f"unsafe story id for filesystem use: {story_id!r}")
    return story_id


def _image_filename(index: int) -> str:
    return "hero.png" if index == 0 else f"scene-{index}.png"


# Soft default used when the admin hasn't set `budget.daily_usd` yet. Matches
# the placeholder shown on the admin settings page and gives the running cost
# log a real number to compare against on first runs.
DEFAULT_BUDGET_DAILY_USD = 5.0


def _budget_log() -> None:
    """Print the daily spend cap and a running estimate. Never blocks."""
    cap_raw = store.get_setting("budget.daily_usd")
    try:
        cap = float(cap_raw) if cap_raw is not None else DEFAULT_BUDGET_DAILY_USD
    except ValueError:
        cap = DEFAULT_BUDGET_DAILY_USD
    spent = _running_cost_usd()
    note = "" if cap_raw is not None else " (default; set budget.daily_usd in /admin/settings to override)"
    print(f"[media budget] cap = ${cap:.2f} / day{note}, est spend this process = ${spent:.2f}")


def running_cost_usd() -> float:
    """Public wrapper around the running-cost estimate. Used by callers
    outside this module (notably story_jobs_worker._default_process)
    to compute per-job spend by snapshotting before/after a single
    pipeline run. Returns a USD float; multiply by 100 + round for
    the integer cents that lands in stories.cost_cents."""
    return _running_cost_usd()


def _running_cost_usd() -> float:
    """Estimate spend so far in this process from the providers' totals."""
    images_used = images.totals.get("images", 0)
    image_model = models.get_selected("images")
    image_avg = IMAGE_COST_USD.get(image_model, 0.05)
    voice_model = models.get_selected("voice")
    tts_per_char = TTS_COST_PER_CHAR.get(voice_model, 0.0)
    if voice_model.startswith("google/"):
        tts_chars = voice.totals.get("google_tts_characters", 0)
        stt_seconds = voice.totals.get("google_stt_seconds", 0.0)
        return images_used * image_avg + tts_chars * tts_per_char + stt_seconds * STT_COST_PER_SECOND
    if voice_model.startswith("elevenlabs/"):
        tts_chars = voice.totals.get("elevenlabs_characters", 0)
        return images_used * image_avg + tts_chars * tts_per_char
    return images_used * image_avg


def _story_cost_cents(image_count: int, narration_chars: int, narration_seconds: float) -> int:
    """Per-story USD estimate, in cents (rounded), for the cost_cents column."""
    image_model = models.get_selected("images")
    image_avg = IMAGE_COST_USD.get(image_model, 0.05)
    voice_model = models.get_selected("voice")
    tts_per_char = TTS_COST_PER_CHAR.get(voice_model, 0.0)
    cost = image_count * image_avg + narration_chars * tts_per_char
    if voice_model.startswith("google/"):
        cost += narration_seconds * STT_COST_PER_SECOND
    return max(0, round(cost * 100))


def generate_media(
    story_id: str,
    idea: dict,
    body: str,
    title: str,
    dry_run: bool,
    repo_root: Path,
    image_count: int | None = None,
) -> dict:
    """Generate images + narration for one story and return DB columns.

    Returns the subset of story columns this stage owns:
    `hero_image`, `hero_image_landscape`, `hero_has_baked_title`, `images`,
    `audio_url`, `alignment`, `cost_cents`. Caller merges them into
    `store.upsert_story`. Any failure inside this function is logged and
    partial output is returned (e.g. a story can still ship with fewer
    images than requested if some calls fail).

    `title` is the branded LoreWire title — it goes into the cinematic
    thumbnail prompt so the image model bakes the title typography directly
    into the hero compositions.
    """
    safe_id = _sanitize_id(story_id)
    out: dict = {}

    print(f"[media id={safe_id}] start")
    _budget_log()

    out_dir = _staging_dir(safe_id, repo_root)
    if not dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
    url_prefix = f"{PUBLIC_URL_PREFIX}/{safe_id}"

    # --- scene image prompts: still doodle, used for Article + Gallery + the
    # Remotion composition's per-shot illustrations. Scene count walks an
    # explicit `image_count` override (legacy callers) -> `media.scene_count`
    # when mode=manual -> the auto-derived count based on the body's word
    # count (TTS isn't done yet at fresh-run, so no audio duration to read).
    scene_count = _resolve_scene_count(image_count, body=body)
    # `make_image_prompts` still yields hero + scenes, but the hero slot is
    # overwritten downstream by the cinematic title-baked thumbnail. We keep
    # using slot 0 from make_image_prompts only as a doodle scene-style
    # fallback when the cinematic call fails.
    prompts = stages.make_image_prompts(idea, body, dry_run, n=scene_count + 1)
    print(f"[media id={safe_id} prompts] {len(prompts)} doodle scene prompts + 1 cinematic hero")

    # Cinematic title-baked hero: portrait (3:4) for mobile billboard + posters,
    # landscape (16:9) for desktop hero strips. Same title typography baked into
    # both so the CSS title overlay is suppressed in the UI.
    portrait_hero_url: str | None = None
    landscape_hero_url: str | None = None
    category = idea.get("category", "Drama")
    for aspect_ratio, filename, label in (
        ("3:4", "hero.png", "hero portrait"),
        ("16:9", "hero-landscape.png", "hero landscape"),
    ):
        public_url = f"{url_prefix}/{filename}"
        if dry_run:
            print(f"[media id={safe_id} {label}] (DRY RUN cinematic) -> {public_url}")
            if aspect_ratio == "3:4":
                portrait_hero_url = public_url
            else:
                landscape_hero_url = public_url
            continue
        cinematic_prompt = stages.make_thumbnail_prompt(
            title, category, body, aspect_ratio, dry_run=False
        )
        started = time.time()
        kie_url = _generate_with_retry(
            cinematic_prompt, f"id={safe_id} {label}", aspect_ratio=aspect_ratio
        )
        if kie_url is None:
            print(f"[media id={safe_id} {label}] FAILED, no image stored")
            continue
        local_path = out_dir / filename
        try:
            images.download(kie_url, local_path)
        except Exception as e:
            print(f"[media id={safe_id} {label}] download FAILED: {e}")
            continue
        stored = gcs.publish(local_path, f"{safe_id}/{filename}", public_url)
        elapsed = time.time() - started
        print(
            f"[media id={safe_id} {label}] cinematic title-baked "
            f"({models.get_selected('images')}, {aspect_ratio}) -> {stored} ({elapsed:.1f}s)"
        )
        if aspect_ratio == "3:4":
            portrait_hero_url = stored
        else:
            landscape_hero_url = stored

    # Scene images (doodle aesthetic, used in Article + Gallery + Remotion).
    # prompts[0] from make_image_prompts is the doodle hero fallback we don't
    # need any more; the cinematic thumbnails own the hero slot now. Slice
    # everything after for the scene set.
    #
    # Phase 2 of _plans/2026-06-12-video-aspect-ratio.md: scenes now follow
    # the resolved video aspect — portrait videos still ask kie for 3:4
    # (byte-identical to the pre-Phase-2 flow), landscape videos ask for
    # 16:9 so the wider canvas isn't getting object-fit-cropped. There's
    # no story row yet at the fresh-run point, so the resolver only sees
    # the global default + legacy 9:16 floor.
    fresh_video_aspect = resolve_aspect_for_fresh_run()
    scene_kie_aspect = scene_aspect_for(fresh_video_aspect)
    print(
        f"[media id={safe_id} aspect] video={fresh_video_aspect} "
        f"scene_kie_aspect={scene_kie_aspect}"
    )
    scene_prompts = prompts[1:] if len(prompts) > 1 else prompts
    scene_urls: list[str] = []
    for i, prompt in enumerate(scene_prompts):
        filename = f"scene-{i + 1}.png"
        public_url = f"{url_prefix}/{filename}"
        label = f"scene-{i + 1}"
        if dry_run:
            print(f"[media id={safe_id} {label}] (DRY RUN doodle) -> {public_url}")
            scene_urls.append(public_url)
            continue
        started = time.time()
        kie_url = _generate_with_retry(
            prompt, f"id={safe_id} {label}", aspect_ratio=scene_kie_aspect,
        )
        if kie_url is None:
            continue
        local_path = out_dir / filename
        try:
            images.download(kie_url, local_path)
        except Exception as e:
            print(f"[media id={safe_id} {label}] download FAILED: {e}")
            continue
        stored_url = gcs.publish(local_path, f"{safe_id}/{filename}", public_url)
        elapsed = time.time() - started
        print(
            f"[media id={safe_id} {label}] doodle "
            f"({models.get_selected('images')}, {scene_kie_aspect}) "
            f"-> {stored_url} ({elapsed:.1f}s)"
        )
        scene_urls.append(stored_url)

    if portrait_hero_url:
        out["hero_image"] = portrait_hero_url
    if landscape_hero_url:
        out["hero_image_landscape"] = landscape_hero_url
    # hero_has_baked_title only true when the cinematic call landed at least
    # one orientation; otherwise the UI falls back to the CSS overlay.
    if portrait_hero_url or landscape_hero_url:
        out["hero_has_baked_title"] = 1
    if scene_urls:
        out["images"] = json.dumps(scene_urls)

    # Wave 3 Phase 3 PropSlideIn: generate a small library of prop cutouts when
    # the admin has the prop_slide motion beat enabled. Off by default so this
    # step (and its kie cost) is opt-in. Per-prop cost: ~$0.05 at gpt-image-2.
    if not dry_run and _prop_slide_enabled():
        prop_count = _prop_count()
        plan = stages.make_prop_plan(idea, body, prop_count, dry_run=False)
        print(f"[media id={safe_id} props] planning {len(plan)} prop(s)")
        prop_list: list[dict] = []
        for i, item in enumerate(plan):
            filename = f"prop-{i + 1}.png"
            public_url = f"{url_prefix}/{filename}"
            label = f"prop-{i + 1} ({item['keyword']})"
            prompt = stages.make_prop_image_prompt(item["keyword"])
            started = time.time()
            kie_url = _generate_with_retry(prompt, f"id={safe_id} {label}", aspect_ratio="1:1")
            if kie_url is None:
                continue
            local_path = out_dir / filename
            try:
                images.download(kie_url, local_path)
            except Exception as e:
                print(f"[media id={safe_id} {label}] download FAILED: {e}")
                continue
            stored_url = gcs.publish(local_path, f"{safe_id}/{filename}", public_url)
            elapsed = time.time() - started
            print(
                f"[media id={safe_id} {label}] cutout "
                f"({models.get_selected('images')}, 1:1) -> {stored_url} ({elapsed:.1f}s)"
            )
            prop_list.append({
                "url": stored_url,
                "label": item.get("label") or item["keyword"],
                "side": item.get("side"),
            })
        if prop_list:
            out["props"] = json.dumps(prop_list)

    # Wave 3 Phase 3 MouthSwap: generate the protagonist's talking-head bust
    # and a mouth-removed copy. The composition overlays SVG mouth shapes on
    # the mouth-removed version at a fixed anchor (cx=0.50, cy=0.62). Two
    # kie calls per story (~$0.10) so this is opt-in via video.mouth_swap.
    if not dry_run and _mouth_swap_enabled():
        char_prompt = stages.make_character_prompt(idea, body, dry_run=False)
        char_url, char_removed_url = _mouth_swap_block(
            char_prompt, safe_id, out_dir, url_prefix
        )
        if char_url:
            out["character_image"] = char_url
        if char_removed_url:
            out["character_image_mouth_removed"] = char_removed_url

    # --- voice
    if dry_run:
        narration_url = f"{url_prefix}/narration.mp3"
        print(f"[media id={safe_id} voice] (DRY RUN) -> {narration_url}")
        out["audio_url"] = narration_url
        out["alignment"] = json.dumps([])
    else:
        narration_path = out_dir / "narration.mp3"
        started = time.time()
        try:
            result = voice.synthesize(body, narration_path)
            elapsed = time.time() - started
            words = result.get("words", [])
            duration = words[-1]["end"] if words else 0.0
            stored_audio_url = gcs.publish(
                narration_path, f"{safe_id}/narration.mp3", f"{url_prefix}/narration.mp3"
            )
            print(
                f"[media id={safe_id} voice] {len(body)} chars "
                f"({models.get_selected('voice')}, provider={result['provider']}) "
                f"-> {stored_audio_url} ({elapsed:.1f}s, {len(words)} words, ~{duration:.1f}s audio)"
            )
            out["audio_url"] = stored_audio_url
            out["alignment"] = json.dumps(words)
        except Exception as e:
            print(f"[media id={safe_id} voice] FAILED: {e}")

    # --- cost
    narration_chars = len(body) if not dry_run else 0
    if not dry_run and out.get("alignment"):
        try:
            words = json.loads(out["alignment"])
            narration_seconds = words[-1]["end"] if words else 0.0
        except (ValueError, KeyError):
            narration_seconds = 0.0
    else:
        narration_seconds = 0.0
    # Count every image we actually generated this run so the cost estimate
    # tracks the real spend instead of the placeholder it shipped with. Hero
    # (up to 2 aspect ratios), scenes, prop cutouts, plus the two mouth_swap
    # frames when that beat is on. The edit pass is technically cheaper than
    # the generate call, but the per-image average is close enough that we
    # don't split the rate per call.
    image_count = (
        (1 if "hero_image" in out else 0)
        + (1 if "hero_image_landscape" in out else 0)
        + len(scene_urls)
        + (len(json.loads(out["props"])) if out.get("props") else 0)
        + (1 if "character_image" in out else 0)
        + (1 if "character_image_mouth_removed" in out else 0)
    )
    out["cost_cents"] = _story_cost_cents(image_count, narration_chars, narration_seconds)

    print(f"[media id={safe_id} done] est cost ~${out['cost_cents'] / 100:.2f}")
    return out


def public_root_for(repo_root: Path) -> Path:
    """Where this stage writes files. Exposed so callers (CLI/tests) can clear it."""
    return repo_root / PUBLIC_DIR_RELATIVE


def _regen_out_dir(repo_root: Path, safe_id: str) -> Path:
    """Where per-asset regen writes the intermediate local file before
    GCS upload. When GCS is configured (= production) the local file is
    just a scratch upload buffer that gets deleted afterward; use the
    OS tempdir so the read-only filesystem on Vercel's serverless
    functions works. When GCS is NOT configured (= dev without bucket
    access) we keep writing under `lorewire-app/public/generated/` so
    the local Next dev server can still serve `/generated/<id>/<file>`
    as before."""
    import tempfile
    if gcs.is_configured():
        return Path(tempfile.gettempdir()) / "lorewire-regen" / safe_id
    return repo_root / PUBLIC_DIR_RELATIVE / safe_id


# ─── per-asset re-render (2026-06-12) ─────────────────────────────────────────
# Called by pipeline/image_render_worker.py once per claimed queue row. Returns
# (output_url, cost_cents). Raises NotImplementedError for slugs whose
# generators aren't wired yet — the worker catches it and surfaces the message
# to the admin UI verbatim. Implementing additional slugs means lifting the
# inner generators out of generate_media() — see the TODOs inline.

def regen_one(
    story_id: str,
    asset: str,
    repo_root: Path,
) -> tuple[str, int]:
    """Regenerate one asset for one story. Used by the image_render queue
    worker. Updates the relevant DB column and returns (public_url, cents).

    Today only `asset='hero'` is wired end-to-end. Other slugs raise
    NotImplementedError so the queue marks them error with a clear
    message and the admin UI can show "scenes regen not yet wired" inline.
    """
    safe_id = _sanitize_id(story_id)
    story = store.fetch_story(story_id)
    if story is None:
        raise ValueError(f"story {story_id!r} not found")

    # `_regen_out_dir` picks /tmp when GCS is configured so the
    # read-only Vercel function filesystem works; falls back to the
    # Next public/ dir for dev runs without GCS so /generated/... still
    # serves locally.
    out_dir = _regen_out_dir(repo_root, safe_id)
    out_dir.mkdir(parents=True, exist_ok=True)

    if asset == "hero":
        return _regen_hero(story, out_dir, safe_id)

    if asset == "hero_from_short":
        # Pulls the short's persisted character (character_base_url) out of
        # the latest done short_renders row and uses it as the i2i seed
        # for the hero / poster gen. Net effect: the hero stops being a
        # different person from the Watch tab's narrator character.
        return _regen_hero_from_short(story, out_dir, safe_id)

    if asset == "scenes":
        return _regen_scenes(story, out_dir, safe_id)

    if asset == "props":
        return _regen_props(story, out_dir, safe_id)

    if asset == "mouth_swap":
        return _regen_mouth_swap(story, out_dir, safe_id)

    # Per-image granular regens: "scene:N" and "prop:N" target a single
    # element of the matching bulk asset. Slug format is strict — anything
    # past the colon must parse as a non-negative integer.
    if asset.startswith("scene:"):
        return _regen_one_scene(story, out_dir, safe_id, _parse_index(asset))

    if asset.startswith("prop:"):
        return _regen_one_prop(story, out_dir, safe_id, _parse_index(asset))

    # Per-frame regens (video editor Phase 3): "frame:<uuid>" targets one
    # doodle_frame inside stories.video_config. The TS server action wrote
    # the new prompt + snapshotted prev_image before queuing, so we read
    # the prompt off the persisted config and trust it; the worker's job
    # is only to make the picture and stamp the new url back.
    if asset.startswith("frame:"):
        _, _, frame_id = asset.partition(":")
        if not frame_id:
            raise ValueError(f"asset {asset!r} missing frame id after colon")
        return _regen_one_frame(story, out_dir, safe_id, frame_id)

    raise NotImplementedError(f"unknown asset slug {asset!r}")


def _parse_index(asset: str) -> int:
    """Parse the integer suffix from slugs like 'scene:12' or 'prop:3'.
    Raises ValueError on non-numeric or negative input. The TS UI only ever
    sends slugs with valid indices, but we double-check on the worker side
    so a tampered queue row can't crash the worker."""
    _, _, suffix = asset.partition(":")
    if not suffix:
        raise ValueError(f"asset {asset!r} missing index after colon")
    try:
        n = int(suffix)
    except ValueError as e:
        raise ValueError(f"asset {asset!r} has non-numeric index") from e
    if n < 0:
        raise ValueError(f"asset {asset!r} has negative index")
    return n


def _idea_from_story(story: dict) -> dict:
    """Reconstruct the `idea` dict the prompt builders expect, using the
    persisted story row instead of the fresh-run pipeline's working memory.
    Everything we need (title -> headline, category, id -> reddit_id) is
    already on the row."""
    return {
        "reddit_id": story.get("id"),
        "category": (story.get("category") or "Drama").strip(),
        "headline": (story.get("title") or "").strip(),
        "angle": "Retell as an original article in LoreWire's voice.",
    }


def _per_image_cost_cents() -> int:
    active_model = models.get_selected("images")
    return round(IMAGE_COST_USD.get(active_model, 0.05) * 100)


def _regen_hero(story: dict, out_dir: Path, safe_id: str) -> tuple[str, int]:
    """Regenerate the hero set — portrait (3:4) AND landscape (16:9) —
    so the article reader, the OG card, and the landscape video poster
    all stay in sync. Mirrors what the fresh-run pipeline does in
    `generate_media` so a regen on a 16:9 video story doesn't leave a
    stale landscape hero on the row.

    A landscape failure does NOT abort the portrait write — the public
    reader's hero fallback chain prefers portrait when landscape is
    missing, so the partial success is better than refusing the whole
    operation. The returned cost only counts heroes that actually shipped
    so the daily-spend cap reflects reality.
    """
    title = (story.get("title") or "").strip()
    if not title:
        raise ValueError(f"story {safe_id} has no title — cannot build a hero prompt")
    body = (story.get("body") or "").strip()
    category = (story.get("category") or "Drama").strip()
    print(f"[image regen hero] id={safe_id} title={title[:60]!r} (both orientations)")

    per_image_cents = _per_image_cost_cents()
    total_cents = 0
    portrait_url: str | None = None

    # ─── 1. Portrait hero (3:4) — same prompt + dimensions as before. ─────
    portrait_prompt = stages.make_thumbnail_prompt(
        title, category, body, aspect_ratio="3:4", dry_run=False,
    )
    store.log_render_event(
        "prompt_built",
        f"Portrait hero prompt ready ({len(portrait_prompt)} chars)",
        payload={"variant": "portrait", "aspect": "3:4"},
    )
    store.log_render_event(
        "kie_request_sent",
        "Submitted to kie — waiting on portrait generation",
        payload={"variant": "portrait", "aspect": "3:4"},
    )
    portrait_kie = _generate_with_retry(
        portrait_prompt, f"id={safe_id} hero regen portrait", aspect_ratio="3:4",
    )
    if portrait_kie is None:
        store.log_render_event(
            "kie_failed",
            "Portrait generation returned no URL after retries",
            level="error",
            payload={"variant": "portrait"},
        )
        raise RuntimeError("kie portrait hero generation returned no URL after retries")
    store.log_render_event(
        "kie_response_received",
        "kie returned a portrait image URL",
        payload={"variant": "portrait"},
    )
    portrait_local = out_dir / "hero.png"
    images.download(portrait_kie, portrait_local)
    portrait_public = f"{PUBLIC_URL_PREFIX}/{safe_id}/hero.png"
    portrait_url = gcs.publish(
        portrait_local, f"{safe_id}/hero.png", portrait_public,
    )
    store.log_render_event(
        "image_saved",
        f"Portrait uploaded — {portrait_url}",
        payload={"variant": "portrait", "url": portrait_url},
    )
    store.update_story_hero(story["id"], portrait_url)
    total_cents += per_image_cents

    # ─── 2. Landscape hero (16:9) — best-effort. ──────────────────────────
    landscape_prompt = stages.make_thumbnail_prompt(
        title, category, body, aspect_ratio="16:9", dry_run=False,
    )
    store.log_render_event(
        "kie_request_sent",
        "Submitted to kie — waiting on landscape generation",
        payload={"variant": "landscape", "aspect": "16:9"},
    )
    landscape_kie = _generate_with_retry(
        landscape_prompt, f"id={safe_id} hero regen landscape", aspect_ratio="16:9",
    )
    if landscape_kie is None:
        store.log_render_event(
            "kie_failed",
            "Landscape failed; portrait still updated (partial success)",
            level="warn",
            payload={"variant": "landscape"},
        )
        print(
            f"[image regen hero] id={safe_id} landscape FAILED; "
            "portrait still updated"
        )
    else:
        try:
            landscape_local = out_dir / "hero-landscape.png"
            images.download(landscape_kie, landscape_local)
            landscape_public = (
                f"{PUBLIC_URL_PREFIX}/{safe_id}/hero-landscape.png"
            )
            landscape_url = gcs.publish(
                landscape_local,
                f"{safe_id}/hero-landscape.png",
                landscape_public,
            )
            store.log_render_event(
                "image_saved",
                f"Landscape uploaded — {landscape_url}",
                payload={"variant": "landscape", "url": landscape_url},
            )
            store.update_story_hero_landscape(story["id"], landscape_url)
            total_cents += per_image_cents
        except Exception as e:
            print(
                f"[image regen hero] id={safe_id} landscape download FAILED: {e}; "
                "portrait still updated"
            )

    # The queue's output_url shows the portrait by convention (the reader
    # picks portrait as primary). The full success is reflected in total_cents.
    return portrait_url, total_cents


def _regen_hero_from_short(
    story: dict, out_dir: Path, safe_id: str
) -> tuple[str, int]:
    """Regenerate the hero set (portrait + landscape) using the short's
    `character_base_url` as the i2i seed.

    Mirrors `_regen_hero` step-for-step (same title-baked cinematic prompt,
    same per-image cost, same portrait-first / landscape-best-effort flow)
    except both kie calls pass `image_input=[character_base_url]`. The
    prompt also flips to the character-faithful variant via
    `make_thumbnail_prompt(..., character_base_url=...)` so the model
    receives an explicit "redraw THIS person" instruction alongside the
    reference image.

    Why this exists: text-only hero gen invents a fresh face on every
    call, so hero / poster / Watch ended up looking like three unrelated
    people. Sourcing the seed from the short's persisted base character
    makes the three surfaces visually agree about who the protagonist
    is — different art styles, same person.

    Raises ValueError when the story has no completed short render OR
    that short's props don't carry a character_base_url. The queue
    surfaces the message verbatim so the admin sees "render a short
    first" instead of a silent failure.
    """
    title = (story.get("title") or "").strip()
    if not title:
        raise ValueError(f"story {safe_id} has no title — cannot build a hero prompt")
    body = (story.get("body") or "").strip()
    category = (story.get("category") or "Drama").strip()

    # Pull the character_base_url off the latest done short render. We
    # accept ANY done render rather than gating on the currently-applied
    # one so the admin can restyle even when the short hasn't been
    # promoted to stories.video_url yet.
    latest = store.latest_short_render_for_story(story["id"])
    if latest is None or (latest.get("status") or "") != "done":
        raise ValueError(
            f"story {safe_id} has no completed short render — generate a short first"
        )
    props_raw = latest.get("props")
    if not props_raw:
        raise ValueError(
            f"story {safe_id} short render has no props blob — re-render the short"
        )
    try:
        props = json.loads(props_raw)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"story {safe_id} short render props blob is not valid JSON: {e}"
        ) from e
    character_base_url = (props.get("character_base_url") or "").strip() if isinstance(props, dict) else ""
    if not character_base_url:
        raise ValueError(
            f"story {safe_id} short render has no character_base_url — "
            "re-render the short on the current shorts pipeline so the base is persisted"
        )
    print(
        f"[image regen hero from-short] id={safe_id} title={title[:60]!r} "
        f"base={character_base_url[:80]}..."
    )

    per_image_cents = _per_image_cost_cents()
    total_cents = 0
    portrait_url: str | None = None

    # ─── 1. Portrait (3:4) ────────────────────────────────────────────────
    portrait_prompt = stages.make_thumbnail_prompt(
        title, category, body, aspect_ratio="3:4", dry_run=False,
        character_base_url=character_base_url,
    )
    store.log_render_event(
        "prompt_built",
        f"Portrait hero (i2i) prompt ready ({len(portrait_prompt)} chars)",
        payload={"variant": "portrait", "aspect": "3:4", "mode": "i2i"},
    )
    store.log_render_event(
        "kie_request_sent",
        "Submitted to kie — waiting on portrait generation (i2i)",
        payload={"variant": "portrait", "aspect": "3:4", "mode": "i2i"},
    )
    portrait_kie = _generate_with_retry(
        portrait_prompt,
        f"id={safe_id} hero regen portrait (i2i)",
        aspect_ratio="3:4",
        image_input=[character_base_url],
        # Pin the i2i-capable variant. `kie/gpt-image-2` (no -i2i suffix)
        # silently drops image_input per images.py:108-111, which would
        # send us right back to text-only generation. The short itself
        # uses the same model for scene gen — that's why the short keeps
        # its character consistent and we're matching that contract.
        model="kie/gpt-image-2-i2i",
    )
    if portrait_kie is None:
        store.log_render_event(
            "kie_failed",
            "Portrait i2i generation returned no URL after retries",
            level="error",
            payload={"variant": "portrait", "mode": "i2i"},
        )
        raise RuntimeError("kie portrait hero (i2i) generation returned no URL after retries")
    store.log_render_event(
        "kie_response_received",
        "kie returned a portrait image URL (i2i)",
        payload={"variant": "portrait", "mode": "i2i"},
    )
    portrait_local = out_dir / "hero.png"
    images.download(portrait_kie, portrait_local)
    portrait_public = f"{PUBLIC_URL_PREFIX}/{safe_id}/hero.png"
    portrait_url = gcs.publish(
        portrait_local, f"{safe_id}/hero.png", portrait_public,
    )
    store.log_render_event(
        "image_saved",
        f"Portrait (i2i) uploaded — {portrait_url}",
        payload={"variant": "portrait", "url": portrait_url, "mode": "i2i"},
    )
    store.update_story_hero(story["id"], portrait_url)
    total_cents += per_image_cents

    # ─── 2. Landscape (16:9) — best-effort ────────────────────────────────
    landscape_prompt = stages.make_thumbnail_prompt(
        title, category, body, aspect_ratio="16:9", dry_run=False,
        character_base_url=character_base_url,
    )
    store.log_render_event(
        "kie_request_sent",
        "Submitted to kie — waiting on landscape generation (i2i)",
        payload={"variant": "landscape", "aspect": "16:9", "mode": "i2i"},
    )
    landscape_kie = _generate_with_retry(
        landscape_prompt,
        f"id={safe_id} hero regen landscape (i2i)",
        aspect_ratio="16:9",
        image_input=[character_base_url],
        model="kie/gpt-image-2-i2i",
    )
    if landscape_kie is None:
        store.log_render_event(
            "kie_failed",
            "Landscape i2i failed; portrait still updated (partial success)",
            level="warn",
            payload={"variant": "landscape", "mode": "i2i"},
        )
        print(
            f"[image regen hero from-short] id={safe_id} landscape FAILED; "
            "portrait still updated"
        )
    else:
        try:
            landscape_local = out_dir / "hero-landscape.png"
            images.download(landscape_kie, landscape_local)
            landscape_public = (
                f"{PUBLIC_URL_PREFIX}/{safe_id}/hero-landscape.png"
            )
            landscape_url = gcs.publish(
                landscape_local,
                f"{safe_id}/hero-landscape.png",
                landscape_public,
            )
            store.log_render_event(
                "image_saved",
                f"Landscape (i2i) uploaded — {landscape_url}",
                payload={"variant": "landscape", "url": landscape_url, "mode": "i2i"},
            )
            store.update_story_hero_landscape(story["id"], landscape_url)
            total_cents += per_image_cents
        except Exception as e:
            print(
                f"[image regen hero from-short] id={safe_id} landscape download FAILED: {e}; "
                "portrait still updated"
            )

    return portrait_url, total_cents


def _regen_scenes(story: dict, out_dir: Path, safe_id: str) -> tuple[str, int]:
    """Regenerate every scene image for a story. Builds fresh LLM prompts
    against the persisted body, generates one image per prompt, replaces
    stories.images wholesale with the new GCS-hosted URLs.

    Returns (first_url, total_cost_cents). The queue's output_url shows the
    first scene as a sample — the full list is visible on the row's images
    column, which the editor reads.
    """
    body = (story.get("body") or "").strip()
    if not body:
        raise ValueError(
            f"story {safe_id} has no body — scene prompts need it for context"
        )
    idea = _idea_from_story(story)
    url_prefix = f"{PUBLIC_URL_PREFIX}/{safe_id}"

    # Route through the resolver so the bulk path picks up the same
    # narration-grounded prompts (and shares the cached character bible)
    # with the per-scene queue workers. On regen the story row has
    # `duration` populated, so the auto path can read it directly
    # instead of falling back to the body word-count estimate. The
    # resolver evicts a stale-marker cache on its own; the TS bulk
    # button has already cleared the prompts cache cluster before this
    # function fires.
    scene_count = _resolve_scene_count(None, story=story)
    # 2026-06-14 Option C: when the world-bible flow is enabled, the
    # bulk path also builds the bible + character refs up front so
    # every scene call passes consistent reference images to kie. On
    # failure we fall through to the grounded narration path.
    world_bible_path = _world_bible_enabled()
    scene_entity_ids: list[list[str]] = []
    world_bible: dict | None = None
    bible_cents = 0
    if world_bible_path:
        prompts_wb, ids_wb, bible_wb, bible_cents = (
            _resolve_scene_entries_world_bible(
                story_id=story["id"],
                story=story,
                idea=idea,
                body=body,
                scene_count=scene_count,
                safe_id=safe_id,
                out_dir=out_dir,
            )
        )
        if prompts_wb:
            scene_prompts = prompts_wb
            scene_entity_ids = ids_wb
            world_bible = bible_wb
        else:
            print(
                f"[image regen scenes] id={safe_id} world_bible path "
                "produced no prompts — falling back to grounded path"
            )
            scene_prompts = _resolve_scene_prompts_cached(
                story_id=story["id"],
                story=story,
                idea=idea,
                body=body,
                scene_count=scene_count,
            )
    else:
        scene_prompts = _resolve_scene_prompts_cached(
            story_id=story["id"],
            story=story,
            idea=idea,
            body=body,
            scene_count=scene_count,
        )
    # Phase 2 of _plans/2026-06-12-video-aspect-ratio.md: resolve scene
    # aspect from the story row. Existing portrait stories with no
    # `aspect` field fall through to 3:4 — same kie call shape as before.
    video_aspect = resolve_aspect_for_story(story)
    scene_kie_aspect = scene_aspect_for(video_aspect)
    print(
        f"[image regen scenes] id={safe_id} count={len(scene_prompts)} "
        f"target={scene_count} aspect={video_aspect} kie={scene_kie_aspect}"
    )

    scene_urls: list[str] = []
    per_image_cents = _per_image_cost_cents()
    total_cents = bible_cents  # Bible build + ref shots already spent
    total_scenes = len(scene_prompts)
    # 2026-06-14 Option C: when the world bible is active, every scene
    # call pins the scene model AND forwards the relevant entity refs.
    # When the world bible path didn't run (setting off / fallback /
    # build failure), `world_bible` is None and `model_for_scenes` stays
    # None, which preserves the pre-Option-C global model selection.
    model_for_scenes: str | None = (
        _scene_image_model() if world_bible is not None else None
    )
    store.log_render_event(
        "scenes_start",
        f"Generating {total_scenes} scenes — kie aspect {scene_kie_aspect}",
        payload={"count": total_scenes, "aspect": scene_kie_aspect},
    )
    for i, prompt in enumerate(scene_prompts):
        filename = f"scene-{i + 1}.png"
        public_url = f"{url_prefix}/{filename}"
        label = f"scene-{i + 1}"
        ids_for_scene = (
            scene_entity_ids[i] if i < len(scene_entity_ids) else []
        )
        refs_for_scene = _refs_for_scene(world_bible, ids_for_scene)
        store.log_render_event(
            "kie_request_sent",
            f"Scene {i + 1}/{total_scenes} submitted to kie "
            f"(refs={len(refs_for_scene)})",
            payload={
                "index": i + 1,
                "of": total_scenes,
                "refs": len(refs_for_scene),
            },
        )
        kie_url = _generate_with_retry(
            prompt,
            f"id={safe_id} {label} regen",
            aspect_ratio=scene_kie_aspect,
            image_input=refs_for_scene or None,
            model=model_for_scenes,
        )
        if kie_url is None:
            store.log_render_event(
                "kie_failed",
                f"Scene {i + 1} failed; continuing",
                level="warn",
                payload={"index": i + 1},
            )
            print(f"[image regen scenes] id={safe_id} {label} FAILED, skipping")
            continue
        local_path = out_dir / filename
        try:
            images.download(kie_url, local_path)
        except Exception as e:
            store.log_render_event(
                "download_failed",
                f"Scene {i + 1} download error: {e}",
                level="warn",
                payload={"index": i + 1},
            )
            print(f"[image regen scenes] id={safe_id} {label} download FAILED: {e}")
            continue
        stored_url = gcs.publish(
            local_path, f"{safe_id}/{filename}", public_url,
        )
        store.log_render_event(
            "image_saved",
            f"Scene {i + 1}/{total_scenes} saved",
            payload={"index": i + 1, "of": total_scenes, "url": stored_url},
        )
        scene_urls.append(stored_url)
        total_cents += per_image_cents

        # Mirror the per-image path: stamp the prompt that produced THIS
        # image onto doodle_frames[i].image_prompt so the editor textarea
        # + the granular grid lightbox both show the actual prompt sent
        # to kie. Without this, a bulk regen still leaves the per-frame
        # field empty for every scene the user didn't redo individually.
        # Pass scene_count so the grow-path uses a stable distribution.
        _persist_frame_prompt(
            story["id"], story, i, prompt, stored_url,
            total_scenes=scene_count,
        )

    if not scene_urls:
        raise RuntimeError("scenes regen produced 0 images — all kie calls failed")

    store.update_story_scenes(story["id"], scene_urls)
    return scene_urls[0], total_cents


def _regen_props(story: dict, out_dir: Path, safe_id: str) -> tuple[str, int]:
    """Regenerate every prop cutout for a story. The admin only sees this
    affordance when video.prop_slide is on (see stories/[id]/page.tsx); we
    still defensively re-check the setting here so a stale UI can't enqueue
    work for a story whose owner has since disabled props."""
    if not _prop_slide_enabled():
        raise RuntimeError(
            "props regen blocked: video.prop_slide is off in Settings. "
            "Turn it on, then try again."
        )
    body = (story.get("body") or "").strip()
    if not body:
        raise ValueError(
            f"story {safe_id} has no body — prop prompts need it for context"
        )
    idea = _idea_from_story(story)
    url_prefix = f"{PUBLIC_URL_PREFIX}/{safe_id}"

    prop_count = _prop_count()
    plan = stages.make_prop_plan(idea, body, prop_count, dry_run=False)
    print(f"[image regen props] id={safe_id} count={len(plan)} target={prop_count}")

    prop_list: list[dict] = []
    per_image_cents = _per_image_cost_cents()
    total_cents = 0
    for i, item in enumerate(plan):
        filename = f"prop-{i + 1}.png"
        public_url = f"{url_prefix}/{filename}"
        label = f"prop-{i + 1} ({item['keyword']})"
        prompt = stages.make_prop_image_prompt(item["keyword"])
        kie_url = _generate_with_retry(
            prompt, f"id={safe_id} {label} regen", aspect_ratio="1:1",
        )
        if kie_url is None:
            print(f"[image regen props] id={safe_id} {label} FAILED, skipping")
            continue
        local_path = out_dir / filename
        try:
            images.download(kie_url, local_path)
        except Exception as e:
            print(f"[image regen props] id={safe_id} {label} download FAILED: {e}")
            continue
        stored_url = gcs.publish(
            local_path, f"{safe_id}/{filename}", public_url,
        )
        prop_list.append({
            "url": stored_url,
            "label": item.get("label") or item["keyword"],
            "side": item.get("side"),
        })
        total_cents += per_image_cents

    if not prop_list:
        raise RuntimeError("props regen produced 0 cutouts — all kie calls failed")

    store.update_story_props(story["id"], prop_list)
    return prop_list[0]["url"], total_cents


def _regen_mouth_swap(
    story: dict, out_dir: Path, safe_id: str,
) -> tuple[str, int]:
    """Regenerate the talking-head bust + its mouth-removed copy. Two kie
    calls (~2× per-image cost). The bust is the OG bust prompt; the
    mouth-removed copy goes through kie's edit endpoint and inherits the
    same character cues so the lip-flap overlay registers correctly."""
    if not _mouth_swap_enabled():
        raise RuntimeError(
            "mouth_swap regen blocked: video.mouth_swap is off in Settings. "
            "Turn it on, then try again."
        )
    body = (story.get("body") or "").strip()
    if not body:
        raise ValueError(
            f"story {safe_id} has no body — character prompt needs it for context"
        )
    idea = _idea_from_story(story)
    url_prefix = f"{PUBLIC_URL_PREFIX}/{safe_id}"
    char_prompt = stages.make_character_prompt(idea, body, dry_run=False)

    char_url, char_removed_url = _mouth_swap_block(
        char_prompt, safe_id, out_dir, url_prefix,
    )
    if not char_url and not char_removed_url:
        raise RuntimeError("mouth_swap regen produced 0 images — kie calls failed")

    store.update_story_character(story["id"], char_url, char_removed_url)
    # Cost: 2 images at the active rate when both came back. When only one
    # made it, the row still records what we spent so the daily cap stays
    # honest.
    per_image_cents = _per_image_cost_cents()
    total_cents = (1 if char_url else 0) * per_image_cents + (
        1 if char_removed_url else 0
    ) * per_image_cents

    # Output URL: the bust is what the composition shows on-screen, so it's
    # the natural sample to surface in the queue row.
    sample = char_url or char_removed_url or ""
    return sample, total_cents


# ─── per-image regens ────────────────────────────────────────────────────────
# Surgical single-element updates for the bulk assets. Called when the admin
# clicks Regenerate on a specific scene or prop thumbnail in the granular
# grid. Each rebuilds only its own image; the rest of the bulk asset's list
# stays untouched.
#
# Cost trade-off: we still call make_image_prompts(n=scene_count+1) for one
# scene regen so character continuity holds across the prompt set. That's
# one cheap LLM call (~$0.001-0.005) on top of the kie image gen
# (~$0.05) — a per-image regen costs effectively the same as the bulk
# per-image cost.

def _regen_one_scene(
    story: dict, out_dir: Path, safe_id: str, index: int,
) -> tuple[str, int]:
    """Regenerate just one scene image. Grows stories.images if `index`
    is past the current end of the list (e.g. a Rebuild-all-scenes batch
    on a story whose images column got out of sync with the auto-derived
    scene count — exact case that broke story `envelope` 2026-06-13:
    stories.images had 3 URLs from a corrupted zombie loop, the bulk
    enqueue made 30 rows, and the worker errored on indices 3..29).

    Behavior:
      - index <  len(existing): splice the new URL into that slot, rest
        of the list untouched (the original per-image regen contract).
      - index >= len(existing): pad the list with empty strings up to
        `index`, then set slot `index` to the new URL. The empty slots
        are placeholders that a later scene:N regen fills; the public
        reader's hero/scene fallback chain treats them as "no image".
    """
    body = (story.get("body") or "").strip()
    if not body:
        raise ValueError(
            f"story {safe_id} has no body — scene prompts need it for context"
        )
    existing = _read_scene_urls(story)
    idea = _idea_from_story(story)
    url_prefix = f"{PUBLIC_URL_PREFIX}/{safe_id}"

    # Scene prompts are cached in `pipeline_cache.scene_prompts` so a
    # 27-row Rebuild-all-scenes batch fires the LLM once instead of 27
    # times. Same prompt set across all scenes = consistent characters
    # scene-to-scene; one call instead of 27 = the LLM's truncation
    # rate goes from ~60% (the original bug — production diagnosis
    # 2026-06-14 on `envelope`) down to one chance per batch. The TS
    # bulk enqueue NULLs pipeline_cache on each Rebuild click so a
    # fresh batch gets fresh prompts. (Field lived inside video_config
    # until 2026-06-14 — see
    # `_plans/2026-06-14-pipeline-cache-column.md`.)
    scene_count = _resolve_scene_count(None, story=story)
    # 2026-06-14 Option C: per-image regen takes the same world-bible
    # path so the regenerated scene stays consistent with its
    # neighbours. When the world-bible flow is off (or build fails),
    # falls back to the grounded narration path.
    world_bible_path = _world_bible_enabled()
    # 2026-06-14 cache-wiped tripwire: when scene:N>0 lands in this
    # function but the pipeline_cache has no world_bible, that means
    # either (a) the migration hasn't backfilled this story yet, or
    # (b) something wiped the cache mid-batch (the editor heartbeat was
    # the original culprit before the column split; if it happens now
    # it points at a new write path stomping on pipeline_cache). Either
    # way we surface a warn so the regression class doesn't burn
    # another $1.50 before someone notices. The bible WILL get rebuilt
    # below — this is observability, not blocking.
    if (
        world_bible_path
        and index > 0
        and _read_world_bible_from_story(story) is None
    ):
        msg = (
            f"world_bible missing for scene:{index} (>0) — pipeline_cache "
            "was empty or wiped between scene:0 and this row"
        )
        print(f"[scene regen cache-wiped] id={safe_id} {msg}")
        try:
            store.log_render_event(
                "cache_wiped",
                msg,
                level="warn",
                payload={"index": index, "scene_count": scene_count},
            )
        except Exception:  # noqa: BLE001
            # log_render_event is best-effort — a missing render
            # context (e.g. tests calling regen_one directly without
            # the cron's use_render_context binding) shouldn't crash.
            pass
    scene_entity_ids: list[list[str]] = []
    world_bible: dict | None = None
    bible_extra_cents = 0
    if world_bible_path:
        prompts_wb, ids_wb, bible_wb, bible_extra_cents = (
            _resolve_scene_entries_world_bible(
                story_id=story["id"],
                story=story,
                idea=idea,
                body=body,
                scene_count=scene_count,
                safe_id=safe_id,
                out_dir=out_dir,
            )
        )
        if prompts_wb:
            scene_prompts = prompts_wb
            scene_entity_ids = ids_wb
            world_bible = bible_wb
        else:
            print(
                f"[image regen one scene] id={safe_id} world_bible "
                "produced no prompts — falling back to grounded path"
            )
            scene_prompts = _resolve_scene_prompts_cached(
                story_id=story["id"],
                story=story,
                idea=idea,
                body=body,
                scene_count=scene_count,
            )
    else:
        scene_prompts = _resolve_scene_prompts_cached(
            story_id=story["id"],
            story=story,
            idea=idea,
            body=body,
            scene_count=scene_count,
        )
    if not scene_prompts:
        raise RuntimeError(
            "scene prompt build returned no prompts — cannot regen"
        )
    prompt = scene_prompts[min(index, len(scene_prompts) - 1)]
    ids_for_this_scene = (
        scene_entity_ids[min(index, len(scene_entity_ids) - 1)]
        if scene_entity_ids
        else []
    )
    refs_for_this_scene = _refs_for_scene(world_bible, ids_for_this_scene)

    filename = f"scene-{index + 1}.png"
    public_url = f"{url_prefix}/{filename}"
    label = f"scene-{index + 1}"
    # Phase 2: resolve the scene aspect from the story so a per-image regen
    # on a 16:9 story asks kie for 16:9, not the 3:4 default.
    scene_kie_aspect = scene_aspect_for(resolve_aspect_for_story(story))
    model_for_scenes = (
        _scene_image_model() if world_bible is not None else None
    )
    kie_url = _generate_with_retry(
        prompt,
        f"id={safe_id} {label} per-image regen",
        aspect_ratio=scene_kie_aspect,
        image_input=refs_for_this_scene or None,
        model=model_for_scenes,
    )
    if kie_url is None:
        raise RuntimeError(f"kie returned no URL for {label}")
    local_path = out_dir / filename
    images.download(kie_url, local_path)
    stored_url = gcs.publish(local_path, f"{safe_id}/{filename}", public_url)

    # Splice into the existing list, leave the rest as-is. Grow with empty
    # placeholders when the index points past the end — the bulk-scenes
    # enqueue path normally pre-sizes stories.images, but a fast-path
    # admin click on a stale story should still succeed instead of
    # rejecting every row past `len(existing)`.
    new_scenes = list(existing)
    while len(new_scenes) <= index:
        new_scenes.append("")
    new_scenes[index] = stored_url
    store.update_story_scenes(story["id"], new_scenes)

    # Persist the prompt + new URL onto the matching doodle_frame so the
    # video editor's per-frame textarea shows what kie was asked to draw.
    # Bulk regens never used to touch video_config — that's why every
    # frame's textarea was empty. Best-effort: a failure here doesn't
    # roll back the scene URL because the image is already public; the
    # admin can re-run the regen if the prompt didn't land.
    # Pass scene_count so the grow-path uses a stable distribution
    # regardless of which per-scene job races to land first.
    _persist_frame_prompt(
        story["id"], story, index, prompt, stored_url,
        total_scenes=scene_count,
    )

    return stored_url, _per_image_cost_cents() + bible_extra_cents


def _regen_one_prop(
    story: dict, out_dir: Path, safe_id: str, index: int,
) -> tuple[str, int]:
    """Regenerate just one prop cutout. The existing prop's label doubles
    as the keyword input — using make_prop_plan would re-pick keywords and
    semantically change the prop set, which a single-prop regen shouldn't.
    """
    if not _prop_slide_enabled():
        raise RuntimeError(
            "prop regen blocked: video.prop_slide is off in Settings."
        )
    existing = _read_prop_list(story)
    if index >= len(existing):
        raise ValueError(
            f"prop index {index} out of range (story has {len(existing)} props)"
        )
    prop = existing[index]
    keyword = (prop.get("label") or "").strip() or "object"
    url_prefix = f"{PUBLIC_URL_PREFIX}/{safe_id}"

    filename = f"prop-{index + 1}.png"
    public_url = f"{url_prefix}/{filename}"
    label = f"prop-{index + 1} ({keyword})"
    prompt = stages.make_prop_image_prompt(keyword)
    kie_url = _generate_with_retry(
        prompt, f"id={safe_id} {label} per-image regen", aspect_ratio="1:1",
    )
    if kie_url is None:
        raise RuntimeError(f"kie returned no URL for {label}")
    local_path = out_dir / filename
    images.download(kie_url, local_path)
    stored_url = gcs.publish(local_path, f"{safe_id}/{filename}", public_url)

    # Update only this prop's url; preserve label + side.
    new_props = [dict(p) for p in existing]
    new_props[index] = {**existing[index], "url": stored_url}
    store.update_story_props(story["id"], new_props)

    return stored_url, _per_image_cost_cents()


# Video editor Phase 3 part 2. The TS server action
# (lorewire-app/src/app/admin/videos/[id]/actions.ts::queueFrameImageRegen)
# wrote the new prompt into stories.video_config.doodle_frames[i].image_prompt
# and snapshotted the previous state into .prev_image BEFORE inserting
# the queue row. Our job here is the picture, not the bookkeeping —
# read the prompt off the persisted config, generate the image, and
# stamp the new url back. prev_image stays untouched (the editor's
# Revert action handles undo without another model call).
#
# Filename uses the stable frame id so a regen-followed-by-regen
# overwrites the same path and CDN cache eviction is straightforward.
# Two frames can never collide because UUIDs are unique per row.

def _regen_one_frame(
    story: dict, out_dir: Path, safe_id: str, frame_id: str,
) -> tuple[str, int]:
    """Regenerate the image for one doodle frame.

    The frame is located by its stable `id` inside
    stories.video_config.doodle_frames. The prompt is read off the
    persisted config — the TS server action wrote it there before
    queueing this row. Raises ValueError if the config can't be parsed,
    the frame id isn't present, or the frame has no image_prompt.
    """
    raw = story.get("video_config")
    if not raw:
        raise ValueError(
            f"story {safe_id} has no video_config — frame regen needs it"
        )
    try:
        config = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as e:
        raise ValueError(
            f"story {safe_id} video_config is malformed JSON: {e}"
        ) from e
    if not isinstance(config, dict):
        raise ValueError(
            f"story {safe_id} video_config is not a JSON object"
        )

    frames = config.get("doodle_frames")
    if not isinstance(frames, list):
        raise ValueError(
            f"story {safe_id} video_config.doodle_frames is not a list"
        )

    frame_idx: int | None = None
    for i, f in enumerate(frames):
        if isinstance(f, dict) and f.get("id") == frame_id:
            frame_idx = i
            break
    if frame_idx is None:
        raise ValueError(
            f"frame id {frame_id!r} not found in story {safe_id} doodle_frames"
        )

    frame = frames[frame_idx]
    prompt = (frame.get("image_prompt") or "").strip()
    if not prompt:
        # The TS server action validates + writes image_prompt before
        # enqueueing, so an empty prompt here means either a manual queue
        # insert OR a regression in the editor. Fail loudly so the queue
        # row's error column surfaces the cause in the admin UI.
        raise ValueError(
            f"frame {frame_id!r} on story {safe_id} has no image_prompt to regen from"
        )

    url_prefix = f"{PUBLIC_URL_PREFIX}/{safe_id}"
    filename = f"frame-{frame_id}.png"
    public_url = f"{url_prefix}/{filename}"
    label = f"frame-{frame_id}"

    print(f"[regen frame] start id={safe_id} frame={frame_id} prompt_chars={len(prompt)}")

    kie_url = _generate_with_retry(prompt, f"id={safe_id} {label} per-frame regen")
    if kie_url is None:
        raise RuntimeError(f"kie returned no URL for {label}")
    local_path = out_dir / filename
    images.download(kie_url, local_path)
    stored_url = gcs.publish(local_path, f"{safe_id}/{filename}", public_url)

    # Stamp the new url into the live frame; leave image_prompt + prev_image
    # alone (the TS action owns both). dict() copy so we don't mutate the
    # parsed input by reference.
    new_frames = [dict(f) if isinstance(f, dict) else f for f in frames]
    new_frames[frame_idx] = {**frames[frame_idx], "url": stored_url}
    new_config = {**config, "doodle_frames": new_frames}
    store.update_story_video_config(story["id"], new_config)

    cents = _per_image_cost_cents()
    print(f"[regen frame] done id={safe_id} frame={frame_id} cents={cents}")
    return stored_url, cents


def _persist_frame_prompt(
    story_id: str,
    story: dict,
    scene_index: int,
    prompt: str,
    stored_url: str,
    total_scenes: int | None = None,
) -> None:
    """Stamp the kie prompt + new URL onto `video_config.doodle_frames[i]`
    after a bulk scene regen so the editor's per-frame textarea fills with
    something the admin can edit.

    Convention: `doodle_frames[i].url` corresponds to `scene_urls[i]` by
    index. The fresh-run pipeline writes them in lockstep; per-scene
    regen preserves the same ordering.

    `total_scenes` is the final scene count for the regen batch
    (i.e. `_resolve_scene_count`). Required for race-stable
    caption_chunk_start_index distribution — see the grow block below.
    Optional for backward compat: when omitted, the function falls back
    to the legacy `target_len = scene_index + 1` formula. New callers
    should always pass it.

    Best-effort by design:
      - Missing or malformed `video_config` is silently skipped (the row
        will populate next time a fresh-run pipeline writes it; the URL
        already landed in stories.images so the admin reader keeps working).
      - An out-of-range `scene_index` (doodle_frames shorter than
        scene_urls) is logged but doesn't fail — the bulk regen still
        succeeds for its primary job (the image itself).
      - `prev_image` is intentionally NOT touched. The per-frame Revert
        flow owns that snapshot; a bulk regen isn't a frame edit and
        shouldn't trigger Revert state.
    """
    raw = story.get("video_config")
    if not raw:
        # Story has no editor config yet — nothing to persist into.
        # Next fresh-run pipeline write will populate doodle_frames; until
        # then the editor's textarea stays empty (same as today).
        return
    try:
        config = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        print(
            f"[image regen scenes prompt persist] story={story_id} "
            "video_config not parseable as JSON, skipping"
        )
        return
    if not isinstance(config, dict):
        return
    frames = config.get("doodle_frames")
    if not isinstance(frames, list):
        return
    new_frames = list(frames)
    # Grow doodle_frames to the BATCH's final scene count (not just
    # scene_index + 1) so the editor's storyboard rail shows a card for
    # every regenerated scene AND every per-scene regen job — regardless
    # of arrival order — fills the array to the same length with the
    # SAME caption_chunk_start_index for the same i. Without that
    # invariant, two jobs racing produce two different `ci = i * cap /
    # target_len` values for the same i, leaving the persisted array
    # full of duplicate + out-of-order indices that pin the editor
    # preview onto a single image for most of the video.
    #
    # When growing past the existing length, ALSO re-normalize the ci
    # on existing frames so the array stays monotonic across the
    # existing/new boundary. Without this, an envelope that started with
    # 3 fresh-pipeline frames at ci=[0, 25, 51] (hero-share math) gets
    # grown to 27 with new frames at ci=[9, 11, 14, ...] — the join
    # at position 3 regresses (51 → 9) and the editor's window-finder
    # still pins on a single frame for the gap. url, id, image_prompt,
    # prev_image on existing frames are preserved.
    #
    # Legacy fallback (total_scenes=None): preserve the old per-job
    # `target_len = scene_index + 1` formula so older callers that
    # haven't been updated keep working. New code paths always pass
    # total_scenes — see line 1095 (all-scenes bulk) and line 1381
    # (per-scene regen).
    target_len = max(scene_index + 1, total_scenes or 0)
    growing = target_len > len(new_frames)
    if growing:
        captions = (
            config.get("captions")
            if isinstance(config.get("captions"), list)
            else []
        )
        cap_count = len(captions)
        # Re-normalize existing frames' ci to the same monotonic
        # distribution we're about to apply to the grown ones. This
        # only fires on a true grow (target_len > len) so a no-op
        # per-scene update (rare: when total_scenes shrinks between
        # batches) doesn't surprise-rewrite a hand-edited distribution.
        for i in range(len(new_frames)):
            existing = new_frames[i]
            if not isinstance(existing, dict):
                continue
            ci = (
                min(cap_count - 1, max(0, int(round(i * cap_count / target_len))))
                if cap_count > 0
                else 0
            )
            new_frames[i] = {**existing, "caption_chunk_start_index": ci}
        while len(new_frames) < target_len:
            i = len(new_frames)
            ci = (
                min(cap_count - 1, max(0, int(round(i * cap_count / target_len))))
                if cap_count > 0
                else 0
            )
            new_frames.append({
                "id": _new_frame_id(),
                "url": "",
                "image_prompt": "",
                "caption_chunk_start_index": ci,
            })
    target = new_frames[scene_index]
    if not isinstance(target, dict):
        target = {"id": _new_frame_id(), "caption_chunk_start_index": 0}
    new_frame = {**target, "url": stored_url, "image_prompt": prompt}
    # Make sure freshly-grown frames have an id even if some weird
    # legacy frame dict didn't carry one through the spread.
    if not new_frame.get("id"):
        new_frame["id"] = _new_frame_id()
    new_frames[scene_index] = new_frame
    new_config = {**config, "doodle_frames": new_frames}
    store.update_story_video_config(story_id, new_config)
    print(
        f"[image regen scenes prompt persist] story={story_id} "
        f"index={scene_index} prompt_chars={len(prompt)} url={stored_url}"
    )


def _new_frame_id() -> str:
    """Stable random id for a freshly-grown doodle_frame. Imported lazily
    so this module's import time doesn't pay for `uuid` until needed."""
    import uuid as _uuid
    return _uuid.uuid4().hex


# Cache marker — bumped whenever the prompt-build shape changes in a way
# that should evict every previously-cached batch. Legacy caches (no marker
# present) are treated as poisoned for the grounded path: they pre-date
# the narration-binding fix and would otherwise lock the story onto the
# stale prompts that produced "wrong" images in the first place.
SCENE_PROMPTS_BUILT_WITH_GROUNDED = "narration_v1"
SCENE_PROMPTS_BUILT_WITH_LEGACY = "legacy_v0"
# 2026-06-14 Option C: world-bible scene prompts. Cache entry is the
# same `scene_prompts: list[str]` shape but with a parallel
# `scene_entity_ids: list[list[str]]` so the kie scene call can look
# up references for each scene. Marker change auto-evicts every prior
# cache shape on first contact.
SCENE_PROMPTS_BUILT_WITH_WORLD_BIBLE = "world_bible_v1"


# ─── world bible toggles ─────────────────────────────────────────────────────


def _world_bible_enabled() -> bool:
    """Master switch for the Option C path (world bible + per-character
    reference images + nano-banana-2 scene model). Default on. Flipping
    `video.world_bible_enabled` to "0" reverts to the existing
    grounded-narration flow (Option A from the previous plan)."""
    raw = store.get_setting("video.world_bible_enabled")
    if raw is None:
        return True
    return str(raw).strip() not in ("0", "false", "False", "off", "")


def _character_reference_images_enabled() -> bool:
    """When OFF, the world bible is built (schema is still useful for
    prompt-shaping) but per-character ref images are NOT generated. Saves
    ~$0.04 per character per story. Default on — refs are the load-bearing
    piece for visual consistency."""
    raw = store.get_setting("video.character_reference_images_enabled")
    if raw is None:
        return True
    return str(raw).strip() not in ("0", "false", "False", "off", "")


def _location_reference_images_enabled() -> bool:
    """Opt-in. Off by default per the council's "locations are
    perceptually marginal in short-form" note — we ship the schema but
    don't burn $0.04 × N_locations per story unless the admin flips
    this on after seeing scene results."""
    raw = store.get_setting("video.location_reference_images")
    if raw is None:
        return False
    return str(raw).strip() not in ("0", "false", "False", "off", "")


def _scene_image_model() -> str:
    """Registry id for the scene generation model. Default
    "kie/nano-banana-2" because it's the cheapest ref-image-aware
    option ($0.04 vs $0.05 for gpt-image-2) AND supports the
    image_input field this whole flow depends on. Admin can flip to
    "kie/nano-banana-pro" for higher fidelity (~$0.09) or back to
    "kie/gpt-image-2" to disable reference conditioning entirely.
    Unknown values fall through to nano-banana-2."""
    raw = (store.get_setting("video.scene_image_model") or "").strip()
    if raw in {"kie/gpt-image-2", "kie/nano-banana-2", "kie/nano-banana-pro"}:
        return raw
    return "kie/nano-banana-2"


def _scene_prompt_grounding_enabled() -> bool:
    """Settings escape hatch — flipping `video.scene_prompt_grounding` to
    "0" reverts the path to the legacy `make_image_prompts(idea, body, n)`
    behavior. Default on, per the 2026-06-14 plan."""
    raw = store.get_setting("video.scene_prompt_grounding")
    if raw is None:
        return True
    return str(raw).strip() not in ("0", "false", "False", "off", "")


def _character_bible_cache_enabled() -> bool:
    """Diagnostic escape hatch — off forces a fresh bible call every
    regen. Useful when the cached bible turns out wrong and we want one
    regen to overwrite it. Default on."""
    raw = store.get_setting("video.character_bible_cache")
    if raw is None:
        return True
    return str(raw).strip() not in ("0", "false", "False", "off", "")


# ─── world bible: build + ref-image gen + scene-entry resolver ───────────────
# The Option C path. Builds a structured bible of recurring entities
# (characters, sub-characters, locations, items) per story, optionally
# generates one canonical reference image per character (and optionally
# per location), then builds per-scene prompts tagged with the entity ids
# that appear on-screen. Scene gen passes the matching ref URLs to
# nano-banana-2 so identity carries across scenes. See
# `_plans/2026-06-14-world-bible-and-reference-images.md`.


def _build_character_ref_prompt(char: dict, style: str) -> str:
    """Neutral portrait prompt used to mint a character's canonical
    reference image. Deliberately scene-agnostic — no plot context, no
    props, no other characters — so the resulting image works as an
    identity anchor regardless of which scene later references it."""
    name = char.get("name", "the character")
    role = char.get("role", "")
    cues = char.get("visual_cues", "")
    role_clause = f" ({role})" if role else ""
    return (
        f"Neutral head-and-shoulders reference portrait of {name}{role_clause}: "
        f"{cues}. Plain neutral background, soft front lighting, character "
        f"looking forward, mouth closed, neutral expression, no props, no "
        f"other characters in the frame. {style}"
    )


def _build_location_ref_prompt(loc: dict, style: str) -> str:
    name = loc.get("name", "the location")
    cues = loc.get("visual_cues", "")
    return (
        f"Establishing wide shot of {name} with no people present: {cues}. "
        f"Empty environment, soft natural lighting, used as a setting "
        f"reference image. {style}"
    )


def _ensure_entity_reference(
    entity: dict,
    *,
    story_id: str,
    safe_id: str,
    out_dir: Path,
    kind: str,
    prompt_builder,
    aspect_ratio: str,
    style: str,
) -> tuple[dict, int]:
    """Generate (and upload) a canonical reference image for one bible
    entity that doesn't yet have a `reference_image_url`. Returns the
    updated entity (with the new url stamped in) plus the cents spent
    (0 if the entity already had a ref, per_image_cents if a new one
    was generated, 0 again on failure — failure is best-effort, the
    entity keeps `reference_image_url: null` and scene gen falls back
    to text-only for that entity).

    Logging surfaces the kind + entity id + outcome so a "this scene
    looks wrong" debug session can see exactly which refs landed."""
    if not isinstance(entity, dict):
        return entity, 0
    existing_ref = entity.get("reference_image_url")
    if isinstance(existing_ref, str) and existing_ref.strip():
        return entity, 0
    entity_id = entity.get("id") or "unknown"
    prompt = prompt_builder(entity, style)
    label = f"ref {kind}={entity_id} story={safe_id}"
    # The ref shot itself uses the global scenes model — same model the
    # caller will later feed the ref TO, so the visual language matches.
    kie_url = _generate_with_retry(
        prompt,
        label,
        aspect_ratio=aspect_ratio,
        model=_scene_image_model(),
    )
    if kie_url is None:
        print(
            f"[world bible ref] story={story_id} {kind}={entity_id} "
            f"FAILED — entity stays without reference; scene gen falls back to text"
        )
        return entity, 0
    filename = f"ref-{kind}-{entity_id}.png"
    public_url = f"{PUBLIC_URL_PREFIX}/{safe_id}/{filename}"
    local_path = out_dir / filename
    try:
        images.download(kie_url, local_path)
    except Exception as e:  # noqa: BLE001
        print(
            f"[world bible ref] story={story_id} {kind}={entity_id} "
            f"download FAILED: {e}"
        )
        return entity, 0
    try:
        stored_url = gcs.publish(local_path, f"{safe_id}/{filename}", public_url)
    except Exception as e:  # noqa: BLE001
        print(
            f"[world bible ref] story={story_id} {kind}={entity_id} "
            f"upload FAILED: {e}"
        )
        return entity, 0
    print(
        f"[world bible ref] story={story_id} {kind}={entity_id} "
        f"ok url={stored_url}"
    )
    return {**entity, "reference_image_url": stored_url}, _per_image_cost_cents()


def _ensure_world_bible_with_refs(
    story_id: str,
    story: dict,
    safe_id: str,
    idea: dict,
    body: str,
    out_dir: Path,
) -> tuple[dict | None, int]:
    """Resolve the world bible for `story`: build via the LLM when
    missing (or evict + rebuild when the cached marker is stale),
    generate reference images for any characters / locations that need
    them, persist the result, return the bible + cents spent.

    Best-effort: failures along the way log and continue. A bible that
    came back from the LLM but failed to get refs is still returned
    (entries with `reference_image_url: null`) so the rest of the
    pipeline keeps moving — scene gen falls back to text-only on
    missing refs."""
    from pipeline import world_bible as wb

    bible = wb.read_world_bible(story)
    cents_total = 0
    if bible is None:
        print(
            f"[world bible build] story={story_id} cache miss — firing LLM call"
        )
        bible = stages.build_world_bible(idea, body, dry_run=False)
        if bible is None:
            print(
                f"[world bible build] story={story_id} FAILED — LLM returned "
                "unparseable shape; scene gen will fall back to grounded path"
            )
            return None, 0
        print(
            f"[world bible build] story={story_id} "
            f"chars={len(bible['characters'])} "
            f"subs={len(bible['sub_characters'])} "
            f"locs={len(bible['locations'])} "
            f"items={len(bible['items'])}"
        )
    else:
        print(f"[world bible build] story={story_id} cache hit")

    # Ref-image generation. We mutate copies into new entity dicts and
    # rebuild the bible so the persisted shape stays consistent.
    style = (store.get_setting("video.style") or stages.DEFAULT_IMAGE_STYLE).strip()
    if _character_reference_images_enabled():
        new_chars: list[dict] = []
        for c in bible.get("characters") or []:
            updated, cents = _ensure_entity_reference(
                c,
                story_id=story_id,
                safe_id=safe_id,
                out_dir=out_dir,
                kind="char",
                prompt_builder=_build_character_ref_prompt,
                aspect_ratio="3:4",
                style=style,
            )
            new_chars.append(updated)
            cents_total += cents
        bible = {**bible, "characters": new_chars}
        # Sub-characters get refs too — they appear in scenes and a
        # consistent face matters even for "background" roles.
        new_subs: list[dict] = []
        for c in bible.get("sub_characters") or []:
            updated, cents = _ensure_entity_reference(
                c,
                story_id=story_id,
                safe_id=safe_id,
                out_dir=out_dir,
                kind="sub",
                prompt_builder=_build_character_ref_prompt,
                aspect_ratio="3:4",
                style=style,
            )
            new_subs.append(updated)
            cents_total += cents
        bible = {**bible, "sub_characters": new_subs}
    else:
        print(
            f"[world bible refs] story={story_id} "
            "character_reference_images_enabled=off — skipping ref gen"
        )

    if _location_reference_images_enabled():
        new_locs: list[dict] = []
        for loc in bible.get("locations") or []:
            updated, cents = _ensure_entity_reference(
                loc,
                story_id=story_id,
                safe_id=safe_id,
                out_dir=out_dir,
                kind="loc",
                prompt_builder=_build_location_ref_prompt,
                aspect_ratio="16:9",
                style=style,
            )
            new_locs.append(updated)
            cents_total += cents
        bible = {**bible, "locations": new_locs}

    _persist_world_bible(story_id, story, bible)
    return bible, cents_total


def _persist_world_bible(story_id: str, story: dict, bible: dict) -> None:
    """Stamp the bible (with current ref URLs) onto
    `stories.pipeline_cache.world_bible`.

    Lived inside `video_config` until 2026-06-14, but the editor's
    parseVideoConfig drops unknown top-level fields — every editor
    heartbeat silently wiped the world bible and forced the next scene
    worker to rebuild it from scratch ($0.30, ~260s, hits the 270s cron
    deadline, infinite re-claim loop). See
    `_plans/2026-06-14-pipeline-cache-column.md`.

    Best-effort — a failure here doesn't kill the regen because the
    bible is still in memory for THIS run; cache just won't hit on the
    next regen.
    """
    cache = store.read_story_pipeline_cache(story)
    new_cache = {**cache, "world_bible": bible}
    try:
        store.update_story_pipeline_cache(story_id, new_cache)
        # Keep the in-memory story row in sync so a subsequent read in
        # the SAME regen sees the freshly-persisted bible. Mirror the
        # JSON round-trip the DB will do.
        story["pipeline_cache"] = json.dumps(new_cache)
    except Exception as e:  # noqa: BLE001
        print(
            f"[world bible persist] story={story_id} FAILED: {e} — continuing"
        )


def _resolve_scene_entries_world_bible(
    story_id: str,
    story: dict,
    idea: dict,
    body: str,
    scene_count: int,
    safe_id: str,
    out_dir: Path,
) -> tuple[list[str], list[list[str]], dict | None, int]:
    """Return (prompts, entity_ids_per_scene, bible, cents_spent_on_refs)
    for the world-bible path. Builds bible + refs + scene entries on
    cache miss; reads from cache on hit. The entity_ids_per_scene list
    is parallel to prompts (index N has the ids for scene N).

    Caller (`_regen_one_scene` / `_regen_scenes`) feeds the entity_ids
    into `world_bible.entities_by_ids` to pull ref URLs for the kie
    call — see `_refs_for_scene` below.
    """
    cached_prompts, cached_marker = _read_cached_scene_prompts_with_marker(story)
    cached_entity_ids = _read_cached_scene_entity_ids(story)
    if (
        cached_prompts
        and len(cached_prompts) >= scene_count
        and cached_marker == SCENE_PROMPTS_BUILT_WITH_WORLD_BIBLE
        and len(cached_entity_ids) >= scene_count
    ):
        bible = _read_world_bible_from_story(story)
        print(
            f"[scene prompts cache hit] story={story_id} "
            f"marker={cached_marker} count={len(cached_prompts)}"
        )
        return (
            cached_prompts[:scene_count],
            cached_entity_ids[:scene_count],
            bible,
            0,
        )

    if cached_prompts and cached_marker != SCENE_PROMPTS_BUILT_WITH_WORLD_BIBLE:
        print(
            f"[scene prompts cache evict] story={story_id} "
            f"cached_marker={cached_marker or 'none'} "
            f"expected={SCENE_PROMPTS_BUILT_WITH_WORLD_BIBLE} — rebuilding"
        )
    else:
        print(
            f"[scene prompts cache miss] story={story_id} world_bible path "
            f"target={scene_count} — firing LLM call"
        )

    bible, ref_cents = _ensure_world_bible_with_refs(
        story_id=story_id,
        story=story,
        safe_id=safe_id,
        idea=idea,
        body=body,
        out_dir=out_dir,
    )
    if bible is None:
        # Bible build failed entirely; caller falls back to grounded
        # narration path.
        return [], [], None, ref_cents

    narrations = _scene_narrations_from_story(story, scene_count)
    if not narrations or len(narrations) != scene_count:
        print(
            f"[scene prompts world_bible] story={story_id} fallback=grounded "
            "(narrations not aligned with scene_count)"
        )
        return [], [], bible, ref_cents

    entries = stages.make_scene_prompts_from_bible(
        idea, body, narrations, bible, dry_run=False,
    )
    prompts = [e.get("prompt", "") for e in entries]
    entity_ids_per_scene = [
        list(e.get("entity_ids") or []) for e in entries
    ]
    print(
        f"[scene prompts world_bible] story={story_id} "
        f"count={len(prompts)} tagged_scenes="
        f"{sum(1 for ids in entity_ids_per_scene if ids)}"
    )
    if prompts:
        _write_cached_scene_prompts(
            story_id, story, prompts,
            marker=SCENE_PROMPTS_BUILT_WITH_WORLD_BIBLE,
            bible=None,  # bible already persisted separately above
            entity_ids_per_scene=entity_ids_per_scene,
        )
    return prompts, entity_ids_per_scene, bible, ref_cents


def _read_cached_scene_entity_ids(story: dict) -> list[list[str]]:
    """Read `pipeline_cache.scene_entity_ids` off a story row. Empty
    list when missing — caller treats that as a partial cache (caller
    rebuilds if it conflicts with `scene_prompts` length). Lived in
    `video_config` until 2026-06-14; see
    `_plans/2026-06-14-pipeline-cache-column.md`."""
    cache = store.read_story_pipeline_cache(story)
    cached = cache.get("scene_entity_ids") if cache else None
    if not isinstance(cached, list):
        return []
    out: list[list[str]] = []
    for entry in cached:
        if isinstance(entry, list):
            out.append([str(i) for i in entry if isinstance(i, str)])
        else:
            out.append([])
    return out


def _read_world_bible_from_story(story: dict) -> dict | None:
    """Returns the marker-validated bible off `stories.pipeline_cache`
    via `pipeline/world_bible.py:read_world_bible`. Lived under
    `video_config.world_bible` until 2026-06-14; see
    `_plans/2026-06-14-pipeline-cache-column.md`."""
    from pipeline import world_bible as wb
    return wb.read_world_bible(story)


def _refs_for_scene(
    bible: dict | None, entity_ids: list[str],
) -> list[str]:
    """Look up the entity ids in the bible and return the list of
    reference_image_urls that exist (drops None / missing). Used by
    the per-scene kie call to build its `image_input` array."""
    from pipeline import world_bible as wb
    if not bible or not entity_ids:
        return []
    entries = wb.entities_by_ids(bible, entity_ids)
    return wb.reference_urls(entries)


def _resolve_scene_prompts_cached(
    story_id: str,
    story: dict,
    idea: dict,
    body: str,
    scene_count: int,
) -> list[str]:
    """Return the scene prompt list for `story`, building it via the LLM
    only when `pipeline_cache.scene_prompts` is missing, too short, or
    built with a previous prompt-shape (marker mismatch). Persists the
    freshly-built list back into pipeline_cache so sibling workers in
    the same batch read from cache. Lived inside video_config until
    2026-06-14; see `_plans/2026-06-14-pipeline-cache-column.md`.

    Returns the SCENE prompts only — the hero slot (prompts[0] from the
    legacy hero+scenes builder) is stripped before caching so callers
    can index directly with their `scene:N` slug N.

    Cache invalidation: the TS bulk enqueue clears the cache on each
    Rebuild-all click, so a fresh batch always gets a fresh LLM call.
    Per-scene "Redo" clicks via the granular grid keep the cache so the
    new image is consistent with its neighbors — UNLESS the cached
    entry's `built_with` marker doesn't match the current grounded
    shape, in which case we evict and rebuild grounded. That's how
    pre-fix stories self-recover on their first Redo click.

    Grounded path (default): builds one prompt per scene bound to that
    scene's narration line (from doodle_frames + captions). Falls back
    to the legacy article-body-only builder when the setting is off OR
    when narrations can't be derived (no doodle_frames yet, malformed
    config). The fallback also writes a "legacy_v0" marker so when
    grounding flips back on, the next regen evicts the legacy cache.
    """
    grounding_on = _scene_prompt_grounding_enabled()
    cached_prompts, cached_marker = _read_cached_scene_prompts_with_marker(story)
    expected_marker = (
        SCENE_PROMPTS_BUILT_WITH_GROUNDED if grounding_on
        else SCENE_PROMPTS_BUILT_WITH_LEGACY
    )

    if (
        cached_prompts
        and len(cached_prompts) >= scene_count
        and cached_marker == expected_marker
    ):
        print(
            f"[scene prompts cache hit] story={story_id} "
            f"cached_count={len(cached_prompts)} target={scene_count} "
            f"marker={cached_marker}"
        )
        return cached_prompts[:scene_count]

    if cached_prompts and cached_marker != expected_marker:
        print(
            f"[scene prompts cache evict] story={story_id} "
            f"cached_marker={cached_marker or 'none'} "
            f"expected={expected_marker} — rebuilding"
        )
    else:
        print(
            f"[scene prompts cache miss] story={story_id} "
            f"cached_count={len(cached_prompts) if cached_prompts else 0} "
            f"target={scene_count} — firing LLM call"
        )

    if grounding_on:
        narrations = _scene_narrations_from_story(story, scene_count)
        if narrations and len(narrations) == scene_count:
            cached_bible = (
                _read_cached_character_bible(story)
                if _character_bible_cache_enabled()
                else None
            )
            print(
                f"[scene prompts bible] story={story_id} "
                f"cached={cached_bible is not None}"
            )
            scene_prompts, bible = stages.make_grounded_scene_prompts(
                idea, body, narrations, dry_run=False,
                cached_bible=cached_bible,
            )
            print(
                f"[scene prompts grounded] story={story_id} "
                f"count={len(scene_prompts)} "
                f"bible_chars={len(bible['characters']) if bible else 0}"
            )
            if scene_prompts:
                _write_cached_scene_prompts(
                    story_id, story, scene_prompts,
                    marker=SCENE_PROMPTS_BUILT_WITH_GROUNDED,
                    bible=bible,
                )
            return scene_prompts
        print(
            f"[scene prompts grounded] story={story_id} fallback=legacy "
            "(no narrations available — story may pre-date doodle_frames)"
        )

    # Legacy path: setting off OR narrations unavailable. Use the original
    # builder and stamp a legacy marker so a later grounded run evicts.
    prompts = stages.make_image_prompts(
        idea, body, dry_run=False, n=scene_count + 1,
    )
    scene_prompts = prompts[1:] if len(prompts) > 1 else prompts
    if scene_prompts:
        _write_cached_scene_prompts(
            story_id, story, scene_prompts,
            marker=SCENE_PROMPTS_BUILT_WITH_LEGACY,
            bible=None,
        )
    return scene_prompts


def _scene_narrations_from_story(
    story: dict, scene_count: int,
) -> list[str]:
    """Pull `video_config.doodle_frames` + `video_config.captions` off the
    story and derive the per-scene narration list. Returns [] when either
    is missing/malformed; caller falls back to the legacy article-only
    prompt path. We don't require the lists to be equal length — if
    doodle_frames is shorter than scene_count we still return what's
    there so the caller can decide (it will fall back). When LONGER, we
    trim to scene_count so the returned list lines up 1:1 with the kie
    slot indices."""
    raw = story.get("video_config")
    if not raw:
        return []
    try:
        config = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(config, dict):
        return []
    frames = config.get("doodle_frames")
    captions = config.get("captions")
    if not isinstance(frames, list) or not isinstance(captions, list):
        return []
    narrations = stages.derive_scene_narrations(frames, captions)
    if not narrations:
        return []
    if len(narrations) > scene_count:
        return narrations[:scene_count]
    return narrations


def _read_cached_character_bible(story: dict) -> dict | None:
    """Read `pipeline_cache.character_bible` off a story row. Returns
    None on any malformed shape — caller treats that as a miss and pays
    for the bible call. Lived in `video_config` until 2026-06-14; see
    `_plans/2026-06-14-pipeline-cache-column.md`."""
    cache = store.read_story_pipeline_cache(story)
    bible = cache.get("character_bible") if cache else None
    if not isinstance(bible, dict):
        return None
    chars = bible.get("characters")
    if not isinstance(chars, list) or not chars:
        return None
    # Light shape validation — anything weirder than this drops to a
    # miss because make_grounded_scene_prompts can't use it safely.
    cleaned: list[dict] = []
    for c in chars:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name", "")).strip()
        cues = str(c.get("visual_cues", "")).strip()
        if name and cues:
            cleaned.append({"name": name, "visual_cues": cues})
    if not cleaned:
        return None
    return {
        "characters": cleaned[:4],
        "summary": str(bible.get("summary", "")).strip(),
    }


def _read_cached_scene_prompts_with_marker(
    story: dict,
) -> tuple[list[str] | None, str | None]:
    """Returns (scene_prompts, scene_prompts_built_with) off the story's
    `pipeline_cache` so the resolver can decide whether to trust the
    cache or evict on shape mismatch. Lived inside `video_config` until
    2026-06-14; see
    `_plans/2026-06-14-pipeline-cache-column.md`."""
    cache = store.read_story_pipeline_cache(story)
    if not cache:
        return None, None
    cached = cache.get("scene_prompts")
    marker = cache.get("scene_prompts_built_with")
    if not isinstance(cached, list):
        return None, None
    cleaned = [str(p) for p in cached if isinstance(p, str) and p.strip()]
    if not cleaned:
        return None, None
    return cleaned, str(marker) if isinstance(marker, str) else None


def _write_cached_scene_prompts(
    story_id: str,
    story: dict,
    scene_prompts: list[str],
    *,
    marker: str,
    bible: dict | None,
    entity_ids_per_scene: list[list[str]] | None = None,
) -> None:
    """Stamp the prompt list + shape marker (+ optional character bible
    + optional per-scene entity ids) into `stories.pipeline_cache`.
    Best-effort — a failure here doesn't prevent the regen because the
    prompt is still being used by this caller; cache just won't hit on
    the next scene.

    Pre-2026-06-14: lived in `video_config`. The editor's
    parseVideoConfig drops unknown top-level fields and the heartbeat
    write path wiped the cache silently — see
    `_plans/2026-06-14-pipeline-cache-column.md` for the diagnosis.

    The `marker` keys the cache to its prompt-build shape so a future
    code change that bumps the marker (or flips between grounded and
    legacy) self-evicts every previously-cached batch on first contact.
    The `bible` (when provided) is stored alongside so a sibling regen
    on the same story reuses the same characters instead of paying for
    a second bible call.

    `entity_ids_per_scene` (2026-06-14 Option C) is the parallel list
    of bible entity ids on-screen in each scene — written under
    `scene_entity_ids` so the scene call later looks up the matching
    refs for the kie image_input. Same length as `scene_prompts`.
    """
    cache = store.read_story_pipeline_cache(story)
    new_cache: dict = {
        **cache,
        "scene_prompts": list(scene_prompts),
        "scene_prompts_built_with": marker,
    }
    if bible is not None:
        new_cache["character_bible"] = bible
    if entity_ids_per_scene is not None:
        new_cache["scene_entity_ids"] = [
            list(ids) for ids in entity_ids_per_scene
        ]
    try:
        store.update_story_pipeline_cache(story_id, new_cache)
        # Keep the in-memory story row in sync so the next reader in
        # this regen run hits the cache. JSON-encode to match what the
        # DB round-trip would return.
        story["pipeline_cache"] = json.dumps(new_cache)
    except Exception as e:  # noqa: BLE001
        print(
            f"[scene prompts cache write] story={story_id} FAILED: {e} — "
            "continuing without cache"
        )


def _read_scene_urls(story: dict) -> list[str]:
    """Parse stories.images JSON into a list. Tolerates null + invalid
    inputs (returns []) so the per-image regen path always has a list to
    work with."""
    raw = story.get("images")
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    return [u for u in parsed if isinstance(u, str)] if isinstance(parsed, list) else []


def _read_prop_list(story: dict) -> list[dict]:
    """Parse stories.props JSON into a list of {url,label,side} dicts."""
    raw = story.get("props")
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    return [p for p in parsed if isinstance(p, dict)] if isinstance(parsed, list) else []
