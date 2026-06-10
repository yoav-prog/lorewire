"""Storage layer.

SQLite for local dev/validation (zero setup, stdlib only). The schema mirrors
the production Postgres tables, so moving to Cloud SQL is a connection change,
not a rewrite. `settings` holds admin-managed config like the active model per
stage (never secrets).
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
    category     TEXT,
    title        TEXT,
    summary      TEXT,
    body         TEXT,
    status       TEXT,
    source_url   TEXT,
    created_at   REAL,
    payload      TEXT
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


def _conn() -> sqlite3.Connection:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init() -> None:
    with _conn() as c:
        c.executescript(SCHEMA)


def upsert_story(s: dict) -> None:
    row = {**s, "payload": json.dumps(s.get("payload", {}))}
    with _conn() as c:
        c.execute(
            """
            INSERT INTO stories (id, reddit_id, category, title, summary, body, status, source_url, created_at, payload)
            VALUES (:id, :reddit_id, :category, :title, :summary, :body, :status, :source_url, :created_at, :payload)
            ON CONFLICT(id) DO UPDATE SET
                category=excluded.category, title=excluded.title, summary=excluded.summary,
                body=excluded.body, status=excluded.status, source_url=excluded.source_url,
                payload=excluded.payload
            """,
            row,
        )


def all_stories() -> list[dict]:
    with _conn() as c:
        cur = c.execute("SELECT id, category, title, status FROM stories ORDER BY created_at DESC")
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
