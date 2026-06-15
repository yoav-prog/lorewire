"use client";

// Small picker that lets an admin link an article to a story (the Reddit
// pipeline kind whose short_render scenes the article wants to borrow). When
// the link is set, the sibling ShortScenesPanel surfaces the linked story's
// scene images for hero / og / gallery promotion.
//
// UI: collapsed by default to a one-line summary
//   "Linked story: <title>   [Change]  [Unlink]"   (linked)
//   "Linked story: none      [Link to story]"      (unlinked)
// Clicking the action button opens an inline panel with a search box that
// filters the slim story list by title. Clicking a row fires
// setArticleStoryIdAction immediately (lazy user — no Save click required),
// then closes the panel and triggers a router refresh so the panel and
// ShortScenesPanel re-render from the new server state.
//
// Plan: _plans/2026-06-15-shorts-to-article-media.md

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setArticleStoryIdAction } from "@/app/admin/actions";

const ROW =
  "flex w-full items-center gap-3 rounded-md border border-line bg-bg px-3 py-2 text-left text-[13px] text-ink transition-colors hover:border-accent hover:bg-surface focus:border-accent focus:outline-none";
const ROW_SELECTED =
  "flex w-full items-center gap-3 rounded-md border border-accent bg-accent/10 px-3 py-2 text-left text-[13px] text-ink";
const BTN =
  "rounded-md border border-line bg-bg px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40";
const BTN_DANGER =
  "rounded-md border border-line bg-bg px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-warn transition-colors hover:border-warn disabled:cursor-not-allowed disabled:opacity-40";
const SEARCH =
  "w-full rounded-md border border-line bg-bg px-3 py-2 text-[13px] text-ink outline-none focus:border-accent";

export interface StoryOption {
  id: string;
  title: string | null;
}

export interface LinkedStoryWidgetProps {
  articleId: string;
  /** Currently-persisted articles.story_id, or null when unlinked. */
  currentStoryId: string | null;
  /** Title of the currently-linked story for the collapsed-state label.
   *  Server resolves it; null when the link is dangling (story deleted) so
   *  the widget can still show "(deleted)" without an extra round-trip. */
  currentStoryTitle: string | null;
  /** All stories the picker can choose from. Slim shape (id + title) keeps
   *  the page payload small even with hundreds of stories. */
  stories: StoryOption[];
}

export function LinkedStoryWidget({
  articleId,
  currentStoryId,
  currentStoryTitle,
  stories,
}: LinkedStoryWidgetProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return stories.slice(0, 50);
    return stories
      .filter((s) => (s.title ?? "").toLowerCase().includes(q))
      .slice(0, 50);
  }, [stories, query]);

  function pick(storyId: string | null): void {
    setError("");
    const formData = new FormData();
    formData.set("id", articleId);
    formData.set("story_id", storyId ?? "");
    startTransition(async () => {
      console.info("[article-editor link-story]", {
        articleId,
        picked: storyId,
      });
      const result = await setArticleStoryIdAction(formData);
      if (!result.ok) {
        setError(result.error ?? "unknown");
        return;
      }
      setOpen(false);
      setQuery("");
      router.refresh();
    });
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted">
          Linked story
        </span>
        <span className="flex-1 truncate text-[13px] text-ink">
          {currentStoryId ? (currentStoryTitle ?? "(deleted)") : (
            <span className="text-muted">none</span>
          )}
        </span>
        {currentStoryId && (
          <button
            type="button"
            className={BTN_DANGER}
            disabled={pending}
            onClick={() => pick(null)}
          >
            Unlink
          </button>
        )}
        <button
          type="button"
          className={BTN}
          disabled={pending}
          onClick={() => setOpen((v) => !v)}
        >
          {currentStoryId ? "Change" : "Link to story"}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-2">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title…"
            className={SEARCH}
          />
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-muted">
                {stories.length === 0
                  ? "No stories yet."
                  : "No matches."}
              </div>
            ) : (
              filtered.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={s.id === currentStoryId ? ROW_SELECTED : ROW}
                  disabled={pending}
                  onClick={() => pick(s.id)}
                >
                  <span className="flex-1 truncate">
                    {s.title ?? "(untitled)"}
                  </span>
                  <span className="font-mono text-[10px] text-muted">
                    {s.id.slice(0, 8)}
                  </span>
                </button>
              ))
            )}
          </div>
          {filtered.length === 50 && (
            <div className="px-3 py-1 text-[11px] text-muted">
              Showing first 50. Refine the search to see more.
            </div>
          )}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-2 rounded-md border border-warn bg-warn/10 px-3 py-2 text-[12px] text-warn"
        >
          Couldn’t set linked story: {error}
        </div>
      )}
    </div>
  );
}
