"""IdeasDB CSV importer.

Reads Yoav's curated "IdeasDB" Google Sheet, matches each row against the
existing reddit_source pool, and either flips an existing seed to priority
or inserts an idea-only seed that the worker will expand into a full post
via expand_seed_to_post (see pipeline/stages.py).

Idempotent on re-import: every run produces a per-row diff written to
`ideas_import_log`, dry-run by default. `--apply` commits.

Plan: _plans/2026-06-23-ideasdb-priority-import.md
CLI:  scripts/import_ideas.py  (this module also exposes `main()` for
                                `python -m pipeline.ideas_import`)
"""
from __future__ import annotations

import argparse
import csv
import dataclasses
import datetime
import hashlib
import io as _io
import json
import logging
import re
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from pipeline import store

logger = logging.getLogger(__name__)

# Required headers in the IdeasDB sheet export. Missing any of these is a
# hard error — silent column re-mapping is the bug that ruins a curated
# pool weeks after the fact.
EXPECTED_HEADERS = [
    "Category",
    "Type",
    "Headline",
    "Summary",
    "Source",
    "Strength",
    "Done Already?",
]

STRENGTH_NONE = "none"
STRENGTH_MEDIUM = "medium"
STRENGTH_STRONG = "strong"
_STRENGTH_VALUES = frozenset({STRENGTH_NONE, STRENGTH_MEDIUM, STRENGTH_STRONG})

# Reddit submission IDs are base36 (0-9 + a-z), typically 5-8 chars.
# Used to decide whether a Source token is a candidate for a reddit_id
# match vs. junk (`external_search_1`, `Supplemental`, etc.).
_REDDIT_ID_RE = re.compile(r"^[a-z0-9]{4,10}$")
# Whitespace + bullet/asterisk characters that creep in from the Sheet's
# "*1b9x4q2 *(Supplemental Concept)" formatting. Split on these so the
# first token comes out clean.
_TOKEN_SPLIT_RE = re.compile(r"[\s*,;()]+")


# ---------- data classes ------------------------------------------------------

@dataclass(frozen=True)
class IdeaRow:
    """One IdeasDB row after parsing + normalization. Immutable so the
    parser → diff → apply pipeline can't accidentally mutate the input."""
    line_no: int
    category: str
    type_: str               # 'Story' | 'List' | other
    headline: str
    summary: str
    source_raw: str          # raw cell value, preserved for source_hint
    source_tokens: tuple[str, ...]
    strength: str            # one of STRENGTH_* (always set, defaults 'medium')
    done: bool
    fingerprint: str         # normalize_fingerprint(headline, category)


@dataclass
class RowDiff:
    """One row's verdict in the import diff. `action` drives the counters
    in ImportSummary; `before`/`after` carry just the changed fields so
    the dry-run log stays readable on 2000-row imports."""
    reddit_id: str
    action: str              # 'added' | 'updated' | 'strength_only'
                             # | 'status_changed' | 'unchanged'
                             # | 'skipped_done' | 'warned'
    line_no: int
    headline: str
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    warnings: list[str] = field(default_factory=list)
    secondary_token_flips: list[str] = field(default_factory=list)


@dataclass
class ImportSummary:
    """Whole-import counters + the full per-row diff envelope. Mutated as
    compute_diff walks the rows; apply() persists this verbatim into
    ideas_import_log.diff_json."""
    run_id: str
    started_at: str
    csv_path: str
    rows_total: int = 0
    rows_skipped_list: int = 0
    rows_skipped_done: int = 0
    rows_added: int = 0
    rows_updated: int = 0
    rows_strength_only: int = 0
    rows_status_changed: int = 0
    rows_unchanged: int = 0
    rows_warned: int = 0
    seeds_vanished: int = 0
    diffs: list[RowDiff] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    vanished_ids: list[str] = field(default_factory=list)


# ---------- helpers -----------------------------------------------------------

def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _norm_text(raw: str | None) -> str:
    return (raw or "").strip()


def _norm_done(raw: str | None) -> bool:
    s = _norm_text(raw).lower()
    return s == "yes"


def _norm_strength(raw: str | None) -> str:
    """Map the Sheet's Strength column to the enum. Tolerant of trailing
    parenthetical commentary like 'Strong (Property Drama)' which appears
    in the real export — the leading word is the signal."""
    s = _norm_text(raw).lower()
    if not s:
        return STRENGTH_MEDIUM  # default with a warning, see parse_ideas_csv
    head = s.split()[0] if s.split() else s
    if head.startswith("strong"):
        return STRENGTH_STRONG
    if head.startswith("medium"):
        return STRENGTH_MEDIUM
    if head.startswith("she") or head.startswith("weak"):
        # 'she needs to wait' / 'weak' style cells — treat as medium with a warning
        return STRENGTH_MEDIUM
    return STRENGTH_MEDIUM


def normalize_fingerprint(headline: str, category: str | None) -> str:
    """Secondary match key: lowercase + whitespace-collapse +
    pipe-join(headline, category). Survives typo fixes, stays stable
    across re-imports of the same row."""
    h = re.sub(r"\s+", " ", _norm_text(headline)).lower()
    c = re.sub(r"\s+", " ", _norm_text(category)).lower()
    return f"{h}|{c}"


def _parse_source_tokens(raw: str | None) -> tuple[str, ...]:
    """Split Source on whitespace + bullet glyphs, drop empties, lowercase.
    Tokens that don't look like a reddit submission id are kept (for
    forensics in source_hint) but filtered downstream when matching."""
    s = _norm_text(raw)
    if not s:
        return ()
    parts = [p.strip().lower() for p in _TOKEN_SPLIT_RE.split(s) if p.strip()]
    return tuple(parts)


def _is_reddit_id_shape(tok: str) -> bool:
    return bool(_REDDIT_ID_RE.match(tok))


def _synthetic_reddit_id(headline: str, source_hint: str) -> str:
    """idea_<sha1(headline + '|' + source_hint)[:12]>. Stable across
    re-imports of the same row; includes source_hint so a sourceless
    idea with a different Source string later becomes a different seed
    (acceptable per the plan — the operator can dedupe by hand)."""
    payload = f"{_norm_text(headline)}|{_norm_text(source_hint)}".encode("utf-8")
    return f"idea_{hashlib.sha1(payload).hexdigest()[:12]}"


def _levenshtein_ratio(a: str, b: str) -> float:
    """Edit distance / max(len). Used to decide whether a headline edit
    is 'substantial' (>0.30 → needs_expansion=1). Iterative DP, O(len(a) *
    len(b)). Strings are short (headlines), so this is cheap.
    """
    if not a and not b:
        return 0.0
    if a == b:
        return 0.0
    if not a or not b:
        return 1.0
    la, lb = len(a), len(b)
    # Two-row DP to keep memory O(min(la, lb)).
    prev = list(range(lb + 1))
    curr = [0] * (lb + 1)
    for i in range(1, la + 1):
        curr[0] = i
        for j in range(1, lb + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            curr[j] = min(
                prev[j] + 1,            # deletion
                curr[j - 1] + 1,        # insertion
                prev[j - 1] + cost,     # substitution
            )
        prev, curr = curr, prev
    return prev[lb] / max(la, lb)


# ---------- parse -------------------------------------------------------------

def parse_ideas_csv(path: Path | str) -> tuple[list[IdeaRow], list[str]]:
    """Read the IdeasDB CSV. Returns (rows, warnings).

    Filtering happens here:
      - Type != 'Story' rows are dropped (counted as `rows_skipped_list`
        at the diff stage by counting the difference).
      - Done=Yes rows are KEPT — the merge contract uses them to skip
        the matching seed (status → 'skipped'). They're filtered by
        compute_diff after the match key is resolved.
      - Headers absent → ValueError (hard fail).

    `warnings` collects soft anomalies (missing Source, blank Strength,
    unparseable date, etc.) so the operator sees them on the dry-run
    summary.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"IdeasDB CSV not found: {p}")

    warnings: list[str] = []
    rows: list[IdeaRow] = []

    raw = p.read_text(encoding="utf-8", errors="replace")
    if "\x00" in raw:
        warnings.append(
            f"stripped {raw.count(chr(0))} NUL byte(s) from file before parse"
        )
        raw = raw.replace("\x00", "")
    # Sheets / Excel exports often prepend a UTF-8 BOM; csv.DictReader
    # treats it as part of the first header name, which makes the
    # 'Category' header match fail. Strip it before the read.
    if raw and raw[0] == "﻿":
        raw = raw[1:]

    with _io.StringIO(raw, newline="") as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames or []
        # Header matching is case-insensitive, whitespace-tolerant, and
        # forgives a known typo ("Done Aleady?" → "Done Already?") that's
        # baked into Yoav's actual Sheet. We build a map from canonical
        # header → the real header string in this file, then read every
        # row through that map so the rest of the parser stays clean.
        header_alias = {
            "done aleady?": "Done Already?",  # missing 'r' in the sheet
        }

        def _normalize(h: str) -> str:
            return header_alias.get(h.strip().lower(), h.strip()).lower()

        actual_by_canonical: dict[str, str] = {}
        for h in headers:
            canonical = _normalize(h or "")
            for expected in EXPECTED_HEADERS:
                if canonical == expected.lower():
                    actual_by_canonical[expected] = h
                    break
        missing = [h for h in EXPECTED_HEADERS if h not in actual_by_canonical]
        if missing:
            raise ValueError(
                f"IdeasDB CSV is missing required headers: {missing}. "
                f"Got: {headers}"
            )

        def _cell(raw_row: dict, expected: str) -> str:
            return raw_row.get(actual_by_canonical[expected], "")

        for line_no, raw_row in enumerate(reader, start=2):  # +1 hdr, +1 1-idx
            type_ = _norm_text(_cell(raw_row, "Type"))
            if not type_:
                warnings.append(f"line {line_no}: blank Type, treated as 'Story'")
                type_ = "Story"
            headline = _norm_text(_cell(raw_row, "Headline"))
            if not headline:
                warnings.append(f"line {line_no}: blank Headline; skipped")
                continue
            category = _norm_text(_cell(raw_row, "Category"))
            summary = _norm_text(_cell(raw_row, "Summary"))
            source_raw = _norm_text(_cell(raw_row, "Source"))
            source_tokens = _parse_source_tokens(source_raw)
            raw_strength = _norm_text(_cell(raw_row, "Strength"))
            strength = _norm_strength(raw_strength)
            if not raw_strength:
                warnings.append(
                    f"line {line_no}: blank Strength, defaulting to 'medium'"
                )
            elif strength == STRENGTH_MEDIUM and not (
                raw_strength.lower().startswith(("strong", "medium"))
            ):
                warnings.append(
                    f"line {line_no}: unrecognised Strength {raw_strength!r}, "
                    "treated as 'medium'"
                )
            done = _norm_done(_cell(raw_row, "Done Already?"))
            fingerprint = normalize_fingerprint(headline, category)

            rows.append(IdeaRow(
                line_no=line_no,
                category=category,
                type_=type_,
                headline=headline,
                summary=summary,
                source_raw=source_raw,
                source_tokens=source_tokens,
                strength=strength,
                done=done,
                fingerprint=fingerprint,
            ))

    logger.info(
        "[ideas-import csv-parse] file=%s rows_parsed=%d warnings=%d",
        str(p), len(rows), len(warnings),
    )
    return rows, warnings


# ---------- match-key resolution ---------------------------------------------

def _find_match(ir: IdeaRow) -> tuple[dict | None, str | None, list[str]]:
    """Resolve an IdeaRow to an existing reddit_source row, in priority
    order:
      1. First Source token that looks like a reddit_id matches an
         existing reddit_source row.
      2. Fingerprint match (lowercased+collapsed headline|category).
      3. No match.

    Returns (matched_row_or_None, matched_via, warnings). `matched_via` is
    'token' / 'fingerprint' / None.
    """
    warns: list[str] = []
    # Stage 1: token match. Iterate tokens, stop at first hit.
    for tok in ir.source_tokens:
        if not _is_reddit_id_shape(tok):
            continue
        row = store.fetch_reddit_source(tok)
        if row is not None:
            return row, "token", warns
    # Stage 2: fingerprint match.
    row = store.fetch_reddit_source_by_fingerprint(ir.fingerprint)
    if row is not None:
        warns.append(
            f"fingerprint-match seed={row['reddit_id']!r} for "
            f"headline={ir.headline!r}"
        )
        return row, "fingerprint", warns
    return None, None, warns


def _multi_token_secondary_flips(
    ir: IdeaRow, primary_match: dict | None
) -> list[str]:
    """Per the merge contract: when Source carries multiple reddit_id
    tokens, fan out — flip strength on every additional matching seed
    too, not just the primary match. Returns the list of additional
    reddit_ids that got flipped (or would, in dry-run)."""
    if len(ir.source_tokens) <= 1:
        return []
    flipped: list[str] = []
    primary_id = primary_match["reddit_id"] if primary_match else None
    for tok in ir.source_tokens:
        if not _is_reddit_id_shape(tok):
            continue
        if tok == primary_id:
            continue
        row = store.fetch_reddit_source(tok)
        if row is not None:
            flipped.append(tok)
    return flipped


# ---------- diff --------------------------------------------------------------

def _new_idea_seed_row(ir: IdeaRow, now: str) -> dict:
    """Build a complete reddit_source row dict for an idea-only seed.
    Uses placeholders for the legacy NOT NULL columns (title=headline,
    subreddit='curated', full_text='', date_written=now). The worker
    dispatches on `needs_expansion=1` to run expand_seed_to_post before
    the existing stages."""
    rid = _synthetic_reddit_id(ir.headline, ir.source_raw)
    return {
        "reddit_id": rid,
        "subreddit": "curated",
        "date_written": now,
        "title": ir.headline,
        "full_text": "",  # worker's dispatch signal + expand stage fills it
        "comments": None,
        "url": None,
        "summary": ir.summary or None,
        "length_chars": len(ir.summary),
        "status": "imported",
        "story_id": None,
        "notes": None,
        "first_synced": now,
        "last_synced": now,
        "strength": ir.strength,
        "category": ir.category or None,
        "headline": ir.headline,
        "source_hint": ir.source_raw or None,
        "needs_expansion": 1,
        "fingerprint": ir.fingerprint,
    }


def _classify_match(
    ir: IdeaRow, seed: dict, secondary_flips: list[str]
) -> RowDiff:
    """Compute the diff verdict for an idea row that matched an existing
    seed.

    Merge contract (post Yoav's 2026-06-23 clarification): priority is a
    first-class editorial signal that travels with every matched row,
    regardless of Done state. So ideas-owned columns (strength, category,
    headline, source_hint, fingerprint) always update on match. Status
    transitions layer on top:

      - Done=Yes + seed.status in {imported}    → also flip status='skipped'
      - Done=Yes + seed.status in {used, processing, skipped} → status untouched,
            warning surfaced; priority still applies (the operator can filter
            by Strong/Medium in the admin even on already-shipped rows).
      - Done=No  + seed.status == 'skipped'     → restore status='imported'
            (reversibility — the IdeasDB sheet can un-mark a row by clearing
            its Done cell).
      - Done=No  + any other status             → status untouched.
    """
    diff = RowDiff(
        reddit_id=seed["reddit_id"],
        action="unchanged",
        line_no=ir.line_no,
        headline=ir.headline,
        secondary_token_flips=secondary_flips,
    )

    before: dict[str, Any] = {}
    after: dict[str, Any] = {}

    # Step A — ideas-owned column updates. Apply unconditionally so the
    # priority badge is filterable in the admin for every matched seed,
    # including already-shipped ones (Yoav's explicit ask 2026-06-23).
    for col in ("strength", "category", "headline", "source_hint", "fingerprint"):
        old = seed.get(col)
        new = (
            ir.strength if col == "strength"
            else ir.category or None if col == "category"
            else ir.headline if col == "headline"
            else (ir.source_raw or None) if col == "source_hint"
            else ir.fingerprint  # 'fingerprint'
        )
        if old != new:
            before[col] = old
            after[col] = new

    # Step B — status transition based on Done. Skip-flip is the only
    # destructive move so we guard it carefully; un-skip is symmetric to
    # keep the sheet round-trippable.
    if ir.done:
        if seed.get("status") in ("used", "processing", "skipped"):
            # Can't skip an in-flight or shipped row, but the strength
            # update above still landed. Surface the warning so the
            # operator knows the status didn't change.
            diff.warnings.append(
                f"Done=Yes but seed.status={seed.get('status')}; status "
                "untouched (priority still applied)"
            )
        else:
            before["status"] = seed.get("status")
            after["status"] = "skipped"
    else:
        if seed.get("status") == "skipped":
            # Done flip-off: restore to imported so the worker can pick
            # it up again. Same defensive guard as above — never touch
            # used/processing/imported status here.
            before["status"] = "skipped"
            after["status"] = "imported"

    # Step C — headline edit → re-expansion trigger. Only fires on
    # idea-only seeds (subreddit='curated') because clobbering a real
    # reddit_source.full_text would lose data we can't regenerate. The
    # 0.30 ratio threshold catches "rewrote the angle" without firing
    # on typo fixes.
    old_headline = seed.get("headline") or ""
    if (
        seed.get("subreddit") == "curated"
        and seed.get("needs_expansion") == 0
        and old_headline
        and _levenshtein_ratio(old_headline, ir.headline) > 0.30
    ):
        before["needs_expansion"] = 0
        after["needs_expansion"] = 1

    # Status-conflict warning: strength flip on used/processing is allowed
    # but flagged so the operator can spot it.
    if (
        seed.get("status") in ("used", "processing")
        and "strength" in after
    ):
        diff.warnings.append(
            f"strength flipped on status={seed.get('status')} row "
            f"({before.get('strength')!r} -> {after.get('strength')!r})"
        )

    if not before and not after:
        diff.action = "unchanged"
        return diff

    diff.before, diff.after = before, after
    if "status" in after:
        diff.action = "status_changed"
    elif len(after) == 1 and "strength" in after:
        diff.action = "strength_only"
    else:
        diff.action = "updated"
    return diff


def compute_diff(idea_rows: list[IdeaRow], csv_path: str) -> ImportSummary:
    """Walk every parsed IdeaRow, resolve its match key, and classify the
    verdict. Reads the DB but does not write. Returns an ImportSummary
    ready to hand to `apply()` (which persists the log row + actual
    mutations) or to print as a dry-run report."""
    summary = ImportSummary(
        run_id=str(uuid.uuid4()),
        started_at=_now_iso(),
        csv_path=str(csv_path),
        rows_total=len(idea_rows),
    )
    seen_seed_ids: set[str] = set()
    seen_fingerprints: set[str] = set()

    for ir in idea_rows:
        if ir.type_.strip().lower() != "story":
            summary.rows_skipped_list += 1
            continue

        match, via, match_warns = _find_match(ir)
        secondary_flips = _multi_token_secondary_flips(ir, match)

        if match is None:
            # Pre-empt duplicate idea_<sha> within this single CSV — same
            # headline + source_raw gives the same synthetic reddit_id, so
            # the second occurrence updates the in-flight in-memory seed
            # rather than re-inserting.
            synth_id = _synthetic_reddit_id(ir.headline, ir.source_raw)
            if synth_id in seen_seed_ids:
                summary.rows_unchanged += 1
                continue
            seen_seed_ids.add(synth_id)
            seen_fingerprints.add(ir.fingerprint)
            diff = RowDiff(
                reddit_id=synth_id,
                action="added",
                line_no=ir.line_no,
                headline=ir.headline,
                after={
                    "strength": ir.strength,
                    "category": ir.category or None,
                    "headline": ir.headline,
                    "source_hint": ir.source_raw or None,
                    "fingerprint": ir.fingerprint,
                    "needs_expansion": 1,
                    "status": "imported",
                },
                secondary_token_flips=secondary_flips,
            )
            if ir.done:
                # Curious case: an idea marked Done but with no existing
                # seed. The merge contract says skipped_done — no point
                # inserting then immediately skipping.
                diff.action = "skipped_done"
                summary.rows_skipped_done += 1
                summary.diffs.append(diff)
                continue
            summary.rows_added += 1
            summary.diffs.append(diff)
            continue

        seen_seed_ids.add(match["reddit_id"])
        seen_fingerprints.add(ir.fingerprint)
        diff = _classify_match(ir, match, secondary_flips)
        diff.warnings.extend(match_warns)
        if diff.action == "unchanged":
            summary.rows_unchanged += 1
        elif diff.action == "skipped_done":
            summary.rows_skipped_done += 1
        elif diff.action == "strength_only":
            summary.rows_strength_only += 1
        elif diff.action == "status_changed":
            summary.rows_status_changed += 1
        elif diff.action == "updated":
            summary.rows_updated += 1
        if diff.warnings:
            summary.rows_warned += 1
        summary.diffs.append(diff)

    # Vanish detection. No mutation — just count + record for the diff.
    touched = store.list_ideas_touched_seeds()
    for row in touched:
        rid = row["reddit_id"]
        if rid in seen_seed_ids:
            continue
        # Was its fingerprint seen? If so, the seed actually matched
        # something in this import via a different reddit_id — not vanished.
        if row.get("fingerprint") and row["fingerprint"] in seen_fingerprints:
            continue
        summary.seeds_vanished += 1
        summary.vanished_ids.append(rid)

    logger.info(
        "[ideas-import diff] run=%s total=%d added=%d updated=%d "
        "strength_only=%d status_changed=%d unchanged=%d "
        "skipped_list=%d skipped_done=%d warned=%d vanished=%d",
        summary.run_id, summary.rows_total, summary.rows_added,
        summary.rows_updated, summary.rows_strength_only,
        summary.rows_status_changed, summary.rows_unchanged,
        summary.rows_skipped_list, summary.rows_skipped_done,
        summary.rows_warned, summary.seeds_vanished,
    )
    return summary


# ---------- apply -------------------------------------------------------------

def apply(
    summary: ImportSummary, *, dry_run: bool = True,
) -> ImportSummary:
    """Persist the import. Always writes an ideas_import_log row.

    When dry_run=True, the log row records the diff but no reddit_source
    mutations are committed.

    When dry_run=False, reddit_source rows are inserted / patched per the
    diff envelope, multi-token secondary flips fire, and the log row is
    written.
    """
    started = summary.started_at
    finished = _now_iso()

    if not dry_run:
        for diff in summary.diffs:
            if diff.action == "added":
                # Look up the underlying IdeaRow data from the diff.after
                # envelope plus the diff.headline. We need the full row
                # dict; rebuild from the after envelope + sensible defaults.
                row = {
                    "reddit_id": diff.reddit_id,
                    "subreddit": "curated",
                    "date_written": started,
                    "title": diff.headline,
                    "full_text": "",
                    "comments": None,
                    "url": None,
                    "summary": None,
                    "length_chars": 0,
                    "status": "imported",
                    "story_id": None,
                    "notes": None,
                    "first_synced": started,
                    "last_synced": started,
                    "strength": diff.after.get("strength", "medium") if diff.after else "medium",
                    "category": diff.after.get("category") if diff.after else None,
                    "headline": diff.headline,
                    "source_hint": diff.after.get("source_hint") if diff.after else None,
                    "needs_expansion": 1,
                    "fingerprint": diff.after.get("fingerprint", "") if diff.after else "",
                }
                store.upsert_reddit_source(row)
                logger.info(
                    "[ideas-import apply] added reddit_id=%s headline=%r",
                    diff.reddit_id, diff.headline,
                )
            elif diff.action in ("updated", "strength_only"):
                patch = {
                    k: v for k, v in (diff.after or {}).items()
                    if k in {"strength", "category", "headline",
                             "source_hint", "needs_expansion", "fingerprint"}
                }
                store.update_ideas_fields(diff.reddit_id, **patch)
                logger.info(
                    "[ideas-import apply] %s reddit_id=%s changes=%s",
                    diff.action, diff.reddit_id, sorted(patch.keys()),
                )
            elif diff.action == "status_changed":
                # Two flavors: Done=Yes flipping to 'skipped', or Done=No
                # restoring 'skipped' → 'imported'. Both go through the
                # existing set_reddit_source_status helper, then the
                # ideas-owned columns (if any) patch.
                new_status = (diff.after or {}).get("status")
                if new_status:
                    store.set_reddit_source_status(diff.reddit_id, new_status)
                patch = {
                    k: v for k, v in (diff.after or {}).items()
                    if k in {"strength", "category", "headline",
                             "source_hint", "needs_expansion", "fingerprint"}
                }
                if patch:
                    store.update_ideas_fields(diff.reddit_id, **patch)
                logger.info(
                    "[ideas-import apply] status_changed reddit_id=%s "
                    "status=%s patch=%s",
                    diff.reddit_id, new_status, sorted(patch.keys()),
                )

            # Multi-token secondary flips: every additional matching token
            # gets its strength bumped to the IdeaRow's strength. We don't
            # have the strength on the diff envelope here (the primary
            # row's strength may differ in 'unchanged' cases) — so reuse
            # diff.after['strength'] if present, else fall back to the
            # already-matched seed's existing strength (no-op).
            if diff.secondary_token_flips and diff.after:
                tgt_strength = diff.after.get("strength")
                if tgt_strength:
                    for sec in diff.secondary_token_flips:
                        store.update_ideas_fields(sec, strength=tgt_strength)
                        logger.info(
                            "[ideas-import apply] secondary-flip reddit_id=%s "
                            "strength=%s (from line %d)",
                            sec, tgt_strength, diff.line_no,
                        )

    # Always persist a log row.
    log = {
        "run_id": summary.run_id,
        "started_at": started,
        "finished_at": finished,
        "csv_path": summary.csv_path,
        "dry_run": 1 if dry_run else 0,
        "rows_total": summary.rows_total,
        "rows_skipped_list": summary.rows_skipped_list,
        "rows_skipped_done": summary.rows_skipped_done,
        "rows_added": summary.rows_added,
        "rows_updated": summary.rows_updated,
        "rows_strength_only": summary.rows_strength_only,
        "rows_status_changed": summary.rows_status_changed,
        "rows_unchanged": summary.rows_unchanged,
        "rows_warned": summary.rows_warned,
        "seeds_vanished": summary.seeds_vanished,
        "notes": "\n".join(summary.notes) if summary.notes else None,
        "diff_json": _serialize_diff(summary),
    }
    store.insert_ideas_import_log(log)
    logger.info(
        "[ideas-import log] run=%s dry_run=%s log_written",
        summary.run_id, dry_run,
    )
    return summary


def _serialize_diff(summary: ImportSummary) -> str | None:
    """Compact-JSON-serialize the per-row diff envelope for the log. Caps
    at ~1 MB; truncates with a notes warning if the envelope exceeds it
    (only happens on truly pathological 10k+-row imports)."""
    if not summary.diffs and not summary.vanished_ids:
        return None
    payload = {
        "diffs": [
            {
                "reddit_id": d.reddit_id,
                "action": d.action,
                "line_no": d.line_no,
                "headline": d.headline,
                "before": d.before,
                "after": d.after,
                "warnings": d.warnings,
                "secondary_token_flips": d.secondary_token_flips,
            }
            for d in summary.diffs
        ],
        "vanished_ids": summary.vanished_ids,
    }
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    # 25 MB cap — comfortably fits 2k+ rows even with verbose warnings and
    # leaves headroom for an angry sheet edit that touches every row. The
    # original 1 MB cap blew on the first real import (1,695 rows landed
    # at 4 MB+ of compact JSON). Postgres TEXT and SQLite TEXT both handle
    # this size cleanly.
    if len(blob) > 25_000_000:
        summary.notes.append(
            f"diff_json truncated from {len(blob)} chars to first 25MB"
        )
        return blob[:25_000_000]
    return blob


# ---------- CLI ---------------------------------------------------------------

def _safe_print(line: str) -> None:
    """print() that survives a non-UTF-8 Windows console (cp1255 for a
    Hebrew locale). The CSV carries em-dashes, smart quotes, and the odd
    Hebrew glyph in warning text; piping that through print() on a
    Windows console raised UnicodeEncodeError mid-summary on the first
    real import. Encoding via sys.stdout's encoding with errors='replace'
    keeps the run going and renders unmappable chars as `?`."""
    enc = getattr(sys.stdout, "encoding", None) or "utf-8"
    try:
        print(line)
    except UnicodeEncodeError:
        sys.stdout.write(line.encode(enc, errors="replace").decode(enc) + "\n")


def _print_summary(summary: ImportSummary, *, dry_run: bool) -> None:
    """Human-readable summary for the CLI. Always prints, regardless of
    --apply. Counters first, then warnings, then vanished IDs."""
    label = "DRY-RUN" if dry_run else "APPLIED"
    _safe_print(f"=== IdeasDB import {label} (run_id={summary.run_id}) ===")
    _safe_print(f"  total rows parsed     : {summary.rows_total}")
    _safe_print(f"  skipped (Type=List)   : {summary.rows_skipped_list}")
    _safe_print(f"  skipped (Done=Yes)    : {summary.rows_skipped_done}")
    _safe_print(f"  added (new ideas)     : {summary.rows_added}")
    _safe_print(f"  updated               : {summary.rows_updated}")
    _safe_print(f"  strength-only flips   : {summary.rows_strength_only}")
    _safe_print(f"  status changes        : {summary.rows_status_changed}")
    _safe_print(f"  unchanged             : {summary.rows_unchanged}")
    _safe_print(f"  rows with warnings    : {summary.rows_warned}")
    _safe_print(f"  seeds vanished from sheet: {summary.seeds_vanished}")
    if summary.seeds_vanished and summary.vanished_ids:
        sample = ", ".join(summary.vanished_ids[:5])
        more = "" if summary.seeds_vanished <= 5 else f", +{summary.seeds_vanished - 5} more"
        _safe_print(f"    vanished sample        : {sample}{more}")
    warn_diffs = [d for d in summary.diffs if d.warnings]
    if warn_diffs:
        _safe_print(f"  warnings (first 10):")
        for d in warn_diffs[:10]:
            for w in d.warnings:
                _safe_print(f"    line {d.line_no} reddit_id={d.reddit_id}: {w}")
    if summary.notes:
        _safe_print(f"  notes:")
        for n in summary.notes:
            _safe_print(f"    {n}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Import Yoav's curated IdeasDB sheet into reddit_source",
    )
    parser.add_argument("csv", type=str, help="Path to IdeasDB CSV export")
    parser.add_argument(
        "--apply", action="store_true",
        help="Commit changes (default is dry-run preview)",
    )
    parser.add_argument(
        "--quiet", action="store_true",
        help="Suppress per-warning printout (counters + log row only)",
    )
    parser.add_argument(
        "--log-level", default="INFO",
        help="Python logging level (default INFO)",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )

    store.init()
    rows, warnings = parse_ideas_csv(args.csv)
    summary = compute_diff(rows, args.csv)
    for w in warnings:
        summary.notes.append(w)
    summary = apply(summary, dry_run=not args.apply)
    if not args.quiet:
        _print_summary(summary, dry_run=not args.apply)
    return 0


if __name__ == "__main__":
    sys.exit(main())
