// Auto-publish (and manual re-publish) of a rendered short as an
// Instagram Story, on top of the Reel cross-post on the same render.
// Plan: _plans/2026-06-25-instagram-facebook-stories-cross-publish.md.
//
// Mirrors publish-to-instagram.ts (the Reel publisher) exactly: same
// three-step async flow against the IG Business Account, same FB Page
// Access Token, same container_id resume mechanic, same retry-cron
// integration. Two deltas:
//
//   1. media_type=STORIES (not REELS) at container creation.
//   2. NO caption. The /media endpoint with media_type=STORIES does
//      not accept a caption parameter; Story text overlays are
//      creation-tool-only stickers. The DB row drops the caption
//      column accordingly.
//
// Independent toggle: `publisher.instagram.auto_publish_story`
// (default off). The story cross-post fires AFTER the Reel publish
// succeeds and is wrapped in .catch() at the render-route call site
// so a Story failure can never bubble back into the Reel flow.
//
// Reuses FB_PAGE_ACCESS_TOKEN + IG_BUSINESS_ACCOUNT_ID. No new env
// vars, no new App Review — the `instagram_content_publish` scope
// already covers Stories.

import "server-only";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";
import { getSetting } from "@/lib/repo";

// --- Types -----------------------------------------------------------------

export type InstagramStoryStatus = "pending" | "posted" | "failed" | "deleted";
export type InstagramStoryTrigger = "auto" | "manual";

export interface InstagramStoryRow {
  id: string;
  story_id: string;
  render_id: string | null;
  ig_account_id: string;
  trigger: InstagramStoryTrigger;
  video_url: string;
  container_id: string | null;
  status: InstagramStoryStatus;
  external_post_id: string | null;
  ig_error_code: number | null;
  ig_error_subcode: number | null;
  error_message: string | null;
  attempts: number | null;
  created_at: string;
  posted_at: string | null;
  deleted_at: string | null;
}

const COLS =
  "id, story_id, render_id, ig_account_id, trigger, video_url, container_id, status, external_post_id, ig_error_code, ig_error_subcode, error_message, attempts, created_at, posted_at, deleted_at";

export interface PublishArgs {
  storyId: string;
  renderId: string | null;
  videoUrl: string;
  trigger: InstagramStoryTrigger;
}

export type PublishResult =
  | { status: "skipped"; reason: string }
  | { status: "posted"; row: InstagramStoryRow }
  | { status: "pending"; row: InstagramStoryRow }
  | { status: "failed"; row: InstagramStoryRow };

export interface IgFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type IgFetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<IgFetchResponse>;

export interface PublishDeps {
  fetch?: IgFetchLike;
  now?: () => Date;
  /** Test override for the container-poll sleep so unit tests don't take 30s. */
  sleepMs?: (ms: number) => Promise<void>;
}

// --- Settings keys ---------------------------------------------------------

export const SETTING_AUTO_PUBLISH = "publisher.instagram.auto_publish_story";

// --- Observability ---------------------------------------------------------

function log(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[publish instagram_story ${event}]`, JSON.stringify(fields));
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
    `SELECT COUNT(*) AS n FROM instagram_stories
     WHERE story_id = ? AND status IN ('pending', 'posted')`,
    [storyId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function getRow(id: string): Promise<InstagramStoryRow | null> {
  return one<InstagramStoryRow>(
    `SELECT ${COLS} FROM instagram_stories WHERE id = ?`,
    [id],
  );
}

async function insertPendingRow(args: {
  storyId: string;
  renderId: string | null;
  igAccountId: string;
  trigger: InstagramStoryTrigger;
  videoUrl: string;
  now: string;
}): Promise<InstagramStoryRow> {
  const id = randomUUID();
  await run(
    `INSERT INTO instagram_stories (
       id, story_id, render_id, ig_account_id, trigger, video_url,
       status, attempts, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    [
      id,
      args.storyId,
      args.renderId,
      args.igAccountId,
      args.trigger,
      args.videoUrl,
      args.now,
    ],
  );
  const row = await getRow(id);
  if (!row) throw new Error("publish-to-instagram-story: inserted row vanished");
  return row;
}

async function setContainerId(id: string, containerId: string): Promise<void> {
  await run(`UPDATE instagram_stories SET container_id = ? WHERE id = ?`, [
    containerId,
    id,
  ]);
}

async function markPending(id: string): Promise<void> {
  await run(
    `UPDATE instagram_stories
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
    `UPDATE instagram_stories
     SET status = 'posted',
         external_post_id = ?,
         posted_at = ?,
         attempts = COALESCE(attempts, 0) + 1,
         error_message = NULL,
         ig_error_code = NULL,
         ig_error_subcode = NULL
     WHERE id = ?`,
    [externalPostId, postedAt, id],
  );
}

async function markFailed(id: string, err: NormalizedIgError): Promise<void> {
  await run(
    `UPDATE instagram_stories
     SET status = 'failed',
         attempts = COALESCE(attempts, 0) + 1,
         ig_error_code = ?,
         ig_error_subcode = ?,
         error_message = ?
     WHERE id = ?`,
    [err.code, err.subcode, err.message, id],
  );
}

async function markDeleted(id: string, deletedAt: string): Promise<void> {
  await run(
    `UPDATE instagram_stories
     SET status = 'deleted', deleted_at = ?
     WHERE id = ?`,
    [deletedAt, id],
  );
}

// --- Instagram Graph API ---------------------------------------------------

// Same subdomain as the Reel publisher — IG accounts linked via a FB
// Page use graph.facebook.com, NOT graph.instagram.com. Verified
// 2026-06-24 against the live LoreWire IG account.
const IG_BASE = "https://graph.facebook.com/v22.0";

const CONTAINER_POLL_TIMEOUT_MS = 30_000;
const CONTAINER_POLL_INTERVAL_MS = 2_000;

interface NormalizedIgError {
  code: number | null;
  subcode: number | null;
  message: string;
}

interface IgErrorBody {
  error?: {
    code?: number;
    error_subcode?: number;
    message?: string;
    fbtrace_id?: string;
  };
}

interface IgIdBody {
  id?: string;
}

interface IgStatusBody {
  status_code?: string;
}

function normalizeIgError(
  status: number,
  body: unknown,
  bodyText: string,
): NormalizedIgError {
  const err = (body as IgErrorBody | null)?.error ?? null;
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

async function parseIgResponse(
  resp: IgFetchResponse,
): Promise<
  | { ok: true; data: unknown }
  | { ok: false; error: NormalizedIgError }
> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON error body; normalizeIgError handles the fallback.
    }
    return { ok: false, error: normalizeIgError(resp.status, parsed, text) };
  }
  const data = await resp.json().catch(() => null);
  return { ok: true, data };
}

/** Step 1: create the Story container (media_type=STORIES). */
async function createContainer(
  igAccountId: string,
  videoUrl: string,
  fetchImpl: IgFetchLike,
): Promise<
  | { ok: true; containerId: string }
  | { ok: false; error: NormalizedIgError }
> {
  const token = process.env.FB_PAGE_ACCESS_TOKEN ?? "";
  const body = new URLSearchParams({
    access_token: token,
    media_type: "STORIES",
    video_url: videoUrl,
  }).toString();
  const url = `${IG_BASE}/${encodeURIComponent(igAccountId)}/media`;
  let resp: IgFetchResponse;
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
  const parsed = await parseIgResponse(resp);
  if (!parsed.ok) return parsed;
  const data = parsed.data as IgIdBody | null;
  if (!data || typeof data.id !== "string" || data.id.length === 0) {
    return {
      ok: false,
      error: {
        code: null,
        subcode: null,
        message: "instagram_story: 200 OK but missing container id",
      },
    };
  }
  return { ok: true, containerId: data.id };
}

async function getContainerStatus(
  containerId: string,
  fetchImpl: IgFetchLike,
): Promise<
  | { ok: true; status: string }
  | { ok: false; error: NormalizedIgError }
> {
  const token = process.env.FB_PAGE_ACCESS_TOKEN ?? "";
  const url = `${IG_BASE}/${encodeURIComponent(containerId)}?fields=status_code&access_token=${encodeURIComponent(token)}`;
  let resp: IgFetchResponse;
  try {
    resp = await fetchImpl(url, { method: "GET" });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return {
      ok: false,
      error: { code: null, subcode: null, message: msg.slice(0, 500) },
    };
  }
  const parsed = await parseIgResponse(resp);
  if (!parsed.ok) return parsed;
  const data = parsed.data as IgStatusBody | null;
  const status = (data?.status_code ?? "").toString();
  if (!status) {
    return {
      ok: false,
      error: {
        code: null,
        subcode: null,
        message: "instagram_story: container status response missing status_code",
      },
    };
  }
  return { ok: true, status };
}

type ContainerPollOutcome =
  | { kind: "finished" }
  | { kind: "error"; status: string; message: string }
  | { kind: "timeout"; lastStatus: string };

async function pollContainer(
  storyId: string,
  rowId: string,
  containerId: string,
  fetchImpl: IgFetchLike,
  deps: PublishDeps,
): Promise<ContainerPollOutcome> {
  const sleep = deps.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  let pollN = 0;
  let lastStatus = "UNKNOWN";
  while (Date.now() - started < CONTAINER_POLL_TIMEOUT_MS) {
    pollN += 1;
    const res = await getContainerStatus(containerId, fetchImpl);
    if (!res.ok) {
      return {
        kind: "error",
        status: "FETCH_ERROR",
        message: res.error.message,
      };
    }
    lastStatus = res.status;
    log("container_poll", {
      story_id: storyId,
      row_id: rowId,
      container_id: containerId,
      status_code: lastStatus,
      poll_n: pollN,
      elapsed_ms: Date.now() - started,
    });
    if (lastStatus === "FINISHED") return { kind: "finished" };
    if (lastStatus === "ERROR" || lastStatus === "EXPIRED") {
      return {
        kind: "error",
        status: lastStatus,
        message: `instagram_story container ${lastStatus.toLowerCase()}`,
      };
    }
    if (lastStatus === "PUBLISHED") return { kind: "finished" };
    await sleep(CONTAINER_POLL_INTERVAL_MS);
  }
  return { kind: "timeout", lastStatus };
}

async function publishContainer(
  igAccountId: string,
  containerId: string,
  fetchImpl: IgFetchLike,
): Promise<
  | { ok: true; externalPostId: string }
  | { ok: false; error: NormalizedIgError }
> {
  const token = process.env.FB_PAGE_ACCESS_TOKEN ?? "";
  const body = new URLSearchParams({
    access_token: token,
    creation_id: containerId,
  }).toString();
  const url = `${IG_BASE}/${encodeURIComponent(igAccountId)}/media_publish`;
  let resp: IgFetchResponse;
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
  const parsed = await parseIgResponse(resp);
  if (!parsed.ok) return parsed;
  const data = parsed.data as IgIdBody | null;
  if (!data || typeof data.id !== "string" || data.id.length === 0) {
    return {
      ok: false,
      error: {
        code: null,
        subcode: null,
        message: "instagram_story: publish 200 OK but missing post id",
      },
    };
  }
  return { ok: true, externalPostId: data.id };
}

/** Delete a previously-published Story via DELETE /{post-id}. Stories
 *  auto-expire after 24h so manual deletion is rarely useful, but the
 *  Reel publisher's manual re-publish flow exposes a Delete + Republish
 *  button — we mirror the same API surface for symmetry. */
export async function deleteInstagramStory(
  externalPostId: string,
  deps: PublishDeps = {},
): Promise<{ ok: true } | { ok: false; error: NormalizedIgError }> {
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
  const url = `${IG_BASE}/${encodeURIComponent(externalPostId)}?access_token=${encodeURIComponent(token)}`;
  let resp: IgFetchResponse;
  try {
    resp = await fetchImpl(url, { method: "DELETE" });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return {
      ok: false,
      error: { code: null, subcode: null, message: msg.slice(0, 500) },
    };
  }
  const parsed = await parseIgResponse(resp);
  if (!parsed.ok) return parsed;
  return { ok: true };
}

const defaultFetch: IgFetchLike = async (url, init) => {
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
 *  Runs the full 3-step flow inline:
 *    1. Create container (media_type=STORIES)
 *    2. Poll for FINISHED (up to 30s)
 *    3. Publish container
 *  On step-2 timeout, returns `pending` with the container_id persisted
 *  so the retry cron can resume polling without re-creating. */
export async function publishShortToInstagramStory(
  args: PublishArgs,
  deps: PublishDeps = {},
): Promise<PublishResult> {
  const fetchImpl = deps.fetch ?? defaultFetch;
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();

  const igAccountId = process.env.IG_BUSINESS_ACCOUNT_ID ?? "";
  const token = process.env.FB_PAGE_ACCESS_TOKEN ?? "";
  if (!igAccountId || !token) {
    log("skipped", {
      story_id: args.storyId,
      render_id: args.renderId,
      reason: "missing IG_BUSINESS_ACCOUNT_ID or FB_PAGE_ACCESS_TOKEN",
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
    igAccountId,
    trigger: args.trigger,
    videoUrl: args.videoUrl,
    now: nowIso,
  });

  log("attempt", {
    story_id: row.story_id,
    render_id: row.render_id,
    trigger: row.trigger,
    ig_account_id: row.ig_account_id,
    video_url_host: hostOf(row.video_url),
    ...tokenFingerprint(),
  });

  return runFullPipeline(row, fetchImpl, deps);
}

async function runFullPipeline(
  row: InstagramStoryRow,
  fetchImpl: IgFetchLike,
  deps: PublishDeps,
): Promise<PublishResult> {
  const igAccountId = process.env.IG_BUSINESS_ACCOUNT_ID ?? "";
  if (row.ig_account_id !== igAccountId) {
    const err: NormalizedIgError = {
      code: null,
      subcode: null,
      message: `ig_account_id mismatch: row=${row.ig_account_id} env=${igAccountId}`,
    };
    await markFailed(row.id, err);
    log("error", {
      story_id: row.story_id,
      render_id: row.render_id,
      trigger: row.trigger,
      ig_message: err.message,
      reason: "ig_account_id mismatch",
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }

  const t0 = Date.now();
  let containerId = row.container_id;

  if (!containerId) {
    const created = await createContainer(igAccountId, row.video_url, fetchImpl);
    if (!created.ok) {
      await markFailed(row.id, created.error);
      log("error", {
        story_id: row.story_id,
        render_id: row.render_id,
        trigger: row.trigger,
        ig_error_code: created.error.code,
        ig_error_subcode: created.error.subcode,
        ig_message: created.error.message,
        stage: "container_create",
      });
      const fresh = await getRow(row.id);
      return { status: "failed", row: fresh ?? row };
    }
    containerId = created.containerId;
    await setContainerId(row.id, containerId);
    log("container_created", {
      story_id: row.story_id,
      render_id: row.render_id,
      container_id: containerId,
      latency_ms: Date.now() - t0,
    });
  }

  const poll = await pollContainer(
    row.story_id,
    row.id,
    containerId,
    fetchImpl,
    deps,
  );
  if (poll.kind === "timeout") {
    await markPending(row.id);
    log("container_timeout", {
      story_id: row.story_id,
      render_id: row.render_id,
      container_id: containerId,
      last_status: poll.lastStatus,
      elapsed_ms: Date.now() - t0,
    });
    const fresh = await getRow(row.id);
    return { status: "pending", row: fresh ?? row };
  }
  if (poll.kind === "error") {
    const err: NormalizedIgError = {
      code: null,
      subcode: null,
      message: poll.message,
    };
    await markFailed(row.id, err);
    log("error", {
      story_id: row.story_id,
      render_id: row.render_id,
      trigger: row.trigger,
      ig_message: poll.message,
      stage: "container_poll",
      poll_status: poll.status,
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }

  const published = await publishContainer(igAccountId, containerId, fetchImpl);
  if (!published.ok) {
    await markFailed(row.id, published.error);
    log("error", {
      story_id: row.story_id,
      render_id: row.render_id,
      trigger: row.trigger,
      ig_error_code: published.error.code,
      ig_error_subcode: published.error.subcode,
      ig_message: published.error.message,
      stage: "publish",
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }

  const postedAt = new Date().toISOString();
  await markPosted(row.id, published.externalPostId, postedAt);
  log("ok", {
    story_id: row.story_id,
    render_id: row.render_id,
    trigger: row.trigger,
    external_post_id: published.externalPostId,
    total_latency_ms: Date.now() - t0,
  });
  const fresh = await getRow(row.id);
  if (!fresh) throw new Error("publish-to-instagram-story: posted row vanished");
  return { status: "posted", row: fresh };
}

/** Single retry attempt against an existing instagram_stories row.
 *  Resumes from container_id when set (skipping step 1), otherwise
 *  walks the full pipeline. Unlike publishShortToInstagramStory, this
 *  does NOT check the auto-publish toggle — toggle gates only new
 *  auto attempts; the retry cron always drains. */
export async function attemptInstagramStoryPublishForRow(
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
    resume_from: row.container_id ? "container" : "create",
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
  const row = await one<InstagramStoryRow>(
    `SELECT ${COLS} FROM instagram_stories
     WHERE story_id = ? AND status = 'posted'
     ORDER BY posted_at DESC LIMIT 1`,
    [storyId],
  );
  if (!row || !row.external_post_id) {
    return { ok: false, error: "no posted row found for story" };
  }
  const started = Date.now();
  const r = await deleteInstagramStory(row.external_post_id, deps);
  const latency = Date.now() - started;
  if (!r.ok) {
    log("error", {
      story_id: storyId,
      external_post_id: row.external_post_id,
      ig_error_code: r.error.code,
      ig_error_subcode: r.error.subcode,
      ig_message: r.error.message,
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
