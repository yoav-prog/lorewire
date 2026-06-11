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
    { name: "created_at", type: "TEXT" },
    { name: "updated_at", type: "TEXT" },
  ],
};

export const TABLES: Table[] = [STORIES, SETTINGS, USERS, VIDEO_SEGMENTS];

// CREATE TABLE that parses identically on SQLite and Postgres.
export function createTableSql(t: Table): string {
  const defs = t.columns.map(
    (c) => `${c.name} ${c.type}${c.pk ? " PRIMARY KEY" : ""}`,
  );
  return `CREATE TABLE IF NOT EXISTS ${t.name} (${defs.join(", ")})`;
}
