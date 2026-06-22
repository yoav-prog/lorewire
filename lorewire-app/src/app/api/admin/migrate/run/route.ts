// POST /api/admin/migrate/run — run ONE batch of the GCS -> R2 media migration.
//
// Admin-only. The admin page calls this repeatedly with the returned cursor
// until `done`, so each request stays inside the serverless time budget while
// the whole bucket is copied. The work is additive (GCS is never touched),
// idempotent (objects already in R2 at the right size are skipped), and
// size-verified per object. See lib/migrate-gcs-r2 and the CLI equivalent
// pipeline/migrate_gcs_to_r2.py.

import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/dal";
import { isConfigured as isGcsConfigured } from "@/lib/gcs";
import { isR2Configured } from "@/lib/r2";
import { migrateBatch } from "@/lib/migrate-gcs-r2";

// sharp/streaming aside, this is a Node route and a batch with a large-ish
// object can take a while — give it headroom.
export const runtime = "nodejs";
export const maxDuration = 300;

interface RunBody {
  cursor?: string | null;
  dryRun?: boolean;
  batchSize?: number;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  await requireAdmin();

  if (!isGcsConfigured() || !isR2Configured() || !process.env.R2_MEDIA_BUCKET) {
    return NextResponse.json(
      {
        error:
          "Migration not configured. Need GCS (GCS_BUCKET/CLIENT_EMAIL/PRIVATE_KEY) " +
          "and R2 (R2_* incl. R2_MEDIA_BUCKET) in the environment.",
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
    const result = await migrateBatch({
      cursor: body.cursor ?? null,
      dryRun: Boolean(body.dryRun),
      batchSize: typeof body.batchSize === "number" ? body.batchSize : undefined,
    });
    return NextResponse.json(result);
  } catch (e) {
    console.error("[admin migrate] batch failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "batch failed" },
      { status: 500 },
    );
  }
}
