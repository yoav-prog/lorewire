// Admin tool: compress all existing images the DB references to WebP, in place
// of the giant lossless PNGs that make media slow. Runs in the admin (Vercel)
// environment where R2 + DB creds live. Post-cutover only (needs
// MEDIA_PUBLIC_BASE). Batched via /api/admin/compress/run; this page gates on
// config and hosts the client.

import { isR2Configured } from "@/lib/r2";
import { CompressClient } from "./CompressClient";

export const dynamic = "force-dynamic";

export default function CompressPage() {
  const ready =
    isR2Configured() &&
    Boolean(process.env.R2_MEDIA_BUCKET) &&
    Boolean(process.env.MEDIA_PUBLIC_BASE);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="font-display text-2xl font-black uppercase tracking-tight text-ink">
        Compress existing media
      </h1>
      <p className="mt-2 text-sm text-muted">
        Re-encode every image the database references (hero, scene frames, article
        images) from multi-megabyte PNG to WebP — roughly 10-15× smaller at the
        same visual quality, which is what fixes slow media. The originals are
        left untouched; only a WebP copy is added and the stored URL is repointed.
        Resumable and idempotent. Run the dry run first.
      </p>

      {ready ? (
        <CompressClient />
      ) : (
        <p className="mt-6 rounded-lg border border-line bg-surface p-4 text-sm text-danger">
          Not available. This runs after the media cutover — set R2 (incl.
          R2_MEDIA_BUCKET) and MEDIA_PUBLIC_BASE in this environment, then reload.
        </p>
      )}
    </div>
  );
}
