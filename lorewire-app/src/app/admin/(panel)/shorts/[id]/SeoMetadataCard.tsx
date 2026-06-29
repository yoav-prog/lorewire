"use client";

// SEO metadata card on the short editor.
//
// Shows the LLM-generated per-platform metadata (titles / descriptions
// / captions / hashtags / tags) the publishers prefer over the
// template defaults. Includes a "Regenerate" button that re-runs the
// kie.ai Gemini 3.5 Flash pipeline against the current title +
// teleprompter + category.
//
// Editing-in-place is intentionally out of scope for this first
// version — the regenerate button is the loop, plus the publisher
// per-publish overrides on the four publish buttons. Phase 2.1
// (textareas + autosave per field) lands when the auto-regenerate
// quality has been measured for a week of real shorts.
//
// Plan: _plans/2026-06-24-llm-seo-metadata.md.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  regenerateSeoMetadataAction,
  type RegenerateSeoMetadataResult,
  type SeoMetadataState,
} from "./actions";

export function SeoMetadataCard({
  storyId,
  initial,
}: {
  storyId: string;
  initial: SeoMetadataState;
}) {
  const router = useRouter();
  const [state, setState] = useState<SeoMetadataState>(initial);
  const [result, setResult] = useState<RegenerateSeoMetadataResult | null>(
    null,
  );
  const [pending, startTransition] = useTransition();

  function regenerate() {
    setResult(null);
    startTransition(async () => {
      const r = await regenerateSeoMetadataAction(storyId);
      setResult(r);
      if (r.ok) {
        setState({ metadata: r.metadata, generatedAt: r.generatedAt });
        router.refresh();
      }
    });
  }

  const hasMetadata = state.metadata !== null;

  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 text-[12px] text-ink">
          <p className="font-medium">SEO metadata (LLM-generated per platform)</p>
          <p className="mt-0.5 text-[11px] text-muted">
            Auto-generated from this short&apos;s title + narration + category
            via kie.ai Gemini 3.5 Flash. Each platform&apos;s publisher prefers
            this over the template default. The metadata regenerates
            automatically when a fresh render lands; click below to force
            a regeneration on demand.
          </p>
          <CurrentState state={state} />
        </div>
        <button
          type="button"
          onClick={regenerate}
          disabled={pending}
          className="rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "Generating…" : hasMetadata ? "Regenerate" : "Generate"}
        </button>
      </div>

      {result && !result.ok && (
        <div className="mt-2 rounded-md border border-warn/40 bg-warn/5 px-2 py-1.5 font-mono text-[11px] text-warn">
          ✗ {result.error}
        </div>
      )}

      {hasMetadata && (
        <details className="mt-3 group border-t border-line pt-3">
          <summary className="cursor-pointer list-none text-[12px] font-medium text-ink [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-2">
              <svg
                aria-hidden="true"
                viewBox="0 0 12 12"
                className="h-3 w-3 text-muted transition-transform group-open:rotate-180"
              >
                <path
                  d="M2 4l4 4 4-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              View per-platform metadata
            </span>
          </summary>
          <div className="mt-3 space-y-3 text-[11px]">
            <PlatformBlock title="YouTube">
              <FieldRow label="Title" value={state.metadata!.youtube.title} />
              <FieldRow
                label="Description"
                value={state.metadata!.youtube.description}
                multiline
              />
              <FieldRow
                label="Tags"
                value={state.metadata!.youtube.tags.join(", ")}
              />
            </PlatformBlock>
            <PlatformBlock title="TikTok">
              <FieldRow
                label="Caption"
                value={state.metadata!.tiktok.caption}
                multiline
              />
            </PlatformBlock>
            <PlatformBlock title="Facebook">
              <FieldRow
                label="Caption"
                value={state.metadata!.facebook.caption}
                multiline
              />
            </PlatformBlock>
            <PlatformBlock title="Instagram">
              <FieldRow
                label="Caption"
                value={state.metadata!.instagram.caption}
                multiline
              />
            </PlatformBlock>
          </div>
        </details>
      )}
    </div>
  );
}

function CurrentState({ state }: { state: SeoMetadataState }) {
  if (!state.metadata) {
    return (
      <p className="mt-1 font-mono text-[10px] text-muted">
        Not generated yet. Click Generate to run the kie.ai Gemini 3.5
        Flash pipeline against this story&apos;s narration script.
      </p>
    );
  }
  return (
    <p className="mt-1 font-mono text-[10px] text-muted">
      ✓ Generated {formatWhen(state.generatedAt)} — publishers use this
      over the template defaults.
    </p>
  );
}

function PlatformBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-line/60 bg-bg px-3 py-2">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted">
        {title}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function FieldRow({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] font-medium text-muted">{label}</div>
      <div
        className={`text-ink ${multiline ? "whitespace-pre-wrap" : "truncate"}`}
      >
        {value}
      </div>
    </div>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "(unknown time)";
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return "(unknown time)";
  const now = Date.now();
  const diffMs = now - d.valueOf();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
}
