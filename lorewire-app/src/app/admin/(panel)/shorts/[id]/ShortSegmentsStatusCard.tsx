"use client";

// Intro/outro status card + per-short override picker. Mirrors the
// resolver chain in lib/short-segments so the admin sees EXACTLY which
// 9:16 clip will splice on the next Cloud Run render — and can pick a
// different one for THIS short without touching the per-story columns
// the long-form video also reads.
//
// Resolution order shown in the chip:
//   - "Override · <segment>"  -> from short_config.<kind>_segment_id
//   - "Override · Skipped"    -> from short_config.skip_<kind>
//   - "Story · <segment>"     -> per-story pin / global active
//   - skip with reason         -> resolver returned null
//
// The picker drops back to "inherit" when the user picks the same id
// the story chain already resolves to, so the override stays as small
// as possible.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { SegmentPickReason } from "@/lib/segment-resolver";
import { setShortSegmentOverrideAction } from "./actions";

type SegmentSource = "short_config" | "story";

interface SegmentStatus {
  label: string | null;
  reason: SegmentPickReason;
  source: SegmentSource;
}

interface OverrideState {
  intro_segment_id: string | null;
  outro_segment_id: string | null;
  skip_intro: boolean;
  skip_outro: boolean;
}

interface PickerOption {
  id: string;
  label: string;
}

interface PickerOptions {
  intro: PickerOption[];
  outro: PickerOption[];
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

function explain(
  status: SegmentStatus,
  kind: "intro" | "outro",
): string {
  if (status.source === "short_config" && status.reason === "skip-flag") {
    return `Per-short override: SKIP — no ${kind} on this render.`;
  }
  if (status.source === "short_config" && status.reason === "pinned") {
    return `Per-short override is pinned — will splice on every render.`;
  }
  if (status.source === "short_config" && status.reason === "pinned-missing") {
    return `Per-short override points at a deleted segment. Pick a new one or clear the override.`;
  }
  if (status.source === "short_config" && status.reason === "aspect-mismatch") {
    return `Per-short override is 16:9 — short renders skip it. Pick a 9:16 segment.`;
  }
  switch (status.reason) {
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
      return status.reason;
  }
}

export function ShortSegmentsStatusCard({
  storyId,
  intro,
  outro,
  override,
  pickerOptions,
}: {
  storyId: string;
  intro: SegmentStatus;
  outro: SegmentStatus;
  override: OverrideState;
  pickerOptions: PickerOptions;
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
            Per-story default →
          </Link>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <SegmentRow
          storyId={storyId}
          kind="intro"
          status={intro}
          overrideId={override.intro_segment_id}
          overrideSkip={override.skip_intro}
          options={pickerOptions.intro}
        />
        <SegmentRow
          storyId={storyId}
          kind="outro"
          status={outro}
          overrideId={override.outro_segment_id}
          overrideSkip={override.skip_outro}
          options={pickerOptions.outro}
        />
      </div>
    </section>
  );
}

function SegmentRow({
  storyId,
  kind,
  status,
  overrideId,
  overrideSkip,
  options,
}: {
  storyId: string;
  kind: "intro" | "outro";
  status: SegmentStatus;
  overrideId: string | null;
  overrideSkip: boolean;
  options: PickerOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const tone = SKIP_TONE[status.reason];
  const chipClass =
    tone === "ok"
      ? "bg-accent/15 text-accent border-accent/40"
      : tone === "warn"
        ? "bg-warn/15 text-warn border-warn/50"
        : "bg-surface text-muted border-line";

  // Picker current value reflects what's persisted in short_config (NOT
  // the resolved chain), so the dropdown shows what the admin set rather
  // than what the chain returned. "inherit" = no override.
  const pickValue = overrideSkip
    ? "skip"
    : overrideId
      ? overrideId
      : "inherit";

  function onPickChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    const next = e.target.value;
    if (next === pickValue) return;
    setError(null);
    startTransition(async () => {
      const r = await setShortSegmentOverrideAction(
        storyId,
        kind,
        next as "inherit" | "skip" | string,
      );
      if (!r.ok) {
        setError(r.error ?? "save failed");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="rounded-md border border-line bg-bg p-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          {kind}
        </span>
        <span
          className={`rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${chipClass}`}
          title={
            status.source === "short_config"
              ? "From the per-short override"
              : "From per-story pin or global default"
          }
        >
          {status.source === "short_config" ? "Override · " : "Story · "}
          {status.label ?? "skipped"}
        </span>
      </div>
      <p className="mt-1 font-mono text-[11px] text-muted">
        {explain(status, kind)}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <label className="sr-only" htmlFor={`short-${kind}-pick`}>
          {`Per-short ${kind} override`}
        </label>
        <select
          id={`short-${kind}-pick`}
          value={pickValue}
          onChange={onPickChange}
          disabled={pending}
          className="flex-1 rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-accent disabled:cursor-wait"
        >
          <option value="inherit">Inherit story default</option>
          <option value="skip">Skip — no {kind} for this short</option>
          {options.length > 0 && (
            <optgroup label="Pin a specific 9:16 segment">
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {pending && (
          <span className="font-mono text-[10px] text-muted">Saving…</span>
        )}
      </div>
      {error && (
        <p
          role="alert"
          className="mt-1 font-mono text-[10px] text-warn"
        >
          {error}
        </p>
      )}
    </div>
  );
}
