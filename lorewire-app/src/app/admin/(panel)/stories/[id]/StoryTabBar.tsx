"use client";

// Tab nav for the unified story + short editor.
//
// URL-driven (?tab=…) instead of useState because we want deep links,
// back-button parity, and the ability to 308-redirect old
// /admin/shorts/[id] URLs to /admin/stories/[id]?tab=scenes. Visual
// style mirrors ShortEditorClient's tab strip exactly (rule 2).
//
// Plan: _plans/2026-06-24-unified-story-editor.md.

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { resolveStoryTab, STORY_TABS, type StoryTabId } from "./tabs";

export function StoryTabBar({
  storyId,
  activeTab,
}: {
  storyId: string;
  activeTab: StoryTabId;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function go(next: StoryTabId) {
    if (next === activeTab) return;
    // Preserve any other search params (e.g. deep-link debug flags).
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("tab", next);
    // eslint-disable-next-line no-console -- rule 14 (observability)
    console.info("[unified editor tab]", {
      storyId,
      fromTab: activeTab,
      toTab: next,
    });
    startTransition(() => {
      router.push(`/admin/stories/${storyId}?${params.toString()}`, {
        scroll: false,
      });
    });
  }

  return (
    <nav
      role="tablist"
      aria-label="Story editor tabs"
      className="flex flex-wrap gap-1 rounded-md border border-line bg-surface p-1"
    >
      {STORY_TABS.map((t) => {
        const isActive = t.id === activeTab;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={isPending && !isActive}
            onClick={() => go(resolveStoryTab(t.id))}
            className={
              isActive
                ? "rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-bg"
                : "rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-accent/10 disabled:opacity-50"
            }
          >
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
