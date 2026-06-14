"""Reddit candidate sync — CSV in, reddit_source rows out.

Parses the user's exported "RedditDB" sheet (see
ref/MSN-RSS-Researcher-Reddit - RedditDB.csv for the canonical shape) and
upserts each row into the local reddit_source table. The PK is the Reddit
post id, so re-syncing the same CSV is a no-op for unchanged rows and a
content-only refresh for posts that grew (newer comment counts, edited
title, etc.). The admin-managed columns (status, story_id, notes) are
deliberately preserved — see pipeline/store.py:upsert_reddit_source.

Run from the repo root:
    python -m pipeline.reddit_db_sync --csv ref/redditdb.csv
    python -m pipeline.reddit_db_sync --csv ref/redditdb.csv --dry-run

The dry-run path computes the diff (new / updated / unchanged counts and
sample new ids) without writing anything, so the admin upload page can
preview a sync before committing.

Observability: every meaningful step emits a namespaced `[reddit-sync …]`
log line with structured values. See _plans/2026-06-14-reddit-db-sync.md
for the full observability section.
"""
from __future__ import annotations

import argparse
import csv
import datetime
import sys
import time
from pathlib import Path
from typing import Iterable

from pipeline import store

# The 9 columns the parser expects, in the same order the source sheet
# exports them. Header-row drift (a column rename, an inserted column) is
# treated as a hard error — silent column re-mapping is exactly the kind of
# bug that destroys a candidate pool weeks later.
EXPECTED_HEADERS = [
    "Reddit ID",
    "Subreddit",
    "Date Written",
    "Title",
    "Full Text",
    "Comments",
    "URL",
    "Summary",
    "How Long it Is",
]


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _norm_date(raw: str) -> str:
    """Normalize the sheet's `YYYY-MM-DD HH:MM` to ISO-8601 so the
    `date_written >=` filter on the admin side is a clean string compare.
    Falls back to the raw value when the parse fails — the date_written
    column is NOT NULL, so we'd rather store an odd-shaped string than
    drop the row entirely. Bad shapes get logged at parse time."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.datetime.strptime(raw, fmt)
            return dt.replace(tzinfo=datetime.timezone.utc).isoformat()
        except ValueError:
            continue
    return raw


def _norm_int(raw: str) -> int | None:
    """Coerce a cell to int, tolerating empty / 'None' / decimal-y strings.
    Reddit-styled '1.2K' / '5M' are NOT parsed — if the source ever emits
    those we want to see the warning, not silently approximate."""
    s = (raw or "").strip()
    if not s or s.lower() == "none":
        return None
    try:
        return int(s)
    except ValueError:
        try:
            return int(float(s))
        except ValueError:
            return None


def _norm_text(raw: str) -> str:
    """Strip surrounding whitespace; preserve everything inside (newlines,
    quotes, em dashes). The store treats empty strings as not-null in
    text columns so callers that want NULL semantics pass through
    _none_if_blank below."""
    return (raw or "").strip()


def _none_if_blank(s: str) -> str | None:
    return s if s else None


def parse_csv(path: Path | str) -> tuple[list[dict], list[str]]:
    """Read the CSV at `path` and return (rows, warnings).

    `rows` is a list of dicts with every reddit_source column populated
    (status='imported', first/last_synced=now), ready to hand to
    `store.upsert_reddit_source`. `warnings` is a human-readable list of
    parse anomalies (missing reddit_id, unparseable date, duplicate id
    within file, etc.) — surfaced in the diff summary so the admin sees
    them on the import page.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"CSV not found: {p}")

    warnings: list[str] = []
    rows: list[dict] = []
    seen: dict[str, int] = {}  # reddit_id -> last-seen row index
    now = _now_iso()

    # errors='replace' so the smart-quote / em-dash corruption we already
    # see in the export doesn't abort the whole sync. The replacement char
    # (U+FFFD) lands in the cell and the row goes through; the alternative
    # is dropping thousands of otherwise-good rows for one bad byte.
    #
    # NUL bytes (0x00) are valid UTF-8 but csv.reader chokes on them with
    # an opaque "_csv.Error: line contains NUL". Sanitize them up-front:
    # they're never meaningful in this dataset (the source is
    # human-curated text), and stripping them lets the parser see the
    # rest of the row.
    import io as _io
    raw = p.read_text(encoding="utf-8", errors="replace")
    if "\x00" in raw:
        nul_count = raw.count("\x00")
        warnings.append(f"stripped {nul_count} NUL byte(s) from file before parse")
        raw = raw.replace("\x00", "")
    with _io.StringIO(raw, newline="") as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames or []
        missing = [h for h in EXPECTED_HEADERS if h not in headers]
        if missing:
            raise ValueError(
                f"CSV is missing required header columns: {missing}. "
                f"Got: {headers}"
            )

        for line_no, raw_row in enumerate(reader, start=2):  # +1 header, +1 1-indexed
            rid = _norm_text(raw_row.get("Reddit ID", ""))
            if not rid:
                warnings.append(f"line {line_no}: blank Reddit ID, skipped")
                continue
            if rid in seen:
                # Keep last occurrence (matches "latest export wins" intuition);
                # warn so the source sheet's data owner can dedupe at source.
                warnings.append(
                    f"line {line_no}: duplicate Reddit ID {rid!r} "
                    f"(first seen on line {seen[rid]}); keeping later row"
                )
            seen[rid] = line_no

            full_text = _norm_text(raw_row.get("Full Text", ""))
            length_chars = _norm_int(raw_row.get("How Long it Is", "")) or len(full_text)
            comments = _norm_int(raw_row.get("Comments", ""))

            date_raw = _norm_text(raw_row.get("Date Written", ""))
            date_iso = _norm_date(date_raw)
            if date_raw and date_iso == date_raw:
                warnings.append(
                    f"line {line_no}: date {date_raw!r} not in YYYY-MM-DD HH:MM, "
                    "stored as-is"
                )

            title = _norm_text(raw_row.get("Title", ""))
            subreddit = _norm_text(raw_row.get("Subreddit", ""))
            if not subreddit or not title or not full_text:
                # NOT NULL constraints would reject these anyway; bail before
                # the DB round-trip and tell the admin which line was bad.
                warnings.append(
                    f"line {line_no}: missing required field "
                    f"(subreddit={bool(subreddit)}, title={bool(title)}, "
                    f"full_text={bool(full_text)}); skipped"
                )
                continue

            rows.append({
                "reddit_id": rid,
                "subreddit": subreddit,
                "date_written": date_iso or date_raw,
                "title": title,
                "full_text": full_text,
                "comments": comments,
                "url": _none_if_blank(_norm_text(raw_row.get("URL", ""))),
                "summary": _none_if_blank(_norm_text(raw_row.get("Summary", ""))),
                "length_chars": length_chars,
                # Admin-managed columns: defaults only on insert path.
                # upsert_reddit_source ignores these for existing rows.
                "status": "imported",
                "story_id": None,
                "notes": None,
                "first_synced": now,
                "last_synced": now,
            })

    return rows, warnings


_REFRESH_COLS = (
    "subreddit", "date_written", "title", "full_text",
    "comments", "url", "summary", "length_chars",
)


def apply(rows: Iterable[dict], *, dry_run: bool = False) -> dict:
    """Upsert `rows` into the reddit_source table; return the diff summary.

    Strategy: a single SELECT pulls every existing row's reddit_id + refresh
    columns into memory, the in-memory diff partitions incoming rows into
    {new, updated, unchanged}, then a single executemany INSERT and a single
    executemany UPDATE under one transaction commit the writes. This is two
    DB round-trips total for the writes (plus one fetch), regardless of how
    many rows are in the CSV — orders of magnitude faster than per-row
    helper calls on a 30k-row sync.

    `dry_run=True` does the diff but skips the writes — used by the admin
    preview path.
    """
    rows = list(rows)  # may be a generator; we need a second pass for executemany
    incoming = {r["reddit_id"]: r for r in rows}

    existing = store.fetch_reddit_source_snapshot(list(incoming.keys()))

    new_rows: list[dict] = []
    updated_rows: list[dict] = []
    unchanged_count = 0
    sample_new: list[str] = []

    for rid, row in incoming.items():
        prior = existing.get(rid)
        if prior is None:
            new_rows.append(row)
            if len(sample_new) < 10:
                sample_new.append(rid)
            continue
        # Compare only the refresh columns; admin-managed columns (status,
        # story_id, notes) are never touched by sync so they don't factor.
        if all(prior.get(c) == row.get(c) for c in _REFRESH_COLS):
            unchanged_count += 1
        else:
            updated_rows.append(row)

    errors = 0
    if not dry_run:
        # Preserve tracebacks alongside the bracketed log so a constraint
        # violation is debuggable, not just "1500 errors with no clue."
        # The errors counter inflates to the WHOLE batch on rollback
        # because we don't know which row tripped — admins seeing N>0 here
        # should treat the sync as "needs investigation," not "mostly fine."
        import traceback as _tb
        if new_rows:
            try:
                store.bulk_insert_reddit_sources(new_rows)
            except Exception as e:  # noqa: BLE001
                errors += len(new_rows)
                print(
                    f"[reddit-sync bulk-insert-error] count={len(new_rows)} "
                    f"error={type(e).__name__}: {e}"
                )
                _tb.print_exc()
        if updated_rows:
            try:
                store.bulk_refresh_reddit_sources(updated_rows)
            except Exception as e:  # noqa: BLE001
                errors += len(updated_rows)
                print(
                    f"[reddit-sync bulk-update-error] count={len(updated_rows)} "
                    f"error={type(e).__name__}: {e}"
                )
                _tb.print_exc()

    return {
        "new": len(new_rows),
        "updated": len(updated_rows),
        "unchanged": unchanged_count,
        "errors": errors,
        "sample_new": sample_new,
    }


def sync(path: Path | str, *, dry_run: bool = False) -> dict:
    """End-to-end entry: parse the CSV and apply. Returns a summary dict the
    CLI prints and the (future) admin route returns as JSON."""
    t0 = time.perf_counter()
    rows, warnings = parse_csv(path)
    parse_elapsed = time.perf_counter() - t0
    print(
        f"[reddit-sync parse] file={path} rows={len(rows)} warnings={len(warnings)} "
        f"elapsed_ms={int(parse_elapsed * 1000)}"
    )

    store.init()  # idempotent — ensures the reddit_source table exists

    t1 = time.perf_counter()
    diff = apply(rows, dry_run=dry_run)
    write_elapsed = time.perf_counter() - t1
    mode = "dry-run" if dry_run else "live"
    print(
        f"[reddit-sync apply] mode={mode} new={diff['new']} updated={diff['updated']} "
        f"unchanged={diff['unchanged']} errors={diff['errors']} "
        f"elapsed_ms={int(write_elapsed * 1000)}"
    )

    if warnings:
        # Cap so a thousand-warning sync doesn't drown the terminal. The
        # admin import page shows the full list above the fold.
        print(f"[reddit-sync warnings] count={len(warnings)} first_10:")
        for w in warnings[:10]:
            print(f"  - {w}")

    return {
        **diff,
        "warnings": warnings,
        "parsed": len(rows),
        "parse_ms": int(parse_elapsed * 1000),
        "apply_ms": int(write_elapsed * 1000),
    }


def _cli() -> int:
    ap = argparse.ArgumentParser(
        description="Sync the RedditDB CSV into the local reddit_source table"
    )
    ap.add_argument("--csv", required=True, help="path to the exported RedditDB CSV")
    ap.add_argument(
        "--dry-run", action="store_true",
        help="compute the diff without writing anything to the DB",
    )
    args = ap.parse_args()
    result = sync(args.csv, dry_run=args.dry_run)
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    sys.exit(_cli())
