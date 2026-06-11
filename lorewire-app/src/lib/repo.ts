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
  tokens: number | null;
  cost_cents: number | null;
  created_at: string | null;
  updated_at: string | null;
  published_at: string | null;
  payload: string | null;
}

const COLS =
  "id, reddit_id, slug, category, title, summary, body, teleprompter, status, source_url, hero_image, images, audio_url, video_url, duration, alignment, intro_segment_id, outro_segment_id, skip_intro, skip_outro, tokens, cost_cents, created_at, updated_at, published_at, payload";

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
  created_at: string | null;
  updated_at: string | null;
}

const SEGMENT_COLS =
  "id, kind, label, source_url, normalized_url, duration_ms, enabled, created_at, updated_at";

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
}): Promise<void> {
  const now = new Date().toISOString();
  await run(
    `INSERT INTO video_segments (id, kind, label, source_url, normalized_url, duration_ms, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       label = excluded.label,
       source_url = excluded.source_url,
       normalized_url = excluded.normalized_url,
       duration_ms = excluded.duration_ms,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
    [
      s.id,
      s.kind,
      s.label ?? null,
      s.source_url ?? null,
      s.normalized_url ?? null,
      s.duration_ms ?? null,
      s.enabled ?? 1,
      now,
      now,
    ],
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
