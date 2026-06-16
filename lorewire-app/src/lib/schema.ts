// Canonical LoreWire data schema.
//
// The Next app and the Python pipeline share one store: SQLite locally (zero
// setup, written by both the pipeline and the admin) and Postgres in production
// via DATABASE_URL. This shape is mirrored in pipeline/store.py. Types stay
// portable across both engines: TEXT ids and slugs, ISO-8601 timestamps as
// TEXT, booleans as INTEGER 0/1, and JSON blobs as TEXT.

export type ColType = "TEXT" | "INTEGER" | "REAL";

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
    // 2026-06-16 short editor: serialised ShortConfig v1 (see
    // lib/short-config.ts). Parallel to video_config but for the 9:16
    // article-shorts pipeline. Phase 1 of
    // _plans/2026-06-16-short-editor-full-parity.md. The Generate Short
    // action seeds this from a successful short_renders.props; the editor
    // at /admin/(panel)/shorts/[id] patches it through
    // saveShortConfigPatch. Mirrors stories.short_config in store.py.
    { name: "short_config", type: "TEXT" },
    { name: "tokens", type: "INTEGER" },
    { name: "cost_cents", type: "INTEGER" },
    { name: "created_at", type: "TEXT" },
    { name: "updated_at", type: "TEXT" },
    { name: "published_at", type: "TEXT" },
    { name: "payload", type: "TEXT" },
    // Per-row "hide from search engines" flag. Mirrors the noindex column
    // on articles. Stories don't have a public permalink yet so this is
    // data-only today; the per-story public reader, when it lands, must
    // honor it the same way the article reader does.
    { name: "noindex", type: "INTEGER" },
    // Asset-rerender visibility columns. Originally added by the Python
    // pipeline (see pipeline/store.py); mirrored here so the TS schema +
    // StoryRow type expose them for the admin UI's granular regen grid.
    // JSON in props ({url,label,side}[]); flat URLs in the two
    // character_image columns.
    { name: "props", type: "TEXT" },
    { name: "character_image", type: "TEXT" },
    { name: "character_image_mouth_removed", type: "TEXT" },
    // 2026-06-14: pipeline-owned cache that previously lived inside
    // video_config. The editor's parseVideoConfig strictly drops
    // unknown top-level fields, so the heartbeat write path was
    // silently wiping `world_bible`, `scene_prompts`,
    // `scene_prompts_built_with`, `scene_entity_ids`, `character_bible`
    // every time it fired — burning the world-bible rebuild cost on
    // every queued scene. Moving these into their own column keeps the
    // editor and the pipeline from co-tenanting the same JSON blob.
    // The TS side never reads this column; it exists here so
    // ensureSchema's additive ALTER picks it up on prod boot.
    { name: "pipeline_cache", type: "TEXT" },
    // 2026-06-14 voiceover picker per-story override (Phase 1 of
    // _plans/2026-06-14-voiceover-picker.md). Both nullable; NULL = use
    // the global `voice.elevenlabs_voice_id` / `voice.google_voice_name`
    // setting. `voice_provider` mirrors models.get_selected("voice")
    // shape (e.g. "elevenlabs", "google/chirp3-hd", "google/gemini-25-flash-tts");
    // `voice_id` is the provider-native id (ElevenLabs voice_id GUID OR
    // the full Google voice name like "en-US-Chirp3-HD-Aoede"). The
    // server-side resolution chain lives in pipeline/voice.py:synthesize.
    { name: "voice_provider", type: "TEXT" },
    { name: "voice_id", type: "TEXT" },
  ],
};

// Phase 4 of _plans/2026-06-14-voiceover-picker.md. Per-attempt queue
// for voice regen. Mirrors STORY_JOBS shape so the Vercel drain
// pattern (Phase 4.b) can compose with run_one_tick the same way the
// story_jobs drain does. text_hash + voice columns gate idempotency
// via the partial unique index in pipeline/store.py.
export const VOICE_RENDERS: Table = {
  name: "voice_renders",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "story_id", type: "TEXT" },
    { name: "voice_provider", type: "TEXT" },
    { name: "voice_id", type: "TEXT" },
    { name: "text_hash", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "progress", type: "INTEGER" },
    { name: "error", type: "TEXT" },
    { name: "output_url", type: "TEXT" },
    { name: "cost_cents", type: "INTEGER" },
    { name: "requested_by", type: "TEXT" },
    { name: "requested_at", type: "TEXT" },
    { name: "started_at", type: "TEXT" },
    { name: "finished_at", type: "TEXT" },
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
    // Phase 3 of _plans/2026-06-12-video-aspect-ratio.md. NULL on rows
    // that predate the column — the Python pipeline-side ALTER TABLE
    // includes a DEFAULT '9:16' but the TS-side `ensureSchema` does
    // not, so the resolver treats NULL as the legacy 9:16 default at
    // both the picker and the normaliser.
    { name: "aspect", type: "TEXT" },
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
// idempotency; null for hand-authored articles. `story_id` is the optional
// link to the Reddit-pipeline story whose short_render the article borrows
// scene images from (hero/og/gallery promotion in the article editor); no FK
// constraint, set explicitly by the admin via the LinkedStoryWidget.
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
    { name: "story_id", type: "TEXT" },
    { name: "payload", type: "TEXT" },
    { name: "source_sheet_row_id", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
    { name: "updated_at", type: "TEXT" },
    { name: "published_at", type: "TEXT" },
    // Per-row "hide from search engines" flag (2026-06-12 SEO work). 0 or
    // NULL = indexable; 1 = the public reader emits noindex,nofollow on the
    // page and a Disallow could be added to robots.txt in a follow-up.
    { name: "noindex", type: "INTEGER" },
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

// 2026-06-12 asset re-render. Mirrors VIDEO_RENDERS in shape — one queue
// per asset regen request, polled by pipeline/image_render_worker.py.
// `owner_kind` is "story" or "article"; `owner_id` is the row id; `asset`
// is a slug like "hero" / "scene:0" / "scene:12" / "prop:3" / "mouth_swap"
// for stories and "hero" / "og" / "body:<node-id>" / "gallery:<n>" for
// articles. `prompt_hash` is a SHA-256 of the LLM-generated prompt used,
// so requesting the same regen twice with no edits between can be
// idempotent if we ever want it. `cost_cents` records the actual spend
// once the worker finishes — admin UI sums it against budget.daily_usd.
export const IMAGE_RENDERS: Table = {
  name: "image_renders",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "owner_kind", type: "TEXT" },
    { name: "owner_id", type: "TEXT" },
    { name: "asset", type: "TEXT" },
    { name: "prompt_hash", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "progress", type: "INTEGER" },
    { name: "error", type: "TEXT" },
    { name: "output_url", type: "TEXT" },
    { name: "cost_cents", type: "INTEGER" },
    { name: "requested_by", type: "TEXT" },
    { name: "requested_at", type: "TEXT" },
    { name: "started_at", type: "TEXT" },
    { name: "finished_at", type: "TEXT" },
  ],
};

// 2026-06-13 Phase 2 of
// _plans/2026-06-13-worker-host-stop-button-observability.md.
// One row per checkpoint in a regen — claim, prompt_built,
// kie_request_sent, kie_response_received, image_saved, done, error,
// etc. The admin UI polls these to show a live progress timeline
// under each image_renders row so "Generating · Xm ago" stops being
// the only signal. Python-side writer is `store.log_render_event`;
// reader on the TS side is `listRenderEvents` in image-render-queue.ts.
export const IMAGE_RENDER_EVENTS: Table = {
  name: "image_render_events",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "render_id", type: "TEXT" },
    { name: "ts", type: "TEXT" },
    { name: "level", type: "TEXT" },
    { name: "event", type: "TEXT" },
    { name: "message", type: "TEXT" },
    { name: "payload", type: "TEXT" },
  ],
};

// 2026-06-14 video-render observability. Mirrors IMAGE_RENDER_EVENTS for
// the video_renders queue. One row per checkpoint along the render
// lifecycle (enqueue → reset_from_error → claim → dispatch → cloud_run
// response → finish | fail). The editor's RenderControl polls these via
// `listVideoRenderEvents` and renders an inline timeline under the
// Render button so the admin sees exactly which step is in flight or
// where it stalled. Writers live on both sides of the orchestrator:
// `queueRender` (server action) for the click event, and
// `/api/render_video` for every cron-tick phase.
export const VIDEO_RENDER_EVENTS: Table = {
  name: "video_render_events",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "render_id", type: "TEXT" },
    { name: "ts", type: "TEXT" },
    { name: "level", type: "TEXT" },
    { name: "event", type: "TEXT" },
    { name: "message", type: "TEXT" },
    { name: "payload", type: "TEXT" },
  ],
};

// 2026-06-14 Reddit DB sync (see _plans/2026-06-14-reddit-db-sync.md).
// Candidate pool of Reddit posts imported from a CSV in the admin. PK is the
// Reddit post id — the same identifier stories.reddit_id carries — so the
// pipeline can promote a row by reddit_id without rewriting upstream code.
// `status` lifecycle: imported -> queued -> processing -> used; or
// imported -> skipped if the admin rejects. The sync only ever refreshes
// content fields; admin-managed columns (status, story_id, notes) are
// preserved across syncs. Mirrors `reddit_source` in pipeline/store.py.
export const REDDIT_SOURCE: Table = {
  name: "reddit_source",
  columns: [
    { name: "reddit_id", type: "TEXT", pk: true },
    { name: "subreddit", type: "TEXT" },
    { name: "date_written", type: "TEXT" },
    { name: "title", type: "TEXT" },
    { name: "full_text", type: "TEXT" },
    { name: "comments", type: "INTEGER" },
    { name: "url", type: "TEXT" },
    { name: "summary", type: "TEXT" },
    { name: "length_chars", type: "INTEGER" },
    { name: "status", type: "TEXT" },
    { name: "story_id", type: "TEXT" },
    { name: "notes", type: "TEXT" },
    { name: "first_synced", type: "TEXT" },
    { name: "last_synced", type: "TEXT" },
  ],
};

// 2026-06-14 Phase 3 of _plans/2026-06-14-reddit-db-sync.md. Per-attempt
// queue for "Process N selected" bulk action in /admin/reddit-sources.
// pipeline/story_jobs_worker.py polls for status='queued', claims, runs
// the existing stages, and writes a `stories` row. Mirrors `story_jobs`
// in pipeline/store.py.
export const STORY_JOBS: Table = {
  name: "story_jobs",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "reddit_id", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "progress", type: "INTEGER" },
    { name: "error", type: "TEXT" },
    { name: "story_id", type: "TEXT" },
    { name: "with_media", type: "INTEGER" },
    { name: "requested_by", type: "TEXT" },
    { name: "requested_at", type: "TEXT" },
    { name: "started_at", type: "TEXT" },
    { name: "finished_at", type: "TEXT" },
    // 2026-06-16 per-batch output override for Reddit imports. NULL =
    // resolve at worker claim time against `reddit.default_output`
    // (default 'short'); 'short' / 'long' pin the row's output format.
    // See _plans/2026-06-16-reddit-default-to-shorts.md.
    { name: "output_format", type: "TEXT" },
  ],
};

// 2026-06-15 article shorts render queue. Mirrors VIDEO_RENDERS; a separate
// path for the 40-60s doodle shorts so nothing existing breaks. narration_style
// + length_preset are the creation options; `phase` tracks the multi-step
// generation (script/plan/base/scene/render). The UNIQUE (story_id, config_hash)
// constraint + indexes live in pipeline/store.py (the schema authority).
export const SHORT_RENDERS: Table = {
  name: "short_renders",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "story_id", type: "TEXT" },
    { name: "config_hash", type: "TEXT" },
    { name: "narration_style", type: "TEXT" },
    { name: "length_preset", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "phase", type: "TEXT" },
    // REAL to match pipeline/store.py (progress is a 0..1 fraction). If this were
    // INTEGER and the TS app created the table first, Postgres would round 0.5 to
    // 0 and the progress bar would sit at the floor until done.
    { name: "progress", type: "REAL" },
    { name: "error", type: "TEXT" },
    { name: "output_url", type: "TEXT" },
    // The generated DoodleShort props JSON (set by the generation drain); the
    // render cron claims rows where this is set and POSTs it to Cloud Run.
    { name: "props", type: "TEXT" },
    { name: "requested_by", type: "TEXT" },
    { name: "requested_at", type: "TEXT" },
    { name: "started_at", type: "TEXT" },
    { name: "finished_at", type: "TEXT" },
    // How many times the Python reaper has revived a stalled row. The reaper
    // gives up (status -> 'error') past MAX_SHORT_RENDER_ATTEMPTS so a
    // perpetually-failing render can't loop paid retries. createTableSql emits
    // no DEFAULT, so a TS-created column starts NULL; the reaper reads it with
    // COALESCE(attempts, 0). Mirrors pipeline/store.py.
    { name: "attempts", type: "INTEGER" },
    // 2026-06-16 short editor Phase 3: partial-re-render lane marker.
    // NULL = full generation (the default), 'A' = assembly-only (props
    // baked by the action, render drain picks up directly), 'B' = voice
    // + assembly (generation drain picks up via lane_inputs and rewrites
    // props). The render-drain claim filter is unchanged (props IS NOT
    // NULL); Lane B rows transition lane: 'B' -> NULL once their props
    // are built so the render drain only ever sees finished work. Plan:
    // _plans/2026-06-16-short-editor-full-parity.md.
    { name: "lane", type: "TEXT" },
    // Lane B initialization payload (JSON): {script, voice,
    // source_render_id}. Populated by the renderShortLaneB action;
    // consumed by build_short_props_lane_b in the generation drain.
    // NULL on every other lane.
    { name: "lane_inputs", type: "TEXT" },
  ],
};

// 2026-06-15 article shorts observability. Same shape + purpose as
// VIDEO_RENDER_EVENTS — one row per phase transition (script_built,
// scene_generated, voice_synth_done, render_started, render_done,
// cancelled, failed). The TS UI reads via listShortRenderEvents and
// renders a timelapse-style log under the ShortRenderControl progress
// bar. Writers live on both sides: TS server actions (queued, cancelled,
// idempotent_hit) and the Python worker + Cloud Run callback for every
// generation + render phase. Plan:
// _plans/2026-06-15-short-render-events-and-cancel.md.
export const SHORT_RENDER_EVENTS: Table = {
  name: "short_render_events",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "render_id", type: "TEXT" },
    { name: "ts", type: "TEXT" },
    { name: "level", type: "TEXT" },
    { name: "event", type: "TEXT" },
    { name: "message", type: "TEXT" },
    { name: "payload", type: "TEXT" },
  ],
};

// 2026-06-16 homepage curation. One row per slot on the public homepage —
// `surface` names the rail ('hero', 'top10', 'continue', '<category>_row',
// 'new_row'), `position` is 0-based ordering within the surface, `story_id`
// points at stories.id. The (surface, position) pair is unique so two
// stories can't claim the same slot. Public read filters out unpublished
// or noindex stories silently; admin read keeps them so the editor can
// see and prune broken refs. Plan: _plans/2026-06-16-homepage-curation.md.
export const HOMEPAGE_CURATION: Table = {
  name: "homepage_curation",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "surface", type: "TEXT" },
    { name: "position", type: "INTEGER" },
    { name: "story_id", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
    { name: "updated_at", type: "TEXT" },
  ],
};

export const TABLES: Table[] = [
  STORIES,
  SETTINGS,
  USERS,
  VIDEO_SEGMENTS,
  VIDEO_RENDERS,
  VIDEO_RENDER_EVENTS,
  SHORT_RENDERS,
  SHORT_RENDER_EVENTS,
  IMAGE_RENDERS,
  IMAGE_RENDER_EVENTS,
  ARTICLES,
  ARTICLE_REVISIONS,
  REDDIT_SOURCE,
  STORY_JOBS,
  VOICE_RENDERS,
  HOMEPAGE_CURATION,
];

// CREATE TABLE that parses identically on SQLite and Postgres.
export function createTableSql(t: Table): string {
  const defs = t.columns.map(
    (c) => `${c.name} ${c.type}${c.pk ? " PRIMARY KEY" : ""}`,
  );
  return `CREATE TABLE IF NOT EXISTS ${t.name} (${defs.join(", ")})`;
}

// Post-table DDL: indexes that the TS layer enforces because they're
// load-bearing for write paths in this codebase (not just performance
// hints — the ON CONFLICT clauses in src/lib/story-jobs.ts and
// src/lib/voice-render-queue.ts depend on their partial unique indexes
// being present). The Python migration in pipeline/store.py mirrors these
// statements; this list is the TS source of truth for the indexes
// ensureSchema must create after the per-table loop. Performance-only indexes (the bunch on reddit_source / story_jobs
// that just speed up filter queries) are owned by Python and are not
// mirrored here — adding them is a separate, larger refactor.
export const POST_TABLE_DDL: string[] = [
  // 2026-06-14 Phase 5: at most one queued or processing story_job per
  // reddit_id. The bulk-enqueue path's ON CONFLICT (reddit_id) WHERE …
  // clause requires this partial unique index to exist; without it, the
  // INSERT throws because there's no matching constraint. Identical
  // syntax on SQLite >= 3.8 and Postgres >= 9.5.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_story_jobs_one_active " +
    "ON story_jobs(reddit_id) WHERE status IN ('queued', 'processing')",
  // 2026-06-14 video-render observability. Same shape + purpose as the
  // image-render index — every read on the timeline picker filters by
  // render_id and orders by ts, and we expect ~10-30 events per render
  // so the lookup is hot-pathed.
  "CREATE INDEX IF NOT EXISTS idx_video_render_events_render_id " +
    "ON video_render_events(render_id, ts)",
  // 2026-06-15: at most one active voice_render per (story, text, voice).
  // lib/voice-render-queue.ts:enqueueVoiceRender does an INSERT ... ON
  // CONFLICT (story_id, text_hash, voice_provider, voice_id) WHERE status IN
  // (...), which on Postgres REQUIRES this exact partial unique index to
  // exist or the insert throws "no unique or exclusion constraint matching
  // the ON CONFLICT specification" — which 500'd the Regenerate voiceover
  // action in prod. It previously lived ONLY in pipeline/store.py, so prod
  // (where the TS app creates the table but the Python init had not created
  // the index) crashed on click. Mirrors pipeline/store.py exactly.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_renders_one_active " +
    "ON voice_renders(story_id, text_hash, voice_provider, voice_id) " +
    "WHERE status IN ('queued', 'processing')",
  // 2026-06-15 article shorts: pipeline/store.py enqueue_short_render does
  // INSERT ... ON CONFLICT (story_id, config_hash). createTableSql emits no
  // UNIQUE, so when the TS app creates short_renders first on a fresh prod DB
  // the constraint is missing and every enqueue 500s ("no unique or exclusion
  // constraint matching the ON CONFLICT specification"). Mirrors store.py.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_short_renders_story_config " +
    "ON short_renders(story_id, config_hash)",
  // 2026-06-15 short-render observability. Mirrors idx_video_render_events_render_id
  // — every read from the ShortRenderEventTimeline filters by render_id + orders by
  // ts, and we expect ~15-25 events per short so the lookup is hot-pathed.
  "CREATE INDEX IF NOT EXISTS idx_short_render_events_render_id " +
    "ON short_render_events(render_id, ts)",
  // 2026-06-16 homepage curation. (surface, position) uniqueness is the
  // load-bearing invariant — two stories can't share a slot, and add/remove/
  // move operations depend on packed positions. Surface filter is also the
  // hot read path (one query per rail) so the leading column matches.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_homepage_curation_surface_position " +
    "ON homepage_curation(surface, position)",
];
