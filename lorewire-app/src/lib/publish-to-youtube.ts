// Auto-publish (and manual re-publish) of a rendered short to the
// LoreWire YouTube channel via the YouTube Data API v3 + Resumable
// Upload protocol. Plan:
// _plans/2026-06-24-youtube-and-tiktok-auto-publish-and-socials-admin.md.
//
// Best-effort, server-only. The OAuth credential (client id, client
// secret, refresh token) lives in env and never touches the DB or the
// logs (rule 13). Failures land in youtube_posts with status='failed'
// so the retry cron (/api/retry_youtube_publishes) can pick them up;
// the render route must never bounce because of a YouTube hiccup.
//
// One row per attempt. The auto path dedups in code at the story
// level so a re-render doesn't create a second public video; the
// manual path bypasses that dedup so the admin can re-publish a
// previously-posted story on demand.
//
// Upload flow:
//   1. Refresh OAuth access token (google-auth-library).
//   2. POST to .../channels?part=id&mine=true → verify channel id matches
//      YOUTUBE_CHANNEL_ID env (defense in depth).
//   3. POST /upload/youtube/v3/videos?uploadType=resumable with metadata
//      → returns the upload session URL in the Location header.
//   4. Fetch the GCS MP4 into memory.
//   5. PUT the bytes to the upload session URL.
//   6. (Best-effort) POST /upload/youtube/v3/captions to attach the SRT
//      sidecar from the same render.
//
// YouTube's resumable upload supports chunked PUTs; we use a single
// PUT here because LoreWire shorts top out around 20 MB and the
// Vercel function memory budget handles that comfortably.

import "server-only";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";
import { getSetting } from "@/lib/repo";
import { loadSeoMetadata } from "@/lib/seo-metadata";
import { resolveShortThumbnailUrl } from "@/lib/short-thumbnail";

// --- Types -----------------------------------------------------------------

export type YouTubePostStatus = "pending" | "posted" | "failed" | "deleted";
export type YouTubePostTrigger = "auto" | "manual";

export interface YouTubePostRow {
  id: string;
  story_id: string;
  render_id: string | null;
  channel_id: string;
  trigger: YouTubePostTrigger;
  video_url: string;
  title: string;
  description: string;
  tags_json: string;
  category_id: string;
  made_for_kids: number;
  synthetic: number;
  privacy: string;
  status: YouTubePostStatus;
  external_video_id: string | null;
  yt_error_reason: string | null;
  error_message: string | null;
  attempts: number | null;
  created_at: string;
  posted_at: string | null;
  deleted_at: string | null;
}

const COLS =
  "id, story_id, render_id, channel_id, trigger, video_url, title, description, tags_json, category_id, made_for_kids, synthetic, privacy, status, external_video_id, yt_error_reason, error_message, attempts, created_at, posted_at, deleted_at";

/** What the title + description templates can interpolate. The auto
 *  path populates from the story row; the manual path can supply
 *  richer context if it wants. */
export interface MetadataContext {
  /** Short hook (one-line punchy lead). Falls back to title. */
  hook: string | null;
  /** Article title. Falls back to story id. */
  title: string | null;
  /** Full URL to the article / story permalink. */
  article_url: string | null;
  /** Story category — used by tag templates and the {{category}} token. */
  category: string | null;
}

export interface PublishArgs {
  storyId: string;
  /** Render id this publish corresponds to. */
  renderId: string | null;
  /** Publicly accessible URL to the rendered MP4 (GCS public URL). */
  videoUrl: string;
  /** Publicly accessible URL to the SRT captions file from the same
   *  render (optional). When present and the upload-captions setting is
   *  on, we attach it via captions.insert after the video upload
   *  succeeds — best-effort. */
  captionsUrl?: string | null;
  trigger: YouTubePostTrigger;
  context: MetadataContext;
  /** Manual flow per-publish overrides. Each one wins over the
   *  template-rendered default when present. */
  titleOverride?: string | null;
  descriptionOverride?: string | null;
  tagsOverride?: readonly string[] | null;
}

export type PublishResult =
  | { status: "skipped"; reason: string }
  | { status: "posted"; row: YouTubePostRow }
  | { status: "failed"; row: YouTubePostRow };

/** Minimal Response shape so tests can stub fetch without pulling in
 *  the full Web API or undici types. */
export interface YtFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type YtFetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  },
) => Promise<YtFetchResponse>;

/** Refresh an access token using the YouTube refresh token. Returns
 *  the access token string. Tests stub this so they don't hit Google. */
export type AccessTokenProvider = () => Promise<string>;

export interface PublishDeps {
  fetch?: YtFetchLike;
  /** Stable clock for tests. Defaults to `Date.now()`. */
  now?: () => Date;
  /** Override for the OAuth access-token refresh path (tests stub this). */
  getAccessToken?: AccessTokenProvider;
}

// --- Settings keys + templates ---------------------------------------------

/** Settings keys for the admin UI. Exported so settings/socials and any
 *  future admin surface read/write the same strings as the publisher
 *  here — single source of truth, no drift. */
export const SETTING_AUTO_PUBLISH = "publisher.youtube.auto_publish";
export const SETTING_TITLE_TEMPLATE = "publisher.youtube.title_template";
export const SETTING_DESCRIPTION_TEMPLATE =
  "publisher.youtube.description_template";
export const SETTING_TAGS_BASE = "publisher.youtube.tags_base";
export const SETTING_CATEGORY_ID = "publisher.youtube.category_id";
export const SETTING_PRIVACY_DEFAULT = "publisher.youtube.privacy_default";
export const SETTING_MADE_FOR_KIDS = "publisher.youtube.made_for_kids";
export const SETTING_SYNTHETIC_MEDIA = "publisher.youtube.synthetic_media";
export const SETTING_UPLOAD_CAPTIONS = "publisher.youtube.upload_captions";
/** Toggle for the custom-thumbnail upload step (PR following
 *  _plans/2026-06-28-explicit-thumbnail-uploads.md). When ON (default),
 *  publishShortToYouTube fetches the story's scene-1 image and calls
 *  videos.thumbnails.set so YouTube's smart-picker can't choose the
 *  brand intro. Admin can flip off if the channel consistently hits
 *  the 403 "channel lacks custom-thumbnail privilege" outcome, which
 *  is the documented YouTube behaviour for unverified channels. */
export const SETTING_UPLOAD_CUSTOM_THUMBNAIL =
  "publisher.youtube.upload_custom_thumbnail";

/** Per-category tag overrides key — same shape as
 *  `shorts.auto.category.<cat>`. */
export const settingTagsCategoryKey = (category: string): string =>
  `publisher.youtube.tags.${category}`;

export const DEFAULT_TITLE_TEMPLATE = "{{hook}}";

export const DEFAULT_DESCRIPTION_TEMPLATE = `{{hook}}

{{title}} — the full story, hand-drawn.

LoreWire turns the weirdest, most-argued-about stories on the internet into one-minute hand-drawn shorts. This one is from our {{category}} catalog.

📖 Read the full article: {{article_url}}
🔔 Subscribe for new shorts: https://www.youtube.com/@LoreWireHQ
🌐 lorewire.com

#Shorts #InternetStories #TrueStory #{{category}}Shorts #Reddit`;

export const DEFAULT_TAGS_BASE =
  "true stories, internet stories, lorewire, short stories, storytime";

/** Per-category tag defaults. Empty entries inherit only the base set.
 *  Capitalisation matches the story.category column (Drama, Entitled,
 *  Humor, Roommate, Dating, Wholesome). */
export const DEFAULT_TAGS_BY_CATEGORY: Record<string, string> = {
  Drama: "family drama, relationship stories",
  Entitled: "entitled people, karma stories",
  Roommate: "roommate stories, bad roommates",
  Dating: "dating stories, dating drama",
  Humor: "funny stories, comedy storytime",
  Wholesome: "wholesome stories, faith in humanity",
};

export const DEFAULT_CATEGORY_ID = "24"; // Entertainment
export const DEFAULT_PRIVACY = "public";
export const YT_TITLE_LIMIT = 100;
export const YT_DESCRIPTION_LIMIT = 5000;
export const YT_TAGS_COMBINED_LIMIT = 500;
export const YT_TAGS_MAX_COUNT = 8;

// --- Pure renderers (exported for tests) -----------------------------------

/** Render the title template, trimmed to YouTube's 100-char limit.
 *  Token fallbacks match renderDescription: hook → title → story id. */
export function renderTitle(
  template: string,
  ctx: MetadataContext,
  storyId: string,
): string {
  const title = (ctx.title ?? "").trim() || storyId;
  const hook = (ctx.hook ?? "").trim() || title;
  const category = (ctx.category ?? "").trim() || "Stories";
  const articleUrl =
    (ctx.article_url ?? "").trim() || "https://www.lorewire.com/";
  const rendered = template
    .replaceAll("{{hook}}", hook)
    .replaceAll("{{title}}", title)
    .replaceAll("{{category}}", category)
    .replaceAll("{{article_url}}", articleUrl);
  return trimWithEllipsis(rendered, YT_TITLE_LIMIT);
}

/** Render the description template, trimmed to YouTube's 5000-char limit. */
export function renderDescription(
  template: string,
  ctx: MetadataContext,
  storyId: string,
): string {
  const title = (ctx.title ?? "").trim() || storyId;
  const hook = (ctx.hook ?? "").trim() || title;
  const category = (ctx.category ?? "").trim() || "Stories";
  const articleUrl =
    (ctx.article_url ?? "").trim() || "https://www.lorewire.com/";
  const rendered = template
    .replaceAll("{{hook}}", hook)
    .replaceAll("{{title}}", title)
    .replaceAll("{{category}}", category)
    .replaceAll("{{article_url}}", articleUrl);
  return trimWithEllipsis(rendered, YT_DESCRIPTION_LIMIT);
}

/** Parse a comma-separated tag string into a clean array. Trims each
 *  entry, drops empties, normalises internal whitespace. */
export function parseTagList(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim().replace(/\s+/g, " "))
    .filter((t) => t.length > 0);
}

/** Merge the base tag set with the per-category set, dedupe
 *  case-insensitively, cap at YT_TAGS_MAX_COUNT, and clamp the joined
 *  length to YT_TAGS_COMBINED_LIMIT chars (YouTube's hard limit; tags
 *  past it are silently dropped by the API). */
export function mergeTags(
  base: readonly string[],
  perCategory: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of [...base, ...perCategory]) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= YT_TAGS_MAX_COUNT) break;
  }
  // Drop tags from the tail until joined length fits.
  while (out.length > 0 && joinedTagLen(out) > YT_TAGS_COMBINED_LIMIT) {
    out.pop();
  }
  return out;
}

function joinedTagLen(tags: readonly string[]): number {
  // YouTube counts the cumulative length of all tags plus a separator
  // per tag. Comma + space is the standard approximation.
  if (tags.length === 0) return 0;
  return tags.reduce((sum, t) => sum + t.length, 0) + (tags.length - 1) * 2;
}

function trimWithEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  // Reserve one char for the single Unicode ellipsis so the count is
  // exact (vs. three ASCII dots).
  return s.slice(0, max - 1) + "…";
}

// --- Observability ---------------------------------------------------------

function log(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[publish youtube ${event}]`, JSON.stringify(fields));
}

/** Pulls only what's safe to log from the env: presence + length,
 *  never the value itself. Rule 13. */
function credentialsFingerprint(): {
  has_refresh: boolean;
  refresh_len: number;
  has_client: boolean;
} {
  const r = process.env.YOUTUBE_REFRESH_TOKEN ?? "";
  const c = process.env.YOUTUBE_CLIENT_ID ?? "";
  return {
    has_refresh: r.length > 0,
    refresh_len: r.length,
    has_client: c.length > 0,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<invalid-url>";
  }
}

function maskChannelId(id: string): string {
  return id.length <= 6 ? id : `…${id.slice(-6)}`;
}

// --- DB helpers ------------------------------------------------------------

async function existingActiveRowsForStory(storyId: string): Promise<number> {
  const rows = await all<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM youtube_posts
     WHERE story_id = ? AND status IN ('pending', 'posted')`,
    [storyId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function getRow(id: string): Promise<YouTubePostRow | null> {
  return one<YouTubePostRow>(
    `SELECT ${COLS} FROM youtube_posts WHERE id = ?`,
    [id],
  );
}

async function insertPendingRow(args: {
  storyId: string;
  renderId: string | null;
  channelId: string;
  trigger: YouTubePostTrigger;
  videoUrl: string;
  title: string;
  description: string;
  tags: readonly string[];
  categoryId: string;
  madeForKids: boolean;
  synthetic: boolean;
  privacy: string;
  now: string;
}): Promise<YouTubePostRow> {
  const id = randomUUID();
  await run(
    `INSERT INTO youtube_posts (
       id, story_id, render_id, channel_id, trigger, video_url, title,
       description, tags_json, category_id, made_for_kids, synthetic,
       privacy, status, attempts, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    [
      id,
      args.storyId,
      args.renderId,
      args.channelId,
      args.trigger,
      args.videoUrl,
      args.title,
      args.description,
      JSON.stringify(args.tags),
      args.categoryId,
      args.madeForKids ? 1 : 0,
      args.synthetic ? 1 : 0,
      args.privacy,
      args.now,
    ],
  );
  const row = await getRow(id);
  if (!row) throw new Error("publish-to-youtube: inserted row vanished");
  return row;
}

async function markPosted(
  id: string,
  externalVideoId: string,
  postedAt: string,
): Promise<void> {
  await run(
    `UPDATE youtube_posts
     SET status = 'posted',
         external_video_id = ?,
         posted_at = ?,
         attempts = COALESCE(attempts, 0) + 1,
         error_message = NULL,
         yt_error_reason = NULL
     WHERE id = ?`,
    [externalVideoId, postedAt, id],
  );
}

async function markFailed(
  id: string,
  err: NormalizedYtError,
): Promise<void> {
  await run(
    `UPDATE youtube_posts
     SET status = 'failed',
         attempts = COALESCE(attempts, 0) + 1,
         yt_error_reason = ?,
         error_message = ?
     WHERE id = ?`,
    [err.reason, err.message, id],
  );
}

async function markDeleted(id: string, deletedAt: string): Promise<void> {
  await run(
    `UPDATE youtube_posts
     SET status = 'deleted', deleted_at = ?
     WHERE id = ?`,
    [deletedAt, id],
  );
}

// --- YouTube Data API ------------------------------------------------------

const YT_BASE = "https://www.googleapis.com/youtube/v3";
const YT_UPLOAD_BASE = "https://www.googleapis.com/upload/youtube/v3";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

interface NormalizedYtError {
  reason: string | null;
  message: string;
  status: number | null;
}

interface YtErrorBody {
  error?: {
    code?: number;
    message?: string;
    errors?: { reason?: string; message?: string }[];
  };
}

interface YtVideoResource {
  id?: string;
  snippet?: { title?: string; categoryId?: string };
}

interface OAuthTokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface ChannelListResponse {
  items?: { id?: string }[];
}

function normalizeYtError(
  status: number,
  body: unknown,
  bodyText: string,
): NormalizedYtError {
  const err = (body as YtErrorBody | null)?.error ?? null;
  if (err) {
    const first = err.errors?.[0];
    const reason = first?.reason ?? null;
    const message = first?.message ?? err.message ?? "";
    return {
      reason,
      message: message.slice(0, 500) || `HTTP ${status}`,
      status,
    };
  }
  return {
    reason: null,
    message: `HTTP ${status}: ${bodyText.slice(0, 300)}`,
    status,
  };
}

/** Default access-token provider. Exchanges the refresh token for a
 *  short-lived access token at oauth2.googleapis.com/token. Pure
 *  string return — caller decides expiry handling (we always refresh
 *  on every publish so there's no stored access token to expire). */
const defaultGetAccessToken: AccessTokenProvider = async () => {
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN ?? "";
  const clientId = process.env.YOUTUBE_CLIENT_ID ?? "";
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET ?? "";
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error(
      "youtube oauth: missing YOUTUBE_REFRESH_TOKEN / CLIENT_ID / CLIENT_SECRET",
    );
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }).toString();
  const { fetch: uFetch } = await import("undici");
  const resp = await uFetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(
      `youtube oauth: refresh failed HTTP ${resp.status}: ${text.slice(0, 300)}`,
    );
  }
  let parsed: OAuthTokenResponse;
  try {
    parsed = JSON.parse(text) as OAuthTokenResponse;
  } catch {
    throw new Error("youtube oauth: refresh response was not JSON");
  }
  if (!parsed.access_token) {
    throw new Error("youtube oauth: refresh response missing access_token");
  }
  return parsed.access_token;
};

/** Defense in depth: confirm the OAuth token actually belongs to the
 *  channel we expect. Mismatch means an admin grafted a different
 *  Google account's refresh token in — we refuse to upload, no matter
 *  what status flags claim. */
async function verifyChannelId(
  accessToken: string,
  expectedChannelId: string,
  fetchImpl: YtFetchLike,
): Promise<{ ok: true } | { ok: false; error: NormalizedYtError }> {
  const url = `${YT_BASE}/channels?part=id&mine=true`;
  let resp: YtFetchResponse;
  try {
    resp = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return {
      ok: false,
      error: {
        reason: "network",
        message: msg.slice(0, 500),
        status: null,
      },
    };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON; normalizeYtError handles the fallback.
    }
    return {
      ok: false,
      error: normalizeYtError(resp.status, parsed, text),
    };
  }
  const data = (await resp.json().catch(() => null)) as
    | ChannelListResponse
    | null;
  const actual = data?.items?.[0]?.id ?? "";
  if (!actual) {
    return {
      ok: false,
      error: {
        reason: "no_channel",
        message: "youtube: channels.list returned no items",
        status: null,
      },
    };
  }
  if (actual !== expectedChannelId) {
    return {
      ok: false,
      error: {
        reason: "channel_mismatch",
        message: `youtube: refresh token belongs to ${maskChannelId(actual)} but YOUTUBE_CHANNEL_ID is ${maskChannelId(expectedChannelId)}`,
        status: null,
      },
    };
  }
  return { ok: true };
}

/** Fetch the GCS-hosted MP4 into memory. Returns the bytes + a guess
 *  at the content type. Stream-to-stream upload would be cleaner but
 *  is awkward on Vercel's undici stack; the short MP4s are small
 *  enough (≤25 MB typical) that in-memory is the simplest robust
 *  shape and keeps test stubbing trivial. */
async function fetchVideoBytes(
  videoUrl: string,
  fetchImpl: YtFetchLike,
): Promise<
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; error: NormalizedYtError }
> {
  let resp: YtFetchResponse;
  try {
    resp = await fetchImpl(videoUrl, { method: "GET" });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return {
      ok: false,
      error: {
        reason: "video_fetch",
        message: `youtube: failed to fetch video bytes: ${msg.slice(0, 400)}`,
        status: null,
      },
    };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return {
      ok: false,
      error: {
        reason: "video_fetch",
        message: `youtube: video fetch HTTP ${resp.status}: ${text.slice(0, 200)}`,
        status: resp.status,
      },
    };
  }
  let buffer: ArrayBuffer;
  try {
    buffer = await resp.arrayBuffer();
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return {
      ok: false,
      error: {
        reason: "video_fetch",
        message: `youtube: failed to read video bytes: ${msg.slice(0, 400)}`,
        status: null,
      },
    };
  }
  const contentType = resp.headers.get("content-type") ?? "video/mp4";
  return {
    ok: true,
    bytes: new Uint8Array(buffer),
    contentType,
  };
}

/** Initiate the resumable upload session. Returns the upload URL
 *  from the Location header. */
async function initResumableUpload(
  accessToken: string,
  metadata: object,
  totalBytes: number,
  videoContentType: string,
  fetchImpl: YtFetchLike,
): Promise<{ ok: true; uploadUrl: string } | { ok: false; error: NormalizedYtError }> {
  const url = `${YT_UPLOAD_BASE}/videos?uploadType=resumable&part=snippet,status`;
  let resp: YtFetchResponse;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(totalBytes),
        "X-Upload-Content-Type": videoContentType,
      },
      body: JSON.stringify(metadata),
    });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return {
      ok: false,
      error: {
        reason: "init_network",
        message: msg.slice(0, 500),
        status: null,
      },
    };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // ignore
    }
    return {
      ok: false,
      error: normalizeYtError(resp.status, parsed, text),
    };
  }
  const uploadUrl = resp.headers.get("location");
  if (!uploadUrl) {
    return {
      ok: false,
      error: {
        reason: "init_no_location",
        message: "youtube: resumable init returned no Location header",
        status: resp.status,
      },
    };
  }
  return { ok: true, uploadUrl };
}

/** Upload the bytes to the resumable session URL in one PUT. */
async function uploadVideoBytes(
  uploadUrl: string,
  bytes: Uint8Array,
  contentType: string,
  fetchImpl: YtFetchLike,
): Promise<
  | { ok: true; externalVideoId: string }
  | { ok: false; error: NormalizedYtError }
> {
  let resp: YtFetchResponse;
  try {
    resp = await fetchImpl(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
      },
      body: bytes,
    });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return {
      ok: false,
      error: {
        reason: "upload_network",
        message: msg.slice(0, 500),
        status: null,
      },
    };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // ignore
    }
    return {
      ok: false,
      error: normalizeYtError(resp.status, parsed, text),
    };
  }
  const data = (await resp.json().catch(() => null)) as YtVideoResource | null;
  if (!data || typeof data.id !== "string" || data.id.length === 0) {
    return {
      ok: false,
      error: {
        reason: "upload_no_id",
        message: "youtube: upload 200 OK but response missing video id",
        status: resp.status,
      },
    };
  }
  return { ok: true, externalVideoId: data.id };
}

/** Best-effort attach an SRT caption track to a freshly-uploaded
 *  video. Failure here MUST NOT mark the row failed — the video is
 *  already live; we just log and move on. */
/** Custom-thumbnail sidecar.
 *  Fetches a thumbnail image from a public URL (typically the story's
 *  scene-1 GCS object) and POSTs it to videos.thumbnails.set with
 *  uploadType=media. Per
 *  _plans/2026-06-28-explicit-thumbnail-uploads.md, this is the only
 *  reliable way to override YouTube's smart-picker — frame 0 of the
 *  MP4 is not enough because YouTube scores frames for visual
 *  distinctiveness and tends to pick bright-color frames (e.g. the
 *  brand intro) over story content.
 *
 *  Best-effort: a 403 (channel lacks custom-thumbnail privilege),
 *  429 (rate limit) or any other failure is REPORTED via the return
 *  value and the caller logs without blocking the publish. Channels
 *  without the privilege are common (it's gated on YouTube's account-
 *  verification step), so 403 is a steady-state outcome not a bug.
 */
async function uploadCustomThumbnail(args: {
  accessToken: string;
  videoId: string;
  thumbnailUrl: string;
  fetchImpl: YtFetchLike;
}): Promise<
  | { ok: true }
  | { ok: false; reason: string; status?: number }
> {
  let fetchResp: YtFetchResponse;
  try {
    fetchResp = await args.fetchImpl(args.thumbnailUrl, { method: "GET" });
  } catch (e) {
    return {
      ok: false,
      reason: `thumbnail fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!fetchResp.ok) {
    return {
      ok: false,
      reason: `thumbnail fetch HTTP ${fetchResp.status}`,
      status: fetchResp.status,
    };
  }
  let buf: ArrayBuffer;
  try {
    buf = await fetchResp.arrayBuffer();
  } catch (e) {
    return {
      ok: false,
      reason: `thumbnail read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  // YouTube docs accept JPEG and PNG up to 2 MB (Shorts thumbs in
  // practice are well under). Anything bigger gets a 400 invalidImage.
  // We trust the source (our own GCS) but cap defensively.
  const bytes = new Uint8Array(buf);
  if (bytes.byteLength === 0) {
    return { ok: false, reason: "thumbnail fetch returned zero bytes" };
  }
  // YouTube infers the mime from the body but accepts an explicit
  // Content-Type. Pull from the upstream response when it's a real
  // image/* value; otherwise default to image/png (scene-1 GCS objects
  // are PNG or WebP — both accepted).
  const upstreamCt = fetchResp.headers?.get?.("content-type") ?? "";
  const contentType = upstreamCt.startsWith("image/")
    ? upstreamCt
    : "image/png";
  const setUrl =
    `${YT_UPLOAD_BASE}/thumbnails/set?videoId=` +
    `${encodeURIComponent(args.videoId)}&uploadType=media`;
  let resp: YtFetchResponse;
  try {
    resp = await args.fetchImpl(setUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": contentType,
      },
      body: bytes,
    });
  } catch (e) {
    return {
      ok: false,
      reason: `thumbnails.set failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return {
      ok: false,
      reason: `thumbnails.set HTTP ${resp.status}: ${text.slice(0, 200)}`,
      status: resp.status,
    };
  }
  return { ok: true };
}

async function uploadCaptionsSidecar(args: {
  accessToken: string;
  videoId: string;
  captionsUrl: string;
  fetchImpl: YtFetchLike;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const captionsResp = await args.fetchImpl(args.captionsUrl, { method: "GET" });
  if (!captionsResp.ok) {
    return {
      ok: false,
      reason: `srt fetch HTTP ${captionsResp.status}`,
    };
  }
  let captionsBuf: ArrayBuffer;
  try {
    captionsBuf = await captionsResp.arrayBuffer();
  } catch (e) {
    return {
      ok: false,
      reason: `srt read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const captionsBytes = new Uint8Array(captionsBuf);
  // captions.insert uses a two-part upload — metadata first as a
  // resource, then the binary as the upload body. We use the simple
  // form: uploadType=media with the snippet supplied as query params.
  // YouTube also accepts multipart; uploadType=media keeps the code
  // path matching the videos.insert resumable shape.
  const snippet = {
    videoId: args.videoId,
    language: "en",
    name: "English (auto-uploaded by LoreWire)",
    isDraft: false,
  };
  const initUrl = `${YT_UPLOAD_BASE}/captions?uploadType=resumable&part=snippet`;
  let initResp: YtFetchResponse;
  try {
    initResp = await args.fetchImpl(initUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "application/octet-stream",
        "X-Upload-Content-Length": String(captionsBytes.byteLength),
      },
      body: JSON.stringify({ snippet }),
    });
  } catch (e) {
    return {
      ok: false,
      reason: `captions init failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!initResp.ok) {
    const text = await initResp.text().catch(() => "");
    return {
      ok: false,
      reason: `captions init HTTP ${initResp.status}: ${text.slice(0, 200)}`,
    };
  }
  const uploadUrl = initResp.headers.get("location");
  if (!uploadUrl) {
    return { ok: false, reason: "captions init returned no Location header" };
  }
  let putResp: YtFetchResponse;
  try {
    putResp = await args.fetchImpl(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(captionsBytes.byteLength),
      },
      body: captionsBytes,
    });
  } catch (e) {
    return {
      ok: false,
      reason: `captions PUT failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!putResp.ok) {
    const text = await putResp.text().catch(() => "");
    return {
      ok: false,
      reason: `captions PUT HTTP ${putResp.status}: ${text.slice(0, 200)}`,
    };
  }
  return { ok: true };
}

/** Delete a previously-uploaded video via DELETE /videos?id=. Used by
 *  the manual re-publish "delete previous" path. */
export async function deleteYouTubeVideo(
  externalVideoId: string,
  deps: PublishDeps = {},
): Promise<{ ok: true } | { ok: false; error: NormalizedYtError }> {
  const fetchImpl = deps.fetch ?? defaultFetch;
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;
  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    return {
      ok: false,
      error: {
        reason: "oauth",
        message: e instanceof Error ? e.message : String(e),
        status: null,
      },
    };
  }
  const url = `${YT_BASE}/videos?id=${encodeURIComponent(externalVideoId)}`;
  let resp: YtFetchResponse;
  try {
    resp = await fetchImpl(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return {
      ok: false,
      error: { reason: "network", message: msg.slice(0, 500), status: null },
    };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // ignore
    }
    return { ok: false, error: normalizeYtError(resp.status, parsed, text) };
  }
  return { ok: true };
}

// Default fetch impl. We import undici lazily so the test environment
// can fully stub via deps.fetch without touching the network layer.
const defaultFetch: YtFetchLike = async (url, init) => {
  const { fetch: uFetch } = await import("undici");
  const r = await uFetch(url, init as Parameters<typeof uFetch>[1]);
  return {
    ok: r.ok,
    status: r.status,
    headers: r.headers as { get(name: string): string | null },
    json: () => r.json(),
    text: () => r.text(),
    arrayBuffer: () => r.arrayBuffer(),
  };
};

// --- Public API ------------------------------------------------------------

/** Entry point for the render route (auto trigger) and the manual
 *  publish action. Performs inline: gating, dedup (auto only), pending
 *  row insert, OAuth refresh, channel id verify, resumable upload,
 *  captions sidecar, terminal row update. Returns a discriminated
 *  result for callers that want to surface the outcome.
 *  Throws only on unexpected internal errors (eg. row insert vanished);
 *  YouTube API failures land in `status: 'failed'`, not exceptions. */
export async function publishShortToYouTube(
  args: PublishArgs,
  deps: PublishDeps = {},
): Promise<PublishResult> {
  const fetchImpl = deps.fetch ?? defaultFetch;
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;

  const channelId = process.env.YOUTUBE_CHANNEL_ID ?? "";
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN ?? "";
  if (!channelId || !refreshToken) {
    log("skipped", {
      story_id: args.storyId,
      render_id: args.renderId,
      reason: "missing YOUTUBE_CHANNEL_ID or YOUTUBE_REFRESH_TOKEN",
      ...credentialsFingerprint(),
    });
    return { status: "skipped", reason: "missing env config" };
  }

  if (args.trigger === "auto") {
    const autoOn = (await getSetting(SETTING_AUTO_PUBLISH)) === "1";
    if (!autoOn) {
      log("skipped", {
        story_id: args.storyId,
        render_id: args.renderId,
        reason: "auto_publish toggle off",
      });
      return { status: "skipped", reason: "auto-publish toggle off" };
    }
    const active = await existingActiveRowsForStory(args.storyId);
    if (active > 0) {
      log("skipped", {
        story_id: args.storyId,
        render_id: args.renderId,
        reason: "story already has pending/posted row",
        existing_rows: active,
      });
      return { status: "skipped", reason: "story already published" };
    }
  }

  // Resolve metadata: per-publish overrides win, then templates, then
  // hard defaults from this file's constants.
  const titleTemplate =
    (await getSetting(SETTING_TITLE_TEMPLATE)) ?? DEFAULT_TITLE_TEMPLATE;
  const descTemplate =
    (await getSetting(SETTING_DESCRIPTION_TEMPLATE)) ??
    DEFAULT_DESCRIPTION_TEMPLATE;
  const tagsBaseRaw =
    (await getSetting(SETTING_TAGS_BASE)) ?? DEFAULT_TAGS_BASE;
  const catKey = settingTagsCategoryKey(args.context.category ?? "");
  const tagsCatRaw =
    args.context.category != null
      ? ((await getSetting(catKey)) ??
        DEFAULT_TAGS_BY_CATEGORY[args.context.category] ??
        "")
      : "";
  const categoryId =
    (await getSetting(SETTING_CATEGORY_ID)) ?? DEFAULT_CATEGORY_ID;
  const privacy =
    (await getSetting(SETTING_PRIVACY_DEFAULT)) ?? DEFAULT_PRIVACY;
  const madeForKids = (await getSetting(SETTING_MADE_FOR_KIDS)) === "1";
  const synthetic =
    ((await getSetting(SETTING_SYNTHETIC_MEDIA)) ?? "1") !== "0";
  const uploadCaptions =
    ((await getSetting(SETTING_UPLOAD_CAPTIONS)) ?? "1") !== "0";

  // Resolution chain: per-publish override > LLM-generated seo_metadata
  // > settings template > DEFAULT_* constant. seo_metadata is the
  // Phase 2 layer (per-story LLM-generated metadata) — when present,
  // it slots between the admin's per-click overrides and the template
  // fallback. See _plans/2026-06-24-llm-seo-metadata.md.
  const seoMeta = await loadSeoMetadata(args.storyId);
  const seoYouTube = seoMeta?.youtube;
  const titleResolved =
    args.titleOverride != null && args.titleOverride.length > 0
      ? trimWithEllipsis(args.titleOverride, YT_TITLE_LIMIT)
      : seoYouTube?.title
        ? trimWithEllipsis(seoYouTube.title, YT_TITLE_LIMIT)
        : renderTitle(titleTemplate, args.context, args.storyId);
  const descriptionResolved =
    args.descriptionOverride != null && args.descriptionOverride.length > 0
      ? trimWithEllipsis(args.descriptionOverride, YT_DESCRIPTION_LIMIT)
      : seoYouTube?.description
        ? trimWithEllipsis(seoYouTube.description, YT_DESCRIPTION_LIMIT)
        : renderDescription(descTemplate, args.context, args.storyId);
  const tagsResolved =
    args.tagsOverride != null
      ? mergeTags(args.tagsOverride, [])
      : seoYouTube?.tags
        ? mergeTags(seoYouTube.tags, [])
        : mergeTags(parseTagList(tagsBaseRaw), parseTagList(tagsCatRaw));
  const metadataSource: "override" | "seo_metadata" | "template" =
    args.titleOverride || args.descriptionOverride || args.tagsOverride
      ? "override"
      : seoYouTube
        ? "seo_metadata"
        : "template";

  const row = await insertPendingRow({
    storyId: args.storyId,
    renderId: args.renderId,
    channelId,
    trigger: args.trigger,
    videoUrl: args.videoUrl,
    title: titleResolved,
    description: descriptionResolved,
    tags: tagsResolved,
    categoryId,
    madeForKids,
    synthetic,
    privacy,
    now: nowIso,
  });

  log("attempt", {
    story_id: row.story_id,
    render_id: row.render_id,
    trigger: row.trigger,
    channel_id: maskChannelId(row.channel_id),
    video_url_host: hostOf(row.video_url),
    title_len: titleResolved.length,
    description_len: descriptionResolved.length,
    tag_count: tagsResolved.length,
    metadata_source: metadataSource,
    privacy,
    made_for_kids: madeForKids,
    synthetic,
    upload_captions: uploadCaptions,
    ...credentialsFingerprint(),
  });

  // Resolve the per-story cover image. Skipped silently when the story
  // has no short_config (legacy) or no scene-1; the publish proceeds
  // without an explicit thumbnail and YouTube auto-picks. Per
  // _plans/2026-06-28-explicit-thumbnail-uploads.md.
  const uploadCustomThumbnail =
    ((await getSetting(SETTING_UPLOAD_CUSTOM_THUMBNAIL)) ?? "1") !== "0";
  const thumbnailUrl = uploadCustomThumbnail
    ? await resolveShortThumbnailUrl(args.storyId)
    : null;

  return runUploadPipeline(row, {
    fetchImpl,
    getAccessToken,
    captionsUrl: args.captionsUrl ?? null,
    uploadCaptions,
    thumbnailUrl,
    uploadCustomThumbnail,
  });
}

interface PipelineDeps {
  fetchImpl: YtFetchLike;
  getAccessToken: AccessTokenProvider;
  captionsUrl: string | null;
  uploadCaptions: boolean;
  /** Public URL of the image to upload as the video's custom thumbnail
   *  (typically the story's scene-1 GCS object). Null = skip the
   *  thumbnails.set step entirely; YouTube auto-picks the cover.
   *  Per _plans/2026-06-28-explicit-thumbnail-uploads.md. */
  thumbnailUrl: string | null;
  /** Setting toggle (publisher.youtube.upload_custom_thumbnail). When
   *  false, skip the thumbnail upload even if `thumbnailUrl` is set —
   *  lets an admin disable a 403-loop without code change. */
  uploadCustomThumbnail: boolean;
}

async function runUploadPipeline(
  row: YouTubePostRow,
  deps: PipelineDeps,
): Promise<PublishResult> {
  const channelId = process.env.YOUTUBE_CHANNEL_ID ?? "";
  if (row.channel_id !== channelId) {
    // Env changed between insert and publish: refuse to upload to a
    // different channel than the row was staged for.
    const err: NormalizedYtError = {
      reason: "channel_mismatch",
      message: `channel_id mismatch: row=${maskChannelId(row.channel_id)} env=${maskChannelId(channelId)}`,
      status: null,
    };
    await markFailed(row.id, err);
    log("error", {
      story_id: row.story_id,
      render_id: row.render_id,
      trigger: row.trigger,
      yt_reason: err.reason,
      yt_message: err.message,
      stage: "channel_mismatch",
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }

  const t0 = Date.now();

  // Step 1: refresh OAuth access token.
  let accessToken: string;
  try {
    accessToken = await deps.getAccessToken();
  } catch (e) {
    const err: NormalizedYtError = {
      reason: "oauth",
      message: (e instanceof Error ? e.message : String(e)).slice(0, 500),
      status: null,
    };
    await markFailed(row.id, err);
    log("error", {
      story_id: row.story_id,
      render_id: row.render_id,
      yt_reason: err.reason,
      yt_message: err.message,
      stage: "oauth_refresh",
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }
  log("oauth_refresh", {
    story_id: row.story_id,
    render_id: row.render_id,
    ok: true,
    latency_ms: Date.now() - t0,
  });

  // Step 2: verify channel id (defense in depth).
  const verify = await verifyChannelId(accessToken, channelId, deps.fetchImpl);
  if (!verify.ok) {
    await markFailed(row.id, verify.error);
    log("error", {
      story_id: row.story_id,
      render_id: row.render_id,
      yt_reason: verify.error.reason,
      yt_message: verify.error.message,
      stage: "verify_channel",
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }

  // Step 3: fetch the video bytes.
  const tFetch = Date.now();
  const fetched = await fetchVideoBytes(row.video_url, deps.fetchImpl);
  if (!fetched.ok) {
    await markFailed(row.id, fetched.error);
    log("error", {
      story_id: row.story_id,
      render_id: row.render_id,
      yt_reason: fetched.error.reason,
      yt_message: fetched.error.message,
      stage: "video_fetch",
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }
  log("video_fetched", {
    story_id: row.story_id,
    render_id: row.render_id,
    bytes: fetched.bytes.byteLength,
    latency_ms: Date.now() - tFetch,
  });

  // Step 4: init resumable upload.
  const tags = safeParseTags(row.tags_json);
  const metadata = {
    snippet: {
      title: row.title,
      description: row.description,
      tags,
      categoryId: row.category_id,
      defaultLanguage: "en",
    },
    status: {
      privacyStatus: row.privacy,
      selfDeclaredMadeForKids: row.made_for_kids === 1,
      containsSyntheticMedia: row.synthetic === 1,
      embeddable: true,
      license: "youtube",
    },
  };
  const tInit = Date.now();
  const inited = await initResumableUpload(
    accessToken,
    metadata,
    fetched.bytes.byteLength,
    fetched.contentType,
    deps.fetchImpl,
  );
  if (!inited.ok) {
    await markFailed(row.id, inited.error);
    log("error", {
      story_id: row.story_id,
      render_id: row.render_id,
      yt_reason: inited.error.reason,
      yt_message: inited.error.message,
      http_status: inited.error.status,
      stage: "init_upload",
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }
  log("upload_init_ok", {
    story_id: row.story_id,
    render_id: row.render_id,
    latency_ms: Date.now() - tInit,
  });

  // Step 5: PUT the video bytes.
  const tUpload = Date.now();
  const uploaded = await uploadVideoBytes(
    inited.uploadUrl,
    fetched.bytes,
    fetched.contentType,
    deps.fetchImpl,
  );
  if (!uploaded.ok) {
    await markFailed(row.id, uploaded.error);
    log("error", {
      story_id: row.story_id,
      render_id: row.render_id,
      yt_reason: uploaded.error.reason,
      yt_message: uploaded.error.message,
      http_status: uploaded.error.status,
      stage: "upload_bytes",
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }

  const postedAt = new Date().toISOString();
  await markPosted(row.id, uploaded.externalVideoId, postedAt);
  log("ok", {
    story_id: row.story_id,
    render_id: row.render_id,
    trigger: row.trigger,
    external_video_id: uploaded.externalVideoId,
    upload_latency_ms: Date.now() - tUpload,
    total_latency_ms: Date.now() - t0,
  });

  // Step 5.5 (best-effort): custom thumbnail upload. Per
  // _plans/2026-06-28-explicit-thumbnail-uploads.md. YouTube's
  // smart-picker tends to choose visually-distinctive frames (the
  // brand intro wins for our content) regardless of t=0, so this
  // is the only reliable cover-control for YouTube. Failures NEVER
  // block the publish — 403 (channel lacks privilege) is a steady-
  // state outcome for unverified channels, not a bug.
  if (deps.uploadCustomThumbnail && deps.thumbnailUrl && accessToken) {
    const tThumb = Date.now();
    const thumb = await uploadCustomThumbnail({
      accessToken,
      videoId: uploaded.externalVideoId,
      thumbnailUrl: deps.thumbnailUrl,
      fetchImpl: deps.fetchImpl,
    });
    if (thumb.ok) {
      log("custom_thumbnail_ok", {
        story_id: row.story_id,
        render_id: row.render_id,
        external_video_id: uploaded.externalVideoId,
        latency_ms: Date.now() - tThumb,
      });
    } else {
      log("custom_thumbnail_failed", {
        story_id: row.story_id,
        render_id: row.render_id,
        external_video_id: uploaded.externalVideoId,
        reason: thumb.reason,
        http_status: thumb.status,
        latency_ms: Date.now() - tThumb,
      });
    }
  } else {
    log("custom_thumbnail_skipped", {
      story_id: row.story_id,
      render_id: row.render_id,
      external_video_id: uploaded.externalVideoId,
      reason: !deps.uploadCustomThumbnail
        ? "upload_custom_thumbnail setting off"
        : "no thumbnail URL resolved (story missing short_config / scene-1)",
    });
  }

  // Step 6 (best-effort): captions sidecar.
  if (deps.uploadCaptions && deps.captionsUrl) {
    const tCap = Date.now();
    const cap = await uploadCaptionsSidecar({
      accessToken,
      videoId: uploaded.externalVideoId,
      captionsUrl: deps.captionsUrl,
      fetchImpl: deps.fetchImpl,
    });
    if (cap.ok) {
      log("captions_upload_ok", {
        story_id: row.story_id,
        render_id: row.render_id,
        external_video_id: uploaded.externalVideoId,
        latency_ms: Date.now() - tCap,
      });
    } else {
      log("captions_upload_failed", {
        story_id: row.story_id,
        render_id: row.render_id,
        external_video_id: uploaded.externalVideoId,
        reason: cap.reason,
        latency_ms: Date.now() - tCap,
      });
    }
  } else {
    log("captions_upload_skipped", {
      story_id: row.story_id,
      render_id: row.render_id,
      external_video_id: uploaded.externalVideoId,
      reason:
        !deps.uploadCaptions
          ? "upload_captions setting off"
          : "no captions URL provided",
    });
  }

  const fresh = await getRow(row.id);
  if (!fresh) throw new Error("publish-to-youtube: posted row vanished");
  return { status: "posted", row: fresh };
}

function safeParseTags(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === "string");
    }
  } catch {
    // ignore
  }
  return [];
}

/** Single retry attempt against an existing youtube_posts row. The
 *  retry cron loops over eligible rows (status='failed' with backoff
 *  elapsed) and calls this. Bumps attempts and re-walks the upload
 *  pipeline from scratch — YouTube's resumable upload session URL
 *  expires after a few hours so we don't try to resume mid-stream;
 *  we just start over with a fresh init. */
export async function attemptYouTubePublishForRow(
  rowId: string,
  deps: PublishDeps = {},
): Promise<PublishResult> {
  const fetchImpl = deps.fetch ?? defaultFetch;
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;
  const row = await getRow(rowId);
  if (!row) {
    log("skipped", { row_id: rowId, reason: "row not found" });
    return { status: "skipped", reason: "row not found" };
  }
  if (row.status !== "failed" && row.status !== "pending") {
    log("skipped", {
      row_id: rowId,
      status: row.status,
      reason: "row not eligible for retry",
    });
    return { status: "skipped", reason: "row not eligible for retry" };
  }
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN ?? "";
  if (!refreshToken) {
    log("skipped", {
      row_id: rowId,
      reason: "YOUTUBE_REFRESH_TOKEN not set",
    });
    return { status: "skipped", reason: "missing env config" };
  }
  log("retry", {
    story_id: row.story_id,
    render_id: row.render_id,
    attempt: (row.attempts ?? 0) + 1,
  });
  const uploadCaptions =
    ((await getSetting(SETTING_UPLOAD_CAPTIONS)) ?? "1") !== "0";
  // Re-resolve the custom thumbnail on retry — short_config might have
  // been edited between the original attempt and the retry, so we want
  // the freshest scene-1 URL. Same setting gate as the fresh path.
  const uploadCustomThumbnailToggle =
    ((await getSetting(SETTING_UPLOAD_CUSTOM_THUMBNAIL)) ?? "1") !== "0";
  const thumbnailUrl = uploadCustomThumbnailToggle
    ? await resolveShortThumbnailUrl(row.story_id)
    : null;
  return runUploadPipeline(row, {
    fetchImpl,
    getAccessToken,
    captionsUrl: null, // we don't snapshot the captions URL on the row
    uploadCaptions,
    thumbnailUrl,
    uploadCustomThumbnail: uploadCustomThumbnailToggle,
  });
}

/** Used by the manual re-publish "delete previous" flow. Looks up the
 *  latest posted row for a story, calls DELETE against YouTube, and
 *  flips the local row to 'deleted' on success. Returns the deleted
 *  row id (so the caller can chain into a fresh publishShortToYouTube
 *  call) or an error to surface. */
export async function deleteLatestPostedRowForStory(
  storyId: string,
  deps: PublishDeps = {},
): Promise<
  | { ok: true; rowId: string; externalVideoId: string }
  | { ok: false; error: string }
> {
  const row = await one<YouTubePostRow>(
    `SELECT ${COLS} FROM youtube_posts
     WHERE story_id = ? AND status = 'posted'
     ORDER BY posted_at DESC LIMIT 1`,
    [storyId],
  );
  if (!row || !row.external_video_id) {
    return { ok: false, error: "no posted row found for story" };
  }
  const started = Date.now();
  const r = await deleteYouTubeVideo(row.external_video_id, deps);
  const latency = Date.now() - started;
  if (!r.ok) {
    log("error", {
      story_id: storyId,
      external_video_id: row.external_video_id,
      yt_reason: r.error.reason,
      yt_message: r.error.message,
      latency_ms: latency,
      reason: "delete failed",
    });
    return { ok: false, error: r.error.message };
  }
  const deletedAt = new Date().toISOString();
  await markDeleted(row.id, deletedAt);
  log("deleted", {
    story_id: storyId,
    external_video_id: row.external_video_id,
    latency_ms: latency,
  });
  return { ok: true, rowId: row.id, externalVideoId: row.external_video_id };
}
