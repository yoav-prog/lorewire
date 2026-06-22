// Intro/outro library (Wave 3 Phase 4; per-aspect 2026-06-15). Two stacked
// sections — Intros and Outros — each split into a wide (16:9) and a tall
// (9:16) group because "active" is now per-aspect: a wide and a tall segment
// can both be live, and each render uses the one matching its shape. Each group
// has its own ACTIVE badge, "Set as active" control, and a loud empty/gap
// state so the admin never ships a render with a missing clip by accident. The
// shared upload form per kind auto-detects the file's aspect and the card lands
// in the matching group. The master switch `video.intro_outro_enabled` lives on
// the Settings page; we mirror it here so the admin sees it without leaving.
//
// Uploads land as `status='pending'`; once the browser confirms the PUT,
// finalize flips to `uploading`; pipeline/segments_worker.py picks it up,
// normalizes with ffmpeg, and flips to `ready`. While any row on the page is
// in a transitional state, <SegmentsAutoRefresh> polls every 5s so the chip
// transitions live in front of the admin.

import { requireCapability } from "@/lib/dal";
import {
  getSetting,
  listSegments,
  type SegmentKind,
  type SegmentRow,
} from "@/lib/repo";
import {
  LEGACY_DEFAULT_ASPECT,
  VIDEO_ASPECTS,
  activeSegmentSettingKey,
  isVideoAspect,
  type VideoAspect,
} from "@/lib/aspect";
import {
  setActiveSegmentAction,
  setSegmentEnabledAction,
  renameSegmentAction,
  deleteSegmentAction,
  saveSettingAction,
} from "@/app/admin/actions";
import SettingsShell from "@/app/admin/SettingsShell";
import { SegmentUploadForm } from "./SegmentUploadForm";
import { SegmentsAutoRefresh } from "./SegmentsAutoRefresh";

// Plain-language labels per aspect so a non-technical admin isn't left parsing
// "16:9" — the council's Outsider lens. `tag`/`platforms` head the group, `noun`
// fills the warning copy ("…will render with no intro").
const ASPECT_GROUP: Record<
  VideoAspect,
  { tag: string; ratio: string; platforms: string; noun: string }
> = {
  "16:9": {
    tag: "Wide",
    ratio: "16:9",
    platforms: "YouTube, X, LinkedIn",
    noun: "wide videos",
  },
  "9:16": {
    tag: "Tall",
    ratio: "9:16",
    platforms: "Shorts, TikTok, Reels",
    noun: "tall videos",
  },
};

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

// A NULL aspect column predates the per-aspect work; treat it as the legacy
// 9:16 default, same as the resolver and the worker.
function segmentAspect(row: SegmentRow): VideoAspect {
  return isVideoAspect(row.aspect) ? row.aspect : LEGACY_DEFAULT_ASPECT;
}

function isLiveActive(row: SegmentRow | undefined): boolean {
  return Boolean(row && row.enabled !== 0 && (row.status ?? "ready") === "ready");
}

export default async function SegmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("settings.manage");
  const sp = await searchParams;
  const errorKey = typeof sp.error === "string" ? sp.error : "";

  const [
    activeIntro16x9,
    activeIntro9x16,
    activeOutro16x9,
    activeOutro9x16,
    masterRaw,
  ] = await Promise.all([
    getSetting(activeSegmentSettingKey("intro", "16:9")),
    getSetting(activeSegmentSettingKey("intro", "9:16")),
    getSetting(activeSegmentSettingKey("outro", "16:9")),
    getSetting(activeSegmentSettingKey("outro", "9:16")),
    getSetting("video.intro_outro_enabled"),
  ]);
  // Active id per (kind, aspect) — the four independent slots.
  const activeByKindAspect: Record<SegmentKind, Record<VideoAspect, string>> = {
    intro: { "16:9": activeIntro16x9 ?? "", "9:16": activeIntro9x16 ?? "" },
    outro: { "16:9": activeOutro16x9 ?? "", "9:16": activeOutro9x16 ?? "" },
  };
  const masterExplicitlyOff = ["0", "false", "off", "no"].includes(
    (masterRaw ?? "").trim().toLowerCase(),
  );
  // Choose which upload path the form should use:
  //   - Prod (Vercel): always GCS resumable. Fail loud if creds are missing
  //     so the page surfaces "configure GCS" instead of silently breaking.
  //   - Dev with GCS configured: GCS resumable (same as prod, easier debug).
  //   - Dev without GCS: local multipart -> system ffmpeg -> public/segments.
  const isVercel = process.env.VERCEL === "1";
  const hasGcs = Boolean(process.env.GCS_BUCKET);
  const uploadMode: "gcs" | "local" = isVercel || hasGcs ? "gcs" : "local";

  const [intros, outros] = await Promise.all([
    listSegments("intro"),
    listSegments("outro"),
  ]);
  const rowsByKind: Record<SegmentKind, SegmentRow[]> = {
    intro: intros,
    outro: outros,
  };

  const transitionalCount =
    intros.filter(isTransitional).length + outros.filter(isTransitional).length;

  // Gap detection: a (kind, aspect) slot is "covered" when its active id names
  // a ready, enabled row of the matching aspect. Anything uncovered ships
  // body-only, so surface it loudly at the top. Moot when the master switch is
  // off (nothing splices at all), so skip the banner in that case.
  const gaps: { kind: SegmentKind; aspect: VideoAspect }[] = [];
  if (!masterExplicitlyOff) {
    for (const kind of ["intro", "outro"] as const) {
      for (const aspect of VIDEO_ASPECTS) {
        const activeId = activeByKindAspect[kind][aspect];
        const activeRow = rowsByKind[kind].find(
          (r) => r.id === activeId && segmentAspect(r) === aspect,
        );
        if (!isLiveActive(activeRow)) gaps.push({ kind, aspect });
      }
    }
  }

  return (
    <SettingsShell
      active="intros"
      title="Intros & outros"
      description="Upload short branded clips that the pipeline splices onto every rendered video. Wide (16:9) and tall (9:16) videos each get their own active intro and outro; a story can override the pick or skip the segment from its edit page."
    >
      <div className="space-y-6">
        <SegmentsAutoRefresh activeRows={transitionalCount} />

        {errorKey && (
          <div className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-[13px] text-danger">
            {errorKey}
          </div>
        )}

        {gaps.length > 0 && (
          <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-[13px] text-warn">
            <span className="font-semibold">Heads up.</span> No active segment
            for:{" "}
            {gaps
              .map((g) => `${ASPECT_GROUP[g.aspect].tag.toLowerCase()} ${g.kind}`)
              .join(", ")}
            . Those renders ship without that clip until you set one below.
          </div>
        )}

        <form
          action={saveSettingAction}
          className="rounded-xl border border-line bg-surface p-4"
        >
          <input type="hidden" name="key" value="video.intro_outro_enabled" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[13px] font-semibold text-ink">
                Master switch
              </div>
              <p className="mt-0.5 text-[12px] text-muted">
                {masterExplicitlyOff
                  ? "Currently off. No intro or outro is spliced onto any render."
                  : "Currently on. The active intro and outro for each shape are spliced onto every render. Per-story overrides still apply."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <select
                name="value"
                defaultValue={masterExplicitlyOff ? "0" : "1"}
                className="rounded-lg border border-line bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
              >
                <option value="1">On</option>
                <option value="0">Off</option>
              </select>
              <button className="rounded-md border border-line px-3 py-1.5 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent">
                Save
              </button>
            </div>
          </div>
        </form>

        <SegmentKindSection
          kind="intro"
          title="Intros"
          rows={intros}
          activeByAspect={activeByKindAspect.intro}
          uploadMode={uploadMode}
        />

        <SegmentKindSection
          kind="outro"
          title="Outros"
          rows={outros}
          activeByAspect={activeByKindAspect.outro}
          uploadMode={uploadMode}
        />
      </div>
    </SettingsShell>
  );
}

function SegmentKindSection({
  kind,
  title,
  rows,
  activeByAspect,
  uploadMode,
}: {
  kind: SegmentKind;
  title: string;
  rows: SegmentRow[];
  activeByAspect: Record<VideoAspect, string>;
  uploadMode: "gcs" | "local";
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

      <SegmentUploadForm
        kind={kind}
        singular={singular}
        uploadMode={uploadMode}
      />

      {VIDEO_ASPECTS.map((aspect) => (
        <SegmentAspectGroup
          key={aspect}
          kind={kind}
          aspect={aspect}
          singular={singular}
          rows={rows.filter((r) => segmentAspect(r) === aspect)}
          activeId={activeByAspect[aspect]}
        />
      ))}
    </section>
  );
}

function SegmentAspectGroup({
  kind,
  aspect,
  singular,
  rows,
  activeId,
}: {
  kind: SegmentKind;
  aspect: VideoAspect;
  singular: string;
  rows: SegmentRow[];
  activeId: string;
}) {
  const meta = ASPECT_GROUP[aspect];
  const lower = singular.toLowerCase();
  const activeRow = rows.find((r) => r.id === activeId);
  const covered = isLiveActive(activeRow);

  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface/40 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-[12px] font-semibold uppercase tracking-wider text-ink">
          {meta.tag}
        </span>
        <span className="font-mono text-[11px] text-muted">
          {meta.ratio} · {meta.platforms}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-[12px] text-warn">
          No {meta.ratio} {lower} uploaded yet. {meta.tag} videos render with no{" "}
          {lower}.
        </p>
      ) : !covered ? (
        <p className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-[12px] text-warn">
          No active {lower} for {meta.noun}. Set one below or {meta.tag.toLowerCase()}{" "}
          renders play without it.
        </p>
      ) : null}

      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((row) => (
            <SegmentRowCard
              key={row.id}
              row={row}
              kind={kind}
              singular={singular}
              aspectNoun={meta.noun}
              isActive={row.id === activeId}
            />
          ))}
        </div>
      )}
    </div>
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
  singular,
  aspectNoun,
  isActive,
}: {
  row: SegmentRow;
  kind: SegmentKind;
  singular: string;
  aspectNoun: string;
  isActive: boolean;
}) {
  const enabled = row.enabled !== 0;
  const status = row.status ?? "ready";
  const isReady = status === "ready";
  // Active-but-disabled is a silent trap: the slot still points here so the
  // resolver finds the active id, sees it disabled, and renders body-only.
  // Surface it on the card the admin would look at to fix it.
  const activeButDark = isActive && (!enabled || !isReady);
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
            // extra dep. preload=metadata avoids fetching the whole file just
            // to show the poster; audio is left on so the admin hears the
            // segment exactly as it will splice into a render. No autoplay
            // here, so the browser's "muted to allow autoplay" requirement
            // does not apply.
            <video
              src={previewUrl}
              controls
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

          {activeButDark && (
            <p className="rounded-md border border-warn/40 bg-warn/10 p-2 text-[11px] text-warn">
              Active but {enabled ? "still processing" : "disabled"} — {aspectNoun}{" "}
              render with no {singular.toLowerCase()} until this is{" "}
              {enabled ? "ready" : "re-enabled"} or another is set active.
            </p>
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
