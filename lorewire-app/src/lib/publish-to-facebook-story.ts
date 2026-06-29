// Auto-publish (and manual re-publish) of a rendered short as a
// Facebook Page Story, on top of the Reel cross-post on the same render.
// Plan: _plans/2026-06-25-instagram-facebook-stories-cross-publish.md.
//
// FB Page Stories use a 4-step upload-by-URL flow against TWO subdomains
// (different from FB Reels, which is single-shot):
//
//   1. start:  POST graph.facebook.com/v22.0/{page-id}/video_stories
//                with upload_phase=start
//              → { video_id, upload_url }
//   2. upload: POST {upload_url} (on rupload.facebook.com) with header
//                file_url: <public GCS url>
//              → rupload pulls the bytes from the URL
//   3. poll:   GET graph.facebook.com/v22.0/{video_id}?fields=status
//              → { status: { video_status: "ready|processing|..." } }
//   4. finish: POST graph.facebook.com/v22.0/{page-id}/video_stories
//                with upload_phase=finish&video_id=...
//              → { success: true, post_id }
//
// `upload_session_id` on the row = the `video_id` from step 1 — survives
// across retries so a pending row can resume at step 3 (poll) or step 4
// (finish) without re-uploading bytes. Mirrors INSTAGRAM_STORIES.container_id.
//
// Independent toggle: `publisher.facebook.auto_publish_story` (default
// off). Reuses FB_PAGE_ACCESS_TOKEN + FB_PAGE_ID — no new env vars, no
// new App Review.

import "server-only";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";
import { getSetting } from "@/lib/repo";

// --- Types -----------------------------------------------------------------

export type FacebookStoryStatus = "pending" | "posted" | "failed" | "deleted";
export type FacebookStoryTrigger = "auto" | "manual";

export interface FacebookStoryRow {
  id: string;
  story_id: string;
  render_id: string | null;
  page_id: string;
  trigger: FacebookStoryTrigger;
  video_url: string;
  upload_session_id: string | null;
  status: FacebookStoryStatus;
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
  "id, story_id, render_id, page_id, trigger, video_url, upload_session_id, status, external_post_id, fb_error_code, fb_error_subcode, error_message, attempts, created_at, posted_at, deleted_at";

export interface PublishArgs {
  storyId: string;
  renderId: string | null;
  videoUrl: string;
  trigger: FacebookStoryTrigger;
}

export type PublishResult =
  | { status: "skipped"; reason: string }
  | { status: "posted"; row: FacebookStoryRow }
  | { status: "pending"; row: FacebookStoryRow }
  | { status: "failed"; row: FacebookStoryRow };

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
    body?: string;
  },
) => Promise<FbFetchResponse>;

export interface PublishDeps {
  fetch?: FbFetchLike;
  now?: () => Date;
  /** Test override for the status-poll sleep. */
  sleepMs?: (ms: number) => Promise<void>;
}

// --- Settings keys ---------------------------------------------------------

export const SETTING_AUTO_PUBLISH = "publisher.facebook.auto_publish_story";

// --- Observability ---------------------------------------------------------

function log(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[publish facebook_story ${event}]`, JSON.stringify(fields));
}

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

async function existingActiveRowsForStory(storyId: string): Promise<number> {
  const rows = await all<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM facebook_stories
     WHERE story_id = ? AND status IN ('pending', 'posted')`,
    [storyId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function getRow(id: string): Promise<FacebookStoryRow | null> {
  return one<FacebookStoryRow>(
    `SELECT ${COLS} FROM facebook_stories WHERE id = ?`,
    [id],
  );
}

async function insertPendingRow(args: {
  storyId: string;
  renderId: string | null;
  pageId: string;
  trigger: FacebookStoryTrigger;
  videoUrl: string;
  now: string;
}): Promise<FacebookStoryRow> {
  const id = randomUUID();
  await run(
    `INSERT INTO facebook_stories (
       id, story_id, render_id, page_id, trigger, video_url,
       status, attempts, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    [
      id,
      args.storyId,
      args.renderId,
      args.pageId,
      args.trigger,
      args.videoUrl,
      args.now,
    ],
  );
  const row = await getRow(id);
  if (!row) throw new Error("publish-to-facebook-story: inserted row vanished");
  return row;
}

async function setUploadSessionId(id: string, uploadSessionId: string): Promise<void> {
  await run(
    `UPDATE facebook_stories SET upload_session_id = ? WHERE id = ?`,
    [uploadSessionId, id],
  );
}

async function markPending(id: string): Promise<void> {
  await run(
    `UPDATE facebook_stories
     SET status = 'pending', attempts = COALESCE(attempts, 0) + 1
     WHERE id = ?`,
    [id],
  );
}

async function markPosted(
  id: string,
  externalPostId: string,
  postedAt: string,
): Promise<void> {
  await run(
    `UPDATE facebook_stories
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

async function markFailed(id: string, err: NormalizedFbError): Promise<void> {
  await run(
    `UPDATE facebook_stories
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
    `UPDATE facebook_stories
     SET status = 'deleted', deleted_at = ?
     WHERE id = ?`,
    [deletedAt, id],
  );
}

// --- Facebook Graph API ----------------------------------------------------

const GRAPH_BASE = "https://graph.facebook.com/v22.0";

const STATUS_POLL_TIMEOUT_MS = 30_000;
const STATUS_POLL_INTERVAL_MS = 2_000;

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

interface FbStartBody {
  video_id?: string;
  upload_url?: string;
}

interface FbFinishBody {
  success?: boolean;
  post_id?: string | number;
}

interface FbStatusBody {
  status?: {
    video_status?: string;
  };
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

async function parseFbResponse(
  resp: FbFetchResponse,
): Promise<
  | { ok: true; data: unknown }
  | { ok: false; error: NormalizedFbError }
> {
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
  const data = await resp.json().catch(() => null);
  return { ok: true, data };
}

/** Step 1: start the upload session. Returns { video_id, upload_url }. */
async function startUpload(
  pageId: string,
  fetchImpl: FbFetchLike,
): Promise<
  | { ok: true; videoId: string; uploadUrl: string }
  | { ok: false; error: NormalizedFbError }
> {
  const token = process.env.FB_PAGE_ACCESS_TOKEN ?? "";
  const body = new URLSearchParams({
    access_token: token,
    upload_phase: "start",
  }).toString();
  const url = `${GRAPH_BASE}/${encodeURIComponent(pageId)}/video_stories`;
  let resp: FbFetchResponse;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return {
      ok: false,
      error: { code: null, subcode: null, message: msg.slice(0, 500) },
    };
  }
  const parsed = await parseFbResponse(resp);
  if (!parsed.ok) return parsed;
  const data = parsed.data as FbStartBody | null;
  if (
    !data ||
    typeof data.video_id !== "string" ||
    data.video_id.length === 0 ||
    typeof data.upload_url !== "string" ||
    data.upload_url.length === 0
  ) {
    return {
      ok: false,
      error: {
        code: null,
        subcode: null,
        message: "facebook_story: start 200 OK but missing video_id / upload_url",
      },
    };
  }
  return { ok: true, videoId: data.video_id, uploadUrl: data.upload_url };
}

/** Step 2: ask rupload to pull bytes from our GCS URL. The token goes
 *  in the Authorization header here (rupload subdomain convention),
 *  NOT as a query/body param. */
async function ruploadByUrl(
  uploadUrl: string,
  videoUrl: string,
  fetchImpl: FbFetchLike,
): Promise<{ ok: true } | { ok: false; error: NormalizedFbError }> {
  const token = process.env.FB_PAGE_ACCESS_TOKEN ?? "";
  let resp: FbFetchResponse;
  try {
    resp = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${token}`,
        file_url: videoUrl,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return {
      ok: false,
      error: { code: null, subcode: null, message: msg.slice(0, 500) },
    };
  }
  const parsed = await parseFbResponse(resp);
  if (!parsed.ok) return parsed;
  return { ok: true };
}

/** Step 3 (single check): query video_status. */
async function getVideoStatus(
  videoId: string,
  fetchImpl: FbFetchLike,
): Promise<
  | { ok: true; status: string }
  | { ok: false; error: NormalizedFbError }
> {
  const token = process.env.FB_PAGE_ACCESS_TOKEN ?? "";
  const url = `${GRAPH_BASE}/${encodeURIComponent(videoId)}?fields=status&access_token=${encodeURIComponent(token)}`;
  let resp: FbFetchResponse;
  try {
    resp = await fetchImpl(url, { method: "GET" });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return {
      ok: false,
      error: { code: null, subcode: null, message: msg.slice(0, 500) },
    };
  }
  const parsed = await parseFbResponse(resp);
  if (!parsed.ok) return parsed;
  const data = parsed.data as FbStatusBody | null;
  const status = (data?.status?.video_status ?? "").toString();
  if (!status) {
    return {
      ok: false,
      error: {
        code: null,
        subcode: null,
        message: "facebook_story: status response missing video_status",
      },
    };
  }
  return { ok: true, status };
}

type StatusPollOutcome =
  | { kind: "ready" }
  | { kind: "error"; status: string; message: string }
  | { kind: "timeout"; lastStatus: string };

async function pollVideoStatus(
  storyId: string,
  rowId: string,
  videoId: string,
  fetchImpl: FbFetchLike,
  deps: PublishDeps,
): Promise<StatusPollOutcome> {
  const sleep = deps.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  let pollN = 0;
  let lastStatus = "unknown";
  while (Date.now() - started < STATUS_POLL_TIMEOUT_MS) {
    pollN += 1;
    const res = await getVideoStatus(videoId, fetchImpl);
    if (!res.ok) {
      return {
        kind: "error",
        status: "FETCH_ERROR",
        message: res.error.message,
      };
    }
    lastStatus = res.status;
    log("status_poll", {
      story_id: storyId,
      row_id: rowId,
      video_id: videoId,
      video_status: lastStatus,
      poll_n: pollN,
      elapsed_ms: Date.now() - started,
    });
    if (lastStatus === "ready") return { kind: "ready" };
    if (lastStatus === "error" || lastStatus === "expired") {
      return {
        kind: "error",
        status: lastStatus,
        message: `facebook_story video ${lastStatus}`,
      };
    }
    await sleep(STATUS_POLL_INTERVAL_MS);
  }
  return { kind: "timeout", lastStatus };
}

/** Step 4: finish the upload session and publish the story. */
async function finishUpload(
  pageId: string,
  videoId: string,
  fetchImpl: FbFetchLike,
): Promise<
  | { ok: true; externalPostId: string }
  | { ok: false; error: NormalizedFbError }
> {
  const token = process.env.FB_PAGE_ACCESS_TOKEN ?? "";
  const body = new URLSearchParams({
    access_token: token,
    upload_phase: "finish",
    video_id: videoId,
  }).toString();
  const url = `${GRAPH_BASE}/${encodeURIComponent(pageId)}/video_stories`;
  let resp: FbFetchResponse;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return {
      ok: false,
      error: { code: null, subcode: null, message: msg.slice(0, 500) },
    };
  }
  const parsed = await parseFbResponse(resp);
  if (!parsed.ok) return parsed;
  const data = parsed.data as FbFinishBody | null;
  if (!data || data.success !== true || data.post_id == null) {
    return {
      ok: false,
      error: {
        code: null,
        subcode: null,
        message: "facebook_story: finish 200 OK but missing post_id / success=false",
      },
    };
  }
  return { ok: true, externalPostId: String(data.post_id) };
}

/** Delete a previously-published Story via DELETE /{post-id}. Stories
 *  auto-expire after 24h so manual deletion is rarely useful — exposed
 *  for symmetry with the Reel publisher's manual flow. */
export async function deleteFacebookStory(
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
  const parsed = await parseFbResponse(resp);
  if (!parsed.ok) return parsed;
  return { ok: true };
}

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

/** Entry point for the render route (auto) and the manual publish action.
 *  Runs the full 4-step flow inline:
 *    1. start    → video_id + upload_url
 *    2. rupload  (file_url header) → bytes pulled from GCS
 *    3. poll     → video_status=ready
 *    4. finish   → post_id
 *  On step-3 timeout, returns `pending` with the upload_session_id
 *  persisted so the retry cron can resume polling without re-uploading. */
export async function publishShortToFacebookStory(
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
        reason: "auto_publish_story toggle off",
      });
      return { status: "skipped", reason: "auto-publish toggle off" };
    }
    const active = await existingActiveRowsForStory(args.storyId);
    if (active > 0) {
      log("skipped", {
        story_id: args.storyId,
        render_id: args.renderId,
        reason: "story already has pending/posted Story row",
        existing_rows: active,
      });
      return { status: "skipped", reason: "story already published" };
    }
  }

  const row = await insertPendingRow({
    storyId: args.storyId,
    renderId: args.renderId,
    pageId,
    trigger: args.trigger,
    videoUrl: args.videoUrl,
    now: nowIso,
  });

  log("attempt", {
    story_id: row.story_id,
    render_id: row.render_id,
    trigger: row.trigger,
    page_id: row.page_id,
    video_url_host: hostOf(row.video_url),
    ...tokenFingerprint(),
  });

  return runFullPipeline(row, fetchImpl, deps);
}

async function runFullPipeline(
  row: FacebookStoryRow,
  fetchImpl: FbFetchLike,
  deps: PublishDeps,
): Promise<PublishResult> {
  const pageId = process.env.FB_PAGE_ID ?? "";
  if (row.page_id !== pageId) {
    const err: NormalizedFbError = {
      code: null,
      subcode: null,
      message: `page_id mismatch: row=${row.page_id} env=${pageId}`,
    };
    await markFailed(row.id, err);
    log("error", {
      story_id: row.story_id,
      render_id: row.render_id,
      trigger: row.trigger,
      fb_message: err.message,
      reason: "page_id mismatch",
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }

  const t0 = Date.now();
  let videoId = row.upload_session_id;

  if (!videoId) {
    const started = await startUpload(pageId, fetchImpl);
    if (!started.ok) {
      await markFailed(row.id, started.error);
      log("error", {
        story_id: row.story_id,
        render_id: row.render_id,
        trigger: row.trigger,
        fb_error_code: started.error.code,
        fb_error_subcode: started.error.subcode,
        fb_message: started.error.message,
        stage: "start",
      });
      const fresh = await getRow(row.id);
      return { status: "failed", row: fresh ?? row };
    }
    videoId = started.videoId;
    await setUploadSessionId(row.id, videoId);
    log("started", {
      story_id: row.story_id,
      render_id: row.render_id,
      video_id: videoId,
      upload_url_host: hostOf(started.uploadUrl),
      latency_ms: Date.now() - t0,
    });

    const uploaded = await ruploadByUrl(started.uploadUrl, row.video_url, fetchImpl);
    if (!uploaded.ok) {
      await markFailed(row.id, uploaded.error);
      log("error", {
        story_id: row.story_id,
        render_id: row.render_id,
        trigger: row.trigger,
        video_id: videoId,
        fb_error_code: uploaded.error.code,
        fb_error_subcode: uploaded.error.subcode,
        fb_message: uploaded.error.message,
        stage: "rupload",
      });
      const fresh = await getRow(row.id);
      return { status: "failed", row: fresh ?? row };
    }
    log("uploaded", {
      story_id: row.story_id,
      render_id: row.render_id,
      video_id: videoId,
      latency_ms: Date.now() - t0,
    });
  }

  const poll = await pollVideoStatus(row.story_id, row.id, videoId, fetchImpl, deps);
  if (poll.kind === "timeout") {
    await markPending(row.id);
    log("status_timeout", {
      story_id: row.story_id,
      render_id: row.render_id,
      video_id: videoId,
      last_status: poll.lastStatus,
      elapsed_ms: Date.now() - t0,
    });
    const fresh = await getRow(row.id);
    return { status: "pending", row: fresh ?? row };
  }
  if (poll.kind === "error") {
    const err: NormalizedFbError = {
      code: null,
      subcode: null,
      message: poll.message,
    };
    await markFailed(row.id, err);
    log("error", {
      story_id: row.story_id,
      render_id: row.render_id,
      trigger: row.trigger,
      fb_message: poll.message,
      stage: "status_poll",
      poll_status: poll.status,
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }

  const finished = await finishUpload(pageId, videoId, fetchImpl);
  if (!finished.ok) {
    await markFailed(row.id, finished.error);
    log("error", {
      story_id: row.story_id,
      render_id: row.render_id,
      trigger: row.trigger,
      fb_error_code: finished.error.code,
      fb_error_subcode: finished.error.subcode,
      fb_message: finished.error.message,
      stage: "finish",
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }

  const postedAt = new Date().toISOString();
  await markPosted(row.id, finished.externalPostId, postedAt);
  log("ok", {
    story_id: row.story_id,
    render_id: row.render_id,
    trigger: row.trigger,
    external_post_id: finished.externalPostId,
    total_latency_ms: Date.now() - t0,
  });
  const fresh = await getRow(row.id);
  if (!fresh) throw new Error("publish-to-facebook-story: posted row vanished");
  return { status: "posted", row: fresh };
}

/** Single retry attempt against an existing facebook_stories row.
 *  Resumes from upload_session_id when set (skipping start + rupload),
 *  otherwise walks the full pipeline. Does NOT check the auto-publish
 *  toggle — toggle gates only new auto attempts. */
export async function attemptFacebookStoryPublishForRow(
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
    resume_from: row.upload_session_id ? "poll" : "start",
  });
  return runFullPipeline(row, fetchImpl, deps);
}

/** Used by the manual re-publish "delete previous" flow. */
export async function deleteLatestPostedRowForStory(
  storyId: string,
  deps: PublishDeps = {},
): Promise<
  | { ok: true; rowId: string; externalPostId: string }
  | { ok: false; error: string }
> {
  const row = await one<FacebookStoryRow>(
    `SELECT ${COLS} FROM facebook_stories
     WHERE story_id = ? AND status = 'posted'
     ORDER BY posted_at DESC LIMIT 1`,
    [storyId],
  );
  if (!row || !row.external_post_id) {
    return { ok: false, error: "no posted row found for story" };
  }
  const started = Date.now();
  const r = await deleteFacebookStory(row.external_post_id, deps);
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
