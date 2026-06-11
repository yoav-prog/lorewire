// Intro/outro library (Wave 3 Phase 4). Two stacked sections — Intros and
// Outros — each with an upload form, a master "Active" badge, and a row of
// controls per uploaded segment (preview, rename, set active, enable/disable,
// delete). The master switch `video.intro_outro_enabled` lives on the
// Settings page; we link to it so the admin can see it without leaving here.

import Link from "next/link";
import { requireAdmin } from "@/lib/dal";
import {
  getSetting,
  listSegments,
  type SegmentKind,
  type SegmentRow,
} from "@/lib/repo";
import {
  uploadSegmentAction,
  setActiveSegmentAction,
  setSegmentEnabledAction,
  renameSegmentAction,
  deleteSegmentAction,
} from "@/app/admin/actions";

const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";

function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return "—";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const ERROR_MESSAGES: Record<string, string> = {
  "missing-kind": "Missing intro/outro kind on the request.",
  "no-file": "Pick a file before uploading.",
  "too-large": "That file is bigger than 200 MB.",
  "bad-mime": "Only .mp4 and .mov uploads are accepted.",
  "bad-ext": "File extension must be .mp4 or .mov.",
  "not-mp4": "That file does not look like a valid mp4/mov (missing ftyp header).",
  "normalize-failed": "ffmpeg could not normalize that file. Is ffmpeg on PATH?",
  "segment-not-found": "That segment no longer exists.",
  "missing-id": "Missing segment id on the request.",
  "missing-fields": "Missing required fields on the request.",
};

export default async function SegmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const errorKey = typeof sp.error === "string" ? sp.error : "";
  const uploaded = typeof sp.uploaded === "string" ? sp.uploaded : "";
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

  return (
    <div className="space-y-6">
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
          {ERROR_MESSAGES[errorKey] ?? `Error: ${errorKey}`}
        </div>
      )}
      {uploaded && (
        <div className="rounded-xl border border-high/40 bg-high/10 p-3 text-[13px] text-high">
          Upload complete. Segment id {uploaded.slice(0, 8)}…
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

      <form
        action={uploadSegmentAction}
        encType="multipart/form-data"
        className="space-y-2 rounded-xl border border-line bg-surface p-4"
      >
        <input type="hidden" name="kind" value={kind} />
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <div>
            <label className={LABEL}>{title.slice(0, -1)} file (.mp4 / .mov)</label>
            <input
              name="file"
              type="file"
              accept="video/mp4,video/quicktime,.mp4,.mov"
              required
              className="block w-full text-[13px] text-ink file:mr-3 file:rounded-md file:border file:border-line file:bg-bg file:px-3 file:py-1.5 file:text-[12px] file:text-ink hover:file:border-accent"
            />
          </div>
          <div>
            <label className={LABEL}>Label (optional)</label>
            <input
              name="label"
              placeholder={`e.g. "Brand opener v2"`}
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
            />
          </div>
          <div className="flex items-end">
            <button className="rounded-lg bg-accent px-4 py-2 font-semibold text-bg transition-opacity hover:opacity-90">
              Upload
            </button>
          </div>
        </div>
        <p className="text-[12px] text-muted">
          Source is normalized to 1080x1920 @ 30fps (center-crop for landscape
          sources) and stored in GCS. 200 MB max.
        </p>
      </form>

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
  const url = row.normalized_url ?? row.source_url ?? "";
  return (
    <div
      className={`rounded-xl border ${
        isActive ? "border-accent/50 bg-accent/5" : "border-line bg-surface"
      } p-4`}
    >
      <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
        <div>
          {url ? (
            // Native video tag gives a free preview + scrubber without any
            // extra dep. muted+preload=metadata keeps the page light.
            <video
              src={url}
              controls
              muted
              preload="metadata"
              className="w-full rounded-md border border-line bg-bg"
            />
          ) : (
            <div className="flex h-[80px] items-center justify-center rounded-md border border-line bg-bg text-[12px] text-muted">
              no preview
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
            {!enabled && (
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
            {!isActive && enabled && (
              <form action={setActiveSegmentAction}>
                <input type="hidden" name="id" value={row.id} />
                <input type="hidden" name="kind" value={kind} />
                <button className="rounded-md border border-line px-3 py-1.5 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent">
                  Set as active
                </button>
              </form>
            )}
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
