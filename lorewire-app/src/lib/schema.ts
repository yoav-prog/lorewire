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

// Named voiceover presets the admin manages (model + voice + style prompt +
// pace + hook pause). Mirrors `voiceovers` in pipeline/store.py. The shorts
// pipeline resolves one per category -> global default -> code fallback (see
// pipeline/voiceovers.py). speaking_rate is a no-op on the Gemini path.
export const VOICEOVERS: Table = {
  name: "voiceovers",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "name", type: "TEXT" },
    { name: "provider", type: "TEXT" },
    { name: "voice_id", type: "TEXT" },
    { name: "style_prompt", type: "TEXT" },
    { name: "speaking_rate", type: "REAL" },
    { name: "hook_pause", type: "INTEGER" },
    { name: "created_at", type: "TEXT" },
    { name: "updated_at", type: "TEXT" },
  ],
};

export const SETTINGS: Table = {
  name: "settings",
  columns: [
    { name: "key", type: "TEXT", pk: true },
    { name: "value", type: "TEXT" },
  ],
};

// `users` predates the public-side auth work — its original purpose was admin
// staff with email + password_hash + role. The 2026-06-19 anonymous-first plan
// adds public-side rows (role='user') created via OAuth, so the additive
// columns below cover both worlds:
//   - admin staff rows keep password_hash, leave provider/provider_sub NULL.
//   - OAuth user rows leave password_hash NULL, fill provider + provider_sub.
// `anonymous_id` is the prior `lw_anon` cookie value at first sign-in, the
// stitch between the anonymous browser and the registered identity. It's only
// set on creation; later sign-ins on other devices don't overwrite it. NULL
// for admin rows and for users who registered without prior anonymous use.
// Plan: _plans/2026-06-19-anonymous-first-auth.md.
export const USERS: Table = {
  name: "users",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "email", type: "TEXT" },
    { name: "password_hash", type: "TEXT" },
    { name: "role", type: "TEXT" },
    { name: "name", type: "TEXT" },
    { name: "picture_url", type: "TEXT" },
    { name: "provider", type: "TEXT" },
    { name: "provider_sub", type: "TEXT" },
    { name: "anonymous_id", type: "TEXT" },
    { name: "last_seen_at", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
    // 2026-06-22 admin user-management Phase 3. Account status for moderation.
    // NULL or 'active' = normal; 'suspended' = sign-in/participation blocked
    // (reversible). The per-request DB re-read in requireAdmin/currentUser/
    // readActiveUserSession is what makes a status change take effect on the
    // next request despite the 7-day JWT. Plan:
    // _plans/2026-06-22-admin-user-management.md (Phase 3).
    { name: "status", type: "TEXT" },
    { name: "suspended_at", type: "TEXT" },
    { name: "suspended_reason", type: "TEXT" },
    // 2026-06-22 Phase 8 staff 2FA (opt-in, default off). totp_secret is base32,
    // set at enrollment and only enforced once mfa_enabled=1.
    // totp_backup_codes is a JSON array of hashed single-use recovery codes.
    { name: "totp_secret", type: "TEXT" },
    { name: "mfa_enabled", type: "INTEGER" },
    { name: "totp_backup_codes", type: "TEXT" },
  ],
};

// Public-user state: My List. One row per (user_id, story_id), enforced by
// the unique index in POST_TABLE_DDL. `id` is a generated UUID so the row has
// a stable handle for deletes; the upsert path targets (user_id, story_id).
// Plan: _plans/2026-06-19-anonymous-first-auth.md §Storage layout.
export const USER_SAVES: Table = {
  name: "user_saves",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "user_id", type: "TEXT" },
    { name: "story_id", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
  ],
};

// Public-user state: Likes. Parallel to USER_SAVES; wires feed Like button.
export const USER_LIKES: Table = {
  name: "user_likes",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "user_id", type: "TEXT" },
    { name: "story_id", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
  ],
};

// Public-user state: Favorite categories. `category` is one of the six closed
// enum strings from src/app/admin/ui.ts (Drama, Entitled, Humor, Wholesome,
// Dating, Roommate). Stored as text (not FK) because the enum is a code-level
// type, not a row in a categories table — see plan §Resolved.
export const USER_FAV_CATEGORIES: Table = {
  name: "user_fav_categories",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "user_id", type: "TEXT" },
    { name: "category", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
  ],
};

// Public-user state: Recently viewed. Capped server-side via a periodic prune
// (the most recent 50 per user) — the index on (user_id, viewed_at DESC)
// makes the prune cheap. `id` is generated per visit so the same story can
// appear multiple times if revisited (read path collapses by story_id).
export const USER_RECENTLY_VIEWED: Table = {
  name: "user_recently_viewed",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "user_id", type: "TEXT" },
    { name: "story_id", type: "TEXT" },
    { name: "viewed_at", type: "TEXT" },
  ],
};

// 2026-06-19 Phase 3 magic-link auth. One row per outstanding token. The
// raw token is sent in the email and NEVER stored — we store only its
// SHA-256 hash. Verify-by-lookup hashes the incoming token and matches
// against token_hash. `used_at` is null until first verify; the verify
// path enforces single-use by checking used_at IS NULL before accepting
// the token. `email` is stored normalized (lowercased + trimmed) so the
// users-table upsert sees the same key. Expired rows are pruned by a
// future periodic cron; the verify path also rejects on expires_at <
// now, so an unpruned row is harmless. Plan:
// _plans/2026-06-19-anonymous-first-auth.md.
export const MAGIC_LINK_TOKENS: Table = {
  name: "magic_link_tokens",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "email", type: "TEXT" },
    { name: "token_hash", type: "TEXT" },
    { name: "expires_at", type: "TEXT" },
    { name: "used_at", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
  ],
};

// Public-user state: Continue Watching / Reading. One row per (user_id,
// story_id); a re-watch UPDATEs the existing row. `position_ms` for video,
// `position_pct` (0-100) for article scroll progress — non-null exactly one
// of the two depending on the surface. The unique index on (user_id,
// story_id) is what the upsert path targets.
export const USER_CONTINUE: Table = {
  name: "user_continue",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "user_id", type: "TEXT" },
    { name: "story_id", type: "TEXT" },
    { name: "position_ms", type: "INTEGER" },
    { name: "position_pct", type: "INTEGER" },
    { name: "updated_at", type: "TEXT" },
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

// 2026-06-16 story_jobs per-row event timeline. Direct mirror of
// SHORT_RENDER_EVENTS for the story_jobs queue: one row per phase the
// worker enters (claimed, idea_done, research_done, article_done,
// title_done, media_done, video_render_enqueued, forced_short,
// auto_short_enqueued, finished, failed). The reddit-source detail page
// reads via listStoryJobEvents and renders a live timeline so the admin
// can see what's happening to a row without tailing the worker
// terminal. Plan: _plans/2026-06-16-story-job-event-timeline.md.
//
// Carries `reddit_id` denormalised so the per-row detail page can look
// events up by the URL parameter it has on hand (the page route is
// /admin/reddit-sources/[reddit_id]) without joining through story_jobs.
export const STORY_JOB_EVENTS: Table = {
  name: "story_job_events",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "job_id", type: "TEXT" },
    { name: "reddit_id", type: "TEXT" },
    { name: "ts", type: "TEXT" },
    { name: "level", type: "TEXT" },
    { name: "event", type: "TEXT" },
    { name: "message", type: "TEXT" },
    { name: "payload", type: "TEXT" },
  ],
};

// 2026-06-18 engagement polls. One row per story OR article that has
// a poll. `enabled = 0` hides the poll everywhere (admin can park a
// draft without deleting it). `category` is denormalised from
// stories.category (or article-type for article polls) so the rail
// queries ("Most Divisive", etc) filter without a join.
//
// Standalone-article polls (2026-06-18, plan §15): polls can attach
// EITHER to a story (story_id non-null, article_id null) OR an
// article (article_id non-null, story_id null) — never both, never
// neither. The partial unique indexes in POST_TABLE_DDL enforce one
// poll per subject. Story polls go through the existing aggregate
// projection + rail surfaces; article polls compute counts live from
// poll_votes (low expected volume, no projection table needed).
//
// Plan: _plans/2026-06-17-engagement-polls.md.
export const POLLS: Table = {
  name: "polls",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "story_id", type: "TEXT" },
    { name: "article_id", type: "TEXT" },
    { name: "question", type: "TEXT" },
    { name: "option_a_text", type: "TEXT" },
    { name: "option_b_text", type: "TEXT" },
    { name: "enabled", type: "INTEGER" },
    { name: "category", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
    { name: "updated_at", type: "TEXT" },
  ],
};

// 2026-06-18 engagement polls vote log. Append-only, anonymous. One row
// per (poll, cookie_token); the partial unique index in POST_TABLE_DDL
// is what makes the same browser re-voting a no-op rather than a
// duplicate. `cookie_token` is a 256-bit random nonce set
// HttpOnly+Secure+SameSite=Lax — the anti-double-vote primitive. `side`
// is closed enum 'A' | 'B'. `ip_ua_hash` is SHA-256 of (ip || '\n' ||
// user_agent) used ONLY for the rate-limit bucket; the daily aggregate
// refresh cron nulls it on rows older than 24h so it never becomes a
// durable fingerprint. `story_id` and `category` are denormalised so the
// rail queries don't join through polls -> stories.
export const POLL_VOTES: Table = {
  name: "poll_votes",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "poll_id", type: "TEXT" },
    { name: "story_id", type: "TEXT" },
    // 2026-06-18 standalone-article polls. Denormalised for
    // article-poll analytics the same way story_id is for rails.
    // Mutually exclusive with story_id at write time — recordVote
    // enforces exactly one is populated based on which subject the
    // parent poll is attached to. The unique index on (poll_id,
    // cookie_token) doesn't change; it's the anti-double-vote
    // primitive regardless of subject.
    { name: "article_id", type: "TEXT" },
    { name: "category", type: "TEXT" },
    { name: "side", type: "TEXT" },
    { name: "cookie_token", type: "TEXT" },
    { name: "ip_ua_hash", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
    // 2026-06-19 anonymous-first auth. Nullable: anonymous votes leave
    // this NULL and stay anchored to cookie_token; signed-in votes set
    // user_id and the OAuth callback's reconciliation step UPDATEs
    // prior anon votes from the same browser to fill it. Anti-double-
    // vote becomes two PARTIAL unique indexes (see POST_TABLE_DDL):
    // (poll_id, user_id) WHERE user_id IS NOT NULL and the existing
    // (poll_id, cookie_token) which now only enforces over anon rows.
    // Plan: _plans/2026-06-19-anonymous-first-auth.md §Polls + auth.
    { name: "user_id", type: "TEXT" },
  ],
};

// 2026-06-18 engagement polls projection. Refreshed every 5 minutes by
// a Vercel cron. Reading this instead of COUNT(*)/GROUP BY on poll_votes
// is what keeps the rail-query latency budget tight. `divisiveness` is
// `1 - |0.5 - pctA| * 2` (1.0 = perfect 50/50, 0.0 = 100/0). `agreement`
// is `1 - divisiveness`; both stored so the rail queries can ORDER BY
// without recomputing.
export const POLL_AGGREGATES: Table = {
  name: "poll_aggregates",
  columns: [
    { name: "story_id", type: "TEXT", pk: true },
    { name: "poll_id", type: "TEXT" },
    { name: "category", type: "TEXT" },
    { name: "votes_a", type: "INTEGER" },
    { name: "votes_b", type: "INTEGER" },
    { name: "total_votes", type: "INTEGER" },
    { name: "divisiveness", type: "REAL" },
    { name: "agreement", type: "REAL" },
    { name: "last_vote_at", type: "TEXT" },
    { name: "refreshed_at", type: "TEXT" },
  ],
};

// 2026-06-22 data-deletion audit log. One row per honored deletion request,
// keyed by the confirmation_code we hand back (to Meta's data-deletion
// callback, or generated for a self-serve delete). `source` is 'facebook'
// (a Meta signed_request fired this) or 'self_serve' (the user clicked Delete
// my account). `subject_hash` is hashForLog() of the Facebook app-scoped id
// or the internal user id — NEVER the raw value, so the log carries no
// reversible PII (rule 13). `deleted` is 1 when a matching account row was
// found and wiped, 0 when the request resolved to no account (already gone /
// never existed). The public status page at /data-deletion/[code] reads this
// to answer "is my deletion done?" deterministically. Plan:
// _plans/2026-06-22-facebook-login-and-data-deletion.md.
export const DATA_DELETION_REQUESTS: Table = {
  name: "data_deletion_requests",
  columns: [
    { name: "confirmation_code", type: "TEXT", pk: true },
    { name: "source", type: "TEXT" },
    { name: "subject_hash", type: "TEXT" },
    { name: "deleted", type: "INTEGER" },
    { name: "created_at", type: "TEXT" },
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

// 2026-06-22 admin audit log. Append-only record of every sensitive admin
// action (role change, suspend, delete, invite, impersonate) for the
// user-management feature — "who did what to whom, and when". PII-free by
// construction: actor and target are an opaque id plus a one-way hashed label
// (lib/users.hashForLog), and `metadata` is a PII-free JSON blob the caller
// controls. A row references nothing by foreign key (there are none) and
// survives a GDPR deletion of its target with no dangling PII, because the
// only trace left is the hash. App-owned (not mirrored in pipeline/store.py),
// so the app owns its indexes in POST_TABLE_DDL too. There is intentionally no
// update/delete path — append-only is the tamper-resistance at this scale.
// Plan: _plans/2026-06-22-admin-user-management.md (Phase 1).
export const ADMIN_AUDIT_LOG: Table = {
  name: "admin_audit_log",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "actor_id", type: "TEXT" },
    { name: "actor_label", type: "TEXT" },
    { name: "action", type: "TEXT" },
    { name: "target_type", type: "TEXT" },
    { name: "target_id", type: "TEXT" },
    { name: "target_label", type: "TEXT" },
    { name: "metadata", type: "TEXT" },
    { name: "ip_hash", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
  ],
};

// 2026-06-22 article comments + AI moderation
// (_plans/2026-06-22-article-comments-ai-moderation.md). Reader comments on
// articles, moderated by a two-tier pipeline (free OpenAI Moderation API then a
// gpt-5-nano judge). `status` is a closed enum: 'published' (visible to all),
// 'held' (awaiting human review, visible only to its own author),
// 'rejected' (rule violation), 'quarantined' (the non-discretionary
// CSAM/threats path — preserved, never silently deleted), 'deleted' (soft
// delete by the author). `author_user_id` is NULL for guests, who carry a
// `guest_name` only — we deliberately store no guest email (it bought nothing
// but PII liability; abuse is handled by `ip_ua_hash` velocity + a CAPTCHA).
// `cookie_token` is a 256-bit nonce (same primitive as poll_votes) that both
// blocks double-likes and lets a guest see their own held/rejected comment.
// `ip_ua_hash` is one-way and pruned on a retention sweep like poll_votes. The
// stance/sentiment/topic_tag fields are the cheap editorial signal the judge
// emits while it is already reading the comment (stored, not yet surfaced).
// like_count / reply_count are denormalised so the public thread never runs
// COUNT(*) per render.
export const COMMENTS: Table = {
  name: "comments",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "article_id", type: "TEXT" },
    // NULL = top-level. A non-null parent_id points at another comment on the
    // same article. v1 is one level deep; the write path refuses a reply whose
    // parent already has a parent.
    { name: "parent_id", type: "TEXT" },
    { name: "author_user_id", type: "TEXT" },
    { name: "guest_name", type: "TEXT" },
    { name: "body", type: "TEXT" },
    { name: "lang", type: "TEXT" },
    { name: "status", type: "TEXT" },
    // How the current status was reached: 'tier1' (Moderation API),
    // 'tier2' / 'tier2_lowconf' (the judge), 'human' (admin), 'timeout'
    // (failed closed to held). Audited in full in comment_moderation_events.
    { name: "moderation_source", type: "TEXT" },
    { name: "moderation_category", type: "TEXT" },
    { name: "moderation_reason", type: "TEXT" },
    { name: "moderation_confidence", type: "REAL" },
    { name: "stance", type: "TEXT" },
    { name: "sentiment", type: "TEXT" },
    { name: "topic_tag", type: "TEXT" },
    { name: "like_count", type: "INTEGER" },
    { name: "reply_count", type: "INTEGER" },
    { name: "cookie_token", type: "TEXT" },
    { name: "ip_ua_hash", type: "TEXT" },
    { name: "edited_at", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
  ],
};

// 2026-06-22 admin user-management Phase 5. Email invites for new staff. The
// raw one-time token lives ONLY in the emailed link; we store its SHA-256 hash
// (same reasoning as magic_link_tokens / passwords — a DB leak can't be used to
// accept an invite). `role` is bound here at invite time and is never taken
// from the client at accept, so a leaked link can only ever grant the role the
// inviter chose. Single-use via accepted_at; revocable via revoked_at; expires
// ~72h. Plan: _plans/2026-06-22-admin-user-management.md (Phase 5).
export const STAFF_INVITES: Table = {
  name: "staff_invites",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "email", type: "TEXT" },
    { name: "role", type: "TEXT" },
    { name: "token_hash", type: "TEXT" },
    { name: "invited_by", type: "TEXT" },
    { name: "expires_at", type: "TEXT" },
    { name: "accepted_at", type: "TEXT" },
    { name: "revoked_at", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
  ],
};

// One row per like. Anonymous likes are keyed by cookie_token, signed-in by
// user_id; the two partial unique indexes in POST_TABLE_DDL are the
// anti-double-like primitives (mirrors poll_votes). The like count is kept
// denormalised on comments.like_count and reconciled from this log.
export const COMMENT_LIKES: Table = {
  name: "comment_likes",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "comment_id", type: "TEXT" },
    { name: "user_id", type: "TEXT" },
    { name: "cookie_token", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
  ],
};

// 2026-06-22 admin user-management Phase 8. Per-source login throttle —
// brute-force defense for the admin login. `key` is namespaced + hashed by the
// caller (e.g. "admin-login:<ip hash>") so no raw IP is stored. attempts +
// first_at form the rolling window; locked_until is set once the threshold is
// hit. DB-backed because the app is serverless (in-memory wouldn't survive
// across instances). Plan: _plans/2026-06-22-admin-user-management.md (Phase 8).
export const LOGIN_ATTEMPTS: Table = {
  name: "login_attempts",
  columns: [
    { name: "key", type: "TEXT", pk: true },
    { name: "attempts", type: "INTEGER" },
    { name: "first_at", type: "TEXT" },
    { name: "locked_until", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
  ],
};

// Reader reports. A report routes its comment back into the human queue.
// `status` is 'open' | 'actioned' | 'dismissed'.
export const COMMENT_REPORTS: Table = {
  name: "comment_reports",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "comment_id", type: "TEXT" },
    { name: "reporter_user_id", type: "TEXT" },
    { name: "cookie_token", type: "TEXT" },
    { name: "reason", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
  ],
};

// Append-only moderation audit trail. Every status change (AI or human) writes
// a row. This is the DSA statement-of-reasons record and the basis for the
// appeal flow; it is never updated or deleted. `actor` is 'ai' or an admin
// user id.
export const COMMENT_MODERATION_EVENTS: Table = {
  name: "comment_moderation_events",
  columns: [
    { name: "id", type: "TEXT", pk: true },
    { name: "comment_id", type: "TEXT" },
    { name: "actor", type: "TEXT" },
    { name: "from_status", type: "TEXT" },
    { name: "to_status", type: "TEXT" },
    { name: "category", type: "TEXT" },
    { name: "reason", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
  ],
};

export const TABLES: Table[] = [
  STORIES,
  SETTINGS,
  USERS,
  USER_SAVES,
  USER_LIKES,
  USER_FAV_CATEGORIES,
  USER_RECENTLY_VIEWED,
  USER_CONTINUE,
  MAGIC_LINK_TOKENS,
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
  STORY_JOB_EVENTS,
  VOICE_RENDERS,
  VOICEOVERS,
  HOMEPAGE_CURATION,
  POLLS,
  POLL_VOTES,
  POLL_AGGREGATES,
  DATA_DELETION_REQUESTS,
  ADMIN_AUDIT_LOG,
  STAFF_INVITES,
  LOGIN_ATTEMPTS,
  COMMENTS,
  COMMENT_LIKES,
  COMMENT_REPORTS,
  COMMENT_MODERATION_EVENTS,
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
  // 2026-06-22 voiceover presets: names are the admin-facing handle, so keep
  // them unique (mirror of idx_voiceovers_name in pipeline/store.py).
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_voiceovers_name ON voiceovers(name)",
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
  // 2026-06-16 story_jobs observability. Same shape as the short_render_events
  // index. The detail page at /admin/reddit-sources/[reddit_id] reads by
  // reddit_id (cheapest path on a page that already has the URL param); the
  // job_id index supports the by-job lookup used by tests and the API.
  "CREATE INDEX IF NOT EXISTS idx_story_job_events_reddit_id " +
    "ON story_job_events(reddit_id, ts)",
  "CREATE INDEX IF NOT EXISTS idx_story_job_events_job_id " +
    "ON story_job_events(job_id, ts)",
  // 2026-06-16 homepage curation. (surface, position) uniqueness is the
  // load-bearing invariant — two stories can't share a slot, and add/remove/
  // move operations depend on packed positions. Surface filter is also the
  // hot read path (one query per rail) so the leading column matches.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_homepage_curation_surface_position " +
    "ON homepage_curation(surface, position)",
  // 2026-06-18 engagement polls. Both per-subject uniqueness indexes
  // are PARTIAL — they only enforce uniqueness over the non-null
  // values. The schema invariant is "exactly one of (story_id,
  // article_id) is non-null"; the partial indexes mean an article-
  // only poll (story_id NULL) doesn't collide on the story uniqueness
  // check, and vice versa. lib/polls.ts:upsertPoll targets the
  // matching index via lookup-then-write, NOT ON CONFLICT, so this
  // shape works identically on SQLite + Postgres.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_polls_story_id " +
    "ON polls(story_id) WHERE story_id IS NOT NULL",
  // 2026-06-18 standalone-article polls (plan §15). Parallel partial
  // unique to idx_polls_story_id — one poll per article.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_polls_article_id " +
    "ON polls(article_id) WHERE article_id IS NOT NULL",
  // Rail read shape: filter by category + enabled, surface a list.
  "CREATE INDEX IF NOT EXISTS idx_polls_category_enabled " +
    "ON polls(category, enabled)",
  // 2026-06-18 engagement poll votes. (poll_id, cookie_token) uniqueness
  // is the anti-double-vote primitive. lib/polls.ts:recordVote does
  // INSERT ... ON CONFLICT (poll_id, cookie_token) DO NOTHING; missing
  // this index would let the same browser vote twice on Postgres until
  // an explicit duplicate check ran, AND would 500 the action because
  // the ON CONFLICT clause has nothing to match.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_votes_poll_cookie " +
    "ON poll_votes(poll_id, cookie_token)",
  // Per-poll vote count + per-story rollup read paths. Both are touched
  // by the aggregate refresh cron + the per-story sparkline query on
  // /admin/polls/[id].
  "CREATE INDEX IF NOT EXISTS idx_poll_votes_poll_id ON poll_votes(poll_id)",
  "CREATE INDEX IF NOT EXISTS idx_poll_votes_story_id " +
    "ON poll_votes(story_id)",
  // 2026-06-18 standalone-article polls. Mirrors idx_poll_votes_story_id
  // for the article-poll surface — supports the per-article analytics
  // path (admin overview rollups, future article-only divisive rail).
  "CREATE INDEX IF NOT EXISTS idx_poll_votes_article_id " +
    "ON poll_votes(article_id)",
  // Retention sweep (24h prune of ip_ua_hash) + sparkline range scan
  // both filter by created_at. Cheap to keep, expensive to retrofit.
  "CREATE INDEX IF NOT EXISTS idx_poll_votes_created_at " +
    "ON poll_votes(created_at)",
  // 2026-06-18 QA pass: the personalized article-rail mode (and any
  // future "what did this cookie vote on" admin view) reads by
  // cookie_token alone. The compound idx_poll_votes_poll_cookie
  // leads with poll_id so it can't service this query — without a
  // standalone index here, the SELECT becomes a table scan as the
  // vote log grows.
  "CREATE INDEX IF NOT EXISTS idx_poll_votes_cookie_token " +
    "ON poll_votes(cookie_token)",
  // 2026-06-18 engagement poll aggregates. The three rails ORDER BY
  // divisiveness / agreement / category-divisiveness; without these
  // indexes the rails would table-scan poll_aggregates on every public
  // pageview.
  "CREATE INDEX IF NOT EXISTS idx_poll_aggregates_divisiveness " +
    "ON poll_aggregates(divisiveness DESC, total_votes DESC)",
  "CREATE INDEX IF NOT EXISTS idx_poll_aggregates_agreement " +
    "ON poll_aggregates(agreement DESC, total_votes DESC)",
  "CREATE INDEX IF NOT EXISTS idx_poll_aggregates_category " +
    "ON poll_aggregates(category, divisiveness DESC)",
  // 2026-06-19 anonymous-first auth. Load-bearing uniqueness for the
  // OAuth callback's user lookup: (provider, provider_sub) is the
  // identity key Google's `sub` claim maps to. The fallback by-email
  // path uses the email index. Partial uniqueness on provider_sub so
  // admin rows (provider IS NULL) don't collide.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider_sub " +
    "ON users(provider, provider_sub) " +
    "WHERE provider IS NOT NULL AND provider_sub IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)",
  // 2026-06-19 anonymous-first auth: per-user state tables. The unique
  // indexes are the upsert anchors (lib/user-state.ts will INSERT ...
  // ON CONFLICT(user_id, story_id) DO NOTHING for saves/likes; same
  // shape for the others). The non-unique reads sort latest-first.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_saves_user_story " +
    "ON user_saves(user_id, story_id)",
  "CREATE INDEX IF NOT EXISTS idx_user_saves_user_created " +
    "ON user_saves(user_id, created_at DESC)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_likes_user_story " +
    "ON user_likes(user_id, story_id)",
  "CREATE INDEX IF NOT EXISTS idx_user_likes_user_created " +
    "ON user_likes(user_id, created_at DESC)",
  // 2026-06-22 Wires likes. The public feed counts likes per story
  // (COUNT(*) WHERE story_id = ?); the (user_id, story_id) index can't
  // serve a story_id-leading lookup, so without this the count subquery
  // table-scans user_likes on every feed page.
  "CREATE INDEX IF NOT EXISTS idx_user_likes_story " +
    "ON user_likes(story_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_fav_categories_user_cat " +
    "ON user_fav_categories(user_id, category)",
  // Recently-viewed: NOT unique on (user_id, story_id) — re-visits are
  // separate rows, the read collapses by story_id. The (user_id,
  // viewed_at) index supports both the latest-N read and the periodic
  // prune that caps the per-user history at 50.
  "CREATE INDEX IF NOT EXISTS idx_user_recently_viewed_user_viewed " +
    "ON user_recently_viewed(user_id, viewed_at DESC)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_continue_user_story " +
    "ON user_continue(user_id, story_id)",
  "CREATE INDEX IF NOT EXISTS idx_user_continue_user_updated " +
    "ON user_continue(user_id, updated_at DESC)",
  // 2026-06-19 polls + auth. Signed-in users get a second anti-double-
  // vote primitive keyed on user_id (anonymous votes keep using the
  // existing idx_poll_votes_poll_cookie). PARTIAL: only enforces over
  // rows that actually carry a user_id, so the anon row pattern is
  // unchanged. The reconciliation UPDATE in the OAuth callback sets
  // user_id on prior anon rows from the same browser; after that, the
  // signed-in user can re-vote from a second device and recordVote
  // sees the existing (poll_id, user_id) row and returns
  // inserted=false without creating a duplicate. Plan:
  // _plans/2026-06-19-anonymous-first-auth.md §Polls + auth integration.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_votes_poll_user " +
    "ON poll_votes(poll_id, user_id) WHERE user_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_poll_votes_user_id " +
    "ON poll_votes(user_id) WHERE user_id IS NOT NULL",
  // 2026-06-19 Phase 3 magic link. The verify path looks up by
  // token_hash (cheapest index for the hot path); the periodic prune
  // and the verify-time expiry check scan by expires_at.
  "CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_hash " +
    "ON magic_link_tokens(token_hash)",
  "CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_expires " +
    "ON magic_link_tokens(expires_at)",
  // 2026-06-22 admin audit log (app-owned, not in pipeline/store.py). The
  // default view reads newest-first, so created_at DESC is the hot path; the
  // per-user detail panel reads by (target_type, target_id); the by-actor and
  // by-action filters each lead with their column then created_at.
  "CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created " +
    "ON admin_audit_log(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target " +
    "ON admin_audit_log(target_type, target_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_admin_audit_log_actor " +
    "ON admin_audit_log(actor_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action " +
    "ON admin_audit_log(action, created_at DESC)",
  // 2026-06-22 staff invites. The accept path looks up by token_hash (hot);
  // the pending-invites list reads newest-first.
  "CREATE INDEX IF NOT EXISTS idx_staff_invites_token " +
    "ON staff_invites(token_hash)",
  "CREATE INDEX IF NOT EXISTS idx_staff_invites_created " +
    "ON staff_invites(created_at DESC)",
  // 2026-06-22 article comments. The public thread read filters by
  // (article_id, status='published') and paginates by created_at — keyset,
  // never OFFSET — so the leading columns match the hot path.
  "CREATE INDEX IF NOT EXISTS idx_comments_article_thread " +
    "ON comments(article_id, status, created_at)",
  // Reply fan-out under a top-level comment.
  "CREATE INDEX IF NOT EXISTS idx_comments_parent " +
    "ON comments(parent_id) WHERE parent_id IS NOT NULL",
  // Admin review queue reads held/quarantined ordered oldest-first.
  "CREATE INDEX IF NOT EXISTS idx_comments_status_created " +
    "ON comments(status, created_at)",
  // DB-backed guest velocity limit: count this bucket's recent comments in a
  // window. In-memory per-instance limiting (poll-rate-limit.ts) is too weak
  // for guest abuse on serverless, so the write path counts rows here instead.
  "CREATE INDEX IF NOT EXISTS idx_comments_ipua_created " +
    "ON comments(ip_ua_hash, created_at)",
  // "My own comments" (lets a guest see their held/rejected comment) + the
  // per-cookie velocity bucket.
  "CREATE INDEX IF NOT EXISTS idx_comments_cookie_token " +
    "ON comments(cookie_token)",
  // Signed-in user's own comments + per-user velocity bucket.
  "CREATE INDEX IF NOT EXISTS idx_comments_author " +
    "ON comments(author_user_id) WHERE author_user_id IS NOT NULL",
  // Anti-double-like primitives, mirroring poll_votes: cookie uniqueness is
  // the always-on primitive; the user_id partial adds a second key for
  // signed-in likes across devices. lib/comments.ts:toggleLike targets these
  // via lookup-then-write, so the shape works identically on SQLite + Postgres.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_likes_comment_cookie " +
    "ON comment_likes(comment_id, cookie_token)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_likes_comment_user " +
    "ON comment_likes(comment_id, user_id) WHERE user_id IS NOT NULL",
  // Open-reports queue (admin) + per-comment report lookup.
  "CREATE INDEX IF NOT EXISTS idx_comment_reports_status " +
    "ON comment_reports(status, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_comment_reports_comment " +
    "ON comment_reports(comment_id)",
  // Per-comment audit timeline (the statement-of-reasons / appeal record).
  "CREATE INDEX IF NOT EXISTS idx_comment_moderation_events_comment " +
    "ON comment_moderation_events(comment_id, created_at)",
];
