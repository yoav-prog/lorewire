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
  tokens: number | null;
  cost_cents: number | null;
  created_at: string | null;
  updated_at: string | null;
  published_at: string | null;
  payload: string | null;
}

const COLS =
  "id, reddit_id, slug, category, title, summary, body, teleprompter, status, source_url, hero_image, images, audio_url, video_url, duration, alignment, tokens, cost_cents, created_at, updated_at, published_at, payload";

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

export async function getStory(id: string): Promise<StoryRow | null> {
  return one<StoryRow>(`SELECT ${COLS} FROM stories WHERE id = ?`, [id]);
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

export async function setSetting(key: string, value: string): Promise<void> {
  await run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
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
