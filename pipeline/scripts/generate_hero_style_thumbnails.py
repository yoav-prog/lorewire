"""Generate the hero style preview thumbnails (one per HERO_STYLES entry).

Step 3 of _plans/2026-06-17-hero-style-registry.md. For each style in
`pipeline.stages.HERO_STYLES` that doesn't already have a thumbnail
URL stored in settings, this script:

  1. Builds a TEXT-ONLY prompt — stock subject + the style's
     system_prompt_band. No character reference image (each style
     thumbnail shows its own model-chosen character — the picker
     previews the *style*, not identity continuity).
  2. Generates a 3:4 PNG via the active kie image model.
  3. Uploads to GCS at `hero-style-thumbnails/<style_id>.png`.
  4. Persists the public URL as the setting `hero.thumbnail.<style_id>`.

The Step 4 admin picker reads those settings via a tiny server action
so the committed JSON stays stable across generations. Idempotent:
skips styles whose setting already points at a non-empty URL. Use
`--force` to regenerate everything (e.g. after editing a style's
prompt band, or to refresh a stale thumbnail).

Usage::

    python -m pipeline.scripts.generate_hero_style_thumbnails
    python -m pipeline.scripts.generate_hero_style_thumbnails --force

Cost (rule 8): ~$0.04 per image at the active kie model — so the full
six-style library costs ~$0.24 to seed. The script logs the running
total so a hung gen surfaces before it burns the daily cap.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Callable, Optional

from pipeline import gcs, images, stages, store

# 3:4 portrait framing matches the hero / poster format the picker
# renders next to each style label. Kept in step with the hero gen
# path (pipeline/media.py uses 3:4 for the portrait variant).
THUMBNAIL_ASPECT = "3:4"

# Generic subject cue the prompt builder folds into every style. Spelled
# out so the model HAS a subject — without it the style band alone
# tends to produce abstract poster compositions with no character at
# all (defeats the point of a "sample character in this style"
# thumbnail).
STOCK_SUBJECT_CUE = (
    "Subject: an adult person, neutral confident expression, modern "
    "casual clothing in neutral colors, three-quarter portrait framing "
    "centered for a streaming-thumbnail composition."
)


def setting_key(style_id: str) -> str:
    """Where the URL lives. Keep in one place so the picker can read
    the same key without hand-maintaining the format string."""
    return f"hero.thumbnail.{style_id}"


def _build_prompt(style: stages.HeroStyle) -> str:
    """Bespoke prompt for STYLE PREVIEWS — never bakes a title (the
    picker shows the label separately) so `make_thumbnail_prompt` is
    deliberately not reused here."""
    return (
        f"{style.system_prompt_band} "
        f"{STOCK_SUBJECT_CUE} "
        "No text, no title, no watermarks, no signatures."
    )


def _existing_url(
    style_id: str,
    get_setting: Callable[[str], Optional[str]],
) -> str | None:
    """None when no URL is saved OR the saved value is empty/whitespace."""
    raw = (get_setting(setting_key(style_id)) or "").strip()
    return raw or None


def generate_one(
    style: stages.HeroStyle,
    repo_root: Path,
    *,
    generate_fn: Callable[[str, str], str] | None = None,
    download_fn: Callable[[str, Path], None] | None = None,
    publish_fn: Callable[[Path, str, str], str] | None = None,
    set_setting_fn: Callable[[str, str], None] | None = None,
) -> str:
    """Generate one thumbnail end-to-end and return the saved public URL.

    Every kie / gcs / store entry point is injectable so the test
    suite can run the full happy path + the failure paths without
    touching kie or GCS. Production callers pass nothing and get the
    real implementations.
    """
    g = generate_fn or (
        lambda prompt, aspect: images.generate(
            prompt, aspect_ratio=aspect, resolution="1K",
        )
    )
    d = download_fn or images.download
    p = publish_fn or gcs.publish
    ss = set_setting_fn or store.set_setting

    prompt = _build_prompt(style)
    print(f"[hero style thumbnail] gen id={style.id} aspect={THUMBNAIL_ASPECT}")
    kie_url = g(prompt, THUMBNAIL_ASPECT)

    # Stage under the repo's video/ tree so the existing pipeline temp
    # conventions cover cleanup (the dir gets recycled with the rest of
    # the video staging area).
    work_dir = repo_root / "video" / ".hero-style-thumbnails-tmp"
    work_dir.mkdir(parents=True, exist_ok=True)
    local = work_dir / f"{style.id}.png"
    d(kie_url, local)

    gcs_key = f"hero-style-thumbnails/{style.id}.png"
    # Local fallback URL used by gcs.publish when GCS isn't configured —
    # mirrors how the rest of the pipeline forms its public_url arg.
    local_fallback = f"/generated/{gcs_key}"
    final_url = p(local, gcs_key, local_fallback)

    ss(setting_key(style.id), final_url)
    print(f"[hero style thumbnail] saved id={style.id} url={final_url}")
    return final_url


def run(
    *,
    force: bool = False,
    repo_root: Path | None = None,
    get_setting: Callable[[str], Optional[str]] | None = None,
    generate_fn: Callable[[str, str], str] | None = None,
    download_fn: Callable[[str, Path], None] | None = None,
    publish_fn: Callable[[Path, str, str], str] | None = None,
    set_setting_fn: Callable[[str, str], None] | None = None,
) -> dict[str, int]:
    """Iterate the registry + dispatch generate_one for each style that
    needs one. Returns counters so the CLI's exit code can reflect
    partial-failure runs without callers parsing stdout."""
    repo = repo_root or Path(__file__).resolve().parent.parent.parent
    gs = get_setting or store.get_setting

    generated = 0
    skipped = 0
    failed = 0
    for style in stages.HERO_STYLES.values():
        existing = _existing_url(style.id, gs)
        if existing and not force:
            print(
                f"[hero style thumbnail] skip id={style.id} (already at {existing})"
            )
            skipped += 1
            continue
        try:
            generate_one(
                style, repo,
                generate_fn=generate_fn,
                download_fn=download_fn,
                publish_fn=publish_fn,
                set_setting_fn=set_setting_fn,
            )
            generated += 1
        except Exception as e:
            # Partial success — log the failure but keep going so a
            # transient kie hiccup on one style doesn't lose the rest.
            print(
                f"[hero style thumbnail] FAIL id={style.id}: {e}",
                file=sys.stderr,
            )
            failed += 1
    print(
        f"[hero style thumbnail] done generated={generated} "
        f"skipped={skipped} failed={failed}"
    )
    return {"generated": generated, "skipped": skipped, "failed": failed}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force", action="store_true",
        help="Regenerate even when a thumbnail URL is already saved.",
    )
    parser.add_argument(
        "--repo-root",
        default=str(Path(__file__).resolve().parent.parent.parent),
        help="Path to the repo root (defaults to the parent of pipeline/).",
    )
    args = parser.parse_args(argv)

    store.init()

    counts = run(force=args.force, repo_root=Path(args.repo_root))
    # Exit non-zero when something went wrong, OR when nothing got
    # generated AND nothing was already there (probably misconfigured
    # auth — surface to CI).
    if counts["failed"] > 0:
        return 1
    if counts["generated"] == 0 and counts["skipped"] == 0:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
