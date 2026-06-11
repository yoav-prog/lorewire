// Canonical LoreWire data schema.
//
// The Next app and the Python pipeline share one store: SQLite locally (zero
// setup, written by both the pipeline and the admin) and Postgres in production
// via DATABASE_URL. This shape is mirrored in pipeline/store.py. Types stay
// portable across both engines: TEXT ids and slugs, ISO-8601 timestamps as
// TEXT, booleans as INTEGER 0/1, and JSON blobs as TEXT.

export type ColType = "TEXT" | "INTEGER";

export interface Column {
  name: string;
  type: ColType;
  pk?: boolean;
}

export interface Table {
  name: string;
  columns: Column[];
}

export const STORIES: Table = {
  name: "stories",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "reddit_id", type: "TEXT" },
    { name: "slug", type: "TEXT" },
    { name: "category", type: "TEXT" },
    { name: "title", type: "TEXT" },
    { name: "summary", type: "TEXT" },
    { name: "body", type: "TEXT" },
    { name: "teleprompter", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "source_url", type: "TEXT" },
    { name: "hero_image", type: "TEXT" },
    { name: "images", type: "TEXT" },
    { name: "audio_url", type: "TEXT" },
    { name: "video_url", type: "TEXT" },
    { name: "duration", type: "TEXT" },
    { name: "alignment", type: "TEXT" },
    // Per-story intro/outro override (Wave 3 Phase 4). NULL/0 = inherit the
    // global active pick. Resolution chain: skip flag -> story-pinned id ->
    // settings.video.active_<kind>_id.
    { name: "intro_segment_id", type: "TEXT" },
    { name: "outro_segment_id", type: "TEXT" },
    { name: "skip_intro", type: "INTEGER" },
    { name: "skip_outro", type: "INTEGER" },
    // 2026-06-11 video editor: serialised ShortVideoConfig v2 (see
    // lib/video-config.ts). The pipeline writes it on every render; the
    // /admin/videos/[id] editor patches it. Mirrors stories.video_config
    // in pipeline/store.py.
    { name: "video_config", type: "TEXT" },
    { name: "tokens", type: "INTEGER" },
    { name: "cost_cents", type: "INTEGER" },
    { name: "created_at", type: "TEXT" },
    { name: "updated_at", type: "TEXT" },
    { name: "published_at", type: "TEXT" },
    { name: "payload", type: "TEXT" },
  ],
};

export const SETTINGS: Table = {
  name: "settings",
  columns: [
    { name: "key", type: "TEXT", pk: true },
    { name: "value", type: "TEXT" },
  ],
};

export const USERS: Table = {
  name: "users",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "email", type: "TEXT" },
    { name: "password_hash", type: "TEXT" },
    { name: "role", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
  ],
};

// Wave 3 Phase 4 intro/outro library. Each row is one normalized clip in GCS;
// the pipeline picks the active intro + outro per render and splices via
// ffmpeg. Mirrors `video_segments` in pipeline/store.py.
//
// Status lifecycle (2026-06-11 upload-fix): pending -> uploading -> normalizing
// -> ready, with `error` set on any failure. The admin signs a GCS resumable
// upload session, the browser PUTs source bytes direct to GCS (bypassing
// Vercel's 4.5 MB body cap), and pipeline/segments_worker.py picks pending
// rows up to run ffmpeg normalize off-Vercel.
export const VIDEO_SEGMENTS: Table = {
  name: "video_segments",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "kind", type: "TEXT" },
    { name: "label", type: "TEXT" },
    { name: "source_url", type: "TEXT" },
    { name: "normalized_url", type: "TEXT" },
    { name: "duration_ms", type: "INTEGER" },
    { name: "enabled", type: "INTEGER" },
    { name: "status", type: "TEXT" },
    { name: "error", type: "TEXT" },
    { name: "uploaded_at", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
    { name: "updated_at", type: "TEXT" },
  ],
};

// Articles CMS (separate from STORIES — the Reddit/video pipeline). One row
// per article. Body lives in `document` as Tiptap JSON; type-specific fields
// (dateline for news, items[] for listicle, rating for review, etc.) live in
// `payload` as JSON validated by per-type Zod schemas at the repo boundary.
// `language` is "he" or "en"; slug uniqueness is enforced per-language at the
// query layer. `source_sheet_row_id` is reserved for Phase 3 Sheets import
// idempotency; null for hand-authored articles.
export const ARTICLES: Table = {
  name: "articles",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "type", type: "TEXT" },
    { name: "language", type: "TEXT" },
    { name: "slug", type: "TEXT" },
    { name: "title", type: "TEXT" },
    { name: "subtitle", type: "TEXT" },
    { name: "summary", type: "TEXT" },
    { name: "document", type: "TEXT" },
    { name: "hero_image", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "author_id", type: "TEXT" },
    { name: "meta_title", type: "TEXT" },
    { name: "meta_description", type: "TEXT" },
    { name: "og_image", type: "TEXT" },
    { name: "payload", type: "TEXT" },
    { name: "source_sheet_row_id", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
    { name: "updated_at", type: "TEXT" },
    { name: "published_at", type: "TEXT" },
  ],
};

// Append-only history of article snapshots. `appendRevision` coalesces writes
// inside a configurable window so autosave does not explode the table: if the
// most recent revision for this article is unnamed and younger than the
// window, the same row is updated in place; otherwise a new row is inserted.
// Named revisions (is_named=1) survive retention pruning.
export const ARTICLE_REVISIONS: Table = {
  name: "article_revisions",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "article_id", type: "TEXT" },
    { name: "document", type: "TEXT" },
    { name: "payload", type: "TEXT" },
    { name: "title", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "name", type: "TEXT" },
    { name: "is_named", type: "INTEGER" },
    { name: "author_id", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
  ],
};

// 2026-06-11 video editor render queue. The admin Render button inserts a
// row here; pipeline/render_worker.py polls for status='queued' and runs
// generate_video. Idempotency on (story_id, config_hash) so N clicks at
// the same edit state coalesce. Mirrors `video_renders` in
// pipeline/store.py.
export const VIDEO_RENDERS: Table = {
  name: "video_renders",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "story_id", type: "TEXT" },
    { name: "config_hash", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "progress", type: "INTEGER" },
    { name: "error", type: "TEXT" },
    { name: "output_url", type: "TEXT" },
    { name: "requested_by", type: "TEXT" },
    { name: "requested_at", type: "TEXT" },
    { name: "started_at", type: "TEXT" },
    { name: "finished_at", type: "TEXT" },
  ],
};

export const TABLES: Table[] = [
  STORIES,
  SETTINGS,
  USERS,
  VIDEO_SEGMENTS,
  VIDEO_RENDERS,
  ARTICLES,
  ARTICLE_REVISIONS,
];

// CREATE TABLE that parses identically on SQLite and Postgres.
export function createTableSql(t: Table): string {
  const defs = t.columns.map(
    (c) => `${c.name} ${c.type}${c.pk ? " PRIMARY KEY" : ""}`,
  );
  return `CREATE TABLE IF NOT EXISTS ${t.name} (${defs.join(", ")})`;
}
