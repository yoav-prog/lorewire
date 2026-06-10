"""Storage layer.

SQLite for local dev/validation (zero setup, stdlib only). The schema mirrors
lorewire-app/src/lib/schema.ts so the Next admin and the pipeline share one
store; moving to Postgres is a connection change, not a rewrite. Timestamps are
ISO-8601 text and JSON blobs are text, for cross-engine portability. `settings`
holds admin-managed config like the active model per stage (never secrets).
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from pipeline.config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS stories (
    id           TEXT PRIMARY KEY,
    reddit_id    TEXT,
    slug         TEXT,
    category     TEXT,
    title        TEXT,
    summary      TEXT,
    body         TEXT,
    teleprompter TEXT,
    status       TEXT,
    source_url   TEXT,
    hero_image   TEXT,
    images       TEXT,
    audio_url    TEXT,
    video_url    TEXT,
    duration     TEXT,
    alignment    TEXT,
    tokens       INTEGER,
    cost_cents   INTEGER,
    created_at   TEXT,
    updated_at   TEXT,
    published_at TEXT,
    payload      TEXT
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""

_COLUMNS = [
    "id", "reddit_id", "slug", "category", "title", "summary", "body",
    "teleprompter", "status", "source_url", "hero_image", "images", "audio_url",
    "video_url", "duration", "alignment", "tokens", "cost_cents", "created_at",
    "updated_at", "published_at", "payload",
]
# Refreshed on conflict: everything except the identity and creation time.
_UPDATE = [c for c in _COLUMNS if c not in ("id", "created_at")]


def _conn() -> sqlite3.Connection:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init() -> None:
    with _conn() as c:
        c.executescript(SCHEMA)


def _serialize(s: dict) -> dict:
    row = {k: s.get(k) for k in _COLUMNS}
    for jcol in ("images", "alignment", "payload"):
        if isinstance(row.get(jcol), (dict, list)):
            row[jcol] = json.dumps(row[jcol])
    return row


def upsert_story(s: dict) -> None:
    row = _serialize(s)
    cols = ", ".join(_COLUMNS)
    placeholders = ", ".join(f":{c}" for c in _COLUMNS)
    updates = ", ".join(f"{c}=excluded.{c}" for c in _UPDATE)
    with _conn() as c:
        c.execute(
            f"INSERT INTO stories ({cols}) VALUES ({placeholders}) "
            f"ON CONFLICT(id) DO UPDATE SET {updates}",
            row,
        )


def all_stories() -> list[dict]:
    with _conn() as c:
        cur = c.execute(
            "SELECT id, category, title, status FROM stories ORDER BY created_at DESC"
        )
        return [dict(r) for r in cur.fetchall()]


def get_setting(key: str) -> str | None:
    try:
        with _conn() as c:
            row = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
            return row["value"] if row else None
    except sqlite3.OperationalError:
        return None  # settings table not created yet


def set_setting(key: str, value: str) -> None:
    with _conn() as c:
        c.executescript(SCHEMA)
        c.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
