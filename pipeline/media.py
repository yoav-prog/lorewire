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

from pipeline import config, images, models, stages, store, voice

# Output goes under the Next app's public/ so it serves as /generated/<id>/...
# The pipeline runs from the repo root; this is the relative path it writes to.
PUBLIC_DIR_RELATIVE = Path("lorewire-app") / "public" / "generated"
PUBLIC_URL_PREFIX = "/generated"

# Reddit ids are short alphanumerics with the occasional underscore. Anything
# outside this set should never form a filesystem path: it would be either a
# bug or a hostile input.
SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")

# Default scene count. Hero is one of these (index 0), so 4 means 1 hero + 3
# scene shots. Tunable later via an admin setting if needed.
DEFAULT_IMAGE_COUNT = 4

# Rough USD cost bands per image (model -> avg). These are sized for budget
# math, not invoiced totals. Refined when kie publishes a stable per-credit
# rate or the user wants to wire real billing.
IMAGE_COST_USD = {
    "kie/gpt-image-2": 0.05,
    "kie/nano-banana-2": 0.04,
    "kie/nano-banana-pro": 0.10,
}

# USD per character. Sized from each provider's public pricing as of 2026-06.
# ElevenLabs Starter ~$0.30/1k, Google HD tier published as a chars/min rate;
# values below are conservative single-number stand-ins.
TTS_COST_PER_CHAR = {
    "google/chirp3-hd": 30e-6,   # ~$30 / 1M chars (HD)
    "google/neural2":   16e-6,   # ~$16 / 1M chars
    "google/standard":   4e-6,   # ~$4  / 1M chars
    "elevenlabs/default": 300e-6,  # ~$0.30 / 1k chars
}

# Google STT (alignment) per second of audio. Used only on Google voices.
STT_COST_PER_SECOND = 0.024 / 60.0


# kie.ai sometimes takes longer than its short default (180s) on busy hours;
# the 240s ceiling cleared timeouts on the QA fixture run without burning the
# whole pipeline on a stuck job.
IMAGE_POLL_TIMEOUT = 240


def _generate_with_retry(prompt: str, label: str, attempts: int = 2) -> str | None:
    """Call `images.generate` with one retry on transient failure.

    Returns the kie-hosted URL or None when both attempts fail. Logging is
    routed through the same namespace as the caller so a human reading the
    log sees the retry + outcome inline.
    """
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return images.generate(
                prompt, aspect_ratio="3:4", resolution="1K", poll_timeout=IMAGE_POLL_TIMEOUT
            )
        except Exception as e:
            last = e
            if attempt < attempts:
                print(f"[media image retry] {label} attempt {attempt} failed ({e}); retrying once")
    print(f"[media image] {label} FAILED after {attempts} attempts: {last}")
    return None


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
    dry_run: bool,
    repo_root: Path,
    image_count: int = DEFAULT_IMAGE_COUNT,
) -> dict:
    """Generate images + narration for one story and return DB columns.

    Returns the subset of story columns this stage owns:
    `hero_image`, `images`, `audio_url`, `alignment`, `cost_cents`. Caller
    merges them into `store.upsert_story`. Any failure inside this function is
    logged and partial output is returned (e.g. a story can still ship with
    fewer than `image_count` images if some calls fail).
    """
    safe_id = _sanitize_id(story_id)
    out: dict = {}

    print(f"[media id={safe_id}] start")
    _budget_log()

    out_dir = repo_root / PUBLIC_DIR_RELATIVE / safe_id
    if not dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
    url_prefix = f"{PUBLIC_URL_PREFIX}/{safe_id}"

    # --- images
    prompts = stages.make_image_prompts(idea, body, dry_run, n=image_count)
    print(f"[media id={safe_id} prompts] {len(prompts)} prompts (1 hero + {len(prompts) - 1} scenes)")

    image_urls: list[str] = []
    hero_succeeded = False
    for i, prompt in enumerate(prompts):
        filename = _image_filename(i)
        public_url = f"{url_prefix}/{filename}"
        label = "hero" if i == 0 else f"scene-{i}"
        if dry_run:
            print(f"[media id={safe_id} image {i + 1}/{len(prompts)}] {label} (DRY RUN) -> {public_url}")
            image_urls.append(public_url)
            if i == 0:
                hero_succeeded = True
            continue
        started = time.time()
        kie_url = _generate_with_retry(prompt, f"id={safe_id} {label}")
        if kie_url is None:
            continue
        try:
            images.download(kie_url, out_dir / filename)
        except Exception as e:
            print(f"[media id={safe_id} image {i + 1}/{len(prompts)}] {label} download FAILED: {e}")
            continue
        elapsed = time.time() - started
        print(
            f"[media id={safe_id} image {i + 1}/{len(prompts)}] {label} "
            f"({models.get_selected('images')}) -> {public_url} ({elapsed:.1f}s)"
        )
        image_urls.append(public_url)
        if i == 0:
            hero_succeeded = True

    if image_urls:
        out["hero_image"] = image_urls[0]
        out["images"] = json.dumps(image_urls[1:])
        if not hero_succeeded:
            # Hero slot failed (even after retry); the CMS renders hero_image as
            # the primary visual, so we promote the first surviving scene to it
            # rather than ship a story with no hero. Logged so a human can
            # decide whether to regenerate.
            print(f"[media id={safe_id} hero promoted] scene-1 used as hero (original hero failed)")

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
            print(
                f"[media id={safe_id} voice] {len(body)} chars "
                f"({models.get_selected('voice')}, provider={result['provider']}) "
                f"-> {url_prefix}/narration.mp3 ({elapsed:.1f}s, {len(words)} words, ~{duration:.1f}s audio)"
            )
            out["audio_url"] = f"{url_prefix}/narration.mp3"
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
    out["cost_cents"] = _story_cost_cents(len(image_urls), narration_chars, narration_seconds)

    print(f"[media id={safe_id} done] est cost ~${out['cost_cents'] / 100:.2f}")
    return out


def public_root_for(repo_root: Path) -> Path:
    """Where this stage writes files. Exposed so callers (CLI/tests) can clear it."""
    return repo_root / PUBLIC_DIR_RELATIVE
