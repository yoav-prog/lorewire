"""Storage layer.

Dual-driver: Postgres in production (Vercel admin reads + pipeline writes),
SQLite locally for dev and offline runs. The driver is decided at call time
by `DATABASE_URL` so the same code path serves both: set the env var to point
at Postgres and every read/write moves there transparently. Schema mirrors
`lorewire-app/src/lib/schema.ts` so the Next admin and the pipeline share
one store. Timestamps are ISO-8601 TEXT and JSON blobs are TEXT, for
portability across the two engines without per-column type juggling.
`settings` holds admin-managed config (active model per stage, daily budget,
voice prefs) — never secrets.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from pipeline import config
from pipeline.config import DB_PATH

# Schema is split into a list of statements so both sqlite3.executescript()
# and psycopg.execute() can apply them — Python's sqlite3 module rejects
# multi-statement strings in `.execute()`, and psycopg doesn't expose
# `executescript()`.
SCHEMA_STATEMENTS = [
    """CREATE TABLE IF NOT EXISTS stories (
        id                   TEXT PRIMARY KEY,
        reddit_id            TEXT,
        slug                 TEXT,
        category             TEXT,
        title                TEXT,
        summary              TEXT,
        body                 TEXT,
        teleprompter         TEXT,
        status               TEXT,
        source_url           TEXT,
        hero_image           TEXT,
        hero_image_landscape TEXT,
        images               TEXT,
        audio_url            TEXT,
        video_url            TEXT,
        duration             TEXT,
        alignment            TEXT,
        tokens               INTEGER,
        cost_cents           INTEGER,
        created_at           TEXT,
        updated_at           TEXT,
        published_at         TEXT,
        payload              TEXT
    )""",
    # Additive migration for DBs that pre-date the landscape hero column.
    # IF NOT EXISTS works on both SQLite (>= 3.35) and Postgres (>= 9.6).
    "ALTER TABLE stories ADD COLUMN IF NOT EXISTS hero_image_landscape TEXT",
    # Wave 2 cinematic thumbnails bake the title into the image, so the UI
    # suppresses its CSS title overlay when this flag is 1. Stored as INTEGER
    # for portability across SQLite (no native BOOLEAN) and Postgres.
    "ALTER TABLE stories ADD COLUMN IF NOT EXISTS hero_has_baked_title INTEGER DEFAULT 0",
    # Wave 3 Phase 3 PropSlideIn: per-story prop list as JSON, written by the
    # pipeline when the prop_slide motion beat is enabled. Shape:
    #   [{"url": "https://.../prop-N.png", "label": "envelope", "side": "left"}, ...]
    # Composition reads it through config.props_list and slides each in at a
    # spaced interval. Null/empty = no props rendered (which is the default
    # because the beat ships off).
    "ALTER TABLE stories ADD COLUMN IF NOT EXISTS props TEXT",
    """CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
    )""",
]

_COLUMNS = [
    "id", "reddit_id", "slug", "category", "title", "summary", "body",
    "teleprompter", "status", "source_url", "hero_image", "hero_image_landscape",
    "hero_has_baked_title", "images", "audio_url", "video_url", "duration",
    "alignment", "props", "tokens", "cost_cents", "created_at", "updated_at",
    "published_at", "payload",
]
# Refreshed on conflict: everything except the identity and creation time.
_UPDATE = [c for c in _COLUMNS if c not in ("id", "created_at")]


def _is_postgres() -> bool:
    return bool(config.env("DATABASE_URL"))


# --- SQLite path --------------------------------------------------------------

def _sqlite_conn() -> sqlite3.Connection:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# --- Postgres path ------------------------------------------------------------

def _pg_conn():
    import psycopg
    from psycopg.rows import dict_row
    return psycopg.connect(config.env("DATABASE_URL"), row_factory=dict_row)


# --- shared API ---------------------------------------------------------------

def _serialize(s: dict) -> dict:
    row = {k: s.get(k) for k in _COLUMNS}
    for jcol in ("images", "alignment", "props", "payload"):
        if isinstance(row.get(jcol), (dict, list)):
            row[jcol] = json.dumps(row[jcol])
    return row


def init() -> None:
    """Create tables if they don't exist on whichever driver is active."""
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                for stmt in SCHEMA_STATEMENTS:
                    cur.execute(stmt)
            conn.commit()
    else:
        with _sqlite_conn() as c:
            for stmt in SCHEMA_STATEMENTS:
                c.execute(stmt)


def upsert_story(s: dict) -> None:
    row = _serialize(s)
    cols = ", ".join(_COLUMNS)
    updates = ", ".join(f"{c}=excluded.{c}" for c in _UPDATE)
    if _is_postgres():
        placeholders = ", ".join(f"%({c})s" for c in _COLUMNS)
        sql = (
            f"INSERT INTO stories ({cols}) VALUES ({placeholders}) "
            f"ON CONFLICT(id) DO UPDATE SET {updates}"
        )
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, row)
            conn.commit()
    else:
        placeholders = ", ".join(f":{c}" for c in _COLUMNS)
        sql = (
            f"INSERT INTO stories ({cols}) VALUES ({placeholders}) "
            f"ON CONFLICT(id) DO UPDATE SET {updates}"
        )
        with _sqlite_conn() as c:
            c.execute(sql, row)


def all_stories() -> list[dict]:
    sql = "SELECT id, category, title, status FROM stories ORDER BY created_at DESC"
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql)
                return list(cur.fetchall())
    with _sqlite_conn() as c:
        cur = c.execute(sql)
        return [dict(r) for r in cur.fetchall()]


def get_setting(key: str) -> str | None:
    if _is_postgres():
        try:
            with _pg_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT value FROM settings WHERE key = %s", (key,))
                    row = cur.fetchone()
                    return row["value"] if row else None
        except Exception:
            # Settings table not created yet (first run before init()). The
            # SQLite path treats this case the same way for parity.
            return None
    try:
        with _sqlite_conn() as c:
            row = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
            return row["value"] if row else None
    except sqlite3.OperationalError:
        return None


def set_setting(key: str, value: str) -> None:
    if _is_postgres():
        # Ensure the table exists, matching the SQLite path's behavior of
        # creating settings on first write.
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                for stmt in SCHEMA_STATEMENTS:
                    cur.execute(stmt)
                cur.execute(
                    "INSERT INTO settings (key, value) VALUES (%s, %s) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (key, value),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        for stmt in SCHEMA_STATEMENTS:
            c.execute(stmt)
        c.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def fetch_story(story_id: str) -> dict | None:
    """Read a single story row by id, on whichever driver is active.

    Returns a dict keyed by column name, or None when no row matches. Used by
    the export-to-app bridge and the video re-render CLI; both want a uniform
    shape regardless of the underlying driver.
    """
    cols = ", ".join(_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(f"SELECT {cols} FROM stories WHERE id = %s", (story_id,))
                row = cur.fetchone()
                return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(f"SELECT {cols} FROM stories WHERE id=?", (story_id,)).fetchone()
        return dict(row) if row else None


def published_stories() -> list[dict]:
    """Read every published story (media columns included) on whichever driver
    is active. The export bridge uses this to regenerate published.ts; the
    web side keeps the static-overlay pattern so the public site stays fast."""
    sql = (
        "SELECT id, title, category, summary, body, duration, published_at, "
        "created_at, updated_at, hero_image, hero_image_landscape, "
        "hero_has_baked_title, images, audio_url, video_url, alignment "
        "FROM stories WHERE status = "
        + ("%s" if _is_postgres() else "?")
        + " AND body IS NOT NULL AND body != "
        + ("%s" if _is_postgres() else "?")
        + " ORDER BY published_at DESC"
    )
    args: tuple[Any, ...] = ("published", "")
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, args)
                return [dict(r) for r in cur.fetchall()]
    with _sqlite_conn() as c:
        cur = c.execute(sql, args)
        return [dict(r) for r in cur.fetchall()]
