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

import datetime
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
    # Wave 3 Phase 3 MouthSwap: a tight talking-head portrait of the story's
    # protagonist and a kie-edited copy with the mouth removed. Composition
    # overlays SVG mouth shapes on the mouth-removed image during narration
    # so the corner avatar lip-flaps in sync with words. Both null when the
    # mouth_swap beat is off (the default).
    "ALTER TABLE stories ADD COLUMN IF NOT EXISTS character_image TEXT",
    "ALTER TABLE stories ADD COLUMN IF NOT EXISTS character_image_mouth_removed TEXT",
    # Wave 3 Phase 4 intro/outro override layer: each story can pin a specific
    # intro/outro from the library, or opt out entirely. NULL/0 = inherit the
    # global active pick (see settings keys `video.active_intro_id` /
    # `video.active_outro_id` and the master switch `video.intro_outro_enabled`).
    "ALTER TABLE stories ADD COLUMN IF NOT EXISTS intro_segment_id TEXT",
    "ALTER TABLE stories ADD COLUMN IF NOT EXISTS outro_segment_id TEXT",
    "ALTER TABLE stories ADD COLUMN IF NOT EXISTS skip_intro INTEGER DEFAULT 0",
    "ALTER TABLE stories ADD COLUMN IF NOT EXISTS skip_outro INTEGER DEFAULT 0",
    # 2026-06-11 video editor: stories.video_config holds the full
    # ShortVideoConfig v2 JSON object (see lorewire-app/src/lib/video-config.ts
    # and video/src/types.ts). The pipeline writes it on every render so the
    # /admin/videos/[id] editor has the same source of truth the renderer
    # reads; editor patches mark fields in `_locks` so subsequent pipeline
    # runs leave human-edited fields alone (see merge_with_locks in
    # pipeline/video_config.py — added alongside this column).
    "ALTER TABLE stories ADD COLUMN IF NOT EXISTS video_config TEXT",
    """CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
    )""",
    # 2026-06-11 video editor: render queue. The admin clicks Render on
    # /admin/videos/[id]; the Next server action inserts a row here and
    # the local pipeline worker (pipeline/render_worker.py) polls for
    # status='queued' rows, claims one, runs generate_video, writes the
    # result back. Idempotency: `(story_id, config_hash)` unique so ten
    # clicks on Render at the same config-state coalesce into one render.
    """CREATE TABLE IF NOT EXISTS video_renders (
        id              TEXT PRIMARY KEY,
        story_id        TEXT NOT NULL,
        config_hash     TEXT NOT NULL,
        status          TEXT NOT NULL,
        progress        REAL DEFAULT 0,
        error           TEXT,
        output_url      TEXT,
        requested_by    TEXT,
        requested_at    TEXT NOT NULL,
        started_at      TEXT,
        finished_at     TEXT,
        UNIQUE (story_id, config_hash)
    )""",
    # Speeds up the worker's "claim oldest queued render" query — the
    # natural index on (story_id, config_hash) doesn't help that scan.
    "CREATE INDEX IF NOT EXISTS idx_video_renders_status_requested ON video_renders(status, requested_at)",
    # 2026-06-12 asset re-render: image regen queue. The admin clicks
    # Regenerate on any of a story's or article's image assets; the Next
    # server action inserts a row here and the local
    # pipeline/image_render_worker.py polls for status='queued' rows.
    # No idempotency constraint — each click is a fresh row by design.
    """CREATE TABLE IF NOT EXISTS image_renders (
        id              TEXT PRIMARY KEY,
        owner_kind      TEXT NOT NULL,
        owner_id        TEXT NOT NULL,
        asset           TEXT NOT NULL,
        prompt_hash     TEXT,
        status          TEXT NOT NULL,
        progress        INTEGER DEFAULT 0,
        error           TEXT,
        output_url      TEXT,
        cost_cents      INTEGER,
        requested_by    TEXT,
        requested_at    TEXT NOT NULL,
        started_at      TEXT,
        finished_at     TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS idx_image_renders_status_requested ON image_renders(status, requested_at)",
    "CREATE INDEX IF NOT EXISTS idx_image_renders_owner ON image_renders(owner_kind, owner_id, asset, requested_at)",
    # Wave 3 Phase 4 video segment library: intros and outros are uploaded
    # through the admin, normalized once to 1080x1920 @ 30fps H.264+AAC, then
    # cached in GCS. Renders splice the active intro before and the active
    # outro after the body video. `kind` is 'intro' or 'outro'; soft-disabled
    # rows stay around (so a per-story override can still resolve) but are
    # skipped by the global-active picker.
    """CREATE TABLE IF NOT EXISTS video_segments (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        label           TEXT,
        source_url      TEXT,
        normalized_url  TEXT,
        duration_ms     INTEGER,
        enabled         INTEGER DEFAULT 1,
        created_at      TEXT,
        updated_at      TEXT
    )""",
    # 2026-06-11 segments upload fix: browser uploads now go straight to GCS
    # (bypassing Vercel's 4.5 MB body cap) and pipeline/segments_worker.py
    # picks `status='pending'` rows up and runs ffmpeg normalize off-Vercel.
    # `status` lifecycle: pending -> uploading -> normalizing -> ready, with
    # `error` set on any failure. Default 'ready' for parity with legacy rows
    # that pre-date the column (the worker only ever picks up pending/uploading
    # rows, so a backfilled-ready row is never re-normalized by accident).
    "ALTER TABLE video_segments ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ready'",
    "ALTER TABLE video_segments ADD COLUMN IF NOT EXISTS error TEXT",
    "ALTER TABLE video_segments ADD COLUMN IF NOT EXISTS uploaded_at TEXT",
    # The worker's hot path is "newest pending row first" — index it.
    "CREATE INDEX IF NOT EXISTS idx_video_segments_status_created ON video_segments(status, created_at)",
]

_COLUMNS = [
    "id", "reddit_id", "slug", "category", "title", "summary", "body",
    "teleprompter", "status", "source_url", "hero_image", "hero_image_landscape",
    "hero_has_baked_title", "images", "audio_url", "video_url", "duration",
    "alignment", "props", "character_image", "character_image_mouth_removed",
    "intro_segment_id", "outro_segment_id", "skip_intro", "skip_outro",
    "video_config",
    "tokens", "cost_cents", "created_at", "updated_at", "published_at", "payload",
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
    for jcol in ("images", "alignment", "props", "payload", "video_config"):
        if isinstance(row.get(jcol), (dict, list)):
            row[jcol] = json.dumps(row[jcol])
    return row


def init() -> None:
    """Create tables if they don't exist on whichever driver is active.

    SQLite quirk worth knowing: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` is
    a Postgres-only syntax — SQLite errors out with `near "EXISTS"`. The
    schema list uses the Postgres form for parity; for SQLite we strip the
    `IF NOT EXISTS` from ADD COLUMN statements and catch the
    duplicate-column error that fires when the migration was already applied
    on an older DB. Net behavior is "idempotent on both engines", which is
    what the additive migration pattern needs.
    """
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                for stmt in SCHEMA_STATEMENTS:
                    cur.execute(stmt)
            conn.commit()
        return
    with _sqlite_conn() as c:
        for stmt in SCHEMA_STATEMENTS:
            sqlite_stmt = _sqlite_rewrite(stmt)
            try:
                c.execute(sqlite_stmt)
            except sqlite3.OperationalError as e:
                if "duplicate column" in str(e).lower():
                    # Column already present from a prior init() — fine.
                    continue
                raise


# Pulls `IF NOT EXISTS` out of ADD COLUMN clauses because SQLite doesn't
# support it. CREATE TABLE/INDEX IF NOT EXISTS is untouched (SQLite supports
# those just fine). Case-insensitive match handles the lowercase/uppercase
# variants in the schema list.
_ALTER_ADD_IFNE_RE = __import__("re").compile(
    r"\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b", __import__("re").IGNORECASE,
)


def _sqlite_rewrite(stmt: str) -> str:
    return _ALTER_ADD_IFNE_RE.sub("ADD COLUMN", stmt)


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
        # Ensure the settings table exists (idempotent) without re-running the
        # full schema list — that list contains Postgres-only ALTER COLUMN
        # IF NOT EXISTS statements SQLite cannot parse. init() owns the full
        # migration and must run before set_setting in any real flow; this
        # CREATE TABLE is only the bootstrap safety net for "set_setting
        # called before init() ever did."
        c.execute(
            "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)"
        )
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


# --- video_segments helpers ---------------------------------------------------
# A small relational library of intro/outro clips. The pipeline reads through
# `fetch_segment` (single-row) and `list_segments` (admin list page); the admin
# writes via `upsert_segment` (insert or full overwrite) and `delete_segment`.
# Kept in this module so both the pipeline and the admin (via the SQLite file)
# share a single source of truth on the shape.

_SEGMENT_COLUMNS = [
    "id", "kind", "label", "source_url", "normalized_url", "duration_ms",
    "enabled", "status", "error", "uploaded_at", "created_at", "updated_at",
]
_SEGMENT_UPDATE = [c for c in _SEGMENT_COLUMNS if c not in ("id", "created_at")]


def fetch_segment(segment_id: str) -> dict | None:
    """Read one segment by id. Returns None when no row matches."""
    if not segment_id:
        return None
    cols = ", ".join(_SEGMENT_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {cols} FROM video_segments WHERE id = %s",
                    (segment_id,),
                )
                row = cur.fetchone()
                return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(
            f"SELECT {cols} FROM video_segments WHERE id=?", (segment_id,)
        ).fetchone()
        return dict(row) if row else None


def list_segments(kind: str | None = None) -> list[dict]:
    """Read every segment row. Optionally filter by kind ('intro' or 'outro').
    Newest first so the admin list shows recent uploads at the top."""
    cols = ", ".join(_SEGMENT_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                if kind:
                    cur.execute(
                        f"SELECT {cols} FROM video_segments WHERE kind = %s "
                        "ORDER BY created_at DESC",
                        (kind,),
                    )
                else:
                    cur.execute(
                        f"SELECT {cols} FROM video_segments ORDER BY created_at DESC"
                    )
                return [dict(r) for r in cur.fetchall()]
    with _sqlite_conn() as c:
        if kind:
            cur = c.execute(
                f"SELECT {cols} FROM video_segments WHERE kind=? "
                "ORDER BY created_at DESC",
                (kind,),
            )
        else:
            cur = c.execute(
                f"SELECT {cols} FROM video_segments ORDER BY created_at DESC"
            )
        return [dict(r) for r in cur.fetchall()]


def upsert_segment(s: dict) -> None:
    """Insert or refresh a segment row. `id` and `kind` are required."""
    row = {k: s.get(k) for k in _SEGMENT_COLUMNS}
    cols = ", ".join(_SEGMENT_COLUMNS)
    updates = ", ".join(f"{c}=excluded.{c}" for c in _SEGMENT_UPDATE)
    if _is_postgres():
        placeholders = ", ".join(f"%({c})s" for c in _SEGMENT_COLUMNS)
        sql = (
            f"INSERT INTO video_segments ({cols}) VALUES ({placeholders}) "
            f"ON CONFLICT(id) DO UPDATE SET {updates}"
        )
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, row)
            conn.commit()
        return
    placeholders = ", ".join(f":{c}" for c in _SEGMENT_COLUMNS)
    sql = (
        f"INSERT INTO video_segments ({cols}) VALUES ({placeholders}) "
        f"ON CONFLICT(id) DO UPDATE SET {updates}"
    )
    with _sqlite_conn() as c:
        c.execute(sql, row)


def delete_segment(segment_id: str) -> None:
    """Hard-delete a segment row. Callers are responsible for clearing any
    `video.active_*_id` setting or per-story override that points at it."""
    if not segment_id:
        return
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM video_segments WHERE id = %s", (segment_id,)
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute("DELETE FROM video_segments WHERE id=?", (segment_id,))


# Worker hot path: only `uploading` rows are normalize-ready — `pending` means
# the browser is still PUT-ing bytes to GCS (or abandoned the upload); the web
# tier's finalize action flips pending -> uploading once the browser confirms
# the PUT finished. Sweeping pending rows is a separate concern (see
# `list_abandoned_pending_segments`).
_WORKER_PICKUP_STATUS = "uploading"


def list_pending_segments(limit: int = 1) -> list[dict]:
    """Return up to `limit` `uploading` segments, oldest first.

    Used by pipeline/segments_worker.py — the only caller. Keeps the SELECT
    on the indexed `(status, created_at)` so the query stays O(log n) as the
    table grows.
    """
    cols = ", ".join(_SEGMENT_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {cols} FROM video_segments "
                    "WHERE status = %s "
                    "ORDER BY created_at ASC LIMIT %s",
                    (_WORKER_PICKUP_STATUS, limit),
                )
                return [dict(r) for r in cur.fetchall()]
    with _sqlite_conn() as c:
        cur = c.execute(
            f"SELECT {cols} FROM video_segments "
            "WHERE status = ? "
            "ORDER BY created_at ASC LIMIT ?",
            (_WORKER_PICKUP_STATUS, limit),
        )
        return [dict(r) for r in cur.fetchall()]


def list_abandoned_pending_segments(older_than_iso: str) -> list[dict]:
    """Return `pending` rows whose `created_at` is older than `older_than_iso`.

    These are uploads the browser never finalized — either the tab closed
    mid-PUT or the network failed. The worker's sweeper flips them to `error`
    so the admin sees the failure rather than a row that spins forever.
    """
    cols = ", ".join(_SEGMENT_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {cols} FROM video_segments "
                    "WHERE status = %s AND created_at < %s "
                    "ORDER BY created_at ASC",
                    ("pending", older_than_iso),
                )
                return [dict(r) for r in cur.fetchall()]
    with _sqlite_conn() as c:
        cur = c.execute(
            f"SELECT {cols} FROM video_segments "
            "WHERE status = ? AND created_at < ? "
            "ORDER BY created_at ASC",
            ("pending", older_than_iso),
        )
        return [dict(r) for r in cur.fetchall()]


# Allowed columns the worker may patch alongside a status flip. Kept as an
# allow-list so a typo in **fields can't smuggle a write into an unrelated
# column (the worker's only privileged write surface).
_SEGMENT_PATCH_COLUMNS = frozenset(
    {"normalized_url", "duration_ms", "enabled", "error", "uploaded_at"}
)


def set_segment_status(
    segment_id: str,
    status: str,
    **fields: Any,
) -> None:
    """Flip a segment's status and optionally patch any of the columns in
    `_SEGMENT_PATCH_COLUMNS`. `updated_at` is always set to now.

    Unknown column names in `fields` are rejected loudly — this is the worker's
    only write seam and a silent ignore would mask a real bug.
    """
    if not segment_id:
        raise ValueError("set_segment_status requires segment_id")
    extra = {k: v for k, v in fields.items() if v is not None or k == "error"}
    bad = set(extra) - _SEGMENT_PATCH_COLUMNS
    if bad:
        raise ValueError(f"set_segment_status: unknown columns: {sorted(bad)}")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    extra["status"] = status
    extra["updated_at"] = now
    if _is_postgres():
        assigns = ", ".join(f"{c} = %({c})s" for c in extra)
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"UPDATE video_segments SET {assigns} WHERE id = %(id)s",
                    {**extra, "id": segment_id},
                )
            conn.commit()
        return
    assigns = ", ".join(f"{c} = :{c}" for c in extra)
    with _sqlite_conn() as c:
        c.execute(
            f"UPDATE video_segments SET {assigns} WHERE id = :id",
            {**extra, "id": segment_id},
        )


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


# --- video_renders helpers (2026-06-11 video editor render queue) -------------
# The Next admin enqueues a render via the queueRender server action; this
# module's `claim_next_render` is what pipeline/render_worker.py polls. Status
# transitions are queued → rendering → done | error. Idempotency is enforced
# by the UNIQUE (story_id, config_hash) constraint — INSERT OR IGNORE returns
# the existing row when the editor re-clicks Render at the same config-state.

_RENDER_COLUMNS = [
    "id", "story_id", "config_hash", "status", "progress", "error",
    "output_url", "requested_by", "requested_at", "started_at", "finished_at",
]


def enqueue_render(
    render_id: str,
    story_id: str,
    config_hash: str,
    requested_by: str | None = None,
) -> dict:
    """Insert a queued render row OR return the existing one for the same
    (story_id, config_hash). The Next action calls this; idempotency on the
    pair means N concurrent clicks coalesce into a single render."""
    now = _now_iso()
    cols = ", ".join(_RENDER_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                placeholders = ", ".join(f"%({c})s" for c in _RENDER_COLUMNS)
                cur.execute(
                    f"INSERT INTO video_renders ({cols}) VALUES ({placeholders}) "
                    "ON CONFLICT (story_id, config_hash) DO NOTHING",
                    {
                        "id": render_id,
                        "story_id": story_id,
                        "config_hash": config_hash,
                        "status": "queued",
                        "progress": 0,
                        "error": None,
                        "output_url": None,
                        "requested_by": requested_by,
                        "requested_at": now,
                        "started_at": None,
                        "finished_at": None,
                    },
                )
                cur.execute(
                    f"SELECT {cols} FROM video_renders "
                    "WHERE story_id = %s AND config_hash = %s",
                    (story_id, config_hash),
                )
                row = cur.fetchone()
            conn.commit()
        return dict(row) if row else {}
    with _sqlite_conn() as c:
        placeholders = ", ".join(f":{col}" for col in _RENDER_COLUMNS)
        c.execute(
            f"INSERT OR IGNORE INTO video_renders ({cols}) VALUES ({placeholders})",
            {
                "id": render_id,
                "story_id": story_id,
                "config_hash": config_hash,
                "status": "queued",
                "progress": 0,
                "error": None,
                "output_url": None,
                "requested_by": requested_by,
                "requested_at": now,
                "started_at": None,
                "finished_at": None,
            },
        )
        row = c.execute(
            f"SELECT {cols} FROM video_renders "
            "WHERE story_id=? AND config_hash=?",
            (story_id, config_hash),
        ).fetchone()
        return dict(row) if row else {}


def get_render(render_id: str) -> dict | None:
    """Read one render row by id. The Next status endpoint polls this."""
    cols = ", ".join(_RENDER_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {cols} FROM video_renders WHERE id = %s",
                    (render_id,),
                )
                row = cur.fetchone()
                return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(
            f"SELECT {cols} FROM video_renders WHERE id=?", (render_id,)
        ).fetchone()
        return dict(row) if row else None


def latest_render_for_story(story_id: str) -> dict | None:
    """Read the most recently requested render for a story. The editor header
    uses this on page render so the admin sees the last queued/finished
    render's state without having to remember a render id across reloads."""
    cols = ", ".join(_RENDER_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {cols} FROM video_renders WHERE story_id = %s "
                    "ORDER BY requested_at DESC LIMIT 1",
                    (story_id,),
                )
                row = cur.fetchone()
                return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(
            f"SELECT {cols} FROM video_renders WHERE story_id=? "
            "ORDER BY requested_at DESC LIMIT 1",
            (story_id,),
        ).fetchone()
        return dict(row) if row else None


def claim_next_render() -> dict | None:
    """Atomically claim the oldest queued render and flip it to 'rendering'.

    Returns the claimed row, or None when the queue is empty. The worker
    calls this once per polling tick. The atomic update prevents two workers
    from racing on the same row even though we only run one locally today.
    """
    cols = ", ".join(_RENDER_COLUMNS)
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                # FOR UPDATE SKIP LOCKED gives us a clean race-free claim on
                # Postgres. RETURNING gets the row back in one round trip.
                cur.execute(
                    f"UPDATE video_renders SET status = 'rendering', "
                    "started_at = %s WHERE id = ("
                    "SELECT id FROM video_renders WHERE status = 'queued' "
                    "ORDER BY requested_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED"
                    f") RETURNING {cols}",
                    (now,),
                )
                row = cur.fetchone()
            conn.commit()
        return dict(row) if row else None
    # SQLite has no SKIP LOCKED, but the single-fork local worker pattern
    # doesn't need it. The conditional UPDATE (status='queued') means a
    # losing racer simply gets total_changes==0 and tries again next tick.
    with _sqlite_conn() as c:
        row = c.execute(
            "SELECT id FROM video_renders WHERE status='queued' "
            "ORDER BY requested_at ASC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        c.execute(
            "UPDATE video_renders SET status='rendering', started_at=? "
            "WHERE id=? AND status='queued'",
            (now, row["id"]),
        )
        if c.total_changes == 0:
            return None
        claimed = c.execute(
            f"SELECT {cols} FROM video_renders WHERE id=?", (row["id"],)
        ).fetchone()
        return dict(claimed) if claimed else None


def update_render_progress(render_id: str, progress: float) -> None:
    """Update only the progress field. Worker calls this when generate_video
    surfaces a percentage."""
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE video_renders SET progress = %s WHERE id = %s",
                    (progress, render_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE video_renders SET progress=? WHERE id=?",
            (progress, render_id),
        )


def finish_render(render_id: str, output_url: str) -> None:
    """Mark a render done. Worker calls this after generate_video returns a
    successful video_url."""
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE video_renders SET status='done', progress=1.0, "
                    "output_url=%s, finished_at=%s WHERE id=%s",
                    (output_url, now, render_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE video_renders SET status='done', progress=1.0, "
            "output_url=?, finished_at=? WHERE id=?",
            (output_url, now, render_id),
        )


def fail_render(render_id: str, error_message: str) -> None:
    """Mark a render failed. Worker calls this on any exception path."""
    now = _now_iso()
    # Cap the message so a 10MB Python traceback doesn't bloat the row.
    capped = (error_message or "unknown error")[:2000]
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE video_renders SET status='error', error=%s, "
                    "finished_at=%s WHERE id=%s",
                    (capped, now, render_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE video_renders SET status='error', error=?, "
            "finished_at=? WHERE id=?",
            (capped, now, render_id),
        )


def _now_iso() -> str:
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


# --- image_renders helpers (2026-06-12 asset re-render queue) -----------------
# The Next admin enqueues an image regen via enqueueImageRegenAction; this
# module's `claim_next_image_render` is what pipeline/image_render_worker.py
# polls. Status transitions are queued → generating → done | error. Unlike
# video_renders, there's no idempotency constraint — every click is a fresh
# row (config-hash dedup would be confusing for "I want a different image").

_IMAGE_RENDER_COLUMNS = [
    "id", "owner_kind", "owner_id", "asset", "prompt_hash", "status",
    "progress", "error", "output_url", "cost_cents", "requested_by",
    "requested_at", "started_at", "finished_at",
]


def claim_next_image_render() -> dict | None:
    """Atomically claim the oldest queued image regen and flip it to
    'generating'. Returns the claimed row, or None when the queue is empty.
    Mirrors claim_next_render — same race-free idiom on Postgres
    (FOR UPDATE SKIP LOCKED), same conditional UPDATE on SQLite."""
    cols = ", ".join(_IMAGE_RENDER_COLUMNS)
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"UPDATE image_renders SET status = 'generating', "
                    "started_at = %s WHERE id = ("
                    "SELECT id FROM image_renders WHERE status = 'queued' "
                    "ORDER BY requested_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED"
                    f") RETURNING {cols}",
                    (now,),
                )
                row = cur.fetchone()
            conn.commit()
        return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(
            "SELECT id FROM image_renders WHERE status='queued' "
            "ORDER BY requested_at ASC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        c.execute(
            "UPDATE image_renders SET status='generating', started_at=? "
            "WHERE id=? AND status='queued'",
            (now, row["id"]),
        )
        if c.total_changes == 0:
            return None
        claimed = c.execute(
            f"SELECT {cols} FROM image_renders WHERE id=?", (row["id"],)
        ).fetchone()
        return dict(claimed) if claimed else None


def finish_image_render(
    render_id: str, output_url: str, cost_cents: int
) -> None:
    """Mark an image regen done. Worker writes the kie-hosted URL (or local
    /generated/ URL) plus the actual cost in cents."""
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE image_renders SET status='done', progress=100, "
                    "output_url=%s, cost_cents=%s, finished_at=%s WHERE id=%s",
                    (output_url, cost_cents, now, render_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE image_renders SET status='done', progress=100, "
            "output_url=?, cost_cents=?, finished_at=? WHERE id=?",
            (output_url, cost_cents, now, render_id),
        )


def fail_image_render(render_id: str, error_message: str) -> None:
    """Mark an image regen failed. Worker calls this on any exception path
    or on a NotImplementedError from a stub regenerator."""
    now = _now_iso()
    capped = (error_message or "unknown error")[:2000]
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE image_renders SET status='error', error=%s, "
                    "finished_at=%s WHERE id=%s",
                    (capped, now, render_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE image_renders SET status='error', error=?, "
            "finished_at=? WHERE id=?",
            (capped, now, render_id),
        )


def get_image_render(render_id: str) -> dict | None:
    """Read a single image render row by id. Used by tests + ad-hoc queries."""
    cols = ", ".join(_IMAGE_RENDER_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {cols} FROM image_renders WHERE id = %s",
                    (render_id,),
                )
                row = cur.fetchone()
        return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(
            f"SELECT {cols} FROM image_renders WHERE id=?", (render_id,)
        ).fetchone()
        return dict(row) if row else None


def update_story_hero(story_id: str, hero_url: str) -> None:
    """Patch a single column. Used by the image regen worker after a hero
    regen completes so the public reader sees the new image immediately."""
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE stories SET hero_image = %s, updated_at = %s "
                    "WHERE id = %s",
                    (hero_url, now, story_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE stories SET hero_image = ?, updated_at = ? WHERE id = ?",
            (hero_url, now, story_id),
        )


def update_story_scenes(story_id: str, scene_urls: list[str]) -> None:
    """Replace stories.images with a fresh JSON array of scene URLs."""
    now = _now_iso()
    payload = json.dumps(scene_urls)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE stories SET images = %s, updated_at = %s "
                    "WHERE id = %s",
                    (payload, now, story_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE stories SET images = ?, updated_at = ? WHERE id = ?",
            (payload, now, story_id),
        )


def update_story_video_config(story_id: str, video_config: dict) -> None:
    """Replace stories.video_config with a fresh JSON object.

    Used by media.regen_one() for `frame:<id>` slugs: the per-frame regen
    handler reads the prompt off the persisted config, generates a new
    image, then writes the updated config back through this helper.

    Caller is responsible for shaping the dict — this helper does no
    validation. The editor's parseVideoConfig() is the canonical
    validator; the pipeline trusts itself to write a shape that
    round-trips through that parser.
    """
    now = _now_iso()
    payload = json.dumps(video_config)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE stories SET video_config = %s, updated_at = %s "
                    "WHERE id = %s",
                    (payload, now, story_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE stories SET video_config = ?, updated_at = ? WHERE id = ?",
            (payload, now, story_id),
        )


def update_story_props(story_id: str, prop_list: list[dict]) -> None:
    """Replace stories.props with a fresh JSON list of {url,label,side} dicts."""
    now = _now_iso()
    payload = json.dumps(prop_list)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE stories SET props = %s, updated_at = %s "
                    "WHERE id = %s",
                    (payload, now, story_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE stories SET props = ?, updated_at = ? WHERE id = ?",
            (payload, now, story_id),
        )


# --- articles helpers (2026-06-12) -------------------------------------------
# Articles are TS-owned (the schema lives in lorewire-app/src/lib/schema.ts,
# rows are created via the admin editor at /admin/articles/new). The Python
# pipeline historically had no reason to touch them, but the asset re-render
# worker now needs to: hero + og are top-level columns; body + gallery
# images live inside articles.document (Tiptap JSON), so the worker walks
# the doc, replaces image src attributes, and writes the modified doc back.

_ARTICLE_COLUMNS = [
    "id", "type", "language", "slug", "title", "subtitle", "summary",
    "document", "hero_image", "status", "author_id", "meta_title",
    "meta_description", "og_image", "payload", "source_sheet_row_id",
    "created_at", "updated_at", "published_at", "noindex",
]


def fetch_article(article_id: str) -> dict | None:
    """Read a single article row by id, dialect-agnostic."""
    cols = ", ".join(_ARTICLE_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {cols} FROM articles WHERE id = %s", (article_id,)
                )
                row = cur.fetchone()
                return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(
            f"SELECT {cols} FROM articles WHERE id=?", (article_id,)
        ).fetchone()
        return dict(row) if row else None


def update_article_hero(article_id: str, hero_url: str) -> None:
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE articles SET hero_image = %s, updated_at = %s "
                    "WHERE id = %s",
                    (hero_url, now, article_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE articles SET hero_image = ?, updated_at = ? WHERE id = ?",
            (hero_url, now, article_id),
        )


def update_article_og(article_id: str, og_url: str) -> None:
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE articles SET og_image = %s, updated_at = %s "
                    "WHERE id = %s",
                    (og_url, now, article_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE articles SET og_image = ?, updated_at = ? WHERE id = ?",
            (og_url, now, article_id),
        )


def update_article_document(article_id: str, document_json: str) -> None:
    """Replace articles.document wholesale. Worker calls this after walking
    the Tiptap doc, swapping image src attributes for fresh kie URLs, and
    re-serializing. The string IS the document; we don't re-parse on the
    DB side."""
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE articles SET document = %s, updated_at = %s "
                    "WHERE id = %s",
                    (document_json, now, article_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE articles SET document = ?, updated_at = ? WHERE id = ?",
            (document_json, now, article_id),
        )


def update_story_character(
    story_id: str,
    character_url: str | None,
    character_mouth_removed_url: str | None,
) -> None:
    """Patch both mouth-swap columns at once. Either side can be None when
    a partial regen succeeds only halfway — the worker passes both back so
    the row is fully consistent after each tick."""
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE stories SET character_image = %s, "
                    "character_image_mouth_removed = %s, updated_at = %s "
                    "WHERE id = %s",
                    (character_url, character_mouth_removed_url, now, story_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE stories SET character_image = ?, "
            "character_image_mouth_removed = ?, updated_at = ? WHERE id = ?",
            (character_url, character_mouth_removed_url, now, story_id),
        )
