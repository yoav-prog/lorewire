"""Local worker that drains the voice_renders queue.

Phase 4 of `_plans/2026-06-14-voiceover-picker.md`. The admin clicks
"Regenerate voiceover" in the VoicePicker; the server action inserts
one row here; this worker polls for `status='queued'`, claims the
oldest, runs `pipeline.voice.synthesize` against the story's body
with the per-row voice override, uploads to GCS, rebuilds the
captions + duration_ms in `stories.video_config`, and writes the new
audio_url + alignment + config back to `stories` in one atomic
update.

Run with:

    python -m pipeline.voice_renders_worker            # poll every 5s
    python -m pipeline.voice_renders_worker --once     # process one and exit

The fresh-pipeline path (a story being created for the first time)
does NOT go through this queue — voice synthesis happens inline
inside `generate_media`. This worker is for admin-triggered regens
ONLY, where the story already has audio + alignment + (usually) a
prior video render that needs to be marked stale.

Testability:
  - `_default_process(render_row, story_row)` is the single seam tests
    inject a stub process_fn through; the worker's tick loop is
    `run_one_tick(process_fn=...)`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
import time
import traceback
from pathlib import Path
from typing import Callable

from pipeline import gcs, narration, store, video

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_POLL_SECONDS = 5
# 15 min is a comfortable upper bound on a single TTS call — ElevenLabs
# returns in seconds for a 2500-char article, Google in <30s. Anything
# longer is a network stall and the next tick's reap should clear it.
STALE_AFTER_SECONDS = 15 * 60


def _is_serverless() -> bool:
    """True when the worker is running on Vercel's Python runtime. Used
    by `_resolve_output_dir` to route filesystem writes to /tmp instead
    of `public/generated/`, which is part of the deployed bundle and
    read-only on Vercel.
    Detection mirrors what Vercel docs suggest: VERCEL=1 is set on every
    function invocation; VERCEL_ENV carries the deployment env. Either
    is sufficient evidence we're serverless."""
    return bool(os.environ.get("VERCEL") or os.environ.get("VERCEL_ENV"))


def _resolve_output_dir(safe_id: str) -> Path:
    """Pick the writable directory for the synthesized narration. In dev
    we keep the existing pattern (write to public/generated/<id>/ so
    `gcs.publish`'s local fallback can serve `/generated/<id>/narration.mp3`
    without GCS configured). On Vercel, that path is read-only so we use
    a per-invocation /tmp subdirectory — the file lives only long enough
    to upload to GCS, and the drain DOESN'T make sense in a no-GCS
    environment anyway (the local URL would 404 since /tmp isn't served).
    Caller is responsible for cleanup; the drain wraps the call in a
    finally block that removes the tempdir."""
    if _is_serverless():
        return Path(tempfile.mkdtemp(prefix=f"voice-regen-{safe_id}-"))
    return REPO_ROOT / "lorewire-app" / "public" / "generated" / safe_id

# Sample text for the regen path. Unlike Phase 2.b's preview script,
# this isn't a fixed sentence — the body is the actual story text from
# stories.body. The constant lives here only so the test fixtures have
# something to lock against.
PUBLIC_URL_PREFIX = "/generated"

ProcessFn = Callable[[dict, dict], dict]


def text_hash(text: str) -> str:
    """SHA-256 hex digest. Used both for the voice_renders.text_hash
    column (so the partial unique index catches duplicate enqueues for
    the same body) AND inside the server action's pre-flight idempotency
    check.

    Empty / None text returns the hex digest of the empty string —
    callers MUST validate body before enqueueing; this helper is
    intentionally permissive so it never crashes on bad input."""
    if not text:
        text = ""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _default_process(render_row: dict, story_row: dict) -> dict:
    """Real process path: synth + GCS upload + caption rebuild +
    column write. Returns a result dict {audio_url, cost_cents} the
    worker hands to `finish_voice_render`."""
    body = (story_row.get("body") or "").strip()
    if not body:
        raise RuntimeError("story has no body text to synthesize")

    safe_id = _sanitize_id(story_row["id"])
    out_dir = _resolve_output_dir(safe_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    narration_path = out_dir / "narration.mp3"
    serverless_tempdir = out_dir if _is_serverless() else None

    # Snapshot media cost before/after so we can write per-render spend
    # to voice_renders.cost_cents — mirrors the story_jobs cost-capture
    # pattern. TTS provider tables are in pipeline/media.py.
    from pipeline import media
    before_usd = media.running_cost_usd()

    # Single entry point: normalize -> TTS -> script-graft alignment.
    # Skipping any of the three puts homophones/missing punctuation/
    # dropped words back into the admin regen's stored alignment, which
    # the Read-along and gallery consumers then surface unchanged.
    result = narration.render_narration(
        body,
        narration_path,
        override_provider=render_row.get("voice_provider"),
        override_voice_id=render_row.get("voice_id"),
    )
    print(
        f"[voice regen] story={story_row['id']} "
        f"provider={result.get('provider')} "
        f"chars={len(result.get('spoken_script', ''))} "
        f"words={len(result.get('words', []))}"
    )
    store.update_voice_render_progress(render_row["id"], 60)

    # Upload to GCS (or fall back to the local path when GCS isn't
    # configured — same publish() contract the rest of the pipeline uses).
    stored_url = gcs.publish(
        narration_path,
        f"{safe_id}/narration.mp3",
        f"{PUBLIC_URL_PREFIX}/{safe_id}/narration.mp3",
    )

    # Rebuild captions from the new word-level alignment, and lift the
    # duration off the last chunk. The doodle_frames structure is
    # preserved BUT we clamp each frame's caption_chunk_start_index
    # so a frame that pointed past the end of the new caption list
    # doesn't crash the editor preview's find().
    words = result.get("words", [])
    alignment_json = json.dumps(words)
    caption_chunks = video._chunk_alignment(words)
    duration_ms = caption_chunks[-1]["end_ms"] if caption_chunks else 0

    raw_config = story_row.get("video_config")
    cfg: dict = {}
    if raw_config:
        try:
            parsed = json.loads(raw_config)
            if isinstance(parsed, dict):
                cfg = parsed
        except json.JSONDecodeError:
            cfg = {}
    cfg["captions"] = caption_chunks
    cfg["duration_ms"] = duration_ms
    # Trim window resets — the new audio has different ms boundaries so
    # the old clip_start_ms / clip_end_ms would land mid-word.
    cfg.pop("clip_start_ms", None)
    cfg.pop("clip_end_ms", None)
    # Clamp doodle_frames' caption indices into the new range.
    frames = cfg.get("doodle_frames")
    if isinstance(frames, list) and caption_chunks:
        max_idx = len(caption_chunks) - 1
        for f in frames:
            if not isinstance(f, dict):
                continue
            ci = f.get("caption_chunk_start_index")
            if isinstance(ci, int) and ci > max_idx:
                f["caption_chunk_start_index"] = max_idx

    store.update_story_voice_render_output(
        story_id=story_row["id"],
        audio_url=stored_url,
        alignment_json=alignment_json,
        video_config_json=json.dumps(cfg),
    )

    after_usd = media.running_cost_usd()
    cost_cents = max(0, round((after_usd - before_usd) * 100))

    # Best-effort cleanup of the per-invocation /tmp subdir on serverless.
    # /tmp on Vercel is 512MB shared across invocations; a queue of 100
    # voice renders without cleanup would eat ~5GB of stale narration.mp3
    # files between cold boots. Errors here are swallowed because the
    # synth + upload already succeeded — leaking a tempdir is a footnote
    # next to losing the regen.
    if serverless_tempdir is not None:
        try:
            shutil.rmtree(serverless_tempdir, ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass

    return {"audio_url": stored_url, "cost_cents": cost_cents}


def run_one_tick(process_fn: ProcessFn | None = None) -> bool:
    """Claim and process one voice_render. Returns True if work happened
    (success OR failure), False when the queue is empty. Any exception
    in the process path is recorded against the row so a bad render
    doesn't crash the loop.
    """
    pfn = process_fn if process_fn is not None else _default_process

    # Reap crash-orphaned 'processing' rows BEFORE claim so a reaped row
    # can be re-claimed on this same tick. Mirrors story_jobs.
    reaped = store.reap_stale_voice_renders(STALE_AFTER_SECONDS)
    if reaped:
        print(f"[voice regen reap] reset_stale={reaped}")

    claimed = store.claim_next_voice_render()
    if claimed is None:
        return False

    render_id = claimed["id"]
    story_id = claimed["story_id"]
    print(
        f"[voice regen claim] render={render_id} story={story_id} "
        f"provider={claimed.get('voice_provider')} "
        f"voice_id={claimed.get('voice_id')}"
    )

    story = store.fetch_story(story_id)
    if story is None:
        store.fail_voice_render(render_id, f"story {story_id} not found")
        print(f"[voice regen error] render={render_id} missing story")
        return True

    try:
        result = pfn(claimed, story)
    except Exception as e:  # noqa: BLE001 — worker catches everything per-row
        traceback.print_exc()
        store.fail_voice_render(render_id, f"{type(e).__name__}: {e}")
        print(f"[voice regen error] render={render_id} {type(e).__name__}: {e}")
        return True

    audio_url = result.get("audio_url") if isinstance(result, dict) else None
    cost_cents = result.get("cost_cents") if isinstance(result, dict) else None
    if not audio_url:
        store.fail_voice_render(render_id, "process returned no audio_url")
        print(f"[voice regen error] render={render_id} no audio_url returned")
        return True

    store.finish_voice_render(render_id, audio_url, cost_cents)
    print(
        f"[voice regen done] render={render_id} story={story_id} "
        f"audio_url={audio_url} cost_cents={cost_cents}"
    )
    return True


def run_loop(poll_seconds: int = DEFAULT_POLL_SECONDS) -> None:
    print(
        f"[voice regen worker] started "
        f"(poll={poll_seconds}s, stale_after={STALE_AFTER_SECONDS}s, "
        f"repo={REPO_ROOT})"
    )
    while True:
        did_work = run_one_tick()
        if not did_work:
            time.sleep(poll_seconds)


def _sanitize_id(story_id: str) -> str:
    """Mirror of media._sanitize_id — preserve only chars safe on the
    filesystem + URL path. Kept private here so the worker doesn't
    drag the rest of media.py's import surface in for one helper."""
    import re
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "", story_id or "")
    return cleaned or "unknown"


def _cli() -> int:
    parser = argparse.ArgumentParser(
        description="Drain the voice_renders queue.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Process one render (or exit if empty), then stop.",
    )
    parser.add_argument(
        "--poll-seconds",
        type=int,
        default=DEFAULT_POLL_SECONDS,
    )
    args = parser.parse_args()
    store.init()
    if args.once:
        ran = run_one_tick()
        if not ran:
            print("[voice regen worker] queue empty — nothing to do")
        return 0
    try:
        run_loop(args.poll_seconds)
    except KeyboardInterrupt:
        print("[voice regen worker] stopping on interrupt")
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
