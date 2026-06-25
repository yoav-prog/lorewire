"use client";

// Header strip on the short editor that shows the canonical story
// title and exposes a one-click "Regenerate" button next to it.
//
// Plan: _plans/2026-06-25-title-length-gate.md (Layer 3 — admin
// recovery). The regenerate call runs the same LLM prompt as the
// Python pipeline's title gate (lib/title-regenerator.ts), validates
// the response against the length policy, and writes the new title
// to stories.title. On success the visible title updates in place
// and the rest of the page refreshes so any title-derived UI
// (e.g. the hero preview) picks up the change.
//
// Visual language matches the existing SeoMetadataCard regenerate
// affordance: a small pill button beside the field it acts on, an
// inline status line for in-flight + error states.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { regenerateStoryTitleAction } from "@/app/admin/actions";

// Mirrors the cap in lib/title-regenerator + pipeline/stages.py. Used
// only for the "too long" hint badge — the real gate lives server-side.
const TITLE_HINT_MAX_CHARS = 50;

interface Props {
  storyId: string;
  initialTitle: string | null;
}

export function StoryTitleHeader({ storyId, initialTitle }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle ?? "");
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const tooLong = title.length > TITLE_HINT_MAX_CHARS;

  function onClick() {
    setError(null);
    setJustSaved(false);
    startTransition(async () => {
      const result = await regenerateStoryTitleAction(storyId);
      if (result.ok) {
        setTitle(result.title);
        setJustSaved(true);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-base font-semibold text-ink">
          {title || "(untitled)"}
        </h1>
        {tooLong && (
          <span
            className="rounded-md border border-warn/40 bg-warn/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-warn"
            title={`Title is ${title.length} characters; LoreWire hero is tuned for ${TITLE_HINT_MAX_CHARS} or fewer.`}
          >
            {title.length} chars · too long
          </span>
        )}
        <button
          type="button"
          onClick={onClick}
          disabled={pending}
          className="rounded-md border border-line bg-surface px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          title="Generate a fresh branded title from the article body"
        >
          {pending ? "Generating…" : "Regenerate title"}
        </button>
      </div>
      {error && (
        <p className="font-mono text-[11px] text-warn">
          Title regenerate failed: {error}
        </p>
      )}
      {justSaved && !error && (
        <p className="font-mono text-[11px] text-muted">
          New title saved.
        </p>
      )}
    </div>
  );
}
