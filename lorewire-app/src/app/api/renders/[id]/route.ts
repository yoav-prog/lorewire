// Render-status polling endpoint for the /admin/videos/[id] editor.
//
// The Render button enqueues a video_renders row; the client then polls
// here every ~2s until status is `done` or `error`. Auth is admin-only —
// the row's existence and the output_url are sensitive admin metadata.

import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/dal";
import { getRender } from "@/lib/video-render-queue";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireCapability("content.manage");
  const { id } = await params;
  const row = await getRender(id);
  if (!row) {
    return NextResponse.json(
      { error: "render-not-found" },
      { status: 404 },
    );
  }
  return NextResponse.json({
    id: row.id,
    story_id: row.story_id,
    status: row.status,
    progress: row.progress,
    error: row.error,
    output_url: row.output_url,
    requested_at: row.requested_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  });
}
