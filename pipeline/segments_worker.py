"""Pipeline-side worker for the intro/outro library.

Polls `video_segments WHERE status='uploading'` every N seconds; for each
hit, downloads the raw source from GCS, runs ffmpeg normalize via
`pipeline.segments.normalize`, uploads the normalized result back to GCS,
and flips the row to 'ready'. Sweeps abandoned 'pending' rows whose
browser-side PUT never finalized.

Runs forever; safe to Ctrl-C. Idempotent: a row that errors stays 'error'
and is never re-picked unless an admin resets it manually (rare; the admin
deletes and re-uploads instead).

Why a separate process from pipeline.run: this loop must run continuously
to back the admin upload UX, while pipeline.run is invoked on demand for
content batches. Crashes in normalize must not take down render scheduling
and vice versa.

Run as:
    python -m pipeline.segments_worker
    python -m pipeline.segments_worker --interval-s 5 --abandon-after-min 5
    python -m pipeline.segments_worker --once    # one iteration, then exit
"""
from __future__ import annotations

import argparse
import datetime
import shutil
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Callable, Iterable, Optional

from pipeline import gcs, segments, store

# Defaults are tuned for the small-team upload cadence (rule 15: surface in
# settings later if these ever become the wrong knobs). The poll interval and
# abandon threshold are also accepted as CLI args for ad-hoc tweaking.
_DEFAULT_INTERVAL_S = 5.0
_DEFAULT_ABANDON_AFTER_MIN = 5

# Cap how much error detail we persist. We never render this as HTML in the
# admin, but a 50 KB stderr dump in a DB column is still wasteful and the
# meaningful failure signal is always in the last line of ffmpeg's stderr.
_MAX_ERROR_LEN = 500

# Type aliases so the dependency-injection signature of process_segment reads
# cleanly. The worker is the only caller; tests substitute fakes for these.
DownloadFn = Callable[[str, Path], None]
NormalizeFn = Callable[[Path, Path, str], dict]
UploadFn = Callable[[Path, str], str]
SetStatusFn = Callable[..., None]
ListAbandonedFn = Callable[[str], Iterable[dict]]
GetSettingFn = Callable[[str], Optional[str]]
SetSettingFn = Callable[[str, str], None]


def _active_setting_key(kind: str) -> str:
    """Settings key for the global-active pointer of an intro/outro kind. Has
    to match the key the admin's `setActiveSegmentAction` writes (see
    lorewire-app/src/app/admin/actions.ts) and the picker `pick_segment`
    in pipeline/segments.py reads."""
    return f"video.active_{kind}_id"


def _now_utc() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _truncate_error(msg: str) -> str:
    """Clamp an error message to `_MAX_ERROR_LEN` chars, preserving the tail
    (which is where ffmpeg's actual failure line lives)."""
    if len(msg) <= _MAX_ERROR_LEN:
        return msg
    keep = _MAX_ERROR_LEN - 4  # room for the "...\n" prefix
    return "...\n" + msg[-keep:]


# --- download helper ---------------------------------------------------------

def download_source_bytes(url: str, dest: Path, timeout: float = 180.0) -> None:
    """Download `url` to `dest` (overwriting). Raises on non-2xx or network
    error. `urllib.request` is enough — segment sources are public-read GCS
    objects served from `https://storage.googleapis.com/<bucket>/<key>` so
    no auth header is required for the GET. `file://` is allowed too so smoke
    tests can drive the worker without standing up a real server; for those
    the response has no HTTP status, which we treat as success."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        status = resp.status
        if status is not None and not 200 <= status < 300:
            raise RuntimeError(f"download HTTP {status}: {url}")
        with open(dest, "wb") as out:
            shutil.copyfileobj(resp, out)


# --- pure-ish orchestration --------------------------------------------------

def process_segment(
    row: dict,
    *,
    tmp_root: Path,
    download: DownloadFn,
    normalize_fn: NormalizeFn,
    upload_fn: UploadFn,
    set_status: SetStatusFn,
    get_setting: GetSettingFn,
    set_setting: SetSettingFn,
) -> None:
    """End-to-end processing for one `status='uploading'` row.

    Caller is the worker loop. All side-effecting collaborators
    (download / ffmpeg / GCS upload / DB write) are injected so tests can
    stub them without touching the network or the filesystem-heavy ffmpeg
    path. The cleanup of `tmp_root` is the caller's responsibility — we
    only use whatever subdir we mkdir under it.

    Flow:
      1. flip status -> 'normalizing' (so a concurrent poll skips this row).
      2. download source from `row['source_url']` to a tmp dir.
      3. ffmpeg normalize source -> normalized.mp4 in the same tmp dir.
      4. upload normalized.mp4 to `segments/<id>.norm.mp4` in GCS.
      5. flip status -> 'ready' with normalized_url + duration_ms + enabled=1.

    On any exception, flip status -> 'error' with a truncated repr of the
    exception. Never re-raises — the worker loop must stay alive for the
    next row.
    """
    seg_id = str(row.get("id") or "")
    if not seg_id:
        print("[segments worker] skip row without id")
        return

    source_url = str(row.get("source_url") or "")
    kind = str(row.get("kind") or "")
    print(f"[segments worker] pick id={seg_id} kind={kind} source_url={source_url}")

    work_dir = tmp_root / seg_id
    work_dir.mkdir(parents=True, exist_ok=True)
    source_path = work_dir / "source"
    normalized_path = work_dir / "normalized.mp4"

    try:
        set_status(seg_id, "normalizing")

        if not source_url:
            raise RuntimeError("source_url is empty")
        download(source_url, source_path)
        size_mb = source_path.stat().st_size / (1024 * 1024)
        print(f"[segments worker] downloaded id={seg_id} size={size_mb:.1f} MB")

        meta = normalize_fn(source_path, normalized_path, seg_id)
        duration_ms = int(meta.get("duration_ms") or 0)

        normalized_url = upload_fn(normalized_path, f"segments/{seg_id}.norm.mp4")
        print(
            f"[segments worker] uploaded id={seg_id} "
            f"normalized_url={normalized_url} duration_ms={duration_ms}"
        )

        set_status(
            seg_id,
            "ready",
            normalized_url=normalized_url,
            duration_ms=duration_ms,
            enabled=1,
            error=None,
        )

        # Auto-activate the first segment of its kind, mirroring the UX the
        # old (deleted) uploadSegmentAction provided: an admin who uploads
        # their first intro shouldn't have to click "Set as active" too.
        # Only fires when no active id is set — never overrides an explicit
        # admin pick. Bracket this in a try so a transient settings hiccup
        # cannot reverse the "ready" flip we just made above.
        if kind in ("intro", "outro"):
            try:
                key = _active_setting_key(kind)
                current_active = (get_setting(key) or "").strip()
                if not current_active:
                    set_setting(key, seg_id)
                    print(
                        f"[segments worker] auto-activate kind={kind} id={seg_id}"
                    )
            except Exception as inner:
                print(
                    f"[segments worker] auto-activate FAILED id={seg_id}: {inner!r}"
                )

        print(f"[segments worker] done id={seg_id}")
    except Exception as e:
        err = _truncate_error(repr(e))
        # Best-effort failure write — if even this fails the worker logs and
        # moves on; the row stays in 'normalizing' and an admin can delete it
        # by hand. We do not want a transient DB hiccup to crash the loop.
        try:
            set_status(seg_id, "error", error=err)
        except Exception as inner:
            print(f"[segments worker] CRITICAL id={seg_id} error-write FAILED: {inner!r}")
        print(f"[segments worker] FAILED id={seg_id}: {err}")
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def sweep_abandoned(
    *,
    now: datetime.datetime,
    abandon_after_min: int,
    list_abandoned: ListAbandonedFn,
    set_status: SetStatusFn,
) -> int:
    """Mark `pending` rows older than `abandon_after_min` as `error`.

    Returns the count of rows swept. Pure: all collaborators are injected.
    """
    threshold = (now - datetime.timedelta(minutes=abandon_after_min)).isoformat()
    swept = 0
    for row in list_abandoned(threshold):
        seg_id = str(row.get("id") or "")
        if not seg_id:
            continue
        try:
            set_status(seg_id, "error", error="upload abandoned before finalize")
            print(f"[segments worker] sweep id={seg_id} status=pending->error (abandoned)")
            swept += 1
        except Exception as inner:
            print(f"[segments worker] sweep-write FAILED id={seg_id}: {inner!r}")
    return swept


# --- loop --------------------------------------------------------------------

def tick(
    *,
    tmp_root: Path,
    abandon_after_min: int,
    download: DownloadFn = download_source_bytes,
    normalize_fn: NormalizeFn = segments.normalize,
    upload_fn: UploadFn = gcs.upload,
    list_pending: Optional[Callable[[int], list[dict]]] = None,
    list_abandoned: Optional[ListAbandonedFn] = None,
    set_status: SetStatusFn = store.set_segment_status,
    get_setting: GetSettingFn = store.get_setting,
    set_setting: SetSettingFn = store.set_setting,
) -> bool:
    """One iteration of the worker loop. Returns True if a row was processed
    (caller can keep ticking without sleeping) or False if the queue was
    empty (caller should sleep before the next tick).

    Splits the loop body out so `--once` and tests can drive a single pass
    without spinning the real `while True`.
    """
    list_pending = list_pending or store.list_pending_segments
    list_abandoned = list_abandoned or store.list_abandoned_pending_segments

    sweep_abandoned(
        now=_now_utc(),
        abandon_after_min=abandon_after_min,
        list_abandoned=list_abandoned,
        set_status=set_status,
    )

    rows = list_pending(1)
    if not rows:
        return False
    process_segment(
        rows[0],
        tmp_root=tmp_root,
        download=download,
        normalize_fn=normalize_fn,
        upload_fn=upload_fn,
        set_status=set_status,
        get_setting=get_setting,
        set_setting=set_setting,
    )
    return True


def main(
    interval_s: float = _DEFAULT_INTERVAL_S,
    abandon_after_min: int = _DEFAULT_ABANDON_AFTER_MIN,
    once: bool = False,
) -> None:
    """Worker entrypoint. Initializes the schema (no-op if up to date), then
    loops `tick()` forever (or once when `once=True`)."""
    print(
        f"[segments worker] start interval_s={interval_s} "
        f"abandon_after_min={abandon_after_min} once={once}"
    )
    store.init()
    tmp_root = Path(tempfile.gettempdir()) / "lw-segments-worker"
    tmp_root.mkdir(parents=True, exist_ok=True)
    try:
        while True:
            processed = tick(tmp_root=tmp_root, abandon_after_min=abandon_after_min)
            if once:
                return
            if not processed:
                time.sleep(interval_s)
    except KeyboardInterrupt:
        print("[segments worker] stopped by SIGINT")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="LoreWire intro/outro normalize worker")
    ap.add_argument(
        "--interval-s",
        type=float,
        default=_DEFAULT_INTERVAL_S,
        help="seconds between polls when the queue is empty (default: %(default)s)",
    )
    ap.add_argument(
        "--abandon-after-min",
        type=int,
        default=_DEFAULT_ABANDON_AFTER_MIN,
        help=(
            "minutes a row may sit in 'pending' before the sweeper marks it "
            "'error' (default: %(default)s)"
        ),
    )
    ap.add_argument(
        "--once",
        action="store_true",
        help="run a single tick and exit (useful for cron-style scheduling)",
    )
    return ap.parse_args(argv)


if __name__ == "__main__":
    args = _parse_args()
    main(
        interval_s=args.interval_s,
        abandon_after_min=args.abandon_after_min,
        once=args.once,
    )
