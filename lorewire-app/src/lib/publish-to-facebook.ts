// Auto-publish (and manual re-publish) of a rendered short to the
// LoreWire Facebook Page via the Graph API. Plan:
// _plans/2026-06-23-facebook-auto-publish.md.
//
// Best-effort, server-only. The credential (Page Access Token) lives
// in FB_PAGE_ACCESS_TOKEN and never touches the DB or the logs (rule
// 13). Failures land in facebook_posts with status='failed' so the
// retry cron (/api/retry_facebook_publishes) can pick them up; the
// render route must never bounce because of a Facebook hiccup.
//
// One row per attempt. The auto path dedups in code at the story
// level so a re-render doesn't create a second public post; the
// manual path bypasses that dedup so the admin can re-publish a
// previously-posted story on demand.

import "server-only";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";
import { getSetting } from "@/lib/repo";
import { loadSeoMetadata } from "@/lib/seo-metadata";
import { ensureShortPoster } from "@/lib/short-poster";
import { resolveShortThumbnailUrl } from "@/lib/short-thumbnail";

// --- Types -----------------------------------------------------------------

export type FacebookPostStatus = "pending" | "posted" | "failed" | "deleted";
export type FacebookPostTrigger = "auto" | "manual";

export interface FacebookPostRow {
  id: string;
  story_id: string;
  render_id: string | null;
  page_id: string;
  trigger: FacebookPostTrigger;
  video_url: string;
  caption: string;
  status: FacebookPostStatus;
  external_post_id: string | null;
  fb_error_code: number | null;
  fb_error_subcode: number | null;
  error_message: string | null;
  attempts: number | null;
  created_at: string;
  posted_at: string | null;
  deleted_at: string | null;
}

const COLS =
  "id, story_id, render_id, page_id, trigger, video_url, caption, status, external_post_id, fb_error_code, fb_error_subcode, error_message, attempts, created_at, posted_at, deleted_at";

/** What the caption template can interpolate. The auto path populates
 *  from the story row; the manual path can supply richer context if it
 *  wants (e.g. the article slug it already has on hand). */
export interface CaptionContext {
  /** Short hook (one-line punchy lead). Falls back to title when empty. */
  hook: string | null;
  /** Article title. Falls back to story id as a last resort. */
  title: string | null;
  /** Full URL to the article / story permalink. */
  article_url: string | null;
}

export interface PublishArgs {
  storyId: string;
  /** Render id this publish corresponds to (auto path always supplies
   *  it; manual path may omit when re-publishing an older short). */
  renderId: string | null;
  /** Publicly accessible URL to the rendered MP4 (GCS public URL). */
  videoUrl: string;
  trigger: FacebookPostTrigger;
  context: CaptionContext;
  /** Manual flow can override the rendered caption with admin-edited
   *  text. The auto flow leaves this null and renders from the
   *  template setting. */
  captionOverride?: string | null;
}

export type PublishResult =
  | { status: "skipped"; reason: string }
  | { status: "posted"; row: FacebookPostRow }
  | { status: "failed"; row: FacebookPostRow };

/** Minimal Response shape so tests can stub fetch without pulling in
 *  the full Web API or undici types. */
export interface FbFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FbFetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    /** undici fetch accepts string, FormData, Uint8Array, etc. for the
     *  body. We widen this from `string` (the original shape) to
     *  `BodyInit` so the postVideo path can attach a multipart payload
     *  carrying the optional `thumb` image. The default fetch wrapper
     *  passes the body straight through to undici, which handles every
     *  BodyInit variant. Test stubs that only assert URL+method are
     *  unaffected — they can still accept a string body via the union.
     *  Per _plans/2026-06-28-explicit-thumbnail-uploads.md. */
    body?: BodyInit;
  },
) => Promise<FbFetchResponse>;

export interface PublishDeps {
  fetch?: FbFetchLike;
  /** Stable clock for tests. Defaults to `Date.now()`. */
  now?: () => Date;
}

// --- Settings keys + caption template --------------------------------------

/** Settings keys for the admin UI. Exported so settings/page.tsx and any
 *  future admin surface read/write the same strings as the publisher
 *  here — single source of truth, no drift. */
export const SETTING_AUTO_PUBLISH = "publisher.facebook.auto_publish";
export const SETTING_CAPTION_TEMPLATE = "publisher.facebook.caption_template";
/** Toggle for the custom-thumbnail upload step (PR following
 *  _plans/2026-06-28-explicit-thumbnail-uploads.md). When ON (default),
 *  postVideo switches to a multipart body and attaches the story's
 *  scene-1 image as the `thumb` part so FB shows it as the post cover
 *  instead of FB's auto-picked frame. Admin can flip off if the
 *  multipart path becomes flaky or the thumbnails look wrong. */
export const SETTING_UPLOAD_CUSTOM_THUMBNAIL =
  "publisher.facebook.upload_custom_thumbnail";

export const DEFAULT_CAPTION_TEMPLATE =
  "{{hook}}\n\n📖 Read the full story: {{article_url}}";

/** Render the caption template, falling back per the plan:
 *    {{hook}}        missing -> title
 *    {{title}}       missing -> story id
 *    {{article_url}} missing -> https://www.lorewire.com/
 *  Tokens that aren't in the template are simply not substituted.
 *  Pure function; no side effects. */
export function renderCaption(
  template: string,
  ctx: CaptionContext,
  storyId: string,
): string {
  const title = (ctx.title ?? "").trim() || storyId;
  const hook = (ctx.hook ?? "").trim() || title;
  const articleUrl =
    (ctx.article_url ?? "").trim() || "https://www.lorewire.com/";
  return template
    .replaceAll("{{hook}}", hook)
    .replaceAll("{{title}}", title)
    .replaceAll("{{article_url}}", articleUrl);
}

// --- Observability ---------------------------------------------------------

function log(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[publish facebook ${event}]`, JSON.stringify(fields));
}

/** Pulls only what's safe to log from the env: token presence + length,
 *  never the value itself. Rule 13. */
function tokenFingerprint(): { has_token: boolean; token_len: number } {
  const t = process.env.FB_PAGE_ACCESS_TOKEN ?? "";
  return { has_token: t.length > 0, token_len: t.length };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<invalid-url>";
  }
}

// --- DB helpers ------------------------------------------------------------

async function existingActiveRowsForStory(
  storyId: string,
): Promise<number> {
  const rows = await all<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM facebook_posts
     WHERE story_id = ? AND status IN ('pending', 'posted')`,
    [storyId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function getRow(id: string): Promise<FacebookPostRow | null> {
  return one<FacebookPostRow>(
    `SELECT ${COLS} FROM facebook_posts WHERE id = ?`,
    [id],
  );
}

async function insertPendingRow(args: {
  storyId: string;
  renderId: string | null;
  pageId: string;
  trigger: FacebookPostTrigger;
  videoUrl: string;
  caption: string;
  now: string;
}): Promise<FacebookPostRow> {
  const id = randomUUID();
  await run(
    `INSERT INTO facebook_posts (
       id, story_id, render_id, page_id, trigger, video_url, caption,
       status, attempts, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    [
      id,
      args.storyId,
      args.renderId,
      args.pageId,
      args.trigger,
      args.videoUrl,
      args.caption,
      args.now,
    ],
  );
  const row = await getRow(id);
  if (!row) throw new Error("publish-to-facebook: inserted row vanished");
  return row;
}

async function markPosted(
  id: string,
  externalPostId: string,
  postedAt: string,
): Promise<void> {
  await run(
    `UPDATE facebook_posts
     SET status = 'posted',
         external_post_id = ?,
         posted_at = ?,
         attempts = COALESCE(attempts, 0) + 1,
         error_message = NULL,
         fb_error_code = NULL,
         fb_error_subcode = NULL
     WHERE id = ?`,
    [externalPostId, postedAt, id],
  );
}

async function markFailed(
  id: string,
  err: NormalizedFbError,
): Promise<void> {
  await run(
    `UPDATE facebook_posts
     SET status = 'failed',
         attempts = COALESCE(attempts, 0) + 1,
         fb_error_code = ?,
         fb_error_subcode = ?,
         error_message = ?
     WHERE id = ?`,
    [err.code, err.subcode, err.message, id],
  );
}

async function markDeleted(id: string, deletedAt: string): Promise<void> {
  await run(
    `UPDATE facebook_posts
     SET status = 'deleted', deleted_at = ?
     WHERE id = ?`,
    [deletedAt, id],
  );
}

// --- Facebook Graph API ----------------------------------------------------

const GRAPH_VIDEO_BASE = "https://graph-video.facebook.com/v22.0";
const GRAPH_BASE = "https://graph.facebook.com/v22.0";

interface NormalizedFbError {
  code: number | null;
  subcode: number | null;
  message: string;
}

interface FbErrorBody {
  error?: {
    code?: number;
    error_subcode?: number;
    message?: string;
    fbtrace_id?: string;
  };
}

interface FbVideoOkBody {
  id?: string;
}

function normalizeFbError(
  status: number,
  body: unknown,
  bodyText: string,
): NormalizedFbError {
  const err = (body as FbErrorBody | null)?.error ?? null;
  if (err) {
    return {
      code: typeof err.code === "number" ? err.code : null,
      subcode: typeof err.error_subcode === "number" ? err.error_subcode : null,
      message: (err.message ?? "").slice(0, 500) || `HTTP ${status}`,
    };
  }
  return {
    code: null,
    subcode: null,
    message: `HTTP ${status}: ${bodyText.slice(0, 300)}`,
  };
}

/** Fetch the cover image bytes from a public URL (typically a story's
 *  scene-1 GCS object) and return a Blob suitable for multipart upload.
 *  Returns null on any failure — the caller falls back to the url-
 *  encoded path and FB picks the cover automatically. Per
 *  _plans/2026-06-28-explicit-thumbnail-uploads.md. */
async function fetchThumbnailBlob(
  thumbnailUrl: string,
  fetchImpl: FbFetchLike,
): Promise<{ blob: Blob; mime: string } | null> {
  let resp: FbFetchResponse;
  try {
    resp = await fetchImpl(thumbnailUrl, { method: "GET" });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  let bytes: Uint8Array;
  try {
    // The FbFetchResponse contract surfaces .text() / .json() but the
    // real undici Response also exposes .arrayBuffer(). Cast pragmatically
    // — the defaultFetch wrapper forwards the undici Response in full.
    const r = resp as unknown as Response;
    const buf = await r.arrayBuffer();
    bytes = new Uint8Array(buf);
  } catch {
    return null;
  }
  if (bytes.byteLength === 0) return null;
  // Pull the upstream mime if it's a real image/* value. Scene-1 GCS
  // objects are usually image/png; image/webp is also accepted by FB.
  const r = resp as unknown as Response;
  const upstreamCt =
    (typeof r.headers?.get === "function" && r.headers.get("content-type")) ||
    "";
  const mime = upstreamCt.startsWith("image/") ? upstreamCt : "image/png";
  // Blob extension picks the right serialization for FormData boundaries.
  return { blob: new Blob([bytes as BlobPart], { type: mime }), mime };
}

async function postVideo(
  pageId: string,
  videoUrl: string,
  caption: string,
  fetchImpl: FbFetchLike,
  thumbnailUrl: string | null = null,
): Promise<
  | { ok: true; externalPostId: string }
  | { ok: false; error: NormalizedFbError }
> {
  const token = process.env.FB_PAGE_ACCESS_TOKEN ?? "";
  // When a thumbnail URL is supplied, attempt the multipart path: same
  // endpoint, same fields, plus a `thumb` Blob carrying the cover. If
  // the thumbnail fetch fails (network, 404, zero bytes), fall through
  // to the url-encoded path — better to publish without a cover than
  // not publish at all. Per
  // _plans/2026-06-28-explicit-thumbnail-uploads.md.
  let body: BodyInit;
  let headers: Record<string, string>;
  let thumbAttached = false;
  if (thumbnailUrl) {
    const fetched = await fetchThumbnailBlob(thumbnailUrl, fetchImpl);
    if (fetched) {
      const form = new FormData();
      form.append("access_token", token);
      form.append("file_url", videoUrl);
      form.append("description", caption);
      // The Graph API thumb param accepts a multipart file. We send the
      // blob with a filename so FB infers the format from the mime.
      const ext = fetched.mime.split("/")[1] || "png";
      form.append("thumb", fetched.blob, `cover.${ext}`);
      body = form;
      // undici sets the multipart boundary automatically; do NOT preset
      // Content-Type here or the boundary header will be wrong.
      headers = {};
      thumbAttached = true;
    } else {
      // Fetch failed — fall through to the url-encoded path.
      body = new URLSearchParams({
        access_token: token,
        file_url: videoUrl,
        description: caption,
      }).toString();
      headers = { "Content-Type": "application/x-www-form-urlencoded" };
    }
  } else {
    body = new URLSearchParams({
      access_token: token,
      file_url: videoUrl,
      description: caption,
    }).toString();
    headers = { "Content-Type": "application/x-www-form-urlencoded" };
  }
  log("attempt_video", {
    page_id_present: pageId.length > 0,
    video_url_host: hostOf(videoUrl),
    thumb_attached: thumbAttached,
  });
  const url = `${GRAPH_VIDEO_BASE}/${encodeURIComponent(pageId)}/videos`;
  let resp: FbFetchResponse;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers,
      body,
    });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return {
      ok: false,
      error: { code: null, subcode: null, message: msg.slice(0, 500) },
    };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON error body; normalizeFbError handles the fallback.
    }
    return { ok: false, error: normalizeFbError(resp.status, parsed, text) };
  }
  const data = (await resp.json().catch(() => null)) as FbVideoOkBody | null;
  if (!data || typeof data.id !== "string" || data.id.length === 0) {
    return {
      ok: false,
      error: {
        code: null,
        subcode: null,
        message: "facebook: 200 OK but missing video id",
      },
    };
  }
  return { ok: true, externalPostId: data.id };
}

/** Delete a previously-posted Page post via DELETE /{video-id}. Used by
 *  the manual re-publish "delete previous" path. */
export async function deleteFacebookPost(
  externalPostId: string,
  deps: PublishDeps = {},
): Promise<{ ok: true } | { ok: false; error: NormalizedFbError }> {
  const fetchImpl = deps.fetch ?? defaultFetch;
  const token = process.env.FB_PAGE_ACCESS_TOKEN ?? "";
  if (!token) {
    return {
      ok: false,
      error: {
        code: null,
        subcode: null,
        message: "FB_PAGE_ACCESS_TOKEN not set",
      },
    };
  }
  const url = `${GRAPH_BASE}/${encodeURIComponent(externalPostId)}?access_token=${encodeURIComponent(token)}`;
  let resp: FbFetchResponse;
  try {
    resp = await fetchImpl(url, { method: "DELETE" });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return {
      ok: false,
      error: { code: null, subcode: null, message: msg.slice(0, 500) },
    };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON error body; normalizeFbError handles the fallback.
    }
    return { ok: false, error: normalizeFbError(resp.status, parsed, text) };
  }
  return { ok: true };
}

// Default fetch impl. We import undici lazily so the test environment can
// fully stub via deps.fetch without touching the network layer.
const defaultFetch: FbFetchLike = async (url, init) => {
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

/** Entry point for the render route (auto trigger) and the manual
 *  publish route. Performs inline: gating, dedup (auto only), pending
 *  row insert, Facebook POST, terminal row update. Returns a discriminated
 *  result for callers that want to surface the outcome.
 *  Throws only on unexpected internal errors (eg. row insert vanished);
 *  Facebook API failures land in `status: 'failed'`, not exceptions. */
export async function publishShortToFacebook(
  args: PublishArgs,
  deps: PublishDeps = {},
): Promise<PublishResult> {
  const fetchImpl = deps.fetch ?? defaultFetch;
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();

  const pageId = process.env.FB_PAGE_ID ?? "";
  const token = process.env.FB_PAGE_ACCESS_TOKEN ?? "";
  if (!pageId || !token) {
    log("skipped", {
      story_id: args.storyId,
      render_id: args.renderId,
      reason: "missing FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN",
      ...tokenFingerprint(),
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

  const template =
    (await getSetting(SETTING_CAPTION_TEMPLATE)) ?? DEFAULT_CAPTION_TEMPLATE;
  // Resolution chain: per-publish override > seo_metadata > template.
  const seoMeta = await loadSeoMetadata(args.storyId);
  const seoFbCaption = seoMeta?.facebook?.caption;
  const metadataSource: "override" | "seo_metadata" | "template" =
    args.captionOverride != null && args.captionOverride.length > 0
      ? "override"
      : seoFbCaption
        ? "seo_metadata"
        : "template";
  const caption =
    args.captionOverride != null && args.captionOverride.length > 0
      ? args.captionOverride
      : (seoFbCaption ?? renderCaption(template, args.context, args.storyId));

  const row = await insertPendingRow({
    storyId: args.storyId,
    renderId: args.renderId,
    pageId,
    trigger: args.trigger,
    videoUrl: args.videoUrl,
    caption,
    now: nowIso,
  });

  log("attempt", {
    story_id: row.story_id,
    render_id: row.render_id,
    trigger: row.trigger,
    page_id: row.page_id,
    video_url_host: hostOf(row.video_url),
    caption_len: row.caption.length,
    metadata_source: metadataSource,
    ...tokenFingerprint(),
  });

  // Resolve the per-story cover for FB's thumb param. Skipped when the
  // setting is off, the story has no short_config, or scene-1 is
  // missing — postVideo falls through to the url-encoded path and FB
  // auto-picks the cover. Per
  // _plans/2026-06-28-explicit-thumbnail-uploads.md.
  // Phase 2 (per _plans/2026-06-28-phase-2-social-poster-render.md)
  // prefers the deliberate poster from ensureShortPoster; falls back
  // to PR #137's scene-1 URL when the poster path returns null.
  const uploadCustomThumbnail =
    ((await getSetting(SETTING_UPLOAD_CUSTOM_THUMBNAIL)) ?? "1") !== "0";
  let thumbnailUrl: string | null = null;
  if (uploadCustomThumbnail) {
    const poster = await ensureShortPoster(args.storyId);
    thumbnailUrl =
      poster?.url ?? (await resolveShortThumbnailUrl(args.storyId));
  }

  const started = now.valueOf();
  const result = await postVideo(
    pageId,
    args.videoUrl,
    caption,
    fetchImpl,
    thumbnailUrl,
  );
  const latency = Date.now() - started;

  if (result.ok) {
    const postedAt = new Date().toISOString();
    await markPosted(row.id, result.externalPostId, postedAt);
    log("ok", {
      story_id: row.story_id,
      render_id: row.render_id,
      trigger: row.trigger,
      external_post_id: result.externalPostId,
      latency_ms: latency,
    });
    const fresh = await getRow(row.id);
    if (!fresh) throw new Error("publish-to-facebook: posted row vanished");
    return { status: "posted", row: fresh };
  }

  await markFailed(row.id, result.error);
  log("error", {
    story_id: row.story_id,
    render_id: row.render_id,
    trigger: row.trigger,
    fb_error_code: result.error.code,
    fb_error_subcode: result.error.subcode,
    fb_message: result.error.message,
    latency_ms: latency,
  });
  const fresh = await getRow(row.id);
  if (!fresh) throw new Error("publish-to-facebook: failed row vanished");
  return { status: "failed", row: fresh };
}

/** Single retry attempt against an existing facebook_posts row. The
 *  retry cron loops over eligible rows (status='failed' with backoff
 *  elapsed) and calls this. Bumps attempts and re-walks the FB call
 *  path on the row's snapshotted page_id + video_url + caption.
 *  Unlike `publishShortToFacebook`, this does NOT consult the
 *  auto-publish toggle — by design, per Option A in the plan: a
 *  toggle-off shouldn't strand previously-failed rows. */
export async function attemptFacebookPublishForRow(
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
  const token = process.env.FB_PAGE_ACCESS_TOKEN ?? "";
  if (!token) {
    log("skipped", {
      row_id: rowId,
      reason: "FB_PAGE_ACCESS_TOKEN not set",
    });
    return { status: "skipped", reason: "missing env config" };
  }
  log("retry", {
    story_id: row.story_id,
    render_id: row.render_id,
    attempt: (row.attempts ?? 0) + 1,
  });
  // Re-resolve the cover at retry time so a short_renders.props or
  // short_config edit between attempts picks up the freshest poster
  // (Phase 2) or scene-1 URL (PR #137 fallback). Same gate as the
  // fresh-publish path; null → falls through to url-encoded body.
  const uploadCustomThumbnail =
    ((await getSetting(SETTING_UPLOAD_CUSTOM_THUMBNAIL)) ?? "1") !== "0";
  let thumbnailUrl: string | null = null;
  if (uploadCustomThumbnail) {
    const poster = await ensureShortPoster(row.story_id);
    thumbnailUrl =
      poster?.url ?? (await resolveShortThumbnailUrl(row.story_id));
  }
  const started = Date.now();
  const result = await postVideo(
    row.page_id,
    row.video_url,
    row.caption,
    fetchImpl,
    thumbnailUrl,
  );
  const latency = Date.now() - started;
  if (result.ok) {
    const postedAt = new Date().toISOString();
    await markPosted(row.id, result.externalPostId, postedAt);
    log("ok", {
      story_id: row.story_id,
      render_id: row.render_id,
      trigger: row.trigger,
      external_post_id: result.externalPostId,
      latency_ms: latency,
    });
    const fresh = await getRow(row.id);
    return { status: "posted", row: fresh ?? row };
  }
  await markFailed(row.id, result.error);
  log("error", {
    story_id: row.story_id,
    render_id: row.render_id,
    trigger: row.trigger,
    fb_error_code: result.error.code,
    fb_error_subcode: result.error.subcode,
    fb_message: result.error.message,
    latency_ms: latency,
  });
  const fresh = await getRow(row.id);
  return { status: "failed", row: fresh ?? row };
}

/** Used by the manual re-publish "delete previous" flow. Looks up the
 *  latest posted row for a story, calls DELETE against Facebook, and
 *  flips the local row to 'deleted' on success. Returns the deleted
 *  row id (so the caller can chain into a fresh publishShortToFacebook
 *  call) or an error to surface. */
export async function deleteLatestPostedRowForStory(
  storyId: string,
  deps: PublishDeps = {},
): Promise<
  | { ok: true; rowId: string; externalPostId: string }
  | { ok: false; error: string }
> {
  const row = await one<FacebookPostRow>(
    `SELECT ${COLS} FROM facebook_posts
     WHERE story_id = ? AND status = 'posted'
     ORDER BY posted_at DESC LIMIT 1`,
    [storyId],
  );
  if (!row || !row.external_post_id) {
    return { ok: false, error: "no posted row found for story" };
  }
  const started = Date.now();
  const r = await deleteFacebookPost(row.external_post_id, deps);
  const latency = Date.now() - started;
  if (!r.ok) {
    log("error", {
      story_id: storyId,
      external_post_id: row.external_post_id,
      fb_error_code: r.error.code,
      fb_error_subcode: r.error.subcode,
      fb_message: r.error.message,
      latency_ms: latency,
      reason: "delete failed",
    });
    return { ok: false, error: r.error.message };
  }
  const deletedAt = new Date().toISOString();
  await markDeleted(row.id, deletedAt);
  log("deleted", {
    story_id: storyId,
    external_post_id: row.external_post_id,
    latency_ms: latency,
  });
  return { ok: true, rowId: row.id, externalPostId: row.external_post_id };
}
