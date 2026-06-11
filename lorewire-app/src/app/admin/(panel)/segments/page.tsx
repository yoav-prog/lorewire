// Intro/outro library (Wave 3 Phase 4). Two stacked sections — Intros and
// Outros — each with an upload form (browser -> GCS resumable, never through
// Vercel), a master "Active" badge, and a row of controls per uploaded
// segment (preview, rename, set active, enable/disable, delete). The master
// switch `video.intro_outro_enabled` lives on the Settings page; we link to
// it so the admin can see it without leaving here.
//
// Uploads land as `status='pending'`; once the browser confirms the PUT,
// finalize flips to `uploading`; pipeline/segments_worker.py picks it up,
// normalizes with ffmpeg, and flips to `ready`. While any row on the page is
// in a transitional state, <SegmentsAutoRefresh> polls every 5s so the chip
// transitions live in front of the admin.

import Link from "next/link";
import { requireAdmin } from "@/lib/dal";
import {
  getSetting,
  listSegments,
  type SegmentKind,
  type SegmentRow,
} from "@/lib/repo";
import {
  setActiveSegmentAction,
  setSegmentEnabledAction,
  renameSegmentAction,
  deleteSegmentAction,
} from "@/app/admin/actions";
import { SegmentUploadForm } from "./SegmentUploadForm";
import { SegmentsAutoRefresh } from "./SegmentsAutoRefresh";

function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return "—";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const TRANSITIONAL_STATUSES = new Set(["pending", "uploading", "normalizing"]);

function isTransitional(row: SegmentRow): boolean {
  return TRANSITIONAL_STATUSES.has(row.status ?? "");
}

export default async function SegmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const errorKey = typeof sp.error === "string" ? sp.error : "";
  const activeIntroId = (await getSetting("video.active_intro_id")) ?? "";
  const activeOutroId = (await getSetting("video.active_outro_id")) ?? "";
  const masterRaw = (await getSetting("video.intro_outro_enabled")) ?? "";
  const masterExplicitlyOff = ["0", "false", "off", "no"].includes(
    masterRaw.trim().toLowerCase(),
  );

  const [intros, outros] = await Promise.all([
    listSegments("intro"),
    listSegments("outro"),
  ]);

  const transitionalCount =
    intros.filter(isTransitional).length + outros.filter(isTransitional).length;

  return (
    <div className="space-y-6">
      <SegmentsAutoRefresh activeRows={transitionalCount} />
      <div>
        <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
          Intros &amp; outros
        </h1>
        <p className="mt-1 text-[14px] text-muted">
          Upload short branded clips that the pipeline splices onto every
          rendered video. Exactly one intro and one outro is active globally;
          a story can override the pick or skip the segment entirely from its
          edit page.
        </p>
      </div>

      {errorKey && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-[13px] text-danger">
          {errorKey}
        </div>
      )}

      <div className="rounded-xl border border-line bg-surface p-4 text-[13px]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-medium text-ink">Master switch</div>
            <p className="mt-1 text-muted">
              {masterExplicitlyOff
                ? "Currently off. No intro or outro is spliced onto any render."
                : "Currently on. Active intro and outro are spliced onto every render. Per-story overrides still apply."}
            </p>
          </div>
          <Link
            href="/admin/settings#video.intro_outro_enabled"
            className="rounded-md border border-line px-3 py-1.5 font-mono text-[12px] text-ink transition-colors hover:border-accent hover:text-accent"
          >
            Edit in Settings
          </Link>
        </div>
      </div>

      <SegmentSection
        kind="intro"
        title="Intros"
        rows={intros}
        activeId={activeIntroId}
      />

      <SegmentSection
        kind="outro"
        title="Outros"
        rows={outros}
        activeId={activeOutroId}
      />
    </div>
  );
}

function SegmentSection({
  kind,
  title,
  rows,
  activeId,
}: {
  kind: SegmentKind;
  title: string;
  rows: SegmentRow[];
  activeId: string;
}) {
  const singular = title.endsWith("s") ? title.slice(0, -1) : title;
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-[18px] font-bold tracking-tight">
          {title}
        </h2>
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted">
          {rows.length} in library
        </span>
      </div>

      <SegmentUploadForm kind={kind} singular={singular} />

      {rows.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface p-4 text-[13px] text-muted">
          Nothing here yet. Upload an {kind} above.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <SegmentRowCard
              key={row.id}
              row={row}
              kind={kind}
              isActive={row.id === activeId}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function StatusChip({ status }: { status: string }) {
  // Lifecycle colors:
  //   pending     -> "Uploading…" (browser is PUT-ing or has just finished)
  //   uploading   -> "Queued"     (worker hasn't picked it up yet)
  //   normalizing -> "Normalizing…"
  //   error       -> red chip with the message in the card below
  // ready rows don't render a chip — they are the default state.
  if (status === "pending") {
    return (
      <span className="rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-warn">
        Uploading
      </span>
    );
  }
  if (status === "uploading") {
    return (
      <span className="rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-warn">
        Queued
      </span>
    );
  }
  if (status === "normalizing") {
    return (
      <span className="rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-warn">
        Normalizing
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="rounded-full border border-danger/40 bg-danger/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-danger">
        Failed
      </span>
    );
  }
  return null;
}

function SegmentRowCard({
  row,
  kind,
  isActive,
}: {
  row: SegmentRow;
  kind: SegmentKind;
  isActive: boolean;
}) {
  const enabled = row.enabled !== 0;
  const status = row.status ?? "ready";
  const isReady = status === "ready";
  // Only show the preview when we have a normalized output to play. Source
  // bytes are stored in GCS too but they're the un-cropped original — the
  // admin's expectation is "what will the splice render look like."
  const previewUrl = row.normalized_url ?? "";
  const cardBorder = isActive
    ? "border-accent/50 bg-accent/5"
    : status === "error"
      ? "border-danger/40 bg-danger/5"
      : "border-line bg-surface";
  return (
    <div className={`rounded-xl border ${cardBorder} p-4`}>
      <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
        <div>
          {previewUrl ? (
            // Native video tag gives a free preview + scrubber without any
            // extra dep. muted+preload=metadata keeps the page light.
            <video
              src={previewUrl}
              controls
              muted
              preload="metadata"
              className="w-full rounded-md border border-line bg-bg"
            />
          ) : (
            <div className="flex h-[80px] items-center justify-center rounded-md border border-line bg-bg text-center text-[12px] text-muted">
              {status === "error" ? "no preview" : "processing…"}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {isActive && (
              <span className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent">
                Active
              </span>
            )}
            <StatusChip status={status} />
            {!enabled && isReady && (
              <span className="rounded-full border border-line bg-surface2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
                Disabled
              </span>
            )}
            <span className="font-mono text-[11px] uppercase tracking-wider text-muted">
              {formatDuration(row.duration_ms)}
            </span>
            <span className="font-mono text-[11px] text-muted">
              {row.id.slice(0, 8)}
            </span>
          </div>

          {row.label && (
            <p className="text-[13px] text-ink">{row.label}</p>
          )}

          {status === "error" && row.error && (
            <p className="rounded-md border border-danger/40 bg-danger/5 p-2 font-mono text-[11px] text-danger">
              {row.error}
            </p>
          )}

          <form action={renameSegmentAction} className="flex flex-wrap gap-2">
            <input type="hidden" name="id" value={row.id} />
            <input
              name="label"
              defaultValue={row.label ?? ""}
              placeholder="Label"
              className="min-w-[200px] flex-1 rounded-lg border border-line bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
            />
            <button className="rounded-md border border-line px-3 py-1.5 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent">
              Save label
            </button>
          </form>

          <div className="flex flex-wrap gap-2">
            {!isActive && enabled && isReady && (
              <form action={setActiveSegmentAction}>
                <input type="hidden" name="id" value={row.id} />
                <input type="hidden" name="kind" value={kind} />
                <button className="rounded-md border border-line px-3 py-1.5 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent">
                  Set as active
                </button>
              </form>
            )}
            {isReady && (
              <form action={setSegmentEnabledAction}>
                <input type="hidden" name="id" value={row.id} />
                <input
                  type="hidden"
                  name="enabled"
                  value={enabled ? "0" : "1"}
                />
                <button className="rounded-md border border-line px-3 py-1.5 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent">
                  {enabled ? "Disable" : "Enable"}
                </button>
              </form>
            )}
            <form action={deleteSegmentAction}>
              <input type="hidden" name="id" value={row.id} />
              <button className="rounded-md border border-danger/40 px-3 py-1.5 text-[12px] text-danger transition-colors hover:bg-danger/10">
                Delete
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
