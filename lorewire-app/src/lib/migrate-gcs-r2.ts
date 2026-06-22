// One batch of the GCS -> R2 media migration, run from the admin tool. The
// admin page drives this repeatedly with the returned cursor until done, so
// each call stays well inside the serverless time budget while the whole
// bucket gets copied. Properties mirror the CLI script (pipeline/
// migrate_gcs_to_r2.py): additive (never deletes GCS), idempotent (skips
// objects already in R2 at the right size), and size-verified per object.
//
// "Referenced only" mode copies just the media the DB actually points at
// (live stories, articles, segments, short renders) and skips the orphaned
// leftovers that pile up from regenerations — so the migration moves the real
// LoreWire media, not months of dead intermediates.
//
// Large objects (> MAX_OBJECT_BYTES) are reported as "too-large" rather than
// buffered through the function — the handful of big segment sources are best
// handled by the CLI. Everything else (shorts, audio, images) is well under.

import "server-only";
import { all } from "@/lib/db";
import {
  getObjectBytes,
  listObjects,
  parseGcsUrl,
  type GcsObjectMeta,
} from "@/lib/gcs";
import { mediaPublicBase } from "@/lib/media-url";
import {
  MEDIA_CACHE_CONTROL,
  headR2Object,
  mediaBucket,
  mediaUrlToKey,
  putR2Object,
} from "@/lib/r2";

// Per-object ceiling for the in-function copy. Kept modest so a single batch
// can't blow the function's memory; the rare object above this is flagged for
// the CLI instead.
export const MAX_OBJECT_BYTES = 100 * 1024 * 1024;

export type MigrateStatus =
  | "copied"
  | "skipped-present"
  | "skipped-orphan"
  | "too-large"
  | "failed"
  | "would-copy";

export interface MigrateItemResult {
  key: string;
  size: number;
  status: MigrateStatus;
  error?: string;
}

export interface MigrateBatchResult {
  /** Cursor for the next batch, or null when the listing is exhausted. */
  nextCursor: string | null;
  done: boolean;
  items: MigrateItemResult[];
}

export interface MigrateBatchOpts {
  cursor?: string | null;
  batchSize?: number;
  dryRun?: boolean;
  /** When provided, only objects whose key is in this set are copied; the rest
   *  are reported "skipped-orphan". Null/undefined copies everything. */
  referenced?: Set<string> | null;
}

// ── Referenced-key set (the "only LoreWire files" filter) ──────────────────

/** Collect every http(s) URL string anywhere inside a JSON blob. Covers the
 *  stories.images array, the article TipTap document (embedded image src), and
 *  short_renders.props (doodle_frames[].url) with one walk. */
function collectUrlsFromJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (/^https?:\/\//i.test(v)) out.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v && typeof v === "object") {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(parsed);
  return out;
}

/** Build the set of GCS object keys the database actually references. Reads the
 *  media columns across stories, articles, video_segments, and short_renders,
 *  extracting the object key from each GCS (or already-migrated R2) URL. */
export async function buildReferencedKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  const base = mediaPublicBase();
  const add = (url: string | null | undefined): void => {
    if (!url) return;
    const g = parseGcsUrl(url);
    if (g) {
      keys.add(g.key);
      return;
    }
    const mk = mediaUrlToKey(url, base);
    if (mk) keys.add(mk);
  };

  // `payload` is scanned too (defensively) so any media URL stashed there —
  // hero variants, og images, extra renders — is never under-copied. Over-
  // including a stale URL is harmless; under-including would 404 after cutover.
  const stories = await all<{
    video_url: string | null;
    audio_url: string | null;
    hero_image: string | null;
    images: string | null;
    payload: string | null;
  }>("SELECT video_url, audio_url, hero_image, images, payload FROM stories");
  for (const s of stories) {
    add(s.video_url);
    add(s.audio_url);
    add(s.hero_image);
    for (const u of collectUrlsFromJson(s.images)) add(u);
    for (const u of collectUrlsFromJson(s.payload)) add(u);
  }

  const articles = await all<{
    hero_image: string | null;
    og_image: string | null;
    document: string | null;
    payload: string | null;
  }>("SELECT hero_image, og_image, document, payload FROM articles");
  for (const a of articles) {
    add(a.hero_image);
    add(a.og_image);
    for (const u of collectUrlsFromJson(a.document)) add(u);
    for (const u of collectUrlsFromJson(a.payload)) add(u);
  }

  const segments = await all<{
    source_url: string | null;
    normalized_url: string | null;
  }>("SELECT source_url, normalized_url FROM video_segments");
  for (const v of segments) {
    add(v.source_url);
    add(v.normalized_url);
  }

  const shorts = await all<{ props: string | null }>(
    "SELECT props FROM short_renders WHERE props IS NOT NULL",
  );
  for (const sr of shorts) {
    for (const u of collectUrlsFromJson(sr.props)) add(u);
  }

  return keys;
}

declare global {
  // Cached across batches on a warm instance so a multi-batch migration doesn't
  // rebuild the referenced set on every request. The DB doesn't change during a
  // run; a short TTL bounds staleness.
  var __lwMigrateRefKeys: { keys: Set<string>; at: number } | undefined;
}

const REF_CACHE_TTL_MS = 5 * 60 * 1000;

export async function getReferencedKeys(): Promise<Set<string>> {
  const cached = globalThis.__lwMigrateRefKeys;
  const now = Date.now();
  if (cached && now - cached.at < REF_CACHE_TTL_MS) return cached.keys;
  const keys = await buildReferencedKeys();
  globalThis.__lwMigrateRefKeys = { keys, at: now };
  return keys;
}

// ── Copy ────────────────────────────────────────────────────────────────────

async function copyOne(
  obj: GcsObjectMeta,
  bucket: string,
): Promise<MigrateItemResult> {
  if (obj.size > MAX_OBJECT_BYTES) {
    return { key: obj.name, size: obj.size, status: "too-large" };
  }
  try {
    // Idempotent: already in R2 at the same size -> nothing to do.
    const existing = await headR2Object(bucket, obj.name);
    if (existing === obj.size) {
      return { key: obj.name, size: obj.size, status: "skipped-present" };
    }
    const bytes = await getObjectBytes(obj.name);
    await putR2Object(bucket, obj.name, bytes, {
      contentType: obj.contentType,
      cacheControl: MEDIA_CACHE_CONTROL,
    });
    // Verify the object landed at the right size (completeness check).
    const landed = await headR2Object(bucket, obj.name);
    if (landed !== obj.size) {
      throw new Error(`post-upload size mismatch (gcs=${obj.size} r2=${landed})`);
    }
    return { key: obj.name, size: obj.size, status: "copied" };
  } catch (e) {
    return {
      key: obj.name,
      size: obj.size,
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Process one batch: list `batchSize` objects from the cursor and copy each
 *  (or, in dry-run, just report what would copy). When `referenced` is set,
 *  objects not in it are reported "skipped-orphan". Returns the next cursor. */
export async function migrateBatch(
  opts: MigrateBatchOpts = {},
): Promise<MigrateBatchResult> {
  const batchSize = Math.min(Math.max(opts.batchSize ?? 15, 1), 100);
  const page = await listObjects({
    pageToken: opts.cursor ?? undefined,
    maxResults: batchSize,
  });
  const bucket = mediaBucket();
  const items: MigrateItemResult[] = [];
  for (const obj of page.items) {
    if (opts.referenced && !opts.referenced.has(obj.name)) {
      items.push({ key: obj.name, size: obj.size, status: "skipped-orphan" });
      continue;
    }
    if (opts.dryRun) {
      items.push({
        key: obj.name,
        size: obj.size,
        status: obj.size > MAX_OBJECT_BYTES ? "too-large" : "would-copy",
      });
      continue;
    }
    items.push(await copyOne(obj, bucket));
  }
  return {
    nextCursor: page.nextPageToken,
    done: page.nextPageToken === null,
    items,
  };
}
