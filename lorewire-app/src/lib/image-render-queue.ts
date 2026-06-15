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
import { resolveSceneCount } from "@/lib/scene-count";

export type ImageRenderStatus =
  | "queued"
  | "generating"
  | "done"
  | "error"
  | "cancelled";
// Asset owners visible to the admin's media-regen UI panels (Story page and
// Article page). Keep narrow so the panel components don't have to defend
// against a per-scene short owner_kind that has no UI representation here.
export type AssetOwnerKind = "story" | "article";

// What enqueueImageRegen accepts. The shorts editor's per-scene regen
// (Phase 1 of _plans/2026-06-16-short-editor-full-parity.md) widens this
// to include 'short_scene' so the existing image_renders queue can serve
// both surfaces without duplicating helpers. The Python worker's owner_kind
// dispatcher handles all three. The narrower AssetOwnerKind stays the
// type the UI panels see.
export type ImageRenderOwnerKind = AssetOwnerKind | "short_scene";

// Active = the row is doing work or about to. Terminal = the row is settled
// and a Stop button shouldn't appear. Both UI and cancel helpers reuse this.
export const ACTIVE_IMAGE_RENDER_STATUSES: ReadonlySet<ImageRenderStatus> =
  new Set(["queued", "generating"]);

/**
 * Coerce a Postgres bigint/numeric (returned as string by the `postgres`
 * driver) or SQLite integer (returned as number) into a non-negative JS
 * Number — clamped to 0 on NaN so a `null` or malformed value can't poison
 * the downstream `+` and `>` math the budget gate relies on.
 *
 * Without this the daily-budget gate misfired in production (2026-06-13):
 * `"80" + 150 = "80150"`, `"80150" > 5100 = true`, so every regen above
 * the per-call estimate floor was rejected as budget-exceeded.
 */
function toIntCents(raw: number | string | null | undefined): number {
  if (raw == null) return 0;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

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
  ownerKind: ImageRenderOwnerKind;
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
  // `postgres` returns Postgres `bigint` / `numeric` as a string to avoid
  // JS Number precision loss — and SUM on an integer column yields bigint.
  // Without an explicit coerce, `spentCents + estimateCents` does STRING
  // concat ("80" + 150 = "80150") and the daily-budget gate misfires on
  // every regen above ~5¢. Found in production 2026-06-13 against story
  // `envelope` with cap=$51 / spent=$0.80. SQLite returns a Number here
  // so the cast is also safe in the local-dev branch.
  const row = await one<{ spent: number | string | null }>(
    `SELECT COALESCE(SUM(cost_cents), 0) AS spent
     FROM image_renders
     WHERE requested_at >= ? AND cost_cents IS NOT NULL`,
    [sinceIso],
  );
  const spentCents = toIntCents(row?.spent);
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
  /** Story body. Used to auto-derive the scene count when the admin's
   *  mode setting is "auto" — same formula `resolveSceneCount` uses for
   *  the panel display, so the queue size matches the number the user
   *  clicked. Omit for article-side or test callers. */
  storyBody?: string | null;
  /** Story duration string ("M:SS" or "H:MM:SS"). Same source as above. */
  storyDuration?: string | null;
}): Promise<EnqueueScenesBulkResult> {
  // Auto-derive the count from body + duration when the story args are
  // available (the dispatch in `actions.ts` always passes them). This
  // matches what the panel + the Python pipeline both resolve to —
  // without it, the bulk enqueue used the static settings default of 30
  // and a 27-scene story got 30 queue rows where the trailing 3 fall off
  // the end of stories.images (the regression that broke `envelope`
  // 2026-06-14). Falls back to `assetImageCount("scenes")` for callers
  // (tests, legacy paths) that can't supply body + duration.
  const count =
    opts.storyBody !== undefined || opts.storyDuration !== undefined
      ? await resolveSceneCount({
          body: opts.storyBody ?? null,
          duration: opts.storyDuration ?? null,
        })
      : await assetImageCount("scenes");
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

  // Pre-size stories.images to the target count so each scene:N row has
  // a slot to write into. The worker's `_regen_one_scene` can also grow
  // the array on its own (post 2026-06-14 fix), but pre-sizing means the
  // public reader never reads a sparse list mid-rebuild — it sees the
  // existing URLs in slots 0..len-1 and empty strings in the rest until
  // each scene completes. Story-side only; article assets unaffected.
  //
  // Also nulls `stories.pipeline_cache` so the first scene:N worker
  // re-asks the LLM for a fresh prompt set + world bible keyed to the
  // current body. A Rebuild-all click is the user saying "I want a new
  // look"; reusing the cached bible would redraw the same characters
  // into different moments. Per-scene "Redo" clicks (granular grid)
  // leave the cache alone so a single redo stays consistent with its
  // neighbors. Lived inside `video_config` until 2026-06-14 — see
  // `_plans/2026-06-14-pipeline-cache-column.md`.
  if (opts.ownerKind === "story") {
    await preSizeStoryScenes(opts.ownerId, count);
    await clearStoryPipelineCache(opts.ownerId);
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

// NULL out `stories.pipeline_cache` before a Rebuild-all batch so the
// first scene:N worker rebuilds the world bible + scene prompts fresh.
// The whole column drops in one statement: world_bible,
// scene_prompts, scene_prompts_built_with, scene_entity_ids,
// character_bible — their lifetimes are coupled (prompts reference
// bible entities; evicting prompts but keeping the bible would
// produce prompts inconsistent with the next bible's character set).
//
// Pre-2026-06-14 this helper stripped the same fields from
// video_config because the cache used to live there — but
// parseVideoConfig dropped them on every editor save, so every
// scene:N>0 worker re-paid for the bible build. See
// `_plans/2026-06-14-pipeline-cache-column.md` for the diagnosis.
//
// Best-effort: a failure here doesn't fail the bulk — the worker
// would just hit stale state, which is still functionally correct,
// just not "fresh world bible every click".
async function clearStoryPipelineCache(storyId: string): Promise<void> {
  await run(
    `UPDATE stories SET pipeline_cache = NULL, updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), storyId],
  );
}

// Grow stories.images to `targetCount` entries — existing URLs keep their
// slots, missing slots are empty strings. A noop when the array is already
// at or past the target. Defined here next to enqueueScenesBulk because
// the resize is part of the bulk's invariant (every scene:i has a slot to
// write into); making it an internal helper keeps the contract together.
async function preSizeStoryScenes(
  storyId: string,
  targetCount: number,
): Promise<void> {
  const row = await one<{ images: string | null }>(
    `SELECT images FROM stories WHERE id = ?`,
    [storyId],
  );
  let current: string[] = [];
  if (row?.images) {
    try {
      const parsed = JSON.parse(row.images);
      if (Array.isArray(parsed)) {
        current = parsed.filter((u): u is string => typeof u === "string");
      }
    } catch {
      // Malformed JSON: treat as empty and overwrite below.
    }
  }
  if (current.length >= targetCount) return;
  const grown = [...current];
  while (grown.length < targetCount) grown.push("");
  await run(
    `UPDATE stories SET images = ?, updated_at = ? WHERE id = ?`,
    [JSON.stringify(grown), new Date().toISOString(), storyId],
  );
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
