// Image regen queue, mirroring video-render-queue.ts.
//
// Schema: image_renders table (see schema.ts). One row per regen request,
// drained by pipeline/image_render_worker.py.
//
// Identity:
//   owner_kind  "story" | "article"
//   owner_id    the row id in stories or articles
//   asset       slug — "hero" | "scene:0" | "scene:12" | "prop:3" |
//               "mouth_swap" for stories; "hero" | "og" | "gallery:0" |
//               "body:<node-id>" for articles.
//
// Idempotency:
//   The queue is NOT strictly idempotent on (owner, asset) — every click
//   is a fresh row. Users wanting a different result hit Regenerate;
//   over-protecting them with config-hash dedup would be confusing.
//   Burn protection lives in the daily-budget check (budget.daily_usd).
//
// Cost surface (rule 8):
//   estimateImageRegenCostCents looks up the active image model in the
//   pipeline registry and returns the per-image average from media.py's
//   IMAGE_COST_USD table. Surfaced to the admin BEFORE they click. After
//   the worker finishes, the actual `cost_cents` lands on the row.

import "server-only";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";
import { selected } from "@/lib/models";
import { getSetting } from "@/lib/repo";

export type ImageRenderStatus =
  | "queued"
  | "generating"
  | "done"
  | "error"
  | "cancelled";
export type AssetOwnerKind = "story" | "article";

// Active = the row is doing work or about to. Terminal = the row is settled
// and a Stop button shouldn't appear. Both UI and cancel helpers reuse this.
export const ACTIVE_IMAGE_RENDER_STATUSES: ReadonlySet<ImageRenderStatus> =
  new Set(["queued", "generating"]);

export interface ImageRenderRow {
  id: string;
  owner_kind: string;
  owner_id: string;
  asset: string;
  prompt_hash: string | null;
  status: ImageRenderStatus;
  progress: number;
  error: string | null;
  output_url: string | null;
  cost_cents: number | null;
  requested_by: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const COLS =
  "id, owner_kind, owner_id, asset, prompt_hash, status, progress, error, output_url, cost_cents, requested_by, requested_at, started_at, finished_at";

// Per-image cost estimate by model. Mirrors pipeline/media.py:IMAGE_COST_USD
// — keeping this in sync needs care when models are added or repriced.
// Numbers are best-effort averages; the worker writes the actual spend back
// to the row's cost_cents once kie returns a creditsConsumed count.
const IMAGE_COST_USD: Record<string, number> = {
  "kie/gpt-image-2": 0.05,
  "kie/nano-banana-2": 0.04,
  "kie/nano-banana-pro": 0.1,
};

// Mouth-swap generates two images (portrait + mouth-removed); cost it
// accordingly. The bulk slugs "scenes" / "props" read their image count
// from the same admin settings the pipeline uses, so the estimate stays
// accurate as the admin tunes those numbers.
const ASSET_FIXED_COUNT: Record<string, number> = {
  // hero regen now generates BOTH portrait (3:4) and landscape (16:9)
  // so the public reader, OG card, and landscape video poster all stay
  // in sync. See _plans/2026-06-12-video-aspect-ratio.md caveat fixes.
  // Pre-flight estimate matches what `pipeline/media.py:_regen_hero`
  // actually consumes from the kie budget.
  hero: 2,
  og: 1,
  mouth_swap: 2,
};

const SCENE_DEFAULT = 30;
const SCENE_MIN = 6;
const SCENE_MAX = 60;
const PROP_DEFAULT = 5;
const PROP_MIN = 3;
const PROP_MAX = 10;

async function assetImageCount(asset: string): Promise<number> {
  if (asset in ASSET_FIXED_COUNT) return ASSET_FIXED_COUNT[asset];
  if (asset === "scenes") {
    const raw = await getSetting("media.scene_count");
    return clampInt(raw, SCENE_DEFAULT, SCENE_MIN, SCENE_MAX);
  }
  if (asset === "props") {
    const raw = await getSetting("media.prop_count");
    return clampInt(raw, PROP_DEFAULT, PROP_MIN, PROP_MAX);
  }
  // scene:N, prop:N, gallery:N, body:<id> — all single-image regens.
  return 1;
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export async function estimateImageRegenCostCents(
  asset: string,
  /** Override the per-asset image count. Used by article-bulk slugs whose
   *  count comes from the document, not a global setting. */
  imageCountOverride?: number,
): Promise<number> {
  const activeModel = await selected("images"); // e.g. "kie/gpt-image-2"
  const perImage = IMAGE_COST_USD[activeModel] ?? 0.05;
  const count =
    imageCountOverride !== undefined && imageCountOverride >= 0
      ? imageCountOverride
      : await assetImageCount(asset);
  return Math.round(perImage * 100 * count);
}

// ─── enqueue ─────────────────────────────────────────────────────────────────

export async function enqueueImageRegen(opts: {
  ownerKind: AssetOwnerKind;
  ownerId: string;
  asset: string;
  promptHash: string | null;
  requestedBy: string | null;
}): Promise<ImageRenderRow> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO image_renders
      (id, owner_kind, owner_id, asset, prompt_hash, status, progress, error,
       output_url, cost_cents, requested_by, requested_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
    [
      id,
      opts.ownerKind,
      opts.ownerId,
      opts.asset,
      opts.promptHash,
      opts.requestedBy,
      now,
    ],
  );
  const fresh = await one<ImageRenderRow>(
    `SELECT ${COLS} FROM image_renders WHERE id = ?`,
    [id],
  );
  if (!fresh) {
    throw new Error("[image render queue] insert succeeded but row missing");
  }
  return fresh;
}

// ─── reads ───────────────────────────────────────────────────────────────────

export async function getImageRender(
  id: string,
): Promise<ImageRenderRow | null> {
  return one<ImageRenderRow>(
    `SELECT ${COLS} FROM image_renders WHERE id = ?`,
    [id],
  );
}

export async function recentRendersForOwner(
  ownerKind: AssetOwnerKind,
  ownerId: string,
  limit = 20,
): Promise<ImageRenderRow[]> {
  return all<ImageRenderRow>(
    `SELECT ${COLS} FROM image_renders
     WHERE owner_kind = ? AND owner_id = ?
     ORDER BY requested_at DESC LIMIT ?`,
    [ownerKind, ownerId, limit],
  );
}

// ─── per-row event timeline (2026-06-13 Phase 2) ─────────────────────────────
// The drain handler + the pipeline regen helpers write structured events
// into `image_render_events` (one row per checkpoint). The admin UI
// reads them through `listRenderEvents` and renders an inline timeline
// under each row so "Generating · 4m ago" stops being the only signal.

export type RenderEventLevel = "info" | "warn" | "error";

export interface RenderEventRow {
  id: string;
  render_id: string;
  ts: string;
  level: RenderEventLevel;
  event: string;
  message: string | null;
  /** JSON-encoded structured payload; UI parses + displays inline. */
  payload: string | null;
}

const EVENT_COLS =
  "id, render_id, ts, level, event, message, payload";

/**
 * Read the event timeline for one render row in chronological order
 * (oldest first). 200 is enough for a 27-scene rebuild (~5 events per
 * image = ~135) plus dispatch overhead.
 */
export async function listRenderEvents(
  renderId: string,
  limit = 200,
): Promise<RenderEventRow[]> {
  return all<RenderEventRow>(
    `SELECT ${EVENT_COLS} FROM image_render_events
     WHERE render_id = ?
     ORDER BY ts ASC LIMIT ?`,
    [renderId, limit],
  );
}

// Most recent render for a specific asset of an owner. Used by the UI to
// show "Last regenerated: 2m ago" + the latest output_url / error.
export async function latestRenderForAsset(
  ownerKind: AssetOwnerKind,
  ownerId: string,
  asset: string,
): Promise<ImageRenderRow | null> {
  return one<ImageRenderRow>(
    `SELECT ${COLS} FROM image_renders
     WHERE owner_kind = ? AND owner_id = ? AND asset = ?
     ORDER BY requested_at DESC LIMIT 1`,
    [ownerKind, ownerId, asset],
  );
}

// ─── budget ──────────────────────────────────────────────────────────────────
// Image regens count against the same daily-USD cap the pipeline uses for
// auto-runs. Sum the cost_cents of every image_renders row whose
// requested_at is within the rolling 24h window. The cap is a SOFT cap —
// matches the pipeline's behavior — but the admin UI surfaces the
// remaining budget so the user can decide before clicking.

const DEFAULT_DAILY_USD = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BudgetState {
  spentCents: number;
  capCents: number;
  /** Cents headroom remaining; can be negative if the cap was breached. */
  remainingCents: number;
  /** True if `spentCents >= capCents`. */
  exceeded: boolean;
}

export async function getDailyImageBudget(): Promise<BudgetState> {
  const raw = await getSetting("budget.daily_usd");
  const capUsd =
    raw !== null && Number.isFinite(parseFloat(raw))
      ? parseFloat(raw)
      : DEFAULT_DAILY_USD;
  const capCents = Math.round(capUsd * 100);

  const sinceIso = new Date(Date.now() - DAY_MS).toISOString();
  const row = await one<{ spent: number | null }>(
    `SELECT COALESCE(SUM(cost_cents), 0) AS spent
     FROM image_renders
     WHERE requested_at >= ? AND cost_cents IS NOT NULL`,
    [sinceIso],
  );
  const spentCents = row?.spent ?? 0;
  return {
    spentCents,
    capCents,
    remainingCents: capCents - spentCents,
    exceeded: spentCents >= capCents,
  };
}

// Pre-flight budget check. Caller passes the asset slug; we look up its
// estimated cost and return whether enqueuing would exceed the daily cap.
// The actual cost on the row is what the worker writes after kie returns,
// so this is an estimate-vs-spent check — the cap can still be exceeded
// by a few cents if a render is in flight when a fresh one is enqueued.
export async function canEnqueueImageRegen(asset: string): Promise<{
  ok: boolean;
  estimateCents: number;
  budget: BudgetState;
}> {
  const [estimateCents, budget] = await Promise.all([
    estimateImageRegenCostCents(asset),
    getDailyImageBudget(),
  ]);
  return {
    ok: budget.spentCents + estimateCents <= budget.capCents,
    estimateCents,
    budget,
  };
}

// ─── cancel ──────────────────────────────────────────────────────────────────
// Soft cancel: flip the row to 'cancelled' so the cron drain stops touching
// it. No kie cancel call (kie has no public cancel endpoint as of 2026-06-13);
// if a generation finishes server-side after this flip, the result is simply
// discarded because the worker checks status before writing the URL back.
//
// Conditional WHERE clause makes the call idempotent — racing with the cron
// claim leaves whichever transition lands second as a noop. A row that's
// already done/error/cancelled returns null so the caller can surface
// "nothing to cancel" cleanly.

export async function cancelImageRender(
  renderId: string,
  reason: string,
): Promise<ImageRenderRow | null> {
  const now = new Date().toISOString();
  await run(
    `UPDATE image_renders
        SET status = 'cancelled', error = ?, finished_at = ?
      WHERE id = ? AND status IN ('queued','generating')`,
    [reason, now, renderId],
  );
  return getImageRender(renderId);
}

export async function cancelAllImageRendersForOwner(
  ownerKind: AssetOwnerKind,
  ownerId: string,
  reason: string,
): Promise<{ cancelled: string[] }> {
  const now = new Date().toISOString();
  // Snapshot the active row ids before the UPDATE so callers (and the event
  // log writer in actions.ts) can iterate exactly the rows we touched.
  const active = await all<{ id: string }>(
    `SELECT id FROM image_renders
       WHERE owner_kind = ? AND owner_id = ?
         AND status IN ('queued','generating')`,
    [ownerKind, ownerId],
  );
  if (active.length === 0) return { cancelled: [] };
  await run(
    `UPDATE image_renders
        SET status = 'cancelled', error = ?, finished_at = ?
      WHERE owner_kind = ? AND owner_id = ?
        AND status IN ('queued','generating')`,
    [reason, now, ownerKind, ownerId],
  );
  return { cancelled: active.map((r) => r.id) };
}

// ─── bulk scenes enqueue ─────────────────────────────────────────────────────
// Replaces the legacy single 'scenes' row that walked all N scenes in one
// Vercel function invocation — that pattern can't fit under maxDuration and
// the row got reaped + re-claimed forever, with no scene_urls ever persisting
// (see _plans/2026-06-13-stop-button-and-per-scene-queue.md).
//
// Each scene:N row regens one image (~30s, well under the per-tick deadline)
// and `_regen_one_scene` already splices into stories.images after each save,
// so partial progress survives a function death.
//
// One atomic budget check covers the whole batch: the user clicks once, they
// shouldn't get half the scenes accepted and half rejected.

export interface EnqueueScenesBulkResult {
  ok: boolean;
  count?: number;
  estimateCents?: number;
  spentCents?: number;
  capCents?: number;
  firstRenderId?: string;
  error?: string;
}

export async function enqueueScenesBulk(opts: {
  ownerKind: AssetOwnerKind;
  ownerId: string;
  requestedBy: string | null;
}): Promise<EnqueueScenesBulkResult> {
  const count = await assetImageCount("scenes");
  const [perSceneCents, budget] = await Promise.all([
    estimateImageRegenCostCents("scene:0"),
    getDailyImageBudget(),
  ]);
  const totalCents = perSceneCents * count;
  if (budget.spentCents + totalCents > budget.capCents) {
    return {
      ok: false,
      error: "daily-budget-exceeded",
      estimateCents: totalCents,
      spentCents: budget.spentCents,
      capCents: budget.capCents,
    };
  }

  const now = new Date().toISOString();
  const ids = Array.from({ length: count }, () => randomUUID());
  // Insert one row at a time inside a loop. Postgres would let us multi-row
  // INSERT in one statement, but SQLite's wrapper here uses positional
  // params and the cost is N tiny inserts on the same connection — well
  // under a millisecond per row in practice. Trade-off is a tighter blast
  // radius if any insert throws midway.
  for (let i = 0; i < count; i++) {
    await run(
      `INSERT INTO image_renders
         (id, owner_kind, owner_id, asset, prompt_hash, status, progress,
          error, output_url, cost_cents, requested_by, requested_at,
          started_at, finished_at)
       VALUES (?, ?, ?, ?, NULL, 'queued', 0, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
      [ids[i], opts.ownerKind, opts.ownerId, `scene:${i}`, opts.requestedBy, now],
    );
  }
  return {
    ok: true,
    count,
    estimateCents: totalCents,
    spentCents: budget.spentCents,
    capCents: budget.capCents,
    firstRenderId: ids[0],
  };
}

// Aggregate view of every scene:N row most-recently enqueued for an owner.
// Used by the MediaRegenPanel to render the "All scene images" card as a
// single status with progress (12/27 done, 3 in flight, …) without losing
// the underlying granularity. Looks back to the most recent batch by
// finding the latest scene:* requested_at and pulling every row at-or-after
// that timestamp minus a small fudge so rows inserted in the same ms tick
// still group together.
export interface BulkScenesAggregate {
  /** Most-recent batch's representative row, used by LatestRenderLine. */
  latest: ImageRenderRow | null;
  /** Total rows in the most-recent batch. */
  total: number;
  /** Counts within the most-recent batch. */
  done: number;
  active: number;
  error: number;
  cancelled: number;
  /** Render ids of currently active rows — stops target these. */
  activeIds: string[];
}

export async function latestBulkScenes(
  ownerKind: AssetOwnerKind,
  ownerId: string,
): Promise<BulkScenesAggregate> {
  const newest = await one<ImageRenderRow>(
    `SELECT ${COLS} FROM image_renders
       WHERE owner_kind = ? AND owner_id = ? AND asset LIKE 'scene:%'
       ORDER BY requested_at DESC LIMIT 1`,
    [ownerKind, ownerId],
  );
  if (!newest) {
    return {
      latest: null,
      total: 0,
      done: 0,
      active: 0,
      error: 0,
      cancelled: 0,
      activeIds: [],
    };
  }
  const batchRows = await all<ImageRenderRow>(
    `SELECT ${COLS} FROM image_renders
       WHERE owner_kind = ? AND owner_id = ? AND asset LIKE 'scene:%'
         AND requested_at >= ?
       ORDER BY requested_at ASC`,
    [ownerKind, ownerId, newest.requested_at],
  );
  let done = 0;
  let active = 0;
  let errorCount = 0;
  let cancelled = 0;
  const activeIds: string[] = [];
  for (const r of batchRows) {
    if (r.status === "done") done++;
    else if (r.status === "error") errorCount++;
    else if (r.status === "cancelled") cancelled++;
    else {
      active++;
      activeIds.push(r.id);
    }
  }
  return {
    latest: newest,
    total: batchRows.length,
    done,
    active,
    error: errorCount,
    cancelled,
    activeIds,
  };
}
