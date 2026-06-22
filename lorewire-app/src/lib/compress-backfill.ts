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

export async function compressBackfillBatch(
  opts: CompressBatchOpts,
): Promise<CompressBatchResult> {
  const spec = COMPRESS_TABLES.find((t) => t.table === opts.table);
  if (!spec) throw new Error(`unknown compress table: ${opts.table}`);
  const batchSize = Math.min(Math.max(opts.batchSize ?? 10, 1), 50);
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
    for (const url of urls) {
      const key = urlToKey(url);
      if (!key || /\.webp$/i.test(key)) {
        skipped += 1;
        continue;
      }
      try {
        if (opts.dryRun) {
          const exists = await headR2Object(mediaBucket(), toWebpUrl(key));
          if (exists === null) compressed += 1;
          else skipped += 1;
          continue;
        }
        const r = await ensureWebp(key);
        if (!r) {
          skipped += 1;
          continue;
        }
        replace[url] = toWebpUrl(url);
        compressed += 1;
        bytesBefore += r.oldSize;
        bytesAfter += r.newSize;
      } catch (e) {
        failures.push({ url, error: e instanceof Error ? e.message : String(e) });
      }
    }

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
  }

  return {
    table: opts.table,
    nextCursor: rows.length < batchSize ? null : lastId,
    done: rows.length < batchSize,
    rows: rows.length,
    compressed,
    skipped,
    bytesBefore,
    bytesAfter,
    failures,
  };
}
