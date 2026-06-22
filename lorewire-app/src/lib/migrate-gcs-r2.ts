// One batch of the GCS -> R2 media migration, run from the admin tool. The
// admin page drives this repeatedly with the returned cursor until done, so
// each call stays well inside the serverless time budget while the whole
// bucket gets copied. Properties mirror the CLI script (pipeline/
// migrate_gcs_to_r2.py): additive (never deletes GCS), idempotent (skips
// objects already in R2 at the right size), and size-verified per object.
//
// Large objects (> MAX_OBJECT_BYTES) are reported as "too-large" rather than
// buffered through the function — the handful of big segment sources are best
// handled by the CLI. Everything else (shorts, audio, images) is well under.

import "server-only";
import {
  getObjectBytes,
  listObjects,
  type GcsObjectMeta,
} from "@/lib/gcs";
import {
  MEDIA_CACHE_CONTROL,
  headR2Object,
  mediaBucket,
  putR2Object,
} from "@/lib/r2";

// Per-object ceiling for the in-function copy. Kept modest so a single batch
// can't blow the function's memory; the rare object above this is flagged for
// the CLI instead.
export const MAX_OBJECT_BYTES = 100 * 1024 * 1024;

export type MigrateStatus =
  | "copied"
  | "skipped-present"
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
}

async function copyOne(obj: GcsObjectMeta, bucket: string): Promise<MigrateItemResult> {
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
 *  (or, in dry-run, just report what would copy). Returns the next cursor. */
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
