// Data access for stories, settings, and users. One place for every query so
// authorization and shape stay consistent (see the Next data-security guide).

import "server-only";
import { all, one, run } from "@/lib/db";

export type StoryStatus =
  | "draft"
  | "review"
  | "scripted"
  | "rendering"
  | "ready"
  | "published"
  | "archived";

export interface StoryRow {
  id: string;
  reddit_id: string | null;
  slug: string | null;
  category: string | null;
  title: string | null;
  summary: string | null;
  body: string | null;
  teleprompter: string | null;
  status: string | null;
  source_url: string | null;
  hero_image: string | null;
  images: string | null;
  audio_url: string | null;
  video_url: string | null;
  duration: string | null;
  alignment: string | null;
  intro_segment_id: string | null;
  outro_segment_id: string | null;
  skip_intro: number | null;
  skip_outro: number | null;
  // 2026-06-11 video editor: full ShortVideoConfig v2 JSON. NULL until the
  // pipeline writes it on first render OR the editor lands cold and derives
  // a default via defaultVideoConfig() in lib/video-config.ts.
  video_config: string | null;
  // 2026-06-16 short editor: full ShortConfig v1 JSON (lib/short-config.ts).
  // NULL until the short editor lands cold and seeds it from
  // short_renders.props via defaultShortConfig(). Plan:
  // _plans/2026-06-16-short-editor-full-parity.md.
  short_config: string | null;
  tokens: number | null;
  cost_cents: number | null;
  created_at: string | null;
  updated_at: string | null;
  published_at: string | null;
  payload: string | null;
  // 0 or NULL = indexable; 1 = the public story page (when it exists)
  // should emit noindex,nofollow. Mirrors articles.noindex.
  noindex: number | null;
  // Python-pipeline-owned media columns. JSON in props
  // ([{url,label,side},...]); raw URLs in the two character_image* columns.
  // Surfaced here so the admin UI's granular regen grid can list them.
  props: string | null;
  character_image: string | null;
  character_image_mouth_removed: string | null;
  // 2026-06-14: pipeline-owned cache (world_bible, scene_prompts,
  // scene_prompts_built_with, scene_entity_ids, character_bible).
  // The admin's WorldBiblePanel reads this for inspection; the editor
  // is intentionally excluded from writing it (see `EDITABLE`) so the
  // heartbeat path can't wipe the cache the way it used to when these
  // fields lived inside video_config. See
  // `_plans/2026-06-14-pipeline-cache-column.md`.
  pipeline_cache: string | null;
  // 2026-06-14 voiceover picker per-story override (Phase 1 of
  // _plans/2026-06-14-voiceover-picker.md). Both NULL = use the global
  // setting. `voice_provider` mirrors models.get_selected("voice") shape
  // ("elevenlabs" / "google/chirp3-hd" / "google/gemini-25-flash-tts");
  // `voice_id` is the provider-native id. The Python pipeline reads
  // both at synthesize time via the resolution chain in voice.py.
  voice_provider: string | null;
  voice_id: string | null;
}

const COLS =
  "id, reddit_id, slug, category, title, summary, body, teleprompter, status, source_url, hero_image, images, audio_url, video_url, duration, alignment, intro_segment_id, outro_segment_id, skip_intro, skip_outro, video_config, short_config, tokens, cost_cents, created_at, updated_at, published_at, payload, noindex, props, character_image, character_image_mouth_removed, pipeline_cache, voice_provider, voice_id";

// Slim projection for list views (dashboard recent, /admin/stories). Drops the
// large text columns (body, teleprompter, payload, summary, images, alignment)
// that the list does not render — the full editor reads getStory() instead.
const STORY_LIST_COLS =
  "id, slug, category, title, status, cost_cents, created_at, updated_at";

export type StoryListRow = Pick<
  StoryRow,
  | "id"
  | "slug"
  | "category"
  | "title"
  | "status"
  | "cost_cents"
  | "created_at"
  | "updated_at"
>;

// Columns the admin editor is allowed to write directly.
const EDITABLE = new Set([
  "slug",
  "category",
  "title",
  "summary",
  "body",
  "teleprompter",
  "status",
  "source_url",
  "hero_image",
  "images",
  "audio_url",
  "video_url",
  "duration",
  "alignment",
  "payload",
  "video_config",
]);

export async function listStories(
  opts: { status?: string; category?: string; limit?: number } = {},
): Promise<StoryRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    where.push("status = ?");
    params.push(opts.status);
  }
  if (opts.category) {
    where.push("category = ?");
    params.push(opts.category);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = opts.limit ? `LIMIT ${Math.trunc(opts.limit)}` : "";
  return all<StoryRow>(
    `SELECT ${COLS} FROM stories ${clause} ORDER BY COALESCE(updated_at, created_at) DESC ${limit}`,
    params,
  );
}

// List-view variant: slim columns and a real LIMIT so the dashboard does not
// pull every body/teleprompter on every render. The full editor still uses
// listStories / getStory when it needs the heavy fields.
export async function listStoriesSlim(
  opts: { status?: string; category?: string; limit?: number } = {},
): Promise<StoryListRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    where.push("status = ?");
    params.push(opts.status);
  }
  if (opts.category) {
    where.push("category = ?");
    params.push(opts.category);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = opts.limit ? `LIMIT ${Math.trunc(opts.limit)}` : "";
  return all<StoryListRow>(
    `SELECT ${STORY_LIST_COLS} FROM stories ${clause} ORDER BY COALESCE(updated_at, created_at) DESC ${limit}`,
    params,
  );
}

export async function getStory(id: string): Promise<StoryRow | null> {
  return one<StoryRow>(`SELECT ${COLS} FROM stories WHERE id = ?`, [id]);
}

// 2026-06-11 video editor: typed read/write helpers for stories.video_config.
// The column stores a stringified ShortVideoConfig v2 (see
// lib/video-config.ts). Callers should parseVideoConfig() the result before
// trusting the shape — a row written by an older pipeline build, or a row
// the editor hasn't written yet, may not match the current schema.

export async function getStoryConfigJson(
  storyId: string,
): Promise<string | null> {
  const r = await one<{ video_config: string | null }>(
    "SELECT video_config FROM stories WHERE id = ?",
    [storyId],
  );
  return r?.video_config ?? null;
}

// Writes the canonical JSON string into the column and bumps updated_at so
// the existing `ORDER BY updated_at` queries surface freshly-edited videos
// to the dashboard. Caller is responsible for serializing through
// parseVideoConfig() first; passing raw JSON skips validation.
export async function setStoryConfigJson(
  storyId: string,
  json: string,
): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "UPDATE stories SET video_config = ?, updated_at = ? WHERE id = ?",
    [json, now, storyId],
  );
  // eslint-disable-next-line no-console -- rule 14: observability from day one
  console.info("[video editor config persist]", {
    story_id: storyId,
    bytes: json.length,
  });
}

// 2026-06-16 short editor: typed read/write helpers for stories.short_config.
// The column stores a stringified ShortConfig v1 (see lib/short-config.ts).
// Callers MUST parseShortConfig() the result before trusting the shape — a
// row written by an older build or one the editor hasn't touched may not
// match the current schema. Plan:
// _plans/2026-06-16-short-editor-full-parity.md.

export async function getStoryShortConfigJson(
  storyId: string,
): Promise<string | null> {
  const r = await one<{ short_config: string | null }>(
    "SELECT short_config FROM stories WHERE id = ?",
    [storyId],
  );
  return r?.short_config ?? null;
}

// Persists a canonical JSON string into the short_config column and bumps
// updated_at so dashboard ORDER BY updated_at picks up freshly-edited
// shorts. Caller is responsible for validating through parseShortConfig()
// first; passing raw JSON skips validation by design (the action layer is
// the gate).
export async function setStoryShortConfigJson(
  storyId: string,
  json: string,
): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "UPDATE stories SET short_config = ?, updated_at = ? WHERE id = ?",
    [json, now, storyId],
  );
  // eslint-disable-next-line no-console -- rule 14: observability from day one
  console.info("[short editor config persist]", {
    story_id: storyId,
    bytes: json.length,
  });
}

// One-shot summary for the dashboard. Replaces the previous "pull every row,
// reduce in JS" pattern that was loading every story's body and payload just
// to compute three numbers.
export interface DashboardSummary {
  total: number;
  byStatus: Record<string, number>;
  totalCostCents: number;
}

export async function dashboardSummary(): Promise<DashboardSummary> {
  const rows = await all<{
    status: string | null;
    c: number | string;
    cost: number | string;
  }>(
    "SELECT status, COUNT(*) AS c, COALESCE(SUM(cost_cents), 0) AS cost FROM stories GROUP BY status",
    [],
  );
  const byStatus: Record<string, number> = {};
  let total = 0;
  let totalCostCents = 0;
  for (const r of rows) {
    const count = Number(r.c);
    byStatus[r.status ?? "draft"] = count;
    total += count;
    totalCostCents += Number(r.cost);
  }
  return { total, byStatus, totalCostCents };
}

export async function publishedStories(): Promise<StoryRow[]> {
  return all<StoryRow>(
    `SELECT ${COLS} FROM stories WHERE status = 'published' ORDER BY COALESCE(published_at, updated_at, created_at) DESC`,
    [],
  );
}

export async function countByStatus(): Promise<Record<string, number>> {
  const rows = await all<{ status: string | null; c: number }>(
    "SELECT status, COUNT(*) AS c FROM stories GROUP BY status",
    [],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status ?? "unknown"] = Number(r.c);
  return out;
}

export async function updateStory(
  id: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(fields).filter((k) => EDITABLE.has(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`);
  const params: unknown[] = keys.map((k) => fields[k] ?? null);
  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(id);
  await run(`UPDATE stories SET ${sets.join(", ")} WHERE id = ?`, params);
}

export async function setStatus(id: string, status: StoryStatus): Promise<void> {
  const now = new Date().toISOString();
  if (status === "published") {
    await run(
      "UPDATE stories SET status = ?, published_at = ?, updated_at = ? WHERE id = ?",
      [status, now, now, id],
    );
  } else {
    await run("UPDATE stories SET status = ?, updated_at = ? WHERE id = ?", [
      status,
      now,
      id,
    ]);
  }
}

export async function setStoryNoindex(
  id: string,
  noindex: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "UPDATE stories SET noindex = ?, updated_at = ? WHERE id = ?",
    [noindex ? 1 : 0, now, id],
  );
  console.info("[stories repo] noindex", { id, noindex });
}

// Hard delete a story and every row in the schema that is meaningless without
// it. No FK constraints exist (see schema.ts) so the cleanup is explicit. The
// behavior was chosen per _plans/2026-06-19-content-bulk-actions.md:
//
//   Owned rows -> DELETE (renders, render-events via parent-id chain, polls).
//   User state -> DELETE (saves, likes, recently viewed, continue) so the
//     public reader never resolves a "ghost" item it can't render.
//   Loose links -> NULL (articles.story_id, reddit_source.story_id,
//     story_jobs.story_id) so the parent rows keep working without the link.
//   Curation slot -> DELETE the slot (an empty homepage tile is worse than
//     no tile; admin can re-curate).
//
// Returns the row that was deleted (or null if it did not exist) so the
// caller can fan rendered-media (audio_url, video_url) into GCS deletion.
// Throws if the row exists but the cascade fails partway — the caller
// should treat that as a batch-item failure.
export async function deleteStory(id: string): Promise<StoryRow | null> {
  const existing = await getStory(id);
  if (!existing) return null;

  // Render-event children first — they reference their parent render by id.
  await run(
    "DELETE FROM image_render_events WHERE render_id IN " +
      "(SELECT id FROM image_renders WHERE owner_kind = 'story' AND owner_id = ?)",
    [id],
  );
  await run(
    "DELETE FROM video_render_events WHERE render_id IN " +
      "(SELECT id FROM video_renders WHERE story_id = ?)",
    [id],
  );
  await run(
    "DELETE FROM short_render_events WHERE render_id IN " +
      "(SELECT id FROM short_renders WHERE story_id = ?)",
    [id],
  );

  // Owned-by-story queues and projections.
  await run("DELETE FROM image_renders WHERE owner_kind = 'story' AND owner_id = ?", [id]);
  await run("DELETE FROM video_renders WHERE story_id = ?", [id]);
  await run("DELETE FROM short_renders WHERE story_id = ?", [id]);
  await run("DELETE FROM voice_renders WHERE story_id = ?", [id]);
  await run("DELETE FROM poll_votes WHERE story_id = ?", [id]);
  await run("DELETE FROM polls WHERE story_id = ?", [id]);
  await run("DELETE FROM poll_aggregates WHERE story_id = ?", [id]);

  // Public-user state pointing at the story.
  await run("DELETE FROM user_saves WHERE story_id = ?", [id]);
  await run("DELETE FROM user_likes WHERE story_id = ?", [id]);
  await run("DELETE FROM user_recently_viewed WHERE story_id = ?", [id]);
  await run("DELETE FROM user_continue WHERE story_id = ?", [id]);

  // Homepage slot pointing at the story is dropped (an empty slot misleads
  // the reader; the editor can re-fill the position from /admin/homepage).
  await run("DELETE FROM homepage_curation WHERE story_id = ?", [id]);

  // Loose references — preserve the parent row, just unlink. articles.story_id
  // is the hero/og borrow link; reddit_source.story_id is the "this Reddit
  // post produced story X" trail; story_jobs.story_id is the job-history row.
  await run("UPDATE articles SET story_id = NULL WHERE story_id = ?", [id]);
  await run("UPDATE reddit_source SET story_id = NULL WHERE story_id = ?", [id]);
  await run("UPDATE story_jobs SET story_id = NULL WHERE story_id = ?", [id]);

  // Finally, the story row itself.
  await run("DELETE FROM stories WHERE id = ?", [id]);
  // eslint-disable-next-line no-console -- rule 14: observability from day one
  console.info("[stories repo] delete", { id });
  return existing;
}

// Thin wrapper around updateStory for callers that want a typed setter
// instead of a Record<string, unknown>. Used by bulk-content actions so the
// category-change path reads as `setStoryCategory(id, "Drama")` at the call
// site. `category` is already in EDITABLE so this is purely a clarity win.
export async function setStoryCategory(
  id: string,
  category: string,
): Promise<void> {
  await updateStory(id, { category });
}

// Phase 3 of _plans/2026-06-14-voiceover-picker.md. Set or clear the
// per-story voice override. Pass `null` to either field to clear it —
// NULL columns mean "use the global default", which is how the
// resolution chain in pipeline/voice.py:synthesize falls through.
//
// Both fields are written together so an in-flight partial state is
// impossible. If a caller wants to clear ONLY the voice_id while
// keeping the provider override, they pass voice_id=null + the
// existing provider value — the UI's "Reset to global" affordance
// just passes nulls for both at once.
export async function setStoryVoice(
  id: string,
  voice_provider: string | null,
  voice_id: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "UPDATE stories SET voice_provider = ?, voice_id = ?, updated_at = ? WHERE id = ?",
    [voice_provider, voice_id, now, id],
  );
  console.info("[stories repo] voice", {
    id, voice_provider, voice_id,
  });
}

export async function getSetting(key: string): Promise<string | null> {
  const r = await one<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [key],
  );
  return r?.value ?? null;
}

// Batched read: every settings key matching the SQL LIKE prefix in one round
// trip. Use when several keys are needed together so we do not pay N DB hops
// (allSelected() / template loaders).
export async function getSettingsByPrefix(
  prefix: string,
): Promise<Record<string, string>> {
  const rows = await all<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key LIKE ?",
    [`${prefix}%`],
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

// --- video_segments (intro/outro library) -----------------------------------
// The relational library of intro/outro clips. Mirrors `video_segments` in
// pipeline/store.py. Soft-disabled rows stay around (so a per-story override
// can still resolve) but are skipped by the global-active picker.

export type SegmentKind = "intro" | "outro";

export interface SegmentRow {
  id: string;
  kind: string;
  label: string | null;
  source_url: string | null;
  normalized_url: string | null;
  duration_ms: number | null;
  enabled: number | null;
  // Lifecycle: pending -> uploading -> normalizing -> ready, with `error` set
  // on any failure. See lorewire-app/src/lib/schema.ts and
  // pipeline/segments_worker.py for the canonical state machine.
  status: string | null;
  error: string | null;
  uploaded_at: string | null;
  // Phase 3 of _plans/2026-06-12-video-aspect-ratio.md: which canvas
  // shape this segment was normalised to. NULL on rows that predate the
  // column — the pipeline treats those as 9:16 (the orientation the
  // pipeline shipped with).
  aspect: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const SEGMENT_COLS =
  "id, kind, label, source_url, normalized_url, duration_ms, enabled, " +
  "status, error, uploaded_at, aspect, created_at, updated_at";

export async function listSegments(kind?: SegmentKind): Promise<SegmentRow[]> {
  if (kind) {
    return all<SegmentRow>(
      `SELECT ${SEGMENT_COLS} FROM video_segments WHERE kind = ? ORDER BY created_at DESC`,
      [kind],
    );
  }
  return all<SegmentRow>(
    `SELECT ${SEGMENT_COLS} FROM video_segments ORDER BY created_at DESC`,
    [],
  );
}

export async function getSegment(id: string): Promise<SegmentRow | null> {
  if (!id) return null;
  return one<SegmentRow>(
    `SELECT ${SEGMENT_COLS} FROM video_segments WHERE id = ?`,
    [id],
  );
}

export async function upsertSegment(s: {
  id: string;
  kind: SegmentKind;
  label?: string | null;
  source_url?: string | null;
  normalized_url?: string | null;
  duration_ms?: number | null;
  enabled?: number;
  // Lifecycle state — see SegmentRow above and pipeline/segments_worker.py.
  // Omitted on legacy callers; the column-level DEFAULT 'ready' covers them.
  status?: string | null;
  error?: string | null;
  uploaded_at?: string | null;
  // Phase 3 of _plans/2026-06-12-video-aspect-ratio.md. Omitted on legacy
  // callers; the column-level DEFAULT '9:16' covers them.
  aspect?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await run(
    `INSERT INTO video_segments (id, kind, label, source_url, normalized_url, duration_ms, enabled, status, error, uploaded_at, aspect, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       label = excluded.label,
       source_url = excluded.source_url,
       normalized_url = excluded.normalized_url,
       duration_ms = excluded.duration_ms,
       enabled = excluded.enabled,
       status = excluded.status,
       error = excluded.error,
       uploaded_at = excluded.uploaded_at,
       aspect = excluded.aspect,
       updated_at = excluded.updated_at`,
    [
      s.id,
      s.kind,
      s.label ?? null,
      s.source_url ?? null,
      s.normalized_url ?? null,
      s.duration_ms ?? null,
      s.enabled ?? 1,
      s.status ?? "ready",
      s.error ?? null,
      s.uploaded_at ?? null,
      s.aspect ?? "9:16",
      now,
      now,
    ],
  );
}

// Targeted helpers the new upload flow uses. The sign-upload action calls
// `markSegmentUploading()` once the browser confirms the GCS PUT finished,
// flipping status `pending -> uploading` so pipeline/segments_worker.py
// picks the row up. Pure status flips don't go through upsertSegment to
// keep the SQL surgical and to avoid touching label/url columns the worker
// has not authored yet.
export async function markSegmentUploading(id: string): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "UPDATE video_segments SET status = ?, uploaded_at = ?, updated_at = ? " +
      "WHERE id = ? AND status = ?",
    ["uploading", now, now, id, "pending"],
  );
}

// Flip a row to status='error' with a one-line message. Used by finalize
// when the GCS HEAD check finds no bytes — the upload genuinely failed and
// we want the admin to see the failure immediately, not after the 5-minute
// abandoned-sweep. Idempotent on already-error rows.
export async function setSegmentError(
  id: string,
  message: string,
): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "UPDATE video_segments SET status = ?, error = ?, updated_at = ? WHERE id = ?",
    ["error", message.slice(0, 500), now, id],
  );
}

export async function setSegmentEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  await run(
    "UPDATE video_segments SET enabled = ?, updated_at = ? WHERE id = ?",
    [enabled ? 1 : 0, new Date().toISOString(), id],
  );
}

export async function updateSegmentLabel(
  id: string,
  label: string,
): Promise<void> {
  await run(
    "UPDATE video_segments SET label = ?, updated_at = ? WHERE id = ?",
    [label, new Date().toISOString(), id],
  );
}

export async function deleteSegment(id: string): Promise<void> {
  await run("DELETE FROM video_segments WHERE id = ?", [id]);
}

// Per-story override write. Allowed values for `pick`:
//   "inherit" -> clear both the pinned id and the skip flag
//   "skip"    -> set skip_<kind> = 1, clear pinned id
//   <segId>   -> set <kind>_segment_id = segId, clear skip flag
export async function setStorySegmentOverride(
  storyId: string,
  kind: SegmentKind,
  pick: "inherit" | "skip" | (string & {}),
): Promise<void> {
  const idCol = kind === "intro" ? "intro_segment_id" : "outro_segment_id";
  const skipCol = kind === "intro" ? "skip_intro" : "skip_outro";
  const now = new Date().toISOString();
  let segId: string | null = null;
  let skip = 0;
  if (pick === "skip") {
    skip = 1;
  } else if (pick !== "inherit") {
    segId = pick;
  }
  await run(
    `UPDATE stories SET ${idCol} = ?, ${skipCol} = ?, updated_at = ? WHERE id = ?`,
    [segId, skip, now, storyId],
  );
}

// --- articles (CMS) ---------------------------------------------------------
// Long-form editorial content authored in the admin. Separate from STORIES
// (the Reddit/video pipeline). Body is Tiptap JSON in `document`; type-
// specific fields live in `payload` validated by per-type Zod schemas in
// the server-action layer. `language` is "he" or "en"; slug uniqueness is
// enforced per-language by checkSlugAvailable() before writes.

export type ArticleType = "news" | "feature" | "listicle" | "review";
export type ArticleLanguage = "he" | "en";
export type ArticleStatus =
  | "draft"
  | "review"
  | "published"
  | "archived";

export const ARTICLE_TYPES: ArticleType[] = [
  "news",
  "feature",
  "listicle",
  "review",
];
export const ARTICLE_LANGUAGES: ArticleLanguage[] = ["he", "en"];
export const ARTICLE_STATUSES: ArticleStatus[] = [
  "draft",
  "review",
  "published",
  "archived",
];

export interface ArticleRow {
  id: string;
  type: string | null;
  language: string | null;
  slug: string | null;
  title: string | null;
  subtitle: string | null;
  summary: string | null;
  document: string | null;
  hero_image: string | null;
  status: string | null;
  author_id: string | null;
  meta_title: string | null;
  meta_description: string | null;
  og_image: string | null;
  // Optional link to the Reddit-pipeline story whose short_render scenes the
  // article borrows for hero/og/gallery promotion. Set via setArticleStoryId
  // (its own dedicated action), not via the generic ARTICLE_EDITABLE writer.
  story_id: string | null;
  payload: string | null;
  source_sheet_row_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  published_at: string | null;
  // 0 or NULL = indexable; 1 = the public reader emits noindex,nofollow.
  noindex: number | null;
}

const ARTICLE_COLS =
  "id, type, language, slug, title, subtitle, summary, document, hero_image, status, author_id, meta_title, meta_description, og_image, story_id, payload, source_sheet_row_id, created_at, updated_at, published_at, noindex";

// Slim projection for /admin/articles list. Drops the heavy text fields
// (document, payload, summary, meta_*, og_image) the list does not render.
const ARTICLE_LIST_COLS =
  "id, type, language, slug, title, status, hero_image, created_at, updated_at, published_at";

export type ArticleListRow = Pick<
  ArticleRow,
  | "id"
  | "type"
  | "language"
  | "slug"
  | "title"
  | "status"
  | "hero_image"
  | "created_at"
  | "updated_at"
  | "published_at"
>;

// Columns the editor is allowed to write directly via updateArticle. `type`
// and `language` are set at creation only — changing them mid-life would
// invalidate the payload's type-specific shape, so they're handled by a
// dedicated migration path if ever needed. `status` goes through
// setArticleStatus so the publish timestamp is consistent. `slug` goes
// through updateArticleSlug so the per-language collision check runs.
const ARTICLE_EDITABLE = new Set([
  "title",
  "subtitle",
  "summary",
  "document",
  "hero_image",
  "meta_title",
  "meta_description",
  "og_image",
  "payload",
]);

export async function listArticlesSlim(
  opts: {
    status?: string;
    type?: string;
    language?: string;
    limit?: number;
  } = {},
): Promise<ArticleListRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    where.push("status = ?");
    params.push(opts.status);
  }
  if (opts.type) {
    where.push("type = ?");
    params.push(opts.type);
  }
  if (opts.language) {
    where.push("language = ?");
    params.push(opts.language);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = opts.limit ? `LIMIT ${Math.trunc(opts.limit)}` : "";
  const rows = await all<ArticleListRow>(
    `SELECT ${ARTICLE_LIST_COLS} FROM articles ${clause} ORDER BY COALESCE(updated_at, created_at) DESC ${limit}`,
    params,
  );
  console.info("[articles repo] list", {
    count: rows.length,
    status: opts.status ?? null,
    type: opts.type ?? null,
    language: opts.language ?? null,
    limit: opts.limit ?? null,
  });
  return rows;
}

export async function getArticle(id: string): Promise<ArticleRow | null> {
  if (!id) return null;
  return one<ArticleRow>(
    `SELECT ${ARTICLE_COLS} FROM articles WHERE id = ?`,
    [id],
  );
}

export async function getArticleBySlug(
  language: ArticleLanguage,
  slug: string,
): Promise<ArticleRow | null> {
  if (!slug || !language) return null;
  return one<ArticleRow>(
    `SELECT ${ARTICLE_COLS} FROM articles WHERE language = ? AND slug = ?`,
    [language, slug],
  );
}

// Slug uniqueness is scoped per language: /articles/he/foo and /articles/en/foo
// are different documents, both valid. The optional excludeId lets the editor
// re-save its current slug without colliding with itself.
export async function checkSlugAvailable(
  language: ArticleLanguage,
  slug: string,
  excludeId?: string,
): Promise<boolean> {
  if (!slug || !language) return false;
  const sql = excludeId
    ? "SELECT id FROM articles WHERE language = ? AND slug = ? AND id != ?"
    : "SELECT id FROM articles WHERE language = ? AND slug = ?";
  const params = excludeId ? [language, slug, excludeId] : [language, slug];
  const row = await one<{ id: string }>(sql, params);
  return row === null;
}

export interface CreateArticleInput {
  id: string;
  type: ArticleType;
  language: ArticleLanguage;
  slug: string;
  title: string;
  author_id: string | null;
  // Optional fields populated by Sheets bootstrap import. NULL for
  // hand-authored articles. `source_sheet_row_id` is the idempotency key:
  // re-importing the same row finds the existing article via
  // getArticleBySourceSheetRowId and skips the insert.
  summary?: string | null;
  document?: string | null;
  payload?: string | null;
  source_sheet_row_id?: string | null;
}

export async function createArticle(input: CreateArticleInput): Promise<void> {
  const now = new Date().toISOString();
  // Tiptap empty document — one empty paragraph, no marks. Hard-coded here so
  // the repo module does not import Tiptap; the editor produces the same
  // shape via `generateJSON('', extensions)`.
  const emptyDoc = JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph" }],
  });
  await run(
    `INSERT INTO articles (id, type, language, slug, title, summary, document, status, author_id, payload, source_sheet_row_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.type,
      input.language,
      input.slug,
      input.title,
      input.summary ?? null,
      input.document ?? emptyDoc,
      "draft",
      input.author_id,
      input.payload ?? "{}",
      input.source_sheet_row_id ?? null,
      now,
      now,
    ],
  );
  console.info("[articles repo] create", {
    id: input.id,
    type: input.type,
    language: input.language,
    slug: input.slug,
    fromSheet: Boolean(input.source_sheet_row_id),
  });
}

// Idempotency lookup for Sheets bootstrap import. The same row id maps to
// the same article every time, so re-importing skips work without
// double-inserting. Returns null when no prior import wrote this row.
export async function getArticleBySourceSheetRowId(
  rowId: string,
): Promise<ArticleRow | null> {
  if (!rowId) return null;
  return one<ArticleRow>(
    `SELECT ${ARTICLE_COLS} FROM articles WHERE source_sheet_row_id = ?`,
    [rowId],
  );
}

export async function updateArticle(
  id: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(fields).filter((k) => ARTICLE_EDITABLE.has(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`);
  const params: unknown[] = keys.map((k) => fields[k] ?? null);
  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(id);
  await run(`UPDATE articles SET ${sets.join(", ")} WHERE id = ?`, params);
  console.info("[articles repo] update", { id, fields: keys });
}

// Slug change has its own writer because of the per-language collision check;
// callers must call checkSlugAvailable() first.
export async function updateArticleSlug(
  id: string,
  slug: string,
): Promise<void> {
  await run(
    "UPDATE articles SET slug = ?, updated_at = ? WHERE id = ?",
    [slug, new Date().toISOString(), id],
  );
  console.info("[articles repo] update-slug", { id, slug });
}

export async function setArticleStatus(
  id: string,
  status: ArticleStatus,
): Promise<void> {
  const now = new Date().toISOString();
  if (status === "published") {
    await run(
      "UPDATE articles SET status = ?, published_at = ?, updated_at = ? WHERE id = ?",
      [status, now, now, id],
    );
  } else {
    await run(
      "UPDATE articles SET status = ?, updated_at = ? WHERE id = ?",
      [status, now, id],
    );
  }
  console.info("[articles repo] status", { id, status });
}

export async function setArticleNoindex(
  id: string,
  noindex: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "UPDATE articles SET noindex = ?, updated_at = ? WHERE id = ?",
    [noindex ? 1 : 0, now, id],
  );
  console.info("[articles repo] noindex", { id, noindex });
}

// story_id has its own writer because it is intentionally not in
// ARTICLE_EDITABLE — the generic updateArticle path is for editor field
// writes (title/body/etc.); story_id is set by a dedicated action that
// validates the target story exists. Passing null unlinks.
export async function setArticleStoryId(
  id: string,
  storyId: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "UPDATE articles SET story_id = ?, updated_at = ? WHERE id = ?",
    [storyId, now, id],
  );
  console.info("[articles repo] story-id", { id, storyId });
}

export async function deleteArticle(id: string): Promise<void> {
  // Hard delete cascades to revisions so the table doesn't keep orphans. The
  // admin UI gates this behind an archived-status confirmation; soft-delete
  // (status='archived') is the normal "remove from view" path.
  await run("DELETE FROM article_revisions WHERE article_id = ?", [id]);
  await run("DELETE FROM articles WHERE id = ?", [id]);
  console.info("[articles repo] delete", { id });
}

// --- article revisions (append-only with coalescing) ------------------------
// Autosave fires often; a row per save would explode the table. `appendRevision`
// coalesces: if the latest revision for this article is unnamed AND created
// within `coalesceWindowSec` seconds of now, it updates that row in place
// instead of inserting a new one. Named revisions and any revision older than
// the window force an insert.

export interface RevisionRow {
  id: string;
  article_id: string;
  document: string | null;
  payload: string | null;
  title: string | null;
  status: string | null;
  name: string | null;
  is_named: number | null;
  author_id: string | null;
  created_at: string | null;
}

const REVISION_COLS =
  "id, article_id, document, payload, title, status, name, is_named, author_id, created_at";

export interface AppendRevisionInput {
  id: string; // candidate id used only when we INSERT
  article_id: string;
  document: string;
  payload: string;
  title: string;
  status: string;
  author_id: string | null;
  // Window inside which an unnamed revision is updated in place. Default 60s.
  coalesceWindowSec?: number;
}

export interface AppendRevisionResult {
  revisionId: string;
  coalesced: boolean;
}

export async function appendRevision(
  input: AppendRevisionInput,
): Promise<AppendRevisionResult> {
  const now = new Date();
  const nowIso = now.toISOString();
  const window = input.coalesceWindowSec ?? 60;
  const latest = await one<RevisionRow>(
    `SELECT ${REVISION_COLS} FROM article_revisions WHERE article_id = ? ORDER BY created_at DESC LIMIT 1`,
    [input.article_id],
  );
  if (
    latest &&
    !latest.is_named &&
    latest.created_at &&
    now.getTime() - new Date(latest.created_at).getTime() < window * 1000
  ) {
    await run(
      "UPDATE article_revisions SET document = ?, payload = ?, title = ?, status = ?, author_id = ?, created_at = ? WHERE id = ?",
      [
        input.document,
        input.payload,
        input.title,
        input.status,
        input.author_id,
        nowIso,
        latest.id,
      ],
    );
    console.info("[articles revisions] coalesce", {
      articleId: input.article_id,
      revisionId: latest.id,
      windowSec: window,
    });
    return { revisionId: latest.id, coalesced: true };
  }
  await run(
    "INSERT INTO article_revisions (id, article_id, document, payload, title, status, is_named, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      input.id,
      input.article_id,
      input.document,
      input.payload,
      input.title,
      input.status,
      0,
      input.author_id,
      nowIso,
    ],
  );
  console.info("[articles revisions] append", {
    articleId: input.article_id,
    revisionId: input.id,
  });
  return { revisionId: input.id, coalesced: false };
}

export async function listRevisions(
  articleId: string,
): Promise<RevisionRow[]> {
  return all<RevisionRow>(
    `SELECT ${REVISION_COLS} FROM article_revisions WHERE article_id = ? ORDER BY created_at DESC`,
    [articleId],
  );
}

export async function getRevision(id: string): Promise<RevisionRow | null> {
  if (!id) return null;
  return one<RevisionRow>(
    `SELECT ${REVISION_COLS} FROM article_revisions WHERE id = ?`,
    [id],
  );
}

// Promote a revision to "named." Named revisions carry a writer-supplied
// label and survive retention pruning so a known-good snapshot stays
// reachable indefinitely. Idempotent: re-naming an already-named revision
// just updates the label.
export async function nameRevision(
  id: string,
  name: string,
): Promise<void> {
  if (!id) return;
  const cleaned = name.trim().slice(0, 120);
  await run(
    "UPDATE article_revisions SET name = ?, is_named = 1 WHERE id = ?",
    [cleaned || null, id],
  );
  console.info("[articles revisions] named", { id, nameLen: cleaned.length });
}

// Drop the named status from a revision. The label clears too — keeping
// the label around would confuse "Last saved" timelines without serving a
// purpose, since the only reason to demote is to let pruning take it.
export async function unnameRevision(id: string): Promise<void> {
  if (!id) return;
  await run(
    "UPDATE article_revisions SET name = NULL, is_named = 0 WHERE id = ?",
    [id],
  );
  console.info("[articles revisions] unnamed", { id });
}

// Retention prune. Keeps the latest `keep` unnamed revisions plus every
// named revision (regardless of age). Returns the count removed so the
// caller can log it. We delete in one statement against an explicit list
// of ids so SQLite and Postgres both behave identically.
export async function pruneRevisions(
  articleId: string,
  keep: number = 50,
): Promise<number> {
  if (!articleId || keep < 0) return 0;
  const unnamed = await all<{ id: string }>(
    "SELECT id FROM article_revisions WHERE article_id = ? AND is_named = 0 ORDER BY created_at DESC",
    [articleId],
  );
  if (unnamed.length <= keep) return 0;
  const toDrop = unnamed.slice(keep);
  // Build the IN clause with one placeholder per id. Cheaper than a single
  // CTE-based delete and equally portable; we cap the slice at the unnamed
  // count so the query stays bounded.
  const placeholders = toDrop.map(() => "?").join(", ");
  await run(
    `DELETE FROM article_revisions WHERE id IN (${placeholders})`,
    toDrop.map((r) => r.id),
  );
  console.info("[articles revisions] prune", {
    articleId,
    keep,
    removed: toDrop.length,
  });
  return toDrop.length;
}

// --- unified content list (stories + articles in one inbox) ----------------
// The admin's Content tab needs one feed across both kinds. We keep the two
// tables (they have genuinely different lifecycles and write paths) but
// project each into a common ContentRow shape and merge in-memory. With a
// soft cap of 200 per kind we touch at most ~400 rows per request — small
// enough to sort in JS and well below where a SQL UNION would pay off.

export type ContentKind = "story" | "article";

// `kind` is the row's storage type — drives routing to the right editor.
// `subKind` is the user-visible category: for stories it's "video" (the
// only Story product today); for articles it's the article type
// (news/feature/listicle/review). The Content filter chips operate on
// subKind so "Video" and "News" can sit next to each other in one row.
export type ContentSubKind = "video" | ArticleType;

export const CONTENT_SUBKINDS: ContentSubKind[] = [
  "video",
  ...ARTICLE_TYPES,
];

export interface ContentRow {
  kind: ContentKind;
  subKind: ContentSubKind;
  id: string;
  title: string | null;
  slug: string | null;
  status: string | null;
  // Stories carry `category` (Drama/Entitled/…); articles carry no category,
  // their type IS the badge. We surface a single optional label here so the
  // list row can show one extra hint without branching on kind.
  badge: string | null;
  language: string | null; // articles only
  hero_image: string | null;
  updated_at: string | null;
  created_at: string | null;
  published_at: string | null;
}

export interface ListContentOpts {
  subKind?: ContentSubKind;
  status?: string;
  language?: string; // narrows to articles
  limit?: number;
}

export async function listContentSlim(
  opts: ListContentOpts = {},
): Promise<ContentRow[]> {
  const limit = opts.limit ?? 200;
  // Skip the table fetch entirely when the filter already excludes its kind:
  // - subKind="video" or language set -> articles or stories only
  // - subKind=any article type -> stories not needed
  // - status that exists only on stories (scripted/rendering/ready) -> articles not needed
  const isArticleSubKind =
    opts.subKind && opts.subKind !== "video"
      ? ARTICLE_TYPES.includes(opts.subKind as ArticleType)
      : false;
  const isStoryOnlyStatus =
    opts.status === "scripted" ||
    opts.status === "rendering" ||
    opts.status === "ready";
  const wantStories =
    !opts.language &&
    !isArticleSubKind &&
    (opts.subKind === undefined || opts.subKind === "video");
  const wantArticles =
    !isStoryOnlyStatus && (opts.subKind === undefined || isArticleSubKind);

  const articleType = isArticleSubKind ? (opts.subKind as ArticleType) : undefined;

  const [stories, articles] = await Promise.all([
    wantStories
      ? listStoriesSlim({ status: opts.status, limit })
      : Promise.resolve([] as StoryListRow[]),
    wantArticles
      ? listArticlesSlim({
          status: opts.status,
          type: articleType,
          language: opts.language,
          limit,
        })
      : Promise.resolve([] as ArticleListRow[]),
  ]);

  const merged: ContentRow[] = [
    ...stories.map<ContentRow>((s) => ({
      kind: "story",
      subKind: "video",
      id: s.id,
      title: s.title,
      slug: s.slug,
      status: s.status,
      badge: s.category,
      language: null,
      hero_image: null,
      updated_at: s.updated_at,
      created_at: s.created_at,
      published_at: null, // slim story projection drops this
    })),
    ...articles.map<ContentRow>((a) => ({
      kind: "article",
      subKind: (a.type as ArticleType | null) ?? "feature",
      id: a.id,
      title: a.title,
      slug: a.slug,
      status: a.status,
      badge: a.type,
      language: a.language,
      hero_image: a.hero_image,
      updated_at: a.updated_at,
      created_at: a.created_at,
      published_at: a.published_at,
    })),
  ];

  // Newest-first by updated_at, falling back to created_at. ISO-8601 strings
  // sort lexicographically — no Date construction needed.
  merged.sort((a, b) => {
    const aT = a.updated_at ?? a.created_at ?? "";
    const bT = b.updated_at ?? b.created_at ?? "";
    return bT.localeCompare(aT);
  });

  const out = merged.slice(0, limit);
  console.info("[content repo] list", {
    count: out.length,
    storyCount: stories.length,
    articleCount: articles.length,
    subKind: opts.subKind ?? null,
    status: opts.status ?? null,
    language: opts.language ?? null,
  });
  return out;
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  created_at: string;
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  return one<UserRow>(
    "SELECT id, email, password_hash, role, created_at FROM users WHERE email = ?",
    [email.toLowerCase()],
  );
}

export async function getUserById(id: string): Promise<UserRow | null> {
  return one<UserRow>(
    "SELECT id, email, password_hash, role, created_at FROM users WHERE id = ?",
    [id],
  );
}

export async function countUsers(): Promise<number> {
  const r = await one<{ c: number }>("SELECT COUNT(*) AS c FROM users", []);
  return Number(r?.c ?? 0);
}

export async function createUser(u: {
  id: string;
  email: string;
  password_hash: string;
  role: string;
}): Promise<void> {
  await run(
    "INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    [u.id, u.email.toLowerCase(), u.password_hash, u.role, new Date().toISOString()],
  );
}
