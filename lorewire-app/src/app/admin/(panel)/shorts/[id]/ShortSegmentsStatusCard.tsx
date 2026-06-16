// Status card surfaced above the short editor's render banner. Mirrors the
// resolution chain the render path walks (lib/segment-resolver) so the
// admin sees EXACTLY which 9:16 intro / outro will splice on the next
// Cloud Run render — or, if either is being skipped, the reason why.
//
// Stays read-only for v1: the override flow still lives on the story
// edit page (per-story pin / skip toggles) + the global active in
// Settings → Intros & outros. The card links to both so the admin
// doesn't have to hunt for the right surface to fix a skip.
//
// Plan: addresses "intros / outros not applied in short editor" feedback
// from the short editor session. A per-short override is a follow-up
// once the global setting works end-to-end.
//
// Server Component — pure render, no client state.

import Link from "next/link";
import type { SegmentPickReason } from "@/lib/segment-resolver";

interface SegmentStatus {
  label: string | null;
  reason: SegmentPickReason;
}

const SKIP_TONE: Record<SegmentPickReason, "ok" | "muted" | "warn"> = {
  pinned: "ok",
  "global-active": "ok",
  "skip-flag": "muted",
  "master-disabled": "muted",
  "no-default": "warn",
  "pinned-missing": "warn",
  "global-active-missing": "warn",
  "aspect-mismatch": "warn",
};

// Plain-language explanation for every resolver branch so the admin
// doesn't have to read the resolver source to figure out a skip.
function explain(reason: SegmentPickReason, kind: "intro" | "outro"): string {
  switch (reason) {
    case "pinned":
      return `Pinned on the story — will splice.`;
    case "global-active":
      return `Using the global 9:16 active ${kind} — will splice.`;
    case "skip-flag":
      return `Story has Skip ${kind} set — no ${kind} on this short.`;
    case "master-disabled":
      return `Master switch (video.intro_outro_enabled) is off — no ${kind}.`;
    case "no-default":
      return `No 9:16 active ${kind} in Settings — pick one to splice it.`;
    case "pinned-missing":
      return `Pinned segment was deleted — fix the per-story pin.`;
    case "global-active-missing":
      return `Active 9:16 ${kind} segment is missing or disabled.`;
    case "aspect-mismatch":
      return `The picked ${kind} is 16:9 — short renders skip it.`;
    default:
      return reason;
  }
}

export function ShortSegmentsStatusCard({
  storyId,
  intro,
  outro,
}: {
  storyId: string;
  intro: SegmentStatus;
  outro: SegmentStatus;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Intro &amp; Outro &middot; 9:16
        </h2>
        <div className="flex items-center gap-3 font-mono text-[10px] text-muted">
          <Link
            href="/admin/segments"
            className="hover:text-accent hover:underline"
          >
            Manage segments →
          </Link>
          <Link
            href={`/admin/stories/${storyId}`}
            className="hover:text-accent hover:underline"
          >
            Per-story override →
          </Link>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <SegmentRow kind="intro" status={intro} />
        <SegmentRow kind="outro" status={outro} />
      </div>
    </section>
  );
}

function SegmentRow({
  kind,
  status,
}: {
  kind: "intro" | "outro";
  status: SegmentStatus;
}) {
  const tone = SKIP_TONE[status.reason];
  const chipClass =
    tone === "ok"
      ? "bg-accent/15 text-accent border-accent/40"
      : tone === "warn"
        ? "bg-warn/15 text-warn border-warn/50"
        : "bg-surface text-muted border-line";
  return (
    <div className="rounded-md border border-line bg-bg p-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          {kind}
        </span>
        <span
          className={`rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${chipClass}`}
        >
          {status.label ?? "skipped"}
        </span>
      </div>
      <p className="mt-1 font-mono text-[11px] text-muted">
        {explain(status.reason, kind)}
      </p>
    </div>
  );
}
