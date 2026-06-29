// Admin tool: copy all media from the legacy GCS bucket to the R2 media bucket.
// Runs in the admin (Vercel) environment where both sets of credentials live,
// so there's no need to handle GCS keys locally. The actual work happens in
// batches via /api/admin/migrate/run; this page just gates on config and hosts
// the client that drives + reports the run.
//
// Gated by the (panel) layout (admin auth) and re-checked on every batch by the
// API route's requireAdmin.

import { isConfigured as isGcsConfigured } from "@/lib/gcs";
import { isR2Configured } from "@/lib/r2";
import { MigrateClient } from "./MigrateClient";

export const dynamic = "force-dynamic";

export default function MigratePage() {
  const configured =
    isGcsConfigured() && isR2Configured() && Boolean(process.env.R2_MEDIA_BUCKET);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="font-display text-2xl font-black uppercase tracking-tight text-ink">
        Media migration
      </h1>
      <p className="mt-2 text-sm text-muted">
        Copy every object from the legacy Google Cloud Storage bucket into the
        Cloudflare R2 media bucket, keys preserved. The copy is additive (GCS is
        never modified), resumable, and each object is size-verified after upload.
        Run the dry run first to see totals and the one-time GCS egress cost.
      </p>

      {configured ? (
        <MigrateClient />
      ) : (
        <p className="mt-6 rounded-lg border border-line bg-surface p-4 text-sm text-danger">
          Not configured. Set the GCS credentials (GCS_BUCKET, GCS_CLIENT_EMAIL,
          GCS_PRIVATE_KEY) and the R2 credentials (R2_* including R2_MEDIA_BUCKET)
          in this environment, then reload.
        </p>
      )}
    </div>
  );
}
