// Auto-publish (and manual re-publish) of a rendered short to the
// LoreWire Instagram Business Account as a Reel via the Graph API.
// Plan: _plans/2026-06-24-instagram-auto-publish.md.
//
// Mirrors publish-to-facebook.ts with the IG-specific two-step flow:
//   1. POST graph.instagram.com/v22.0/{ig-id}/media        → container_id
//   2. Poll  GET .../{container-id}?fields=status_code      → until FINISHED / ERROR
//   3. POST graph.instagram.com/v22.0/{ig-id}/media_publish ?creation_id=container_id
//      → external_post_id
//
// Reuses FB_PAGE_ACCESS_TOKEN (the IG account is linked to the FB Page).
// New env var: IG_BUSINESS_ACCOUNT_ID. The token never touches the DB
// or the logs (rule 13). On step-2 timeout (still IN_PROGRESS after the
// inline budget), the row is left in `pending` WITH container_id set so
// the retry cron can resume polling without re-creating the container
// (re-creating would burn the 100/24h post quota and orphan one).

import "server-only";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";
import { getSetting } from "@/lib/repo";
import { loadSeoMetadata } from "@/lib/seo-metadata";
import { ensureOgPoster, ensureShortPoster } from "@/lib/short-poster";

// --- Types -----------------------------------------------------------------

export type InstagramPostStatus = "pending" | "posted" | "failed" | "deleted";
export type InstagramPostTrigger = "auto" | "manual" | "scheduled";

export interface InstagramPostRow {
  id: string;
  story_id: string;
  render_id: string | null;
  ig_account_id: string;
  trigger: InstagramPostTrigger;
  video_url: string;
  caption: string;
  container_id: string | null;
  status: InstagramPostStatus;
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
  "id, story_id, render_id, ig_account_id, trigger, video_url, caption, container_id, status, external_post_id, ig_error_code, ig_error_subcode, error_message, attempts, created_at, posted_at, deleted_at";

export interface CaptionContext {
  hook: string | null;
  title: string | null;
  article_url: string | null;
}

export interface PublishArgs {
  storyId: string;
  renderId: string | null;
  videoUrl: string;
  trigger: InstagramPostTrigger;
  context: CaptionContext;
  captionOverride?: string | null;
}

export type PublishResult =
  | { status: "skipped"; reason: string }
  | { status: "posted"; row: InstagramPostRow }
  | { status: "pending"; row: InstagramPostRow }
  | { status: "failed"; row: InstagramPostRow };

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

// --- Settings keys + caption template --------------------------------------

export const SETTING_AUTO_PUBLISH = "publisher.instagram.auto_publish";
export const SETTING_CAPTION_TEMPLATE = "publisher.instagram.caption_template";

export const DEFAULT_CAPTION_TEMPLATE =
  "{{hook}}\n\n📖 Read the full story: {{article_url}}";

/** IG caption hard limit. The render is shared with the FB template
 *  (which allows ~63k), so the trim happens at the IG boundary instead
 *  of in the template — the template stays platform-agnostic. */
export const IG_CAPTION_LIMIT = 2200;

function trimForIg(s: string): { caption: string; truncated: boolean } {
  if (s.length <= IG_CAPTION_LIMIT) return { caption: s, truncated: false };
  // Reserve one char for the ellipsis. Use a single Unicode ellipsis
  // (not three dots) so the count is exact.
  return { caption: s.slice(0, IG_CAPTION_LIMIT - 1) + "…", truncated: true };
}

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
  console.info(`[publish instagram ${event}]`, JSON.stringify(fields));
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
    `SELECT COUNT(*) AS n FROM instagram_posts
     WHERE story_id = ? AND status IN ('pending', 'posted')`,
    [storyId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function getRow(id: string): Promise<InstagramPostRow | null> {
  return one<InstagramPostRow>(
    `SELECT ${COLS} FROM instagram_posts WHERE id = ?`,
    [id],
  );
}

async function insertPendingRow(args: {
  storyId: string;
  renderId: string | null;
  igAccountId: string;
  trigger: InstagramPostTrigger;
  videoUrl: string;
  caption: string;
  now: string;
}): Promise<InstagramPostRow> {
  const id = randomUUID();
  await run(
    `INSERT INTO instagram_posts (
       id, story_id, render_id, ig_account_id, trigger, video_url, caption,
       status, attempts, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    [
      id,
      args.storyId,
      args.renderId,
      args.igAccountId,
      args.trigger,
      args.videoUrl,
      args.caption,
      args.now,
    ],
  );
  const row = await getRow(id);
  if (!row) throw new Error("publish-to-instagram: inserted row vanished");
  return row;
}

async function setContainerId(id: string, containerId: string): Promise<void> {
  await run(`UPDATE instagram_posts SET container_id = ? WHERE id = ?`, [
    containerId,
    id,
  ]);
}

async function markPending(id: string): Promise<void> {
  // Bump attempts even when staying pending so the retry cron doesn't
  // loop forever on a stuck container.
  await run(
    `UPDATE instagram_posts
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
    `UPDATE instagram_posts
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
    `UPDATE instagram_posts
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
    `UPDATE instagram_posts
     SET status = 'deleted', deleted_at = ?
     WHERE id = ?`,
    [deletedAt, id],
  );
}

// --- Instagram Graph API ---------------------------------------------------

// IG publishing for accounts linked via a FB Page uses graph.facebook.com
// — NOT graph.instagram.com (which is for Instagram-direct OAuth tokens
// from the separate Instagram Login flow). Sending a FB Page Access
// Token to graph.instagram.com returns "Cannot parse access token"
// because that subdomain expects Instagram-direct user tokens.
// graph.facebook.com is the correct endpoint when the IG Business Account
// is linked via Meta Business Suite to a FB Page (our setup). Verified
// 2026-06-24 against the live LoreWire IG account.
const IG_BASE = "https://graph.facebook.com/v22.0";

// Inline polling budget. After this, the row stays `pending` with
// `container_id` set; the retry cron resumes polling.
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

/** Step 1: create the Reel container. */
async function createContainer(
  igAccountId: string,
  videoUrl: string,
  caption: string,
  fetchImpl: IgFetchLike,
  posterUrl: string | null = null,
): Promise<
  | { ok: true; containerId: string }
  | { ok: false; error: NormalizedIgError }
> {
  const token = process.env.FB_PAGE_ACCESS_TOKEN ?? "";
  const params: Record<string, string> = {
    access_token: token,
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    // Pick the very first frame of the MP4 as the Reels cover. With the
    // hook-first splice (PR #135) frame 0 IS the story's cold-open scene,
    // so this is the explicit-contract version of "use scene 1 as the
    // grid tile" without burning extra bandwidth on a cover_url multipart
    // upload. v22 documents thumb_offset in ms; "0" matches the very
    // first frame either way. Per
    // _plans/2026-06-28-explicit-thumbnail-uploads.md.
    thumb_offset: "0",
  };
  // Phase 2: when a deliberate poster is available, ALSO send cover_url.
  // v22 Reels containers accept cover_url for a static override; if IG
  // ignores the field (some historical versions did) thumb_offset=0 still
  // produces the right cover via the splice fix. Belt-and-suspenders. Per
  // _plans/2026-06-28-phase-2-social-poster-render.md (Part 4).
  if (posterUrl) {
    params.cover_url = posterUrl;
  }
  const body = new URLSearchParams(params).toString();
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
        message: "instagram: 200 OK but missing container id",
      },
    };
  }
  return { ok: true, containerId: data.id };
}

/** Step 2 (single check): query container's status_code. */
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
        message: "instagram: container status response missing status_code",
      },
    };
  }
  return { ok: true, status };
}

/** Step 2 (loop): poll until FINISHED, ERROR, EXPIRED, or budget exhausted.
 *  Returns 'finished' (proceed to publish), 'error' (abort), or 'timeout'
 *  (stay pending, retry cron resumes). */
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
      // Treat a status-fetch network error as an abort, not a timeout —
      // a real failure should surface to the retry cron with the error
      // message, not loop here.
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
        message: `instagram container ${lastStatus.toLowerCase()}`,
      };
    }
    // IN_PROGRESS or PUBLISHED (already published — treat as finished)
    if (lastStatus === "PUBLISHED") return { kind: "finished" };
    await sleep(CONTAINER_POLL_INTERVAL_MS);
  }
  return { kind: "timeout", lastStatus };
}

/** Step 3: publish the container. */
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
        message: "instagram: publish 200 OK but missing post id",
      },
    };
  }
  return { ok: true, externalPostId: data.id };
}

/** Delete a previously-published Reel via DELETE /{post-id}. Used by
 *  the manual re-publish "delete previous" path. */
export async function deleteInstagramPost(
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
 *    1. Create container
 *    2. Poll for FINISHED (up to 30s)
 *    3. Publish container
 *  On step-2 timeout, returns `pending` with the container_id persisted
 *  so the retry cron can resume polling without re-creating. */
export async function publishShortToInstagram(
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

  const template =
    (await getSetting(SETTING_CAPTION_TEMPLATE)) ?? DEFAULT_CAPTION_TEMPLATE;
  // Resolution chain: per-publish override > seo_metadata > template.
  const seoMeta = await loadSeoMetadata(args.storyId);
  const seoIgCaption = seoMeta?.instagram?.caption;
  const metadataSource: "override" | "seo_metadata" | "template" =
    args.captionOverride != null && args.captionOverride.length > 0
      ? "override"
      : seoIgCaption
        ? "seo_metadata"
        : "template";
  const rendered =
    args.captionOverride != null && args.captionOverride.length > 0
      ? args.captionOverride
      : (seoIgCaption ?? renderCaption(template, args.context, args.storyId));
  const { caption, truncated } = trimForIg(rendered);

  const row = await insertPendingRow({
    storyId: args.storyId,
    renderId: args.renderId,
    igAccountId,
    trigger: args.trigger,
    videoUrl: args.videoUrl,
    caption,
    now: nowIso,
  });

  log("attempt", {
    story_id: row.story_id,
    render_id: row.render_id,
    trigger: row.trigger,
    ig_account_id: row.ig_account_id,
    video_url_host: hostOf(row.video_url),
    caption_len: caption.length,
    caption_truncated: truncated,
    metadata_source: metadataSource,
    ...tokenFingerprint(),
  });

  return runFullPipeline(row, fetchImpl, deps);
}

/** Step 1+2+3 runner used by both publishShortToInstagram (fresh row)
 *  and the retry cron (resuming from container_id when present). */
async function runFullPipeline(
  row: InstagramPostRow,
  fetchImpl: IgFetchLike,
  deps: PublishDeps,
): Promise<PublishResult> {
  const igAccountId = process.env.IG_BUSINESS_ACCOUNT_ID ?? "";
  if (row.ig_account_id !== igAccountId) {
    // Defense in depth — if the env var changes between insert and
    // publish, refuse to post to a different account than the row was
    // staged for.
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
      reason: "page_id mismatch",
    });
    const fresh = await getRow(row.id);
    return { status: "failed", row: fresh ?? row };
  }

  const t0 = Date.now();
  let containerId = row.container_id;

  // Phase 2 (per _plans/2026-06-28-phase-2-social-poster-render.md):
  // resolve the per-story portrait poster URL BEFORE creating the
  // container so the cover_url can land in the same POST. Best-effort:
  // a null return (no poster generated / Cloud Run failed / brand-
  // safety guard) just means the cover falls back to thumb_offset=0 =
  // frame 0 of the MP4, which is the cold-open scene per PR #135's
  // splice fix.
  //
  // Phase 3 (per _plans/2026-06-29-phase-3-og-poster-cards.md): also
  // kick off the LANDSCAPE 1200×630 OG-card render in parallel. Both
  // helpers share the same LLM call (cached after first) so the
  // marginal cost is one extra Cloud Run render. The OG result is NOT
  // used by THIS publish — it's a side effect that stamps
  // `short_config.og_poster_landscape_url` for the next OG bot fetch /
  // page render. Best-effort: failure logs and returns null without
  // throwing, so it can't block the IG publish.
  const [poster] = await Promise.all([
    ensureShortPoster(row.story_id),
    ensureOgPoster(row.story_id),
  ]);
  log("cover", {
    story_id: row.story_id,
    render_id: row.render_id,
    source: poster ? poster.source : "scene_1",
    hash: poster?.hash ?? null,
  });

  // Step 1: create container if we don't already have one
  if (!containerId) {
    const created = await createContainer(
      igAccountId,
      row.video_url,
      row.caption,
      fetchImpl,
      poster?.url ?? null,
    );
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

  // Step 2: poll
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

  // Step 3: publish
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
  if (!fresh) throw new Error("publish-to-instagram: posted row vanished");
  return { status: "posted", row: fresh };
}

/** Single retry attempt against an existing instagram_posts row.
 *  Resumes from container_id when set (skipping step 1), otherwise
 *  walks the full pipeline. Unlike publishShortToInstagram, this does
 *  NOT check the auto-publish toggle (Option A — toggle gates only new
 *  auto attempts, the retry cron always drains). */
export async function attemptInstagramPublishForRow(
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
  const row = await one<InstagramPostRow>(
    `SELECT ${COLS} FROM instagram_posts
     WHERE story_id = ? AND status = 'posted'
     ORDER BY posted_at DESC LIMIT 1`,
    [storyId],
  );
  if (!row || !row.external_post_id) {
    return { ok: false, error: "no posted row found for story" };
  }
  const started = Date.now();
  const r = await deleteInstagramPost(row.external_post_id, deps);
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
