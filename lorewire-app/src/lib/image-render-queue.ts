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

export type ImageRenderStatus = "queued" | "generating" | "done" | "error";
export type AssetOwnerKind = "story" | "article";

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
// accordingly. Props are single images each — the prop_count setting
// drives N regen calls if the admin asks to redo all props.
const ASSET_IMAGE_COUNT: Record<string, number> = {
  hero: 1,
  og: 1,
  mouth_swap: 2,
};

function assetImageCount(asset: string): number {
  if (asset in ASSET_IMAGE_COUNT) return ASSET_IMAGE_COUNT[asset];
  // scene:N, prop:N, gallery:N, body:<id> — all single-image regens.
  return 1;
}

export async function estimateImageRegenCostCents(asset: string): Promise<number> {
  const activeModel = await selected("images"); // e.g. "kie/gpt-image-2"
  const perImage = IMAGE_COST_USD[activeModel] ?? 0.05;
  const count = assetImageCount(asset);
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
