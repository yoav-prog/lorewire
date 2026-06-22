// POST /api/admin/compress/run — one batch of the existing-media WebP backfill.
//
// Admin-only. The admin page drives this per table (stories, articles,
// short_renders) with the returned cursor until each is done. Additive,
// idempotent, size-reported. See lib/compress-backfill.

import { NextResponse, type NextRequest } from "next/server";

import { requireCapability } from "@/lib/dal";
import { isR2Configured } from "@/lib/r2";
import {
  COMPRESS_TABLES,
  compressBackfillBatch,
} from "@/lib/compress-backfill";

export const runtime = "nodejs";
export const maxDuration = 300;

interface RunBody {
  table?: string;
  cursor?: string | null;
  dryRun?: boolean;
  batchSize?: number;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  await requireCapability("settings.manage");

  if (
    !isR2Configured() ||
    !process.env.R2_MEDIA_BUCKET ||
    !process.env.MEDIA_PUBLIC_BASE
  ) {
    return NextResponse.json(
      {
        error:
          "Compression backfill needs R2 (incl. R2_MEDIA_BUCKET) and " +
          "MEDIA_PUBLIC_BASE set — it runs after the media cutover.",
      },
      { status: 503 },
    );
  }

  let body: RunBody;
  try {
    body = (await req.json()) as RunBody;
  } catch {
    body = {};
  }

  try {
    const result = await compressBackfillBatch({
      table: body.table ?? COMPRESS_TABLES[0].table,
      cursor: body.cursor ?? null,
      dryRun: Boolean(body.dryRun),
      batchSize: typeof body.batchSize === "number" ? body.batchSize : undefined,
    });
    return NextResponse.json(result);
  } catch (e) {
    console.error("[admin compress] batch failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "batch failed" },
      { status: 500 },
    );
  }
}
