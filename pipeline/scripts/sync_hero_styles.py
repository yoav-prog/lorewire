"""Emit the hero style registry as JSON for the TS side to consume.

Python is the source of truth for HERO_STYLES + CATEGORY_STYLE_WHITELIST
(see pipeline/stages.py). This script renders both into
`lorewire-app/src/data/hero-styles.json` so the TS picker UI doesn't
have to drift-by-hand-edit. Run after any change to the Python registry:

    python -m pipeline.scripts.sync_hero_styles

The committed JSON file is the contract — `lorewire-app/src/lib/hero-styles.ts`
imports it. The parity test in `pipeline/tests/test_hero_styles_sync.py`
re-runs this script in memory and diffs against the committed file, so
forgetting to re-run after editing the Python is caught in CI.

Adds `thumbnail_url` keys so step 3 (thumbnail generation) can patch
those in without changing the schema. The TS picker treats null as
"no preview available".
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pipeline import stages


def build_payload() -> dict[str, Any]:
    """Return the dict that gets serialised to JSON. Pure — no I/O.
    Kept separate from the writer so the parity test can call it
    without writing files."""
    return {
        "schema_version": 1,
        "styles": [
            {
                "id": style.id,
                "label": style.label,
                "thumbnail_url": style.thumbnail_url,
            }
            for style in stages.HERO_STYLES.values()
        ],
        "category_whitelist": dict(stages.CATEGORY_STYLE_WHITELIST),
    }


def output_path() -> Path:
    """Where the committed JSON lands. Lives under
    `lorewire-app/src/data/` so the Next build picks it up via the
    existing `@/data/...` import alias."""
    return (
        Path(__file__).resolve().parent.parent.parent
        / "lorewire-app" / "src" / "data" / "hero-styles.json"
    )


def write() -> Path:
    """Write the payload to disk + return the path. Stable-sorted +
    trailing newline so re-running with no changes produces a no-op
    diff (matters for the parity test)."""
    path = output_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = build_payload()
    # indent=2 + sort_keys=False so the field order matches what the TS
    # reader expects (styles array order matters — it's the picker's
    # display order). sort_keys=True would re-alphabetize and reorder.
    serialised = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    path.write_text(serialised, encoding="utf-8")
    return path


def main() -> None:
    path = write()
    payload = build_payload()
    print(
        f"[sync hero styles] wrote {path} — "
        f"{len(payload['styles'])} styles, "
        f"{len(payload['category_whitelist'])} categories"
    )


if __name__ == "__main__":
    main()
