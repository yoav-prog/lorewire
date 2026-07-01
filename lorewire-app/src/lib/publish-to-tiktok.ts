// Auto-publish (and manual re-publish) of a rendered short to the
// LoreWire TikTok account via the Content Posting API. Plan:
// _plans/2026-06-24-youtube-and-tiktok-auto-publish-and-socials-admin.md.
//
// Best-effort, server-only. The OAuth credential (client key, client
// secret, refresh token) lives in env and never touches the DB or the
// logs (rule 13). Failures land in tiktok_posts with status='failed'
// so the retry cron (/api/retry_tiktok_publishes) can pick them up.
// The render route must never bounce because of a TikTok hiccup.
//
// Two-step async flow:
//   1. POST .../v2/oauth/token/  → access_token + (rotated) refresh_token
//      + open_id. defaultGetAccessToken validates open_id against env.
//   2. POST .../v2/post/publish/creator_info/query/  → allowed privacy
//      levels (the response intentionally does NOT include open_id; the
//      open_id defense-in-depth lives on the /oauth/token/ response).
//   3. POST .../v2/post/publish/{inbox|video}/init/  → publish_id
//   4. POLL .../v2/post/publish/status/fetch/?publish_id=...  until
//      PUBLISH_COMPLETE / FAILED / EXPIRED
//
// The post_mode setting controls step 3's endpoint:
//   - 'inbox'  → /v2/post/publish/inbox/video/init/  (drafts; works
//                without app audit). Status terminates at SEND_TO_USER_INBOX.
//   - 'direct' → /v2/post/publish/video/init/        (live post;
//                requires app audit). Status terminates at PUBLISH_COMPLETE.
//
// On the 30s inline poll timeout (still PROCESSING_*) the row stays
// `pending` WITH publish_id set so the retry cron can resume polling
// from the same publish_id instead of re-uploading (re-uploading
// would burn the daily post quota).

import "server-only";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";
import { getSetting } from "@/lib/repo";
import { loadSeoMetadata } from "@/lib/seo-metadata";

// --- Types -----------------------------------------------------------------

export type TikTokPostStatus = "pending" | "posted" | "failed" | "deleted";
export type TikTokPostTrigger = "auto" | "manual" | "scheduled";
export type TikTokPostMode = "inbox" | "direct";

export interface TikTokPostRow {
  id: string;
  story_id: string;
  render_id: string | null;
  open_id: string;
  trigger: TikTokPostTrigger;
  video_url: string;
  caption: string;
  privacy_level: string;
  post_mode: TikTokPostMode;
  is_aigc: number;
  disable_duet: number;
  disable_stitch: number;
  disable_comment: number;
  publish_id: string | null;
  status: TikTokPostStatus;
  external_post_id: string | null;
  tt_error_code: string | null;
  error_message: string | null;
  attempts: number | null;
  created_at: string;
  posted_at: string | null;
  deleted_at: string | null;
}

const COLS =
  "id, story_id, render_id, open_id, trigger, video_url, caption, privacy_level, post_mode, is_aigc, disable_duet, disable_stitch, disable_comment, publish_id, status, external_post_id, tt_error_code, error_message, attempts, created_at, posted_at, deleted_at";

export interface CaptionContext {
  hook: string | null;
  title: string | null;
  article_url: string | null;
  category: string | null;
}

export interface PublishArgs {
  storyId: string;
  renderId: string | null;
  videoUrl: string;
  trigger: TikTokPostTrigger;
  context: CaptionContext;
  /** Manual override for the caption (full text, no token substitution). */
  captionOverride?: string | null;
  /** Manual override for post_mode (defaults to the settings value). */
  postModeOverride?: TikTokPostMode | null;
}

export type PublishResult =
  | { status: "skipped"; reason: string }
  | { status: "posted"; row: TikTokPostRow }
  | { status: "pending"; row: TikTokPostRow }
  | { status: "failed"; row: TikTokPostRow };

export interface TtFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type TtFetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<TtFetchResponse>;

/** OAuth refresh result. TikTok rotates refresh tokens on every
 *  exchange (unlike Google), so the caller may need to persist the
 *  new refresh token for the next run. For owner-channel mode we
 *  let the rotation happen in env on each redeploy; observability
 *  surfaces the rotation count so we know when env needs updating. */
export interface AccessTokenBundle {
  access_token: string;
  open_id: string;
  refresh_token_rotated: boolean;
}

export type AccessTokenProvider = () => Promise<AccessTokenBundle>;

export interface PublishDeps {
  fetch?: TtFetchLike;
  now?: () => Date;
  sleepMs?: (ms: number) => Promise<void>;
  getAccessToken?: AccessTokenProvider;
}

// --- Settings keys + templates ---------------------------------------------

export const SETTING_AUTO_PUBLISH = "publisher.tiktok.auto_publish";
export const SETTING_POST_MODE = "publisher.tiktok.post_mode";
export const SETTING_CAPTION_TEMPLATE = "publisher.tiktok.caption_template";
export const SETTING_HASHTAGS_BASE = "publisher.tiktok.hashtags_base";
export const SETTING_PRIVACY_DEFAULT = "publisher.tiktok.privacy_default";
export const SETTING_IS_AIGC = "publisher.tiktok.is_aigc";
export const SETTING_DISABLE_DUET = "publisher.tiktok.disable_duet";
export const SETTING_DISABLE_STITCH = "publisher.tiktok.disable_stitch";
export const SETTING_DISABLE_COMMENT = "publisher.tiktok.disable_comment";

export const settingHashtagsCategoryKey = (category: string): string =>
  `publisher.tiktok.hashtags.${category}`;

/** Caption template default. Hook lands in the first line (the 50-char
 *  window TikTok exposes before the "more" cut). 5 hashtags inline,
 *  no #fyp / #foryou (saturated, near-zero signal in 2026 per SEO
 *  research in the plan). */
export const DEFAULT_CAPTION_TEMPLATE = `{{hook}}

The full story → {{article_url}}

#Shorts #TrueStory #InternetStories #{{category}}Stories #Reddit`;

/** The default caption template already inlines hashtags, so the
 *  base hashtag list is empty by default — admin can add a global
 *  base list that appends to the template-rendered caption. */
export const DEFAULT_HASHTAGS_BASE = "";

export const DEFAULT_HASHTAGS_BY_CATEGORY: Record<string, string> = {
  Drama: "",
  Entitled: "",
  Roommate: "",
  Dating: "",
  Humor: "",
  Wholesome: "",
};

export const DEFAULT_POST_MODE: TikTokPostMode = "inbox";
export const DEFAULT_PRIVACY_LEVEL = "PUBLIC_TO_EVERYONE";
export const TT_CAPTION_LIMIT = 2200;

// --- Pure renderers (exported for tests) -----------------------------------

export function renderCaption(
  template: string,
  ctx: CaptionContext,
  storyId: string,
): string {
  const title = (ctx.title ?? "").trim() || storyId;
  const hook = (ctx.hook ?? "").trim() || title;
  const category = (ctx.category ?? "").trim() || "Stories";
  const articleUrl =
    (ctx.article_url ?? "").trim() || "https://www.lorewire.com/";
  return template
    .replaceAll("{{hook}}", hook)
    .replaceAll("{{title}}", title)
    .replaceAll("{{category}}", category)
    .replaceAll("{{article_url}}", articleUrl);
}

/** Append extra hashtags to a rendered caption, deduplicating against
 *  any hashtags already present (case-insensitive) and trimming to the
 *  2200-char hard cap. Returns the new caption + a flag indicating
 *  whether trimming occurred so observability can flag truncated
 *  hooks. */
export function appendHashtags(
  caption: string,
  extras: readonly string[],
): { caption: string; truncated: boolean } {
  if (extras.length === 0) {
    const t = trimForTt(caption);
    return t;
  }
  const presentLower = new Set(
    Array.from(caption.matchAll(/#[\p{L}\p{N}_]+/gu)).map((m) =>
      m[0].toLowerCase(),
    ),
  );
  const toAdd: string[] = [];
  for (const tag of extras) {
    const t = tag.trim().replace(/^#?/, "#");
    if (t.length <= 1) continue;
    const key = t.toLowerCase();
    if (presentLower.has(key)) continue;
    presentLower.add(key);
    toAdd.push(t);
  }
  const joined =
    toAdd.length === 0 ? caption : caption + " " + toAdd.join(" ");
  return trimForTt(joined);
}

function trimForTt(s: string): { caption: string; truncated: boolean } {
  if (s.length <= TT_CAPTION_LIMIT) return { caption: s, truncated: false };
  return { caption: s.slice(0, TT_CAPTION_LIMIT - 1) + "…", truncated: true };
}

export function parseHashtagList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// --- Observability ---------------------------------------------------------

function log(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[publish tiktok ${event}]`, JSON.stringify(fields));
}

function credentialsFingerprint(): {
  has_refresh: boolean;
  refresh_len: number;
  has_client: boolean;
} {
  const r = process.env.TIKTOK_REFRESH_TOKEN ?? "";
  const c = process.env.TIKTOK_CLIENT_KEY ?? "";
  return {
    has_refresh: r.length > 0,
    refresh_len: r.length,
    has_client: c.length > 0,
  };
}

function maskOpenId(id: string): string {
  return id.length <= 6 ? id : `…${id.slice(-6)}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<invalid-url>";
  }
}

// --- DB helpers ------------------------------------------------------------

async function existingActiveRowsForStory(storyId: string): Promise<number> {
  const rows = await all<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM tiktok_posts
     WHERE story_id = ? AND status IN ('pending', 'posted')`,
    [storyId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function getRow(id: string): Promise<TikTokPostRow | null> {
  const row = await one<TikTokPostRow>(
    `SELECT ${COLS} FROM tiktok_posts WHERE id = ?`,
    [id],
  );
  return row;
}

async function insertPendingRow(args: {
  storyId: string;
  renderId: string | null;
  openId: string;
  trigger: TikTokPostTrigger;
  videoUrl: string;
  caption: string;
  privacyLevel: string;
  postMode: TikTokPostMode;
  isAigc: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  disableComment: boolean;
  now: string;
}): Promise<TikTokPostRow> {
  const id = randomUUID();
  await run(
    `INSERT INTO tiktok_posts (
       id, story_id, render_id, open_id, trigger, video_url, caption,
       privacy_level, post_mode, is_aigc, disable_duet, disable_stitch,
       disable_comment, status, attempts, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    [
      id,
      args.storyId,
      args.renderId,
      args.openId,
      args.trigger,
      args.videoUrl,
      args.caption,
      args.privacyLevel,
      args.postMode,
      args.isAigc ? 1 : 0,
      args.disableDuet ? 1 : 0,
      args.disableStitch ? 1 : 0,
      args.disableComment ? 1 : 0,
      args.now,
    ],
  );
  const row = await getRow(id);
  if (!row) throw new Error("publish-to-tiktok: inserted row vanished");
  return row;
}

async function setPublishId(id: string, publishId: string): Promise<void> {
  await run(`UPDATE tiktok_posts SET publish_id = ? WHERE id = ?`, [
    publishId,
    id,
  ]);
}

async function markPending(id: string): Promise<void> {
  await run(
    `UPDATE tiktok_posts
     SET status = 'pending', attempts = COALESCE(attempts, 0) + 1
     WHERE id = ?`,
    [id],
  );
}

async function markPosted(
  id: string,
  externalPostId: string | null,
  postedAt: string,
): Promise<void> {
  await run(
    `UPDATE tiktok_posts
     SET status = 'posted',
         external_post_id = ?,
         posted_at = ?,
         attempts = COALESCE(attempts, 0) + 1,
         error_message = NULL,
         tt_error_code = NULL
     WHERE id = ?`,
    [externalPostId, postedAt, id],
  );
}

async function markFailed(id: string, err: NormalizedTtError): Promise<void> {
  await run(
    `UPDATE tiktok_posts
     SET status = 'failed',
         attempts = COALESCE(attempts, 0) + 1,
         tt_error_code = ?,
         error_message = ?
     WHERE id = ?`,
    [err.code, err.message, id],
  );
}

async function markDeleted(id: string, deletedAt: string): Promise<void> {
  await run(
    `UPDATE tiktok_posts
     SET status = 'deleted', deleted_at = ?
     WHERE id = ?`,
    [deletedAt, id],
  );
}

// --- TikTok Content Posting API --------------------------------------------

const TT_OAUTH_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const TT_CREATOR_INFO_URL =
  "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const TT_DIRECT_INIT_URL =
  "https://open.tiktokapis.com/v2/post/publish/video/init/";
const TT_INBOX_INIT_URL =
  "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
const TT_STATUS_FETCH_URL =
  "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

const CONTAINER_POLL_TIMEOUT_MS = 30_000;
const CONTAINER_POLL_INTERVAL_MS = 2_000;

interface NormalizedTtError {
  code: string | null;
  message: string;
}

interface TtErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    log_id?: string;
  };
}

interface TtCreatorInfoData {
  privacy_level_options?: string[];
}

interface TtInitData {
  publish_id?: string;
}

interface TtStatusData {
  status?: string;
  publicly_available_post_id?: string[];
  fail_reason?: string;
}

function normalizeTtError(
  status: number,
  body: unknown,
  bodyText: string,
): NormalizedTtError {
  const env = (body as TtErrorEnvelope | null)?.error ?? null;
  if (env) {
    return {
      code: env.code ?? null,
      message: (env.message ?? "").slice(0, 500) || `HTTP ${status}`,
    };
  }
  return {
    code: null,
    message: `HTTP ${status}: ${bodyText.slice(0, 300)}`,
  };
}

/** Default access-token provider. Exchanges the refresh token at
 *  TikTok's /v2/oauth/token/. TikTok rotates the refresh token on
 *  every exchange — we surface that in the bundle so observability
 *  can warn when env needs updating. */
const defaultGetAccessToken: AccessTokenProvider = async () => {
  const refreshToken = process.env.TIKTOK_REFRESH_TOKEN ?? "";
  const clientKey = process.env.TIKTOK_CLIENT_KEY ?? "";
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET ?? "";
  const expectedOpenId = process.env.TIKTOK_OPEN_ID ?? "";
  if (!refreshToken || !clientKey || !clientSecret) {
    throw new Error(
      "tiktok oauth: missing TIKTOK_REFRESH_TOKEN / CLIENT_KEY / CLIENT_SECRET",
    );
  }
  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }).toString();
  const { fetch: uFetch } = await import("undici");
  const resp = await uFetch(TT_OAUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(
      `tiktok oauth: refresh failed HTTP ${resp.status}: ${text.slice(0, 300)}`,
    );
  }
  let parsed: {
    access_token?: string;
    refresh_token?: string;
    open_id?: string;
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("tiktok oauth: refresh response was not JSON");
  }
  if (!parsed.access_token || !parsed.open_id) {
    throw new Error(
      "tiktok oauth: refresh response missing access_token or open_id",
    );
  }
  // Defense in depth: refuse if open_id changed under us.
  if (expectedOpenId && parsed.open_id !== expectedOpenId) {
    throw new Error(
      `tiktok oauth: open_id mismatch — refresh token returned ${maskOpenId(parsed.open_id)} but TIKTOK_OPEN_ID is ${maskOpenId(expectedOpenId)}`,
    );
  }
  return {
    access_token: parsed.access_token,
    open_id: parsed.open_id,
    refresh_token_rotated:
      typeof parsed.refresh_token === "string" &&
      parsed.refresh_token.length > 0 &&
      parsed.refresh_token !== refreshToken,
  };
};

async function parseTtJson(
  resp: TtFetchResponse,
): Promise<
  | { ok: true; data: { data?: unknown; error?: TtErrorEnvelope["error"] } }
  | { ok: false; error: NormalizedTtError }
> {
  const text = await resp.text().catch(() => "");
  let parsed: { data?: unknown; error?: TtErrorEnvelope["error"] } | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (resp.ok) {
      return {
        ok: false,
        error: {
          code: null,
          message: "tiktok: response was not JSON",
        },
      };
    }
  }
  if (!resp.ok) {
    return {
      ok: false,
      error: normalizeTtError(resp.status, parsed, text),
    };
  }
  // TikTok wraps every response in {data, error}; error.code === "ok"
  // for the success path. Anything else is a logical failure.
  if (parsed && parsed.error && parsed.error.code && parsed.error.code !== "ok") {
    return {
      ok: false,
      error: normalizeTtError(resp.status, parsed, text),
    };
  }
  return { ok: true, data: parsed ?? {} };
}

async function queryCreatorInfo(
  accessToken: string,
  fetchImpl: TtFetchLike,
): Promise<
  | { ok: true; allowedPrivacyLevels: string[] }
  | { ok: false; error: NormalizedTtError }
> {
  let resp: TtFetchResponse;
  try {
    resp = await fetchImpl(TT_CREATOR_INFO_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: "",
    });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return {
      ok: false,
      error: { code: "network", message: msg.slice(0, 500) },
    };
  }
  const parsed = await parseTtJson(resp);
  if (!parsed.ok) return parsed;
  const data = (parsed.data?.data ?? {}) as TtCreatorInfoData;
  // TikTok's /creator_info/query/ response returns creator metadata
  // (nickname, avatar, privacy options, post-duration cap, toggles) but
  // NOT open_id. The open_id defense-in-depth happens upstream against
  // the /oauth/token/ response (see defaultGetAccessToken). Don't
  // re-check it here — a missing field would never appear, so the only
  // outcome of checking would be a false-positive failure on every run.
  const allowed = Array.isArray(data.privacy_level_options)
    ? data.privacy_level_options.filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  return { ok: true, allowedPrivacyLevels: allowed };
}

/** Pick a privacy_level the account is allowed to use. Falls through
 *  in this order: requested → SELF_ONLY → first allowed. SELF_ONLY is
 *  the safest fallback because every audited and unaudited account
 *  supports it; the publisher logs the swap so admin sees what was
 *  used. */
export function pickAllowedPrivacy(
  requested: string,
  allowed: readonly string[],
): { picked: string; fellBackFrom: string | null } {
  if (allowed.length === 0) {
    return { picked: requested, fellBackFrom: null };
  }
  if (allowed.includes(requested)) {
    return { picked: requested, fellBackFrom: null };
  }
  if (allowed.includes("SELF_ONLY")) {
    return { picked: "SELF_ONLY", fellBackFrom: requested };
  }
  return { picked: allowed[0], fellBackFrom: requested };
}

interface InitArgs {
  accessToken: string;
  caption: string;
  privacyLevel: string;
  postMode: TikTokPostMode;
  isAigc: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  disableComment: boolean;
  videoUrl: string;
}

async function initPublish(
  args: InitArgs,
  fetchImpl: TtFetchLike,
): Promise<
  | { ok: true; publishId: string }
  | { ok: false; error: NormalizedTtError }
> {
  const url =
    args.postMode === "direct" ? TT_DIRECT_INIT_URL : TT_INBOX_INIT_URL;
  // post_info shape: only the direct endpoint accepts privacy_level
  // and the brand toggles; the inbox endpoint ignores them.
  const postInfo: Record<string, unknown> =
    args.postMode === "direct"
      ? {
          title: args.caption,
          privacy_level: args.privacyLevel,
          disable_duet: args.disableDuet,
          disable_stitch: args.disableStitch,
          disable_comment: args.disableComment,
          video_cover_timestamp_ms: 0,
          brand_content_toggle: false,
          brand_organic_toggle: false,
          is_aigc: args.isAigc,
        }
      : {
          title: args.caption,
          // Pick the very first frame as the draft cover so the inbox
          // preview shows the cold-open scene (per the hook-first splice
          // PR #135) instead of TikTok's auto-pick. The direct branch
          // above already sets this; mirror here so a draft and a live
          // post agree on the cover. Per
          // _plans/2026-06-28-explicit-thumbnail-uploads.md.
          video_cover_timestamp_ms: 0,
          is_aigc: args.isAigc,
        };
  const body = JSON.stringify({
    post_info: postInfo,
    source_info: {
      source: "PULL_FROM_URL",
      video_url: args.videoUrl,
    },
  });
  let resp: TtFetchResponse;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body,
    });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ok: false, error: { code: "network", message: msg.slice(0, 500) } };
  }
  const parsed = await parseTtJson(resp);
  if (!parsed.ok) return parsed;
  const data = (parsed.data?.data ?? {}) as TtInitData;
  if (!data.publish_id) {
    return {
      ok: false,
      error: {
        code: "no_publish_id",
        message: "tiktok: init response missing publish_id",
      },
    };
  }
  return { ok: true, publishId: data.publish_id };
}

interface StatusFetchOk {
  status: string;
  externalPostId: string | null;
}

async function fetchStatus(
  accessToken: string,
  publishId: string,
  fetchImpl: TtFetchLike,
): Promise<
  | { ok: true; result: StatusFetchOk }
  | { ok: false; error: NormalizedTtError }
> {
  let resp: TtFetchResponse;
  try {
    resp = await fetchImpl(TT_STATUS_FETCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ publish_id: publishId }),
    });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ok: false, error: { code: "network", message: msg.slice(0, 500) } };
  }
  const parsed = await parseTtJson(resp);
  if (!parsed.ok) return parsed;
  const data = (parsed.data?.data ?? {}) as TtStatusData;
  const status = (data.status ?? "").toString();
  const externalPostId = Array.isArray(data.publicly_available_post_id)
    ? (data.publicly_available_post_id[0] ?? null)
    : null;
  if (!status) {
    return {
      ok: false,
      error: {
        code: "no_status",
        message: "tiktok: status response missing status field",
      },
    };
  }
  // FAILED carries a fail_reason in the data envelope.
  if (status === "FAILED") {
    return {
      ok: false,
      error: {
        code: data.fail_reason ?? "FAILED",
        message: `tiktok publish failed: ${data.fail_reason ?? "unknown"}`,
      },
    };
  }
  return { ok: true, result: { status, externalPostId } };
}

type PollOutcome =
  | { kind: "complete"; externalPostId: string | null }
  | { kind: "failed"; error: NormalizedTtError }
  | { kind: "timeout"; lastStatus: string };

async function pollUntilTerminal(args: {
  rowId: string;
  storyId: string;
  publishId: string;
  postMode: TikTokPostMode;
  accessToken: string;
  fetchImpl: TtFetchLike;
  sleep: (ms: number) => Promise<void>;
}): Promise<PollOutcome> {
  const started = Date.now();
  let pollN = 0;
  let lastStatus = "UNKNOWN";
  while (Date.now() - started < CONTAINER_POLL_TIMEOUT_MS) {
    pollN += 1;
    const res = await fetchStatus(
      args.accessToken,
      args.publishId,
      args.fetchImpl,
    );
    if (!res.ok) {
      return { kind: "failed", error: res.error };
    }
    lastStatus = res.result.status;
    log("status_poll", {
      story_id: args.storyId,
      row_id: args.rowId,
      publish_id: args.publishId,
      status_code: lastStatus,
      poll_n: pollN,
      elapsed_ms: Date.now() - started,
    });
    // Terminal happy-path statuses differ by post mode.
    // - direct: PUBLISH_COMPLETE → live; the post id appears in
    //   publicly_available_post_id.
    // - inbox: SEND_TO_USER_INBOX → user can publish from drafts.
    //   No external_post_id is available until the user publishes.
    if (
      args.postMode === "direct"
      && (lastStatus === "PUBLISH_COMPLETE" || lastStatus === "PUBLISHED")
    ) {
      return { kind: "complete", externalPostId: res.result.externalPostId };
    }
    if (args.postMode === "inbox" && lastStatus === "SEND_TO_USER_INBOX") {
      return { kind: "complete", externalPostId: null };
    }
    await args.sleep(CONTAINER_POLL_INTERVAL_MS);
  }
  return { kind: "timeout", lastStatus };
}

// Default fetch impl. We import undici lazily so the test environment
// can fully stub via deps.fetch without touching the network layer.
const defaultFetch: TtFetchLike = async (url, init) => {
  const { fetch: uFetch } = await import("undici");
  const r = await uFetch(url, init as Parameters<typeof uFetch>[1]);
  return {
    ok: r.ok,
    status: r.status,
    json: () => r.json(),
    text: () => r.text(),
  };
};

// --- Public API ------------------------------------------------------------

export async function publishShortToTikTok(
  args: PublishArgs,
  deps: PublishDeps = {},
): Promise<PublishResult> {
  const fetchImpl = deps.fetch ?? defaultFetch;
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;

  const expectedOpenId = process.env.TIKTOK_OPEN_ID ?? "";
  const refreshToken = process.env.TIKTOK_REFRESH_TOKEN ?? "";
  if (!expectedOpenId || !refreshToken) {
    log("skipped", {
      story_id: args.storyId,
      render_id: args.renderId,
      reason: "missing TIKTOK_OPEN_ID or TIKTOK_REFRESH_TOKEN",
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
  }
  // A 'scheduled' publish comes from the Publish Scheduler: it bypasses the
  // auto_publish toggle (the schedule IS the intent) but still honors
  // story-level dedup, so a re-dispatch or a manual+scheduled overlap
  // cannot double-post.
  if (args.trigger !== "manual") {
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

  // Resolve metadata.
  const captionTemplate =
    (await getSetting(SETTING_CAPTION_TEMPLATE)) ?? DEFAULT_CAPTION_TEMPLATE;
  const baseHashtagsRaw =
    (await getSetting(SETTING_HASHTAGS_BASE)) ?? DEFAULT_HASHTAGS_BASE;
  const catKey = settingHashtagsCategoryKey(args.context.category ?? "");
  const catHashtagsRaw =
    args.context.category != null
      ? ((await getSetting(catKey)) ??
        DEFAULT_HASHTAGS_BY_CATEGORY[args.context.category] ??
        "")
      : "";
  const privacyDefault =
    (await getSetting(SETTING_PRIVACY_DEFAULT)) ?? DEFAULT_PRIVACY_LEVEL;
  const isAigc = ((await getSetting(SETTING_IS_AIGC)) ?? "1") !== "0";
  const disableDuet = (await getSetting(SETTING_DISABLE_DUET)) === "1";
  const disableStitch = (await getSetting(SETTING_DISABLE_STITCH)) === "1";
  const disableComment = (await getSetting(SETTING_DISABLE_COMMENT)) === "1";
  const settingsPostMode = await getSetting(SETTING_POST_MODE);
  const postModeFromSettings: TikTokPostMode =
    settingsPostMode === "direct" ? "direct" : "inbox";
  const postMode: TikTokPostMode =
    args.postModeOverride ?? postModeFromSettings;

  // Resolution chain: per-publish override > seo_metadata > template.
  // When seo_metadata.tiktok.caption is present, it already includes
  // the LLM-curated hashtags inline so we skip the appendHashtags step
  // for that source — adding more on top would push past TikTok's
  // 3-5 hashtag sweet spot.
  const seoMeta = await loadSeoMetadata(args.storyId);
  const seoTikTokCaption = seoMeta?.tiktok?.caption;
  let metadataSource: "override" | "seo_metadata" | "template" = "template";
  let rendered: string;
  let extras: readonly string[];
  if (args.captionOverride != null && args.captionOverride.length > 0) {
    rendered = args.captionOverride;
    extras = [];
    metadataSource = "override";
  } else if (seoTikTokCaption) {
    rendered = seoTikTokCaption;
    extras = [];
    metadataSource = "seo_metadata";
  } else {
    rendered = renderCaption(captionTemplate, args.context, args.storyId);
    extras = [
      ...parseHashtagList(baseHashtagsRaw),
      ...parseHashtagList(catHashtagsRaw),
    ];
  }
  const { caption, truncated } = appendHashtags(rendered, extras);

  const row = await insertPendingRow({
    storyId: args.storyId,
    renderId: args.renderId,
    openId: expectedOpenId,
    trigger: args.trigger,
    videoUrl: args.videoUrl,
    caption,
    privacyLevel: privacyDefault,
    postMode,
    isAigc,
    disableDuet,
    disableStitch,
    disableComment,
    now: nowIso,
  });

  log("attempt", {
    story_id: row.story_id,
    render_id: row.render_id,
    trigger: row.trigger,
    open_id: maskOpenId(row.open_id),
    video_url_host: hostOf(row.video_url),
    caption_len: caption.length,
    caption_truncated: truncated,
    metadata_source: metadataSource,
    post_mode: postMode,
    privacy_level: privacyDefault,
    is_aigc: isAigc,
    ...credentialsFingerprint(),
  });

  return runFullPipeline(row, fetchImpl, deps);
}

async function runFullPipeline(
  row: TikTokPostRow,
  fetchImpl: TtFetchLike,
  deps: PublishDeps,
): Promise<PublishResult> {
  const expectedOpenId = process.env.TIKTOK_OPEN_ID ?? "";
  if (row.open_id !== expectedOpenId) {
    const err: NormalizedTtError = {
      code: "open_id_mismatch",
      message: `open_id mismatch: row=${maskOpenId(row.open_id)} env=${maskOpenId(expectedOpenId)}`,
    };
    await markFailed(row.id, err);
    log("error", {
      story_id: row.story_id,
      render_id: row.render_id,
      tt_code: err.code,
      tt_message: err.message,
      stage: "open_id_mismatch",
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }

  const t0 = Date.now();
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;
  const sleep =
    deps.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // Step 1: OAuth refresh.
  let bundle: AccessTokenBundle;
  try {
    bundle = await getAccessToken();
  } catch (e) {
    const err: NormalizedTtError = {
      code: "oauth",
      message: (e instanceof Error ? e.message : String(e)).slice(0, 500),
    };
    await markFailed(row.id, err);
    log("error", {
      story_id: row.story_id,
      render_id: row.render_id,
      tt_code: err.code,
      tt_message: err.message,
      stage: "oauth_refresh",
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }
  log("oauth_refresh", {
    story_id: row.story_id,
    render_id: row.render_id,
    ok: true,
    refresh_token_rotated: bundle.refresh_token_rotated,
    open_id: maskOpenId(bundle.open_id),
    latency_ms: Date.now() - t0,
  });

  // Step 2: creator info query (verifies open_id, returns allowed
  // privacy levels). Skip in inbox mode — privacy is not a thing in
  // drafts — but we still want the defense-in-depth open_id check, so
  // we do the query regardless.
  const creator = await queryCreatorInfo(bundle.access_token, fetchImpl);
  if (!creator.ok) {
    await markFailed(row.id, creator.error);
    log("error", {
      story_id: row.story_id,
      render_id: row.render_id,
      tt_code: creator.error.code,
      tt_message: creator.error.message,
      stage: "creator_info_query",
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }
  log("creator_info_query", {
    story_id: row.story_id,
    render_id: row.render_id,
    allowed_privacy: creator.allowedPrivacyLevels,
    latency_ms: Date.now() - t0,
  });
  const { picked: privacyLevel, fellBackFrom } = pickAllowedPrivacy(
    row.privacy_level,
    creator.allowedPrivacyLevels,
  );
  if (fellBackFrom) {
    log("privacy_fallback", {
      story_id: row.story_id,
      render_id: row.render_id,
      requested: fellBackFrom,
      picked: privacyLevel,
      allowed: creator.allowedPrivacyLevels,
    });
  }

  // Step 3: init publish.
  let publishId = row.publish_id;
  if (!publishId) {
    const init = await initPublish(
      {
        accessToken: bundle.access_token,
        caption: row.caption,
        privacyLevel,
        postMode: row.post_mode,
        isAigc: row.is_aigc === 1,
        disableDuet: row.disable_duet === 1,
        disableStitch: row.disable_stitch === 1,
        disableComment: row.disable_comment === 1,
        videoUrl: row.video_url,
      },
      fetchImpl,
    );
    if (!init.ok) {
      await markFailed(row.id, init.error);
      log("error", {
        story_id: row.story_id,
        render_id: row.render_id,
        tt_code: init.error.code,
        tt_message: init.error.message,
        stage: "init",
      });
      const fresh = await getRow(row.id);
      return { status: "failed", row: fresh ?? row };
    }
    publishId = init.publishId;
    await setPublishId(row.id, publishId);
    log("init", {
      story_id: row.story_id,
      render_id: row.render_id,
      publish_id: publishId,
      post_mode: row.post_mode,
      latency_ms: Date.now() - t0,
    });
  }

  // Step 4: poll until terminal.
  const poll = await pollUntilTerminal({
    rowId: row.id,
    storyId: row.story_id,
    publishId,
    postMode: row.post_mode,
    accessToken: bundle.access_token,
    fetchImpl,
    sleep,
  });
  if (poll.kind === "timeout") {
    await markPending(row.id);
    log("status_timeout", {
      story_id: row.story_id,
      render_id: row.render_id,
      publish_id: publishId,
      last_status: poll.lastStatus,
      elapsed_ms: Date.now() - t0,
    });
    const fresh = await getRow(row.id);
    return { status: "pending", row: fresh ?? row };
  }
  if (poll.kind === "failed") {
    await markFailed(row.id, poll.error);
    log("error", {
      story_id: row.story_id,
      render_id: row.render_id,
      tt_code: poll.error.code,
      tt_message: poll.error.message,
      stage: "status_poll",
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }
  const postedAt = new Date().toISOString();
  await markPosted(row.id, poll.externalPostId, postedAt);
  log("ok", {
    story_id: row.story_id,
    render_id: row.render_id,
    trigger: row.trigger,
    post_mode: row.post_mode,
    external_post_id: poll.externalPostId,
    total_latency_ms: Date.now() - t0,
  });
  const fresh = await getRow(row.id);
  if (!fresh) throw new Error("publish-to-tiktok: posted row vanished");
  return { status: "posted", row: fresh };
}

/** Single retry attempt against an existing tiktok_posts row.
 *  Resumes from publish_id when set (skipping the init), otherwise
 *  re-walks the full pipeline. */
export async function attemptTikTokPublishForRow(
  rowId: string,
  deps: PublishDeps = {},
): Promise<PublishResult> {
  const fetchImpl = deps.fetch ?? defaultFetch;
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
  const refreshToken = process.env.TIKTOK_REFRESH_TOKEN ?? "";
  if (!refreshToken) {
    log("skipped", { row_id: rowId, reason: "TIKTOK_REFRESH_TOKEN not set" });
    return { status: "skipped", reason: "missing env config" };
  }
  log("retry", {
    story_id: row.story_id,
    render_id: row.render_id,
    attempt: (row.attempts ?? 0) + 1,
    resume_from: row.publish_id ? "publish_id" : "init",
  });
  return runFullPipeline(row, fetchImpl, deps);
}

/** Used by the manual re-publish "delete previous" flow. TikTok's
 *  Content Posting API does not expose a delete endpoint — we just
 *  mark the local row as deleted so the manual republish has a clean
 *  state to insert into. The actual TikTok post (if any) stays live
 *  on the user's profile and must be removed in the TikTok app. */
export async function deleteLatestPostedRowForStory(
  storyId: string,
): Promise<
  | { ok: true; rowId: string; externalPostId: string | null }
  | { ok: false; error: string }
> {
  const row = await one<TikTokPostRow>(
    `SELECT ${COLS} FROM tiktok_posts
     WHERE story_id = ? AND status = 'posted'
     ORDER BY posted_at DESC LIMIT 1`,
    [storyId],
  );
  if (!row) {
    return { ok: false, error: "no posted row found for story" };
  }
  const deletedAt = new Date().toISOString();
  await markDeleted(row.id, deletedAt);
  log("deleted", {
    story_id: storyId,
    external_post_id: row.external_post_id,
    note: "tiktok api has no delete endpoint; local row only",
  });
  return {
    ok: true,
    rowId: row.id,
    externalPostId: row.external_post_id,
  };
}
