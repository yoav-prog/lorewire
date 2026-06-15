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
    # per-aspect active pick (see settings keys `video.active_<kind>_id_<aspect>`
    # and the master switch `video.intro_outro_enabled`).
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
    # 2026-06-14: pipeline-owned cache previously co-tenanted inside
    # video_config. The editor's parseVideoConfig drops unknown
    # top-level fields, so the heartbeat write path was silently wiping
    # `world_bible`, `scene_prompts`, `scene_prompts_built_with`,
    # `scene_entity_ids`, `character_bible` on every fire. The first
    # scene worker re-built the world bible from scratch every time
    # (~$0.30, ~260s) and the cron's 270s deadline killed the function
    # before the second scene completed. Moving the cache into its own
    # column gives the pipeline a surface the editor can't see.
    # Backfill of existing rows lives in
    # `lorewire-app/scripts/migrate_pipeline_cache.mjs` — run once
    # against prod after the column lands.
    "ALTER TABLE stories ADD COLUMN IF NOT EXISTS pipeline_cache TEXT",
    # 2026-06-14 voiceover picker (Phase 1 of
    # _plans/2026-06-14-voiceover-picker.md): per-story override columns
    # for the narrator's voice. Both nullable; NULL = use the global
    # `voice.elevenlabs_voice_id` / `voice.google_voice_name` setting.
    # `voice_provider` mirrors `models.get_selected("voice")` shape
    # (e.g. "elevenlabs", "google/chirp3-hd", "google/gemini-25-flash-tts");
    # `voice_id` is the provider-native id (ElevenLabs voice_id GUID OR
    # the full Google voice name like "en-US-Chirp3-HD-Aoede"). Resolution
    # chain lives in pipeline/voice.py:synthesize.
    "ALTER TABLE stories ADD COLUMN IF NOT EXISTS voice_provider TEXT",
    "ALTER TABLE stories ADD COLUMN IF NOT EXISTS voice_id TEXT",
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
    # 2026-06-15 article shorts: render queue for the 40-60s vertical doodle
    # shorts (separate path from long-form video_renders so nothing existing
    # breaks). The admin clicks "Generate short"; the Next action inserts a row
    # here; pipeline/short_render_worker.py (and the Vercel cron) drains it.
    # narration_style + length_preset capture the creation options; `phase`
    # tracks the multi-step generation (script/plan/base/scene/render) so the
    # worker resumes and the UI shows progress. Idempotent on
    # (story_id, config_hash) like video_renders.
    """CREATE TABLE IF NOT EXISTS short_renders (
        id              TEXT PRIMARY KEY,
        story_id        TEXT NOT NULL,
        config_hash     TEXT NOT NULL,
        narration_style TEXT,
        length_preset   TEXT,
        status          TEXT NOT NULL,
        phase           TEXT,
        progress        REAL DEFAULT 0,
        error           TEXT,
        output_url      TEXT,
        props           TEXT,
        requested_by    TEXT,
        requested_at    TEXT NOT NULL,
        started_at      TEXT,
        finished_at     TEXT,
        UNIQUE (story_id, config_hash)
    )""",
    "CREATE INDEX IF NOT EXISTS idx_short_renders_status_requested ON short_renders(status, requested_at)",
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
    # 2026-06-13 Phase 2 of _plans/2026-06-13-worker-host-stop-button-observability.md.
    # Per-row event timeline so the admin can see what the worker is
    # actually doing (kie request, kie response, image saved, etc.)
    # without tailing Vercel logs. The bracketed `[drain claim]`-style
    # logs stay; this table is the user-visible mirror of the same
    # events.
    """CREATE TABLE IF NOT EXISTS image_render_events (
        id          TEXT PRIMARY KEY,
        render_id   TEXT NOT NULL,
        ts          TEXT NOT NULL,
        level       TEXT NOT NULL,
        event       TEXT NOT NULL,
        message     TEXT,
        payload     TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS idx_image_render_events_render_id ON image_render_events(render_id, ts)",
    # 2026-06-14 video-render observability. Same shape + purpose as the
    # image-render variant — the Vercel cron orchestrator and the
    # queueRender server action write structured rows here so the editor's
    # RenderControl can render an inline timeline under the Render button.
    """CREATE TABLE IF NOT EXISTS video_render_events (
        id          TEXT PRIMARY KEY,
        render_id   TEXT NOT NULL,
        ts          TEXT NOT NULL,
        level       TEXT NOT NULL,
        event       TEXT NOT NULL,
        message     TEXT,
        payload     TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS idx_video_render_events_render_id ON video_render_events(render_id, ts)",
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
    # Phase 3 of _plans/2026-06-12-video-aspect-ratio.md: each segment is
    # ffmpeg-normalized to a single aspect at upload time. Mixing a 9:16
    # intro into a 16:9 story would force the splice's concat filter to
    # resample (or fail), so the picker filters by matching aspect at
    # render time. Existing rows default to portrait, which matches what
    # they actually are.
    "ALTER TABLE video_segments ADD COLUMN IF NOT EXISTS aspect TEXT DEFAULT '9:16'",
    # The worker's hot path is "newest pending row first" — index it.
    "CREATE INDEX IF NOT EXISTS idx_video_segments_status_created ON video_segments(status, created_at)",
    # 2026-06-14 Reddit DB sync (see _plans/2026-06-14-reddit-db-sync.md).
    # Candidate pool of Reddit posts imported by the admin from a CSV; the
    # admin browses, filters, and bulk-promotes rows into the stories pipeline.
    # `reddit_id` is the strict primary key — the same identifier that the
    # rest of the system uses as slug/source-of-truth (stories.reddit_id).
    # `status` lifecycle: imported -> queued -> processing -> used; or
    # imported -> skipped if the admin rejects. Re-syncs of the same row
    # refresh content fields but never clobber status/story_id/notes —
    # those are the admin's state.
    """CREATE TABLE IF NOT EXISTS reddit_source (
        reddit_id     TEXT PRIMARY KEY,
        subreddit     TEXT NOT NULL,
        date_written  TEXT NOT NULL,
        title         TEXT NOT NULL,
        full_text     TEXT NOT NULL,
        comments      INTEGER,
        url           TEXT,
        summary       TEXT,
        length_chars  INTEGER,
        status        TEXT NOT NULL DEFAULT 'imported',
        story_id      TEXT,
        notes         TEXT,
        first_synced  TEXT NOT NULL,
        last_synced   TEXT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS idx_reddit_source_status   ON reddit_source(status)",
    "CREATE INDEX IF NOT EXISTS idx_reddit_source_sub_len  ON reddit_source(subreddit, length_chars)",
    "CREATE INDEX IF NOT EXISTS idx_reddit_source_comments ON reddit_source(comments)",
    "CREATE INDEX IF NOT EXISTS idx_reddit_source_date     ON reddit_source(date_written)",
    # 2026-06-14 Phase 3 of _plans/2026-06-14-reddit-db-sync.md.
    # Per-attempt queue: each "Process N" click in the admin inserts one row
    # per selected reddit_source, the local pipeline/story_jobs_worker.py
    # polls for status='queued', claims the oldest, runs the existing
    # scrape→idea→research→article→media→video stages against the source
    # row's full_text, writes the result into `stories`, and flips
    # reddit_source.status to 'used' on success. Mirrors video_renders /
    # image_renders in shape and atomic-claim semantics.
    """CREATE TABLE IF NOT EXISTS story_jobs (
        id            TEXT PRIMARY KEY,
        reddit_id     TEXT NOT NULL,
        status        TEXT NOT NULL,
        progress      INTEGER DEFAULT 0,
        error         TEXT,
        story_id      TEXT,
        with_media    INTEGER DEFAULT 1,
        requested_by  TEXT,
        requested_at  TEXT NOT NULL,
        started_at    TEXT,
        finished_at   TEXT
    )""",
    # Worker hot path: oldest queued first. Mirrors the index on
    # image_renders(status, requested_at).
    "CREATE INDEX IF NOT EXISTS idx_story_jobs_status_requested ON story_jobs(status, requested_at)",
    # Admin status lookups: "what's the latest job for this reddit_id?"
    "CREATE INDEX IF NOT EXISTS idx_story_jobs_reddit_id ON story_jobs(reddit_id, requested_at)",
    # 2026-06-14 Phase 5 (see _plans/2026-06-14-story-jobs-followups.md).
    # Hard upper bound: at most one active job per reddit_id, enforced by
    # the DB. The application-level check in has_active_story_job is still
    # the fast path (avoids the wasted INSERT round trip), but this index
    # closes the check-then-insert race window so a simultaneous
    # double-click on Process N can't burn LLM/image credit twice on the
    # same row. Partial-index syntax is identical on SQLite >= 3.8 and
    # Postgres >= 9.5. Safe to add on a populated DB — the existing
    # app-level guard means no current rows violate the constraint.
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_story_jobs_one_active "
    "ON story_jobs(reddit_id) WHERE status IN ('queued', 'processing')",
    # 2026-06-14 Phase 4 of _plans/2026-06-14-voiceover-picker.md.
    # Per-attempt queue for voice regen — admin clicks Regenerate
    # voiceover in the picker UI, server action inserts a row here,
    # the local pipeline/voice_renders_worker.py polls for
    # status='queued', synthesizes new audio with the per-story voice
    # override, uploads to GCS, rebuilds captions + duration_ms in
    # video_config, and updates stories.audio_url + alignment.
    # voice_provider + voice_id are SNAPSHOTTED at enqueue time so a
    # mid-run picker change on the same story doesn't re-route an
    # in-flight render to a different voice. text_hash idempotency:
    # rapid double-clicks on the same (story_id, text_hash,
    # voice_provider, voice_id) coalesce via the partial unique
    # index below.
    """CREATE TABLE IF NOT EXISTS voice_renders (
        id              TEXT PRIMARY KEY,
        story_id        TEXT NOT NULL,
        voice_provider  TEXT,
        voice_id        TEXT,
        text_hash       TEXT NOT NULL,
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
    "CREATE INDEX IF NOT EXISTS idx_voice_renders_status_requested ON voice_renders(status, requested_at)",
    "CREATE INDEX IF NOT EXISTS idx_voice_renders_story_id ON voice_renders(story_id, requested_at)",
    # Same partial-unique pattern as story_jobs: at most one active
    # render per (story, text, voice) combo so a confirm-dialog
    # double-click can't burn the TTS spend twice.
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_renders_one_active "
    "ON voice_renders(story_id, text_hash, voice_provider, voice_id) "
    "WHERE status IN ('queued', 'processing')",
]

_COLUMNS = [
    "id", "reddit_id", "slug", "category", "title", "summary", "body",
    "teleprompter", "status", "source_url", "hero_image", "hero_image_landscape",
    "hero_has_baked_title", "images", "audio_url", "video_url", "duration",
    "alignment", "props", "character_image", "character_image_mouth_removed",
    "intro_segment_id", "outro_segment_id", "skip_intro", "skip_outro",
    "video_config",
    # 2026-06-14: pipeline-owned cache (world_bible, scene_prompts,
    # scene_prompts_built_with, scene_entity_ids, character_bible).
    # Editor never reads or writes this column — see schema.ts comment.
    "pipeline_cache",
    # 2026-06-14 voiceover picker per-story override (see schema comment
    # above for resolution chain). Both NULL on fresh-pipeline writes —
    # the picker UI lands them via setStoryVoiceAction in Phase 3.
    "voice_provider", "voice_id",
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
        _seed_active_segment_aspect()
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
    _seed_active_segment_aspect()


# Sentinel distinguishing "segment row absent" from "row present, aspect NULL"
# in the per-aspect seed below — a missing row must not be seeded (it would
# point a slot at a deleted id), but a present row with a NULL aspect is the
# legacy 9:16 case and should seed the 9:16 slot.
_SEGMENT_MISSING = object()


def _segment_aspect_or_missing(seg_id: str) -> object:
    """Return the `aspect` column for a segment id, or `_SEGMENT_MISSING` when
    there is no such row. A present row with a NULL aspect returns None and the
    caller coalesces it to the legacy 9:16 floor."""
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT aspect FROM video_segments WHERE id = %s", (seg_id,)
                )
                row = cur.fetchone()
                return row["aspect"] if row else _SEGMENT_MISSING
    with _sqlite_conn() as c:
        row = c.execute(
            "SELECT aspect FROM video_segments WHERE id=?", (seg_id,)
        ).fetchone()
        return row["aspect"] if row else _SEGMENT_MISSING


def _seed_active_segment_aspect() -> None:
    """Idempotent one-shot: copy the legacy single active intro/outro pointer
    into the per-aspect slot matching its segment's aspect
    (_plans/2026-06-15-intro-outro-per-aspect-active.md). Before this change the
    active segment lived under a single key per kind; now each aspect has its own
    slot. Only fills an EMPTY slot, so it's a no-op once seeded and never
    overrides an admin's pick. Runs at the end of init() in both runtimes;
    whichever boots first against the shared Postgres wins and the other no-ops.
    Mirror of `seedActiveSegmentAspect` in lorewire-app/src/lib/db.ts.

    Best-effort: a failure here must not crash startup — the slot stays empty and
    the render falls to body-only until the admin sets an active segment by hand.
    """
    from pipeline.aspect import (
        LEGACY_DEFAULT_ASPECT,
        active_segment_setting_key,
        is_video_aspect,
        legacy_active_segment_setting_key,
    )

    for kind in ("intro", "outro"):
        try:
            legacy_id = (
                get_setting(legacy_active_segment_setting_key(kind)) or ""
            ).strip()
            if not legacy_id:
                continue
            raw_aspect = _segment_aspect_or_missing(legacy_id)
            if raw_aspect is _SEGMENT_MISSING:
                continue
            aspect = (
                raw_aspect if is_video_aspect(raw_aspect) else LEGACY_DEFAULT_ASPECT
            )
            slot_key = active_segment_setting_key(kind, aspect)
            if (get_setting(slot_key) or "").strip():
                continue
            set_setting(slot_key, legacy_id)
            print(
                f"[store] seeded per-aspect active {kind} -> {slot_key} = {legacy_id}"
            )
        except Exception as e:
            print(f"[store] seed per-aspect active {kind} failed: {e!r}")


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
    "enabled", "status", "error", "uploaded_at", "aspect",
    "created_at", "updated_at",
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
    {"normalized_url", "duration_ms", "enabled", "error", "uploaded_at",
     # `aspect` was added 2026-06-14 so the worker can override a
     # client-claimed aspect with the value it probed off the file
     # itself (production diagnosis: upload form silently defaulted
     # to 9:16 and the row stayed wrong even when the source was 16:9).
     "aspect"}
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


# --- short_renders helpers (2026-06-15 article shorts render queue) -----------
# Mirrors the video_renders helpers above. The Next "Generate short" action
# enqueues; pipeline/short_render_worker.py (and the Vercel cron) drain via
# claim_next_short_render. Status: queued -> rendering -> done | error, with a
# `phase` field (script/plan/base/scene/render) for the multi-step progress UI.
# Idempotent on (story_id, config_hash).

_SHORT_RENDER_COLUMNS = [
    "id", "story_id", "config_hash", "narration_style", "length_preset",
    "status", "phase", "progress", "error", "output_url", "props",
    "requested_by", "requested_at", "started_at", "finished_at",
]


def enqueue_short_render(
    render_id: str,
    story_id: str,
    config_hash: str,
    narration_style: str | None = None,
    length_preset: str | None = None,
    requested_by: str | None = None,
) -> dict:
    """Insert a queued short-render row OR return the existing one for the same
    (story_id, config_hash). Idempotent so repeat clicks coalesce."""
    now = _now_iso()
    cols = ", ".join(_SHORT_RENDER_COLUMNS)
    values = {
        "id": render_id,
        "story_id": story_id,
        "config_hash": config_hash,
        "narration_style": narration_style,
        "length_preset": length_preset,
        "status": "queued",
        "phase": None,
        "progress": 0,
        "error": None,
        "output_url": None,
        "props": None,
        "requested_by": requested_by,
        "requested_at": now,
        "started_at": None,
        "finished_at": None,
    }
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                placeholders = ", ".join(f"%({c})s" for c in _SHORT_RENDER_COLUMNS)
                cur.execute(
                    f"INSERT INTO short_renders ({cols}) VALUES ({placeholders}) "
                    "ON CONFLICT (story_id, config_hash) DO NOTHING",
                    values,
                )
                cur.execute(
                    f"SELECT {cols} FROM short_renders "
                    "WHERE story_id = %s AND config_hash = %s",
                    (story_id, config_hash),
                )
                row = cur.fetchone()
            conn.commit()
        return dict(row) if row else {}
    with _sqlite_conn() as c:
        placeholders = ", ".join(f":{col}" for col in _SHORT_RENDER_COLUMNS)
        c.execute(
            f"INSERT OR IGNORE INTO short_renders ({cols}) VALUES ({placeholders})",
            values,
        )
        row = c.execute(
            f"SELECT {cols} FROM short_renders WHERE story_id=? AND config_hash=?",
            (story_id, config_hash),
        ).fetchone()
        return dict(row) if row else {}


def get_short_render(render_id: str) -> dict | None:
    """Read one short-render row by id. The Next status endpoint polls this."""
    cols = ", ".join(_SHORT_RENDER_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(f"SELECT {cols} FROM short_renders WHERE id = %s", (render_id,))
                row = cur.fetchone()
                return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(f"SELECT {cols} FROM short_renders WHERE id=?", (render_id,)).fetchone()
        return dict(row) if row else None


def latest_short_render_for_story(story_id: str) -> dict | None:
    """Most recently requested short render for a story (for the editor header)."""
    cols = ", ".join(_SHORT_RENDER_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {cols} FROM short_renders WHERE story_id = %s "
                    "ORDER BY requested_at DESC LIMIT 1",
                    (story_id,),
                )
                row = cur.fetchone()
                return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(
            f"SELECT {cols} FROM short_renders WHERE story_id=? "
            "ORDER BY requested_at DESC LIMIT 1",
            (story_id,),
        ).fetchone()
        return dict(row) if row else None


def claim_next_short_render() -> dict | None:
    """Atomically claim the oldest queued short render and flip it to
    'rendering'. Returns the claimed row, or None when the queue is empty."""
    cols = ", ".join(_SHORT_RENDER_COLUMNS)
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"UPDATE short_renders SET status = 'rendering', "
                    "started_at = %s WHERE id = ("
                    "SELECT id FROM short_renders WHERE status = 'queued' "
                    "ORDER BY requested_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED"
                    f") RETURNING {cols}",
                    (now,),
                )
                row = cur.fetchone()
            conn.commit()
        return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(
            "SELECT id FROM short_renders WHERE status='queued' "
            "ORDER BY requested_at ASC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        c.execute(
            "UPDATE short_renders SET status='rendering', started_at=? "
            "WHERE id=? AND status='queued'",
            (now, row["id"]),
        )
        if c.total_changes == 0:
            return None
        claimed = c.execute(
            f"SELECT {cols} FROM short_renders WHERE id=?", (row["id"],)
        ).fetchone()
        return dict(claimed) if claimed else None


def claim_next_short_for_generation() -> dict | None:
    """Atomically claim the oldest queued short that has NO props yet (needs
    generation) and flip it to 'generating'. The Vercel generation drain calls
    this; the render cron claims rows that already HAVE props."""
    cols = ", ".join(_SHORT_RENDER_COLUMNS)
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"UPDATE short_renders SET status = 'generating', "
                    "started_at = %s WHERE id = ("
                    "SELECT id FROM short_renders WHERE status = 'queued' AND props IS NULL "
                    "ORDER BY requested_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED"
                    f") RETURNING {cols}",
                    (now,),
                )
                row = cur.fetchone()
            conn.commit()
        return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(
            "SELECT id FROM short_renders WHERE status='queued' AND props IS NULL "
            "ORDER BY requested_at ASC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        c.execute(
            "UPDATE short_renders SET status='generating', started_at=? "
            "WHERE id=? AND status='queued'",
            (now, row["id"]),
        )
        if c.total_changes == 0:
            return None
        claimed = c.execute(
            f"SELECT {cols} FROM short_renders WHERE id=?", (row["id"],)
        ).fetchone()
        return dict(claimed) if claimed else None


def store_short_props(render_id: str, props_json: str) -> None:
    """After generation: persist the built props and flip back to 'queued' so the
    render cron (which claims queued rows that HAVE props) picks it up."""
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE short_renders SET props = %s, status = 'queued', "
                    "phase = 'ready', progress = 0.5 WHERE id = %s",
                    (props_json, render_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE short_renders SET props=?, status='queued', phase='ready', "
            "progress=0.5 WHERE id=?",
            (props_json, render_id),
        )


def update_short_render_progress(
    render_id: str, progress: float, phase: str | None = None
) -> None:
    """Update progress (0..1) and optionally the current phase label."""
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                if phase is not None:
                    cur.execute(
                        "UPDATE short_renders SET progress = %s, phase = %s WHERE id = %s",
                        (progress, phase, render_id),
                    )
                else:
                    cur.execute(
                        "UPDATE short_renders SET progress = %s WHERE id = %s",
                        (progress, render_id),
                    )
            conn.commit()
        return
    with _sqlite_conn() as c:
        if phase is not None:
            c.execute(
                "UPDATE short_renders SET progress=?, phase=? WHERE id=?",
                (progress, phase, render_id),
            )
        else:
            c.execute(
                "UPDATE short_renders SET progress=? WHERE id=?",
                (progress, render_id),
            )


def finish_short_render(render_id: str, output_url: str) -> None:
    """Mark a short render done."""
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE short_renders SET status='done', progress=1.0, phase='done', "
                    "output_url=%s, finished_at=%s WHERE id=%s",
                    (output_url, now, render_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE short_renders SET status='done', progress=1.0, phase='done', "
            "output_url=?, finished_at=? WHERE id=?",
            (output_url, now, render_id),
        )


def fail_short_render(render_id: str, error_message: str) -> None:
    """Mark a short render failed."""
    now = _now_iso()
    capped = (error_message or "unknown error")[:2000]
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE short_renders SET status='error', error=%s, "
                    "finished_at=%s WHERE id=%s",
                    (capped, now, render_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE short_renders SET status='error', error=?, "
            "finished_at=? WHERE id=?",
            (capped, now, render_id),
        )


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
    /generated/ URL) plus the actual cost in cents.

    Conditional on `status IN ('queued','generating')` so a row the admin
    cancelled mid-flight stays cancelled, and a row already settled
    (done/error/cancelled) isn't overwritten. The 'queued' branch supports
    short-circuit short-circuit finishes from tests + paths where a regen
    completes before claim_next ran (rare but legitimate). Without this
    guard, a worker's eventual finish call would silently flip
    cancelled → done.
    """
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE image_renders SET status='done', progress=100, "
                    "output_url=%s, cost_cents=%s, finished_at=%s "
                    "WHERE id=%s AND status IN ('queued','generating')",
                    (output_url, cost_cents, now, render_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE image_renders SET status='done', progress=100, "
            "output_url=?, cost_cents=?, finished_at=? "
            "WHERE id=? AND status IN ('queued','generating')",
            (output_url, cost_cents, now, render_id),
        )


def fail_image_render(render_id: str, error_message: str) -> None:
    """Mark an image regen failed. Worker calls this on any exception path
    or on a NotImplementedError from a stub regenerator.

    Conditional on `status IN ('queued','generating')` for the same reason
    as `finish_image_render`: an admin Stop racing with a worker error
    shouldn't lose the cancelled state, and an already-settled row
    shouldn't be overwritten.
    """
    now = _now_iso()
    capped = (error_message or "unknown error")[:2000]
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE image_renders SET status='error', error=%s, "
                    "finished_at=%s "
                    "WHERE id=%s AND status IN ('queued','generating')",
                    (capped, now, render_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE image_renders SET status='error', error=?, "
            "finished_at=? "
            "WHERE id=? AND status IN ('queued','generating')",
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


def count_pending_image_renders() -> int:
    """Cheap early-exit for the Vercel cron drain handler. Returns the number
    of rows the drain would care about — queued (not yet picked up) plus
    generating (in flight). When this is zero the handler can short-circuit
    in <100ms and idle ticks bill near nothing on Active CPU."""
    sql = (
        "SELECT count(*) AS n FROM image_renders "
        "WHERE status IN ('queued', 'generating')"
    )
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql)
                row = cur.fetchone()
        return int(row["n"]) if row else 0
    with _sqlite_conn() as c:
        row = c.execute(sql).fetchone()
        return int(row["n"]) if row else 0


def reap_stale_image_render_claims(stale_after_s: int) -> int:
    """Crash-recovery for the queue. A row stays at status='generating' with
    `started_at` set from `claim_next_image_render`'s atomic flip; if the
    worker that claimed it dies before calling finish/fail, the row would
    sit there forever (the LLM Council flagged exactly this on the
    2026-06-13 plan). Reset rows whose started_at is older than
    `stale_after_s` back to queued so the next tick can re-claim them.

    Returns the number of rows reset. Safe to call on every cron tick —
    the WHERE clause is index-friendly and rows in flight under the
    threshold are untouched."""
    import datetime
    cutoff = (
        datetime.datetime.now(datetime.timezone.utc)
        - datetime.timedelta(seconds=stale_after_s)
    ).isoformat()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE image_renders SET status='queued', "
                    "started_at=NULL WHERE status='generating' "
                    "AND started_at IS NOT NULL AND started_at < %s",
                    (cutoff,),
                )
                count = cur.rowcount
            conn.commit()
        return int(count)
    with _sqlite_conn() as c:
        cur = c.execute(
            "UPDATE image_renders SET status='queued', started_at=NULL "
            "WHERE status='generating' AND started_at IS NOT NULL "
            "AND started_at < ?",
            (cutoff,),
        )
        return int(cur.rowcount)


def reap_stale_short_renders(generating_after_s: int, rendering_after_s: int) -> int:
    """Crash-recovery for the short_renders queue. A row stuck at 'generating'
    (the generation drain died mid-run) or 'rendering' (the render cron / Cloud
    Run died) is reset to 'queued' so the next tick re-claims it. props is left
    untouched, so a reset 'generating' row (props NULL) goes back to the
    generation drain and a reset 'rendering' row (props set) goes back to the
    render cron. Separate thresholds because a real Cloud Run render runs minutes
    while generation is bounded by the drain budget; rendering_after_s must stay
    above the cron's 800s cap so a slow-but-live render is never reset out from
    under itself. Returns the number of rows reset; safe on every tick."""
    import datetime

    def _cutoff(seconds: int) -> str:
        return (
            datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(seconds=seconds)
        ).isoformat()

    gen_cutoff = _cutoff(generating_after_s)
    ren_cutoff = _cutoff(rendering_after_s)
    total = 0
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE short_renders SET status='queued', started_at=NULL, error=NULL "
                    "WHERE status='generating' AND started_at IS NOT NULL AND started_at < %s",
                    (gen_cutoff,),
                )
                total += cur.rowcount
                cur.execute(
                    "UPDATE short_renders SET status='queued', started_at=NULL, error=NULL "
                    "WHERE status='rendering' AND started_at IS NOT NULL AND started_at < %s",
                    (ren_cutoff,),
                )
                total += cur.rowcount
            conn.commit()
        return int(total)
    with _sqlite_conn() as c:
        cur = c.execute(
            "UPDATE short_renders SET status='queued', started_at=NULL, error=NULL "
            "WHERE status='generating' AND started_at IS NOT NULL AND started_at < ?",
            (gen_cutoff,),
        )
        total += cur.rowcount
        cur = c.execute(
            "UPDATE short_renders SET status='queued', started_at=NULL, error=NULL "
            "WHERE status='rendering' AND started_at IS NOT NULL AND started_at < ?",
            (ren_cutoff,),
        )
        total += cur.rowcount
        return int(total)


class _AdvisoryLock:
    """Postgres advisory lock context manager. Phase 1 of the drain
    rollout uses this so two Vercel cron ticks landing within the same
    minute can't both run the drain loop — the second one no-ops fast
    and exits. On SQLite the function is a no-op (only one local worker
    in dev, no concurrency)."""

    def __init__(self, key: int) -> None:
        self.key = key
        self._conn = None
        self._acquired = False

    def __enter__(self) -> bool:
        if not _is_postgres():
            self._acquired = True
            return True
        import psycopg
        self._conn = psycopg.connect(config.env("DATABASE_URL"))
        with self._conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(%s)", (self.key,))
            row = cur.fetchone()
        self._acquired = bool(row and row[0])
        if not self._acquired:
            self._conn.close()
            self._conn = None
        return self._acquired

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._conn is None:
            return
        try:
            with self._conn.cursor() as cur:
                cur.execute("SELECT pg_advisory_unlock(%s)", (self.key,))
            self._conn.commit()
        finally:
            self._conn.close()
            self._conn = None


# Lock key for the image_renders drain. A constant integer so every cron
# tick contends on the same key. Chosen by hand (not derived from name)
# so SQL audits stay obvious. If another drain is ever added, pick a
# different integer.
IMAGE_RENDER_DRAIN_LOCK_KEY = 8472301


def image_render_drain_lock() -> _AdvisoryLock:
    """Convenience wrapper so callers don't memorize the key. Used by
    `lorewire-app/api/drain_image_renders.py`."""
    return _AdvisoryLock(IMAGE_RENDER_DRAIN_LOCK_KEY)


# Phase 8 of _plans/2026-06-14-story-jobs-followups.md.
# Distinct integer so the story_jobs drain doesn't contend with the
# image_renders drain on the same Postgres advisory lock — they're
# independent queues and either can be in flight without blocking the
# other.
STORY_JOBS_DRAIN_LOCK_KEY = 8472302


def story_jobs_drain_lock() -> _AdvisoryLock:
    """Convenience wrapper for the story_jobs drain at
    `lorewire-app/api/drain_story_jobs.py`. Same SQLite no-op /
    Postgres advisory-lock semantics as the image_renders lock."""
    return _AdvisoryLock(STORY_JOBS_DRAIN_LOCK_KEY)


# Phase 4.b of _plans/2026-06-14-voiceover-picker.md.
# Distinct integer so the voice_renders drain doesn't contend with the
# image_renders or story_jobs drains on the same Postgres advisory lock.
# Three queues, three keys — independent throughput for each.
VOICE_RENDERS_DRAIN_LOCK_KEY = 8472303


def voice_renders_drain_lock() -> _AdvisoryLock:
    """Convenience wrapper for the voice_renders drain at
    `lorewire-app/api/drain_voice_renders.py`. Same SQLite no-op /
    Postgres advisory-lock semantics as the other queue locks."""
    return _AdvisoryLock(VOICE_RENDERS_DRAIN_LOCK_KEY)


# ─── image_render_events (2026-06-13 Phase 2 observability) ───────────────────
# A contextvar-based pattern so the regen helpers in pipeline/media.py can
# emit events without every function in the chain growing a render_id
# parameter. The drain handler wraps the regen call in
# `with use_render_context(row['id']):` and the regen path calls
# `log_render_event(...)` at meaningful checkpoints. Local pipeline
# runs (no queue context set) call the same helper as a silent no-op.

import contextvars as _ctxvars
import uuid as _uuid

_current_render_id: _ctxvars.ContextVar[str | None] = _ctxvars.ContextVar(
    "current_render_id", default=None,
)


class _RenderContext:
    """Context manager that binds the current render id so subsequent
    log_render_event() calls know which row to attach to. Returns the
    bound id so callers can grab it without re-reading the context."""

    def __init__(self, render_id: str) -> None:
        self.render_id = render_id
        self._token: _ctxvars.Token | None = None

    def __enter__(self) -> str:
        self._token = _current_render_id.set(self.render_id)
        return self.render_id

    def __exit__(self, *exc) -> None:
        if self._token is not None:
            _current_render_id.reset(self._token)
            self._token = None


def use_render_context(render_id: str) -> _RenderContext:
    """Bind `render_id` as the current event-log target for the
    duration of a `with` block. Drain handler wraps the regen call
    with this so events bubble up to the right row without parameter
    plumbing through every regen helper."""
    return _RenderContext(render_id)


def log_render_event(
    event: str,
    message: str | None = None,
    *,
    level: str = "info",
    payload: dict | None = None,
    render_id: str | None = None,
) -> None:
    """Persist one timeline entry against the current (or explicit)
    render row. When no `render_id` is passed AND no context is bound
    (e.g. local pipeline run not via the queue), this function is a
    silent no-op — by design, so emitting events from
    `pipeline.media` is safe regardless of caller.

    `event` is a short machine slug (e.g. 'kie_request_sent',
    'image_saved'); `message` is the human-readable line shown in the
    admin UI; `payload` carries structured fields (durations, costs,
    URLs) and is JSON-encoded into a TEXT column for portability."""
    target = render_id if render_id is not None else _current_render_id.get()
    if target is None:
        return
    row_id = str(_uuid.uuid4())
    ts = _now_iso()
    payload_json = json.dumps(payload) if payload is not None else None
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO image_render_events "
                    "(id, render_id, ts, level, event, message, payload) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    (row_id, target, ts, level, event, message, payload_json),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "INSERT INTO image_render_events "
            "(id, render_id, ts, level, event, message, payload) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (row_id, target, ts, level, event, message, payload_json),
        )


def list_render_events(render_id: str, limit: int = 200) -> list[dict]:
    """Return events for one render row in chronological order
    (oldest first). 200 is plenty for a 27-scene rebuild that emits
    ~5 events per image (~135) plus the dispatch overhead."""
    sql_pg = (
        "SELECT id, render_id, ts, level, event, message, payload "
        "FROM image_render_events WHERE render_id = %s "
        "ORDER BY ts ASC LIMIT %s"
    )
    sql_sqlite = (
        "SELECT id, render_id, ts, level, event, message, payload "
        "FROM image_render_events WHERE render_id = ? "
        "ORDER BY ts ASC LIMIT ?"
    )
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql_pg, (render_id, limit))
                return [dict(r) for r in cur.fetchall()]
    with _sqlite_conn() as c:
        return [
            dict(r) for r in c.execute(sql_sqlite, (render_id, limit)).fetchall()
        ]


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


def update_story_hero_landscape(story_id: str, hero_url: str) -> None:
    """Sibling of `update_story_hero` for the 16:9 landscape variant. The
    fresh-run pipeline writes both columns; the regen path mirrors it so
    a landscape video story doesn't ship with a stale 16:9 hero after a
    hero regen. Caller still updates the portrait column separately."""
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE stories SET hero_image_landscape = %s, "
                    "updated_at = %s WHERE id = %s",
                    (hero_url, now, story_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE stories SET hero_image_landscape = ?, updated_at = ? "
            "WHERE id = ?",
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


def read_story_pipeline_cache(story: dict) -> dict:
    """Decode `stories.pipeline_cache` off an already-fetched story row.

    Returns an empty dict when the column is NULL, malformed, or not a
    JSON object. Pure read helper — never writes. Mirrors the read shape
    pipeline/media.py used to apply to `video_config` for the five
    pipeline-owned fields (world_bible, scene_prompts, etc.) before
    those moved into their own column.
    """
    raw = story.get("pipeline_cache")
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def update_story_pipeline_cache(story_id: str, cache: dict) -> None:
    """Replace stories.pipeline_cache with a fresh JSON object.

    Pipeline-owned surface: the world bible, cached scene prompts, the
    `scene_prompts_built_with` shape marker, the per-scene entity ids
    list, and the legacy `character_bible` cache all live here. The
    editor never reads or writes this column — its parseVideoConfig
    used to silently drop these fields and burn a fresh ~$0.30
    world-bible rebuild on every scene worker that fired after the
    heartbeat wiped the cache.

    Caller owns the merge: this helper REPLACES the column wholesale,
    so a caller updating a single key must first
    `read_story_pipeline_cache(story)`, splice their change in, and
    pass the merged dict back. Bumps `updated_at` so existing
    "latest activity" queries keep working.
    """
    now = _now_iso()
    payload = json.dumps(cache)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE stories SET pipeline_cache = %s, updated_at = %s "
                    "WHERE id = %s",
                    (payload, now, story_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE stories SET pipeline_cache = ?, updated_at = ? WHERE id = ?",
            (payload, now, story_id),
        )


def clear_story_pipeline_cache(story_id: str) -> None:
    """NULL out stories.pipeline_cache. Used by the TS bulk-enqueue path's
    `clearStoryScenePromptsCache` rewrite — a Rebuild click is the user
    asking for "a new look", so the world bible + cached prompts both
    get wiped together (their lifetimes are coupled at the entity-set
    level; keeping prompts after evicting the bible would produce
    prompts that reference characters not in the new bible).

    Bumps `updated_at` for consistency with the other writers.
    """
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE stories SET pipeline_cache = NULL, "
                    "updated_at = %s WHERE id = %s",
                    (now, story_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE stories SET pipeline_cache = NULL, updated_at = ? "
            "WHERE id = ?",
            (now, story_id),
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


# --- reddit_source helpers (2026-06-14 Reddit DB sync) ------------------------
# Candidate pool for the admin's import-review-publish workflow.
# See _plans/2026-06-14-reddit-db-sync.md for the full flow.
#
# Upsert is intentionally partial: re-syncing the same row from a fresher CSV
# refreshes content fields (title, summary, comments, etc.) but never clobbers
# the admin-managed columns (`status`, `story_id`, `notes`, `first_synced`).
# That separation is what makes the table safe to re-sync as the source sheet
# grows without losing review/publish state.

_REDDIT_SOURCE_COLUMNS = [
    "reddit_id", "subreddit", "date_written", "title", "full_text",
    "comments", "url", "summary", "length_chars", "status", "story_id",
    "notes", "first_synced", "last_synced",
]
# Sync only refreshes content fields. Status/story_id/notes/first_synced
# belong to the admin and to the row's first appearance — never overwritten.
_REDDIT_SOURCE_SYNC_REFRESH = [
    "subreddit", "date_written", "title", "full_text", "comments",
    "url", "summary", "length_chars", "last_synced",
]
# Allow-list for set_reddit_source_status patches. Mirrors the
# set_segment_status pattern so a typo can't smuggle a write into the wrong
# column.
_REDDIT_SOURCE_PATCH_COLUMNS = frozenset({"story_id", "notes"})


def upsert_reddit_source(row: dict) -> str:
    """Insert a new reddit_source row OR refresh content fields on an existing
    one. Returns 'new' for first insert, 'updated' when an existing row got
    refreshed (content actually changed), or 'unchanged' when the row was
    already identical.

    `row` must carry every column in `_REDDIT_SOURCE_COLUMNS`; the parser
    builds a complete dict so the caller never has to remember which fields
    are mandatory.
    """
    rid = row["reddit_id"]
    existing = fetch_reddit_source(rid)
    if existing is None:
        cols = ", ".join(_REDDIT_SOURCE_COLUMNS)
        if _is_postgres():
            placeholders = ", ".join(f"%({c})s" for c in _REDDIT_SOURCE_COLUMNS)
            with _pg_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        f"INSERT INTO reddit_source ({cols}) VALUES ({placeholders})",
                        row,
                    )
                conn.commit()
        else:
            placeholders = ", ".join(f":{c}" for c in _REDDIT_SOURCE_COLUMNS)
            with _sqlite_conn() as c:
                c.execute(
                    f"INSERT INTO reddit_source ({cols}) VALUES ({placeholders})",
                    row,
                )
        return "new"

    # Cheap content-diff: if every refresh-column matches, skip the UPDATE so
    # `last_synced` doesn't churn (and the diff summary stays meaningful).
    refresh_cols = [c for c in _REDDIT_SOURCE_SYNC_REFRESH if c != "last_synced"]
    if all(existing.get(c) == row.get(c) for c in refresh_cols):
        return "unchanged"

    assigns = ", ".join(
        f"{c} = " + ("%(" + c + ")s" if _is_postgres() else f":{c}")
        for c in _REDDIT_SOURCE_SYNC_REFRESH
    )
    where_id = "%(reddit_id)s" if _is_postgres() else ":reddit_id"
    sql = f"UPDATE reddit_source SET {assigns} WHERE reddit_id = {where_id}"
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, row)
            conn.commit()
    else:
        with _sqlite_conn() as c:
            c.execute(sql, row)
    return "updated"


def fetch_reddit_source(reddit_id: str) -> dict | None:
    """Read a single reddit_source row. Returns None when no row matches."""
    if not reddit_id:
        return None
    cols = ", ".join(_REDDIT_SOURCE_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {cols} FROM reddit_source WHERE reddit_id = %s",
                    (reddit_id,),
                )
                row = cur.fetchone()
                return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(
            f"SELECT {cols} FROM reddit_source WHERE reddit_id=?", (reddit_id,)
        ).fetchone()
        return dict(row) if row else None


# Build a parameterized WHERE clause from a filter dict. Keeping the predicate
# builder here (not in the route handlers) means the admin TS layer and any
# future CLI report share the same filter shape and SQL injection guards.
def _reddit_source_where(filters: dict) -> tuple[str, dict]:
    """Translate a filter dict into (sql_fragment, params) ready to slot in
    after `WHERE`. Empty filters → ("1=1", {}). All values bound as named
    params; no value ever touches string concatenation.

    Supported filters:
        status            str | list[str]  exact match / IN
        subreddits        list[str]        IN (...)
        length_min        int              length_chars >= …
        length_max        int              length_chars <= …
        comments_min      int              comments >= …
        date_from         str (ISO date)   date_written >= …
        date_to           str (ISO date)   date_written <= …
        search            str              title LIKE %q% OR summary LIKE %q%
    """
    parts: list[str] = []
    params: dict = {}
    pg = _is_postgres()

    def ph(name: str) -> str:
        return f"%({name})s" if pg else f":{name}"

    status = filters.get("status")
    if status:
        if isinstance(status, str):
            parts.append(f"status = {ph('status')}")
            params["status"] = status
        else:
            keys = []
            for i, s in enumerate(status):
                k = f"status_{i}"
                keys.append(ph(k))
                params[k] = s
            parts.append(f"status IN ({', '.join(keys)})")

    subs = filters.get("subreddits")
    if subs:
        keys = []
        for i, s in enumerate(subs):
            k = f"sub_{i}"
            keys.append(ph(k))
            params[k] = s
        parts.append(f"subreddit IN ({', '.join(keys)})")

    if (lmin := filters.get("length_min")) is not None:
        parts.append(f"length_chars >= {ph('length_min')}")
        params["length_min"] = int(lmin)
    if (lmax := filters.get("length_max")) is not None:
        parts.append(f"length_chars <= {ph('length_max')}")
        params["length_max"] = int(lmax)
    if (cmin := filters.get("comments_min")) is not None:
        parts.append(f"comments >= {ph('comments_min')}")
        params["comments_min"] = int(cmin)
    if (dfrom := filters.get("date_from")):
        parts.append(f"date_written >= {ph('date_from')}")
        params["date_from"] = dfrom
    if (dto := filters.get("date_to")):
        parts.append(f"date_written <= {ph('date_to')}")
        params["date_to"] = dto
    if (q := filters.get("search")):
        # SQLite LIKE is case-insensitive on ASCII by default; Postgres LIKE
        # is case-sensitive, so we use ILIKE there. Either way the search
        # value is parameter-bound — no injection surface.
        op = "ILIKE" if pg else "LIKE"
        parts.append(
            f"(title {op} {ph('search')} OR summary {op} {ph('search')})"
        )
        params["search"] = f"%{q}%"

    return (" AND ".join(parts) or "1=1", params)


def list_reddit_sources(
    filters: dict | None = None,
    *,
    limit: int = 50,
    offset: int = 0,
    order_by: str = "comments DESC",
) -> list[dict]:
    """Return reddit_source rows matching `filters`, paginated.

    `order_by` is a whitelisted column + direction string; defaults to
    `comments DESC` (highest-engagement first, which is what the admin wants
    on a candidate list). Caller is responsible for picking from the allowed
    set; we validate against a small whitelist to keep the surface tight.
    """
    allowed = {
        "comments DESC": "comments DESC NULLS LAST" if _is_postgres() else "comments DESC",
        "comments ASC": "comments ASC",
        "length_chars DESC": "length_chars DESC",
        "length_chars ASC": "length_chars ASC",
        "date_written DESC": "date_written DESC",
        "date_written ASC": "date_written ASC",
        "subreddit ASC": "subreddit ASC, comments DESC",
    }
    ob = allowed.get(order_by) or allowed["comments DESC"]
    where, params = _reddit_source_where(filters or {})
    cols = ", ".join(_REDDIT_SOURCE_COLUMNS)
    if _is_postgres():
        sql = (
            f"SELECT {cols} FROM reddit_source WHERE {where} "
            f"ORDER BY {ob} LIMIT %(limit)s OFFSET %(offset)s"
        )
        params = {**params, "limit": int(limit), "offset": int(offset)}
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                return [dict(r) for r in cur.fetchall()]
    sql = (
        f"SELECT {cols} FROM reddit_source WHERE {where} "
        f"ORDER BY {ob} LIMIT :limit OFFSET :offset"
    )
    params = {**params, "limit": int(limit), "offset": int(offset)}
    with _sqlite_conn() as c:
        cur = c.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]


def count_reddit_sources(filters: dict | None = None) -> int:
    """Total rows matching `filters`. Used by the admin pagination footer."""
    where, params = _reddit_source_where(filters or {})
    sql = f"SELECT count(*) AS n FROM reddit_source WHERE {where}"
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                row = cur.fetchone()
                return int(row["n"]) if row else 0
    with _sqlite_conn() as c:
        row = c.execute(sql, params).fetchone()
        return int(row["n"]) if row else 0


def set_reddit_source_status(
    reddit_id: str, status: str, **fields: Any,
) -> None:
    """Flip a row's status and optionally patch one of the allow-listed
    admin-managed columns (`story_id`, `notes`). Unknown columns are
    rejected loudly so a typo in **fields can't smuggle a write into a
    content column.

    `last_synced` is NOT touched here — that's the sync's job only.
    """
    if not reddit_id:
        raise ValueError("set_reddit_source_status requires reddit_id")
    bad = set(fields) - _REDDIT_SOURCE_PATCH_COLUMNS
    if bad:
        raise ValueError(
            f"set_reddit_source_status: unknown columns: {sorted(bad)}"
        )
    patch = {k: v for k, v in fields.items()}
    patch["status"] = status
    if _is_postgres():
        assigns = ", ".join(f"{c} = %({c})s" for c in patch)
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"UPDATE reddit_source SET {assigns} WHERE reddit_id = %(reddit_id)s",
                    {**patch, "reddit_id": reddit_id},
                )
            conn.commit()
        return
    assigns = ", ".join(f"{c} = :{c}" for c in patch)
    with _sqlite_conn() as c:
        c.execute(
            f"UPDATE reddit_source SET {assigns} WHERE reddit_id = :reddit_id",
            {**patch, "reddit_id": reddit_id},
        )


def fetch_reddit_source_snapshot(reddit_ids: list[str]) -> dict[str, dict]:
    """Return a `{reddit_id: row_dict}` map for every id in `reddit_ids` that
    exists in the table. Only the columns the sync's diff needs are SELECTed
    so the snapshot stays small even for a 30k-row sync.

    Used by reddit_db_sync.apply() to do the in-memory diff in a single DB
    round-trip instead of N per-row SELECTs.
    """
    if not reddit_ids:
        return {}
    snapshot: dict[str, dict] = {}
    # Chunk the IN clause so SQLite's per-statement parameter limit (default
    # 999 on older builds, 32766 on modern ones) and Postgres's 32767 bind
    # limit never bite. 500 is a comfortable floor under both.
    chunk = 500
    cols = (
        "reddit_id, subreddit, date_written, title, full_text, "
        "comments, url, summary, length_chars"
    )
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                for i in range(0, len(reddit_ids), chunk):
                    batch = reddit_ids[i:i + chunk]
                    placeholders = ", ".join("%s" for _ in batch)
                    cur.execute(
                        f"SELECT {cols} FROM reddit_source "
                        f"WHERE reddit_id IN ({placeholders})",
                        batch,
                    )
                    for row in cur.fetchall():
                        snapshot[row["reddit_id"]] = dict(row)
        return snapshot
    with _sqlite_conn() as c:
        for i in range(0, len(reddit_ids), chunk):
            batch = reddit_ids[i:i + chunk]
            placeholders = ", ".join("?" for _ in batch)
            cur = c.execute(
                f"SELECT {cols} FROM reddit_source "
                f"WHERE reddit_id IN ({placeholders})",
                batch,
            )
            for row in cur.fetchall():
                snapshot[row["reddit_id"]] = dict(row)
    return snapshot


def bulk_insert_reddit_sources(rows: list[dict]) -> int:
    """Insert many reddit_source rows in a single transaction with
    executemany. Caller already partitioned via fetch_reddit_source_snapshot
    so every row is genuinely new — hitting a PK conflict here means the
    partitioning is wrong, and we'd rather see the error than silently
    swallow with ON CONFLICT DO NOTHING.
    """
    if not rows:
        return 0
    cols = ", ".join(_REDDIT_SOURCE_COLUMNS)
    if _is_postgres():
        placeholders = ", ".join(f"%({c})s" for c in _REDDIT_SOURCE_COLUMNS)
        sql = f"INSERT INTO reddit_source ({cols}) VALUES ({placeholders})"
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.executemany(sql, rows)
            conn.commit()
        return len(rows)
    placeholders = ", ".join(f":{c}" for c in _REDDIT_SOURCE_COLUMNS)
    sql = f"INSERT INTO reddit_source ({cols}) VALUES ({placeholders})"
    with _sqlite_conn() as c:
        # Wrap the executemany in an explicit transaction so the batch commits
        # as one fsync instead of one per row — a 100x+ speedup on a 30k
        # insert.
        c.execute("BEGIN")
        try:
            c.executemany(sql, rows)
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
    return len(rows)


def bulk_refresh_reddit_sources(rows: list[dict]) -> int:
    """Update only the refresh columns on many reddit_source rows in a single
    transaction. Status, story_id, notes, first_synced are deliberately not
    in the SET list — sync never touches admin-managed state."""
    if not rows:
        return 0
    if _is_postgres():
        assigns = ", ".join(
            f"{c} = %({c})s" for c in _REDDIT_SOURCE_SYNC_REFRESH
        )
        sql = (
            f"UPDATE reddit_source SET {assigns} "
            "WHERE reddit_id = %(reddit_id)s"
        )
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.executemany(sql, rows)
            conn.commit()
        return len(rows)
    assigns = ", ".join(f"{c} = :{c}" for c in _REDDIT_SOURCE_SYNC_REFRESH)
    sql = f"UPDATE reddit_source SET {assigns} WHERE reddit_id = :reddit_id"
    with _sqlite_conn() as c:
        c.execute("BEGIN")
        try:
            c.executemany(sql, rows)
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
    return len(rows)


def list_reddit_source_subreddits() -> list[str]:
    """Distinct subreddit names present in the candidate pool. Powers the
    autocomplete on the admin filter rail (no need to call out to a static
    list — the data itself defines the option set)."""
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT DISTINCT subreddit FROM reddit_source "
                    "ORDER BY subreddit ASC"
                )
                return [r["subreddit"] for r in cur.fetchall()]
    with _sqlite_conn() as c:
        cur = c.execute(
            "SELECT DISTINCT subreddit FROM reddit_source ORDER BY subreddit ASC"
        )
        return [r["subreddit"] for r in cur.fetchall()]


# --- story_jobs helpers (2026-06-14 Phase 3: bulk process trigger) -----------
# Per-attempt queue. Each "Process N selected" click in the admin inserts
# N rows here (one per reddit_source). pipeline/story_jobs_worker.py polls
# for status='queued' and claims oldest. Lifecycle: queued -> processing
# -> done | error. Conditional UPDATEs guard against losing cancelled state
# the same way finish_image_render does.

_STORY_JOB_COLUMNS = [
    "id", "reddit_id", "status", "progress", "error", "story_id",
    "with_media", "requested_by", "requested_at", "started_at", "finished_at",
]


def has_active_story_job(reddit_id: str) -> bool:
    """True when a queued or processing row exists for this reddit_id.
    Used by enqueue_story_job to make "click Process twice" idempotent
    inside one polling window. Not transactional — at very high concurrency
    a duplicate could slip through, but the worker would just do redundant
    work on the same row. Production deploy would add a partial unique
    index `(reddit_id) WHERE status IN ('queued','processing')`."""
    if not reddit_id:
        return False
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM story_jobs WHERE reddit_id = %s "
                    "AND status IN ('queued', 'processing') LIMIT 1",
                    (reddit_id,),
                )
                return cur.fetchone() is not None
    with _sqlite_conn() as c:
        row = c.execute(
            "SELECT 1 FROM story_jobs WHERE reddit_id = ? "
            "AND status IN ('queued', 'processing') LIMIT 1",
            (reddit_id,),
        ).fetchone()
        return row is not None


def enqueue_story_job(
    job_id: str,
    reddit_id: str,
    *,
    with_media: bool = True,
    requested_by: str | None = None,
) -> dict | None:
    """Insert a queued story_job. Returns the inserted row, or None when an
    active job (queued or processing) already exists for this reddit_id —
    the caller takes that as "no-op, idempotent."

    Two layers of defense against double-enqueueing the same reddit_id:
      1. `has_active_story_job` is the fast path — skips the INSERT round
         trip in the common case where the row is plainly idle.
      2. The partial unique index `idx_story_jobs_one_active` is the safety
         net for the rare check-then-insert race. The ON CONFLICT clause
         turns a race-loser into a clean "not inserted" signal instead of
         a UNIQUE violation that would crash the bulk-enqueue action.

    The conflict target must match the partial-index's WHERE clause exactly
    — both engines require this for the partial-index dispatch.
    """
    if has_active_story_job(reddit_id):
        return None
    now = _now_iso()
    row = {
        "id": job_id,
        "reddit_id": reddit_id,
        "status": "queued",
        "progress": 0,
        "error": None,
        "story_id": None,
        "with_media": 1 if with_media else 0,
        "requested_by": requested_by,
        "requested_at": now,
        "started_at": None,
        "finished_at": None,
    }
    cols = ", ".join(_STORY_JOB_COLUMNS)
    conflict_clause = (
        "ON CONFLICT (reddit_id) WHERE status IN ('queued', 'processing') "
        "DO NOTHING"
    )
    if _is_postgres():
        placeholders = ", ".join(f"%({c})s" for c in _STORY_JOB_COLUMNS)
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"INSERT INTO story_jobs ({cols}) VALUES ({placeholders}) "
                    f"{conflict_clause}",
                    row,
                )
                inserted = cur.rowcount > 0
            conn.commit()
        return row if inserted else None
    placeholders = ", ".join(f":{c}" for c in _STORY_JOB_COLUMNS)
    with _sqlite_conn() as c:
        cur = c.execute(
            f"INSERT INTO story_jobs ({cols}) VALUES ({placeholders}) "
            f"{conflict_clause}",
            row,
        )
        # SQLite's executed-cursor exposes rowcount the same way; rely on
        # total_changes as a backstop for older driver builds that return
        # -1 from rowcount on INSERT...ON CONFLICT DO NOTHING no-ops.
        inserted = (cur.rowcount or 0) > 0
    return row if inserted else None


def claim_next_story_job(text_only_only: bool = False) -> dict | None:
    """Atomically claim the oldest queued story_job and flip it to
    'processing'. Returns the claimed row, or None when empty. Mirrors
    claim_next_render's FOR UPDATE SKIP LOCKED on Postgres and the
    conditional UPDATE on SQLite.

    `text_only_only`: when True, only rows with `with_media=0` are
    eligible. Used by the Vercel cron drain whose runtime can't render
    video (no Node + Remotion) — without this filter, the drain would
    race the local worker, claim a with_media=True row, and fail it
    with DRAIN_UNSUPPORTED_MEDIA_REASON. The cumulative damage shows
    up as a fleet of error rows whose source rows bounced back to
    'imported' and then got re-enqueued + re-killed by the next drain
    tick. Filtering at claim time means the drain physically can't
    claim what it can't process; with_media=True rows wait patiently
    for the local worker.
    """
    cols = ", ".join(_STORY_JOB_COLUMNS)
    now = _now_iso()
    extra_where = " AND with_media = 0" if text_only_only else ""
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"UPDATE story_jobs SET status = 'processing', "
                    "started_at = %s WHERE id = ("
                    f"SELECT id FROM story_jobs WHERE status = 'queued'{extra_where} "
                    "ORDER BY requested_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED"
                    f") RETURNING {cols}",
                    (now,),
                )
                row = cur.fetchone()
            conn.commit()
        return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(
            f"SELECT id FROM story_jobs WHERE status='queued'{extra_where} "
            "ORDER BY requested_at ASC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        c.execute(
            "UPDATE story_jobs SET status='processing', started_at=? "
            "WHERE id=? AND status='queued'",
            (now, row["id"]),
        )
        if c.total_changes == 0:
            return None
        claimed = c.execute(
            f"SELECT {cols} FROM story_jobs WHERE id=?", (row["id"],)
        ).fetchone()
        return dict(claimed) if claimed else None


def update_story_job_progress(job_id: str, progress: int) -> None:
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE story_jobs SET progress = %s WHERE id = %s "
                    "AND status = 'processing'",
                    (int(progress), job_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE story_jobs SET progress = ? WHERE id = ? "
            "AND status = 'processing'",
            (int(progress), job_id),
        )


def finish_story_job(job_id: str, story_id: str) -> None:
    """Mark a story_job done. Conditional on status IN ('queued','processing')
    so an already-settled row (done / error / cancelled) isn't overwritten,
    BUT a row that was reaped back to 'queued' by `reap_stale_story_jobs`
    can still be finished by the original worker when it eventually returns
    from a long-running stage. Mirrors finish_image_render's contract.

    Without the 'queued' clause, a reap-during-processing scenario lets the
    next tick re-claim and re-run the same job — double-spending LLM/kie
    cost and leaving the original worker's `finish_story_job` to silently
    no-op (state inconsistency: story exists, source flipped to 'used', but
    story_jobs.status stays 'queued')."""
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE story_jobs SET status='done', progress=100, "
                    "story_id=%s, finished_at=%s "
                    "WHERE id=%s AND status IN ('queued', 'processing')",
                    (story_id, now, job_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE story_jobs SET status='done', progress=100, "
            "story_id=?, finished_at=? "
            "WHERE id=? AND status IN ('queued', 'processing')",
            (story_id, now, job_id),
        )


def fail_story_job(job_id: str, error_message: str) -> None:
    """Mark a story_job failed. Cap the message so a 10 MB traceback can't
    bloat the column. Same `status IN ('queued', 'processing')` conditional
    as finish_story_job — see that helper for why both queued and processing
    are accepted."""
    now = _now_iso()
    capped = (error_message or "unknown error")[:2000]
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE story_jobs SET status='error', error=%s, "
                    "finished_at=%s WHERE id=%s "
                    "AND status IN ('queued', 'processing')",
                    (capped, now, job_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE story_jobs SET status='error', error=?, "
            "finished_at=? WHERE id=? "
            "AND status IN ('queued', 'processing')",
            (capped, now, job_id),
        )


def cancel_story_job(job_id: str) -> bool:
    """Flip a queued or processing story_job to 'cancelled'. Returns True
    when the UPDATE actually changed a row — useful so the caller can
    tell "cancelled now" from "already done / cancelled / error".

    The existing finish_story_job and fail_story_job both gate on
    `status IN ('queued', 'processing')`, so a worker that's mid-render
    when cancellation lands will silently no-op its eventual
    finish/fail call instead of overwriting the cancelled state. The
    LLM/image spend already incurred is lost (the worker keeps running
    until its current call returns), but the result is discarded —
    which is the contract the admin's Stop button signs up for.
    """
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE story_jobs SET status='cancelled', "
                    "finished_at=%s WHERE id=%s "
                    "AND status IN ('queued', 'processing')",
                    (now, job_id),
                )
                changed = cur.rowcount > 0
            conn.commit()
        return changed
    with _sqlite_conn() as c:
        cur = c.execute(
            "UPDATE story_jobs SET status='cancelled', "
            "finished_at=? WHERE id=? "
            "AND status IN ('queued', 'processing')",
            (now, job_id),
        )
        return (cur.rowcount or 0) > 0


def cancel_active_jobs_for_reddit_ids(reddit_ids: list[str]) -> int:
    """Bulk-cancel every active (queued or processing) story_job whose
    reddit_id is in the list. Returns the count of rows actually
    flipped. Mirrors the chunked-IN pattern used elsewhere in this
    module for the dual-driver bind limit (SQLite default 999 /
    Postgres 32767).

    Idempotent: rows already done / error / cancelled stay untouched
    by the `status IN ('queued', 'processing')` guard, so re-running
    the same batch is safe."""
    if not reddit_ids:
        return 0
    cancelled = 0
    now = _now_iso()
    for i in range(0, len(reddit_ids), 500):
        batch = reddit_ids[i:i + 500]
        if _is_postgres():
            placeholders = ", ".join("%s" for _ in batch)
            with _pg_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        f"UPDATE story_jobs SET status='cancelled', "
                        f"finished_at=%s "
                        f"WHERE reddit_id IN ({placeholders}) "
                        f"AND status IN ('queued', 'processing')",
                        (now, *batch),
                    )
                    cancelled += cur.rowcount
                conn.commit()
        else:
            placeholders = ", ".join("?" for _ in batch)
            with _sqlite_conn() as c:
                cur = c.execute(
                    f"UPDATE story_jobs SET status='cancelled', "
                    f"finished_at=? "
                    f"WHERE reddit_id IN ({placeholders}) "
                    f"AND status IN ('queued', 'processing')",
                    (now, *batch),
                )
                cancelled += cur.rowcount or 0
    return cancelled


def get_story_job(job_id: str) -> dict | None:
    cols = ", ".join(_STORY_JOB_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {cols} FROM story_jobs WHERE id = %s", (job_id,),
                )
                row = cur.fetchone()
                return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(
            f"SELECT {cols} FROM story_jobs WHERE id = ?", (job_id,)
        ).fetchone()
        return dict(row) if row else None


def latest_story_job_for_reddit(reddit_id: str) -> dict | None:
    """Most-recently-requested job for a reddit_id. The admin row detail uses
    this to surface the last attempt's outcome even after a fresh enqueue."""
    cols = ", ".join(_STORY_JOB_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {cols} FROM story_jobs WHERE reddit_id = %s "
                    "ORDER BY requested_at DESC LIMIT 1",
                    (reddit_id,),
                )
                row = cur.fetchone()
                return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(
            f"SELECT {cols} FROM story_jobs WHERE reddit_id = ? "
            "ORDER BY requested_at DESC LIMIT 1",
            (reddit_id,),
        ).fetchone()
        return dict(row) if row else None


def count_pending_story_jobs() -> int:
    """Queue depth (queued + processing). Powers the admin's "N in flight"
    counter and lets a future Vercel drain shortcut idle ticks."""
    sql = (
        "SELECT count(*) AS n FROM story_jobs "
        "WHERE status IN ('queued', 'processing')"
    )
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql)
                row = cur.fetchone()
        return int(row["n"]) if row else 0
    with _sqlite_conn() as c:
        row = c.execute(sql).fetchone()
        return int(row["n"]) if row else 0


def today_story_job_estimate_cents(estimate_per_job_cents: int) -> int:
    """Project today's story_jobs spend in cents.

    Today's spend = (jobs that finished today UTC) + (currently active jobs)
    all multiplied by the per-job estimate. Active jobs are included
    regardless of when they were requested so a queued-since-yesterday row
    that's about to be picked up still counts toward today's budget — its
    actual cost will land today.

    Half-open range [day_start, next_day_start) so a row stamped at any
    microsecond up to and including 23:59:59.999999 today still counts.
    The old upper bound of `T23:59:59.999999` missed timestamps with a
    timezone suffix (the lex compare `'…999999+00:00' < '…999999'` is
    False because the longer string sorts higher).
    """
    import datetime as _dt
    today_dt = _dt.datetime.now(_dt.timezone.utc).date()
    today_utc = today_dt.isoformat()
    next_day_utc = (today_dt + _dt.timedelta(days=1)).isoformat()
    sql_pg = (
        "SELECT count(*) AS n FROM story_jobs "
        "WHERE (status = 'done' AND finished_at >= %s AND finished_at < %s) "
        "   OR status IN ('queued', 'processing')"
    )
    sql_sqlite = (
        "SELECT count(*) AS n FROM story_jobs "
        "WHERE (status = 'done' AND finished_at >= ? AND finished_at < ?) "
        "   OR status IN ('queued', 'processing')"
    )
    day_start = today_utc + "T00:00:00"
    day_end = next_day_utc + "T00:00:00"
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql_pg, (day_start, day_end))
                row = cur.fetchone()
        n = int(row["n"]) if row else 0
        return n * max(0, int(estimate_per_job_cents))
    with _sqlite_conn() as c:
        row = c.execute(sql_sqlite, (day_start, day_end)).fetchone()
        n = int(row["n"]) if row else 0
        return n * max(0, int(estimate_per_job_cents))


def today_actual_story_cost_cents() -> int:
    """Sum stories.cost_cents for stories created today (UTC).

    Reads what the worker actually billed (kie images + voice + STT +
    LLM) instead of the count-based projection. Returns 0 when no story
    has a populated cost_cents — older rows pre-date the cost-capture
    micro-phase and stay NULL, so this is a soft "today-and-newer-only"
    counter. Used by the admin budget bar to show actual-vs-estimated.

    Half-open [day_start, next_day_start) range — see
    today_story_job_estimate_cents for why the upper bound is the next
    midnight not 23:59:59.999999.
    """
    import datetime as _dt
    today_dt = _dt.datetime.now(_dt.timezone.utc).date()
    day_start = today_dt.isoformat() + "T00:00:00"
    day_end = (today_dt + _dt.timedelta(days=1)).isoformat() + "T00:00:00"
    sql_pg = (
        "SELECT COALESCE(SUM(cost_cents), 0) AS total FROM stories "
        "WHERE created_at >= %s AND created_at < %s "
        "AND cost_cents IS NOT NULL"
    )
    sql_sqlite = (
        "SELECT COALESCE(SUM(cost_cents), 0) AS total FROM stories "
        "WHERE created_at >= ? AND created_at < ? "
        "AND cost_cents IS NOT NULL"
    )
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql_pg, (day_start, day_end))
                row = cur.fetchone()
        return int(row["total"]) if row else 0
    with _sqlite_conn() as c:
        row = c.execute(sql_sqlite, (day_start, day_end)).fetchone()
        return int(row["total"]) if row else 0


def reap_stale_story_jobs(stale_after_s: int) -> int:
    """Crash recovery. A worker that died mid-job leaves the row at
    status='processing' with started_at set. Reset rows whose started_at is
    older than `stale_after_s` back to queued so the next tick re-claims
    them. Safe to call on every tick — the WHERE clause is index-friendly."""
    import datetime
    cutoff = (
        datetime.datetime.now(datetime.timezone.utc)
        - datetime.timedelta(seconds=stale_after_s)
    ).isoformat()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE story_jobs SET status='queued', started_at=NULL "
                    "WHERE status='processing' AND started_at IS NOT NULL "
                    "AND started_at < %s",
                    (cutoff,),
                )
                count = cur.rowcount
            conn.commit()
        return int(count)
    with _sqlite_conn() as c:
        cur = c.execute(
            "UPDATE story_jobs SET status='queued', started_at=NULL "
            "WHERE status='processing' AND started_at IS NOT NULL "
            "AND started_at < ?",
            (cutoff,),
        )
        return int(cur.rowcount)


# ─── voice_renders queue (Phase 4 of voiceover-picker plan) ──────────────────
#
# Same shape semantics as story_jobs / image_renders: atomic claim, partial
# unique index for active-row idempotency, ISO-string timestamps, JSON
# overlays for the editable bits. The fresh-pipeline narration synthesize
# path does NOT go through this queue — it's only for admin-triggered
# regens against a story that already has audio + alignment + a video
# render in flight.

_VOICE_RENDER_COLUMNS = [
    "id", "story_id", "voice_provider", "voice_id", "text_hash",
    "status", "progress", "error", "output_url", "cost_cents",
    "requested_by", "requested_at", "started_at", "finished_at",
]


def enqueue_voice_render(
    render_id: str,
    story_id: str,
    text_hash: str,
    voice_provider: str | None,
    voice_id: str | None,
    requested_by: str | None = None,
) -> dict | None:
    """Insert one queued voice_render. Returns the inserted row, or None
    on race-loss (an active render for the same (story, text, voice)
    combo already exists). The partial unique index on
    (story_id, text_hash, voice_provider, voice_id)
    WHERE status IN ('queued', 'processing') is the DB-level guard.
    """
    cols = ", ".join(_VOICE_RENDER_COLUMNS)
    now = _now_iso()
    row = {
        "id": render_id,
        "story_id": story_id,
        "voice_provider": voice_provider,
        "voice_id": voice_id,
        "text_hash": text_hash,
        "status": "queued",
        "progress": 0,
        "error": None,
        "output_url": None,
        "cost_cents": None,
        "requested_by": requested_by,
        "requested_at": now,
        "started_at": None,
        "finished_at": None,
    }
    if _is_postgres():
        placeholders = ", ".join(f"%({c})s" for c in _VOICE_RENDER_COLUMNS)
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"INSERT INTO voice_renders ({cols}) VALUES ({placeholders}) "
                    f"ON CONFLICT (story_id, text_hash, voice_provider, voice_id) "
                    f"WHERE status IN ('queued', 'processing') DO NOTHING",
                    row,
                )
                if cur.rowcount == 0:
                    return None
            conn.commit()
        return dict(row)
    placeholders = ", ".join(f":{c}" for c in _VOICE_RENDER_COLUMNS)
    with _sqlite_conn() as c:
        cur = c.execute(
            f"INSERT INTO voice_renders ({cols}) VALUES ({placeholders}) "
            f"ON CONFLICT (story_id, text_hash, voice_provider, voice_id) "
            f"WHERE status IN ('queued', 'processing') DO NOTHING",
            row,
        )
        if cur.rowcount == 0:
            return None
    return dict(row)


def claim_next_voice_render() -> dict | None:
    """Atomically claim the oldest queued voice_render, flipping its
    status to 'processing'. Returns the claimed row, or None when the
    queue is empty. Mirrors claim_next_story_job's semantics."""
    cols = ", ".join(_VOICE_RENDER_COLUMNS)
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"UPDATE voice_renders SET status='processing', "
                    "started_at=%s WHERE id = ("
                    "SELECT id FROM voice_renders WHERE status='queued' "
                    "ORDER BY requested_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED"
                    f") RETURNING {cols}",
                    (now,),
                )
                row = cur.fetchone()
            conn.commit()
        return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(
            "SELECT id FROM voice_renders WHERE status='queued' "
            "ORDER BY requested_at ASC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        c.execute(
            "UPDATE voice_renders SET status='processing', started_at=? "
            "WHERE id=? AND status='queued'",
            (now, row["id"]),
        )
        if c.total_changes == 0:
            return None
        claimed = c.execute(
            f"SELECT {cols} FROM voice_renders WHERE id=?", (row["id"],),
        ).fetchone()
        return dict(claimed) if claimed else None


def finish_voice_render(
    render_id: str,
    output_url: str,
    cost_cents: int | None,
) -> None:
    """Mark a voice_render done with the new audio URL + spend snapshot.
    Conditional on status IN ('queued', 'processing') so a settled row
    (done / error / cancelled) isn't overwritten — same contract as
    finish_story_job."""
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE voice_renders SET status='done', progress=100, "
                    "output_url=%s, cost_cents=%s, finished_at=%s "
                    "WHERE id=%s AND status IN ('queued', 'processing')",
                    (output_url, cost_cents, now, render_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE voice_renders SET status='done', progress=100, "
            "output_url=?, cost_cents=?, finished_at=? "
            "WHERE id=? AND status IN ('queued', 'processing')",
            (output_url, cost_cents, now, render_id),
        )


def fail_voice_render(render_id: str, error_message: str) -> None:
    """Mark a voice_render failed. Same status guard as finish_voice_render."""
    now = _now_iso()
    capped = (error_message or "unknown error")[:2000]
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE voice_renders SET status='error', error=%s, "
                    "finished_at=%s WHERE id=%s "
                    "AND status IN ('queued', 'processing')",
                    (capped, now, render_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE voice_renders SET status='error', error=?, "
            "finished_at=? WHERE id=? "
            "AND status IN ('queued', 'processing')",
            (capped, now, render_id),
        )


def get_voice_render(render_id: str) -> dict | None:
    cols = ", ".join(_VOICE_RENDER_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {cols} FROM voice_renders WHERE id = %s",
                    (render_id,),
                )
                row = cur.fetchone()
                return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(
            f"SELECT {cols} FROM voice_renders WHERE id = ?", (render_id,),
        ).fetchone()
        return dict(row) if row else None


def latest_voice_render_for_story(story_id: str) -> dict | None:
    """Most-recently-requested render for this story. The picker UI reads
    this to surface the in-flight state ('Synthesizing...') and the last
    error message when the previous attempt failed."""
    cols = ", ".join(_VOICE_RENDER_COLUMNS)
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {cols} FROM voice_renders WHERE story_id = %s "
                    "ORDER BY requested_at DESC LIMIT 1",
                    (story_id,),
                )
                row = cur.fetchone()
                return dict(row) if row else None
    with _sqlite_conn() as c:
        row = c.execute(
            f"SELECT {cols} FROM voice_renders WHERE story_id = ? "
            "ORDER BY requested_at DESC LIMIT 1",
            (story_id,),
        ).fetchone()
        return dict(row) if row else None


def count_pending_voice_renders() -> int:
    """Queue depth (queued + processing). Powers the drain's idle
    short-circuit so an empty tick bills near-zero on Vercel Active
    CPU. Mirrors count_pending_story_jobs."""
    sql = (
        "SELECT count(*) AS n FROM voice_renders "
        "WHERE status IN ('queued', 'processing')"
    )
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql)
                row = cur.fetchone()
        return int(row["n"]) if row else 0
    with _sqlite_conn() as c:
        row = c.execute(sql).fetchone()
        return int(row["n"]) if row else 0


def update_voice_render_progress(render_id: str, progress: int) -> None:
    """Best-effort progress tick. Conditional on status='processing' so
    a settled row isn't bumped back to a partial value."""
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE voice_renders SET progress = %s WHERE id = %s "
                    "AND status = 'processing'",
                    (int(progress), render_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE voice_renders SET progress = ? WHERE id = ? "
            "AND status = 'processing'",
            (int(progress), render_id),
        )


def reap_stale_voice_renders(stale_after_s: int) -> int:
    """Reset 'processing' rows whose started_at is older than the
    threshold back to 'queued' so a crashed worker doesn't strand
    the queue. Mirrors reap_stale_story_jobs."""
    import datetime as _dt
    cutoff = (
        _dt.datetime.now(_dt.timezone.utc)
        - _dt.timedelta(seconds=stale_after_s)
    ).isoformat()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE voice_renders SET status='queued', started_at=NULL "
                    "WHERE status='processing' AND started_at IS NOT NULL "
                    "AND started_at < %s",
                    (cutoff,),
                )
                count = cur.rowcount
            conn.commit()
        return int(count)
    with _sqlite_conn() as c:
        cur = c.execute(
            "UPDATE voice_renders SET status='queued', started_at=NULL "
            "WHERE status='processing' AND started_at IS NOT NULL "
            "AND started_at < ?",
            (cutoff,),
        )
        return int(cur.rowcount)


def update_story_voice_render_output(
    story_id: str,
    audio_url: str,
    alignment_json: str,
    video_config_json: str,
) -> None:
    """Atomic three-column update the voice worker fires when a regen
    finishes. We touch audio_url + alignment + video_config in one
    UPDATE so a worker crash mid-write can't leave the row half-stale
    (e.g. new audio but old captions in video_config — which would
    paint the wrong words during playback)."""
    now = _now_iso()
    if _is_postgres():
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE stories SET audio_url = %s, alignment = %s, "
                    "video_config = %s, updated_at = %s WHERE id = %s",
                    (audio_url, alignment_json, video_config_json, now, story_id),
                )
            conn.commit()
        return
    with _sqlite_conn() as c:
        c.execute(
            "UPDATE stories SET audio_url = ?, alignment = ?, "
            "video_config = ?, updated_at = ? WHERE id = ?",
            (audio_url, alignment_json, video_config_json, now, story_id),
        )
