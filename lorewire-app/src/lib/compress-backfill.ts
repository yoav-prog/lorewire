// Backfill: compress every existing image the DB references to WebP, in place
// of the giant lossless PNGs that make media slow (a 2.68 MB frame becomes
// ~200 KB). Per row, for each referenced image URL we ensure a `.webp` twin
// exists in R2 (download the original, re-encode with sharp, upload), then swap
// `.png/.jpg -> .webp` in the stored URL with a uniform string-replace across
// the row's text columns. Properties:
//   - Additive: the original objects are left in R2/GCS; only a `.webp` is
//     added and the DB URL is repointed (reversible by swapping back).
//   - Idempotent: an image whose `.webp` already exists is skipped, and a row
//     with no `.png/.jpg` URLs left is a no-op — so a re-run is safe.
//   - Batched + cursored per table (stories, articles, short_renders), so the
//     admin tool can drive it within the serverless time budget.
//
// Runs post-cutover (MEDIA_PUBLIC_BASE set): the stored URL keeps its host and
// just changes extension; the read resolver maps it onto the R2 `.webp`.
//
// Plan: _plans/2026-06-22-media-compression.md.

import "server-only";
import sharp from "sharp";
import { all, run } from "@/lib/db";
import { parseGcsUrl } from "@/lib/gcs";
import { mediaPublicBase } from "@/lib/media-url";
import {
  MEDIA_CACHE_CONTROL,
  getR2ObjectBytes,
  headR2Object,
  mediaBucket,
  mediaUrlToKey,
  putR2Object,
} from "@/lib/r2";

const WEBP_QUALITY = 82;

// Image URLs anywhere in a column's text (single value, JSON array, or rich-text
// document). Matches .png/.jpg/.jpeg with an optional query string.
const IMAGE_URL_RE = /https?:\/\/[^\s"'<>)\\]+?\.(?:png|jpe?g)(?:\?[^\s"'<>)\\]*)?/gi;
// The trailing image extension to swap (only at the end of the path).
const IMG_EXT_RE = /\.(?:png|jpe?g)(?=$|\?|#)/i;

export interface TableSpec {
  table: string;
  cols: string[];
}

// Text columns on each table that can hold image URLs. Verified against
// lib/schema.ts. video_url/audio_url are deliberately excluded (not images).
export const COMPRESS_TABLES: readonly TableSpec[] = [
  { table: "stories", cols: ["hero_image", "images", "payload"] },
  { table: "articles", cols: ["hero_image", "og_image", "document", "payload"] },
  { table: "short_renders", cols: ["props"] },
];

export function imageUrlsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.match(IMAGE_URL_RE) ?? [];
}

export function toWebpUrl(url: string): string {
  return url.replace(IMG_EXT_RE, ".webp");
}

export function urlToKey(url: string): string | null {
  const g = parseGcsUrl(url);
  if (g) return g.key;
  return mediaUrlToKey(url, mediaPublicBase());
}

/** Ensure the WebP twin of an image key exists in R2. Returns the sizes, or
 *  null when there's nothing to do (already WebP). Idempotent: an existing
 *  `.webp` short-circuits without re-encoding. Throws if the source isn't in R2
 *  or the re-encode fails (the caller records it as a failure). */
async function ensureWebp(
  pngKey: string,
): Promise<{ webpKey: string; oldSize: number; newSize: number } | null> {
  if (/\.webp$/i.test(pngKey)) return null;
  const webpKey = pngKey.replace(IMG_EXT_RE, ".webp");
  const bucket = mediaBucket();
  const existing = await headR2Object(bucket, webpKey);
  if (existing !== null) {
    return { webpKey, oldSize: 0, newSize: existing };
  }
  const bytes = await getR2ObjectBytes(bucket, pngKey);
  const webp = await sharp(Buffer.from(bytes))
    .rotate()
    .webp({ quality: WEBP_QUALITY, effort: 6 })
    .toBuffer();
  await putR2Object(bucket, webpKey, webp, {
    contentType: "image/webp",
    cacheControl: MEDIA_CACHE_CONTROL,
  });
  return { webpKey, oldSize: bytes.byteLength, newSize: webp.length };
}

export interface CompressBatchOpts {
  table: string;
  cursor?: string | null;
  batchSize?: number;
  dryRun?: boolean;
}

export interface CompressBatchResult {
  table: string;
  nextCursor: string | null;
  done: boolean;
  rows: number;
  compressed: number;
  skipped: number;
  bytesBefore: number;
  bytesAfter: number;
  failures: Array<{ url: string; error: string }>;
}

// Bounded-concurrency map: run `fn` over `items`, at most `limit` in flight.
// JS is single-threaded so the shared counters the callbacks mutate are safe;
// only the awaited I/O overlaps — which is the whole point, since the per-image
// download dominates, so a few in flight is several times faster than serial.
async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]);
      }
    },
  );
  await Promise.all(workers);
}

export async function compressBackfillBatch(
  opts: CompressBatchOpts,
): Promise<CompressBatchResult> {
  const spec = COMPRESS_TABLES.find((t) => t.table === opts.table);
  if (!spec) throw new Error(`unknown compress table: ${opts.table}`);
  const batchSize = Math.min(Math.max(opts.batchSize ?? 25, 1), 50);
  // Bound the WORK per request, not the row count. A single image-heavy row can
  // reference dozens of multi-megabyte frames, so a flat 10-row batch ran for
  // minutes and could blow past the 300 s serverless limit with no progress
  // shown — which reads as "stuck". Instead we stop at the first row boundary
  // once this request has done enough real encodes (or, in a dry run, examined
  // enough images) and hand back a cursor so the client resumes cleanly. Skips
  // and already-done images are cheap and don't count, so re-runs sail through
  // many rows per request.
  const WORK_BUDGET = opts.dryRun ? 120 : 8;
  const CONCURRENCY = 4;

  const where = opts.cursor ? "WHERE id > ?" : "";
  const params = opts.cursor ? [opts.cursor] : [];
  const rows = await all<Record<string, string | null>>(
    `SELECT id, ${spec.cols.join(", ")} FROM ${spec.table} ${where} ` +
      `ORDER BY id LIMIT ${batchSize}`,
    params,
  );

  let compressed = 0;
  let skipped = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  let work = 0;
  let stoppedEarly = false;
  const failures: Array<{ url: string; error: string }> = [];
  let lastId: string | null = null;

  for (const row of rows) {
    lastId = row.id;
    const urls = new Set<string>();
    for (const c of spec.cols) {
      for (const u of imageUrlsIn(row[c])) urls.add(u);
    }
    if (urls.size === 0) continue;

    const replace: Record<string, string> = {};
    await mapPool([...urls], CONCURRENCY, async (url) => {
      const key = urlToKey(url);
      if (!key || /\.webp$/i.test(key)) {
        skipped += 1;
        return;
      }
      try {
        if (opts.dryRun) {
          const exists = await headR2Object(mediaBucket(), toWebpUrl(key));
          if (exists === null) compressed += 1;
          else skipped += 1;
          work += 1;
          return;
        }
        const r = await ensureWebp(key);
        if (!r) {
          skipped += 1;
          return;
        }
        replace[url] = toWebpUrl(url);
        compressed += 1;
        bytesBefore += r.oldSize;
        bytesAfter += r.newSize;
        // Only an actual download + re-encode counts toward the budget; a row
        // whose .webp twins already exist is cheap (HEAD only) and shouldn't
        // shorten the request.
        if (r.oldSize > 0) work += 1;
      } catch (e) {
        failures.push({ url, error: e instanceof Error ? e.message : String(e) });
      }
    });

    if (!opts.dryRun && Object.keys(replace).length > 0) {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const c of spec.cols) {
        let text = row[c];
        if (!text) continue;
        let changed = false;
        for (const [oldU, newU] of Object.entries(replace)) {
          if (text.includes(oldU)) {
            text = text.split(oldU).join(newU);
            changed = true;
          }
        }
        if (changed) {
          sets.push(`${c} = ?`);
          vals.push(text);
        }
      }
      if (sets.length > 0) {
        vals.push(row.id);
        await run(`UPDATE ${spec.table} SET ${sets.join(", ")} WHERE id = ?`, vals);
      }
    }

    if (work >= WORK_BUDGET) {
      stoppedEarly = true;
      break;
    }
  }

  // Done only when we consumed the whole selected page AND weren't cut off early
  // by the work budget. Otherwise hand back the last processed id so the next
  // request resumes right after it (no row processed twice, none skipped).
  const done = !stoppedEarly && rows.length < batchSize;
  return {
    table: opts.table,
    nextCursor: done ? null : lastId,
    done,
    rows: rows.length,
    compressed,
    skipped,
    bytesBefore,
    bytesAfter,
    failures,
  };
}
