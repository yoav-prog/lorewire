"use client";

// Per-story comments open / closed switch for the story edit page. Sits
// alongside the other story-level settings; flipping it writes the
// `comments.article_off.<resolvedArticleId>` setting via a server
// action. The "resolved article id" is the comments key — story.id when
// the story isn't linked to a published article, article.id when it is
// — computed server-side and passed in as a prop so the toggle's UI
// stays simple.
//
// Two-line label by design: the legend names the control, the helper
// line shows the live state ("Open · readers can post" vs "Closed ·
// existing comments stay visible") so a glance tells the admin what's
// happening without flipping anything. Optimistic UI on click so the
// new state paints immediately; the server action's revalidatePath
// re-renders the page on success.

import { useState, useTransition } from "react";
import { setArticleCommentsClosedAction } from "@/app/admin/(panel)/comments/actions";

interface StoryCommentsToggleProps {
  resolvedArticleId: string;
  /** True when commenting is currently closed for this story. */
  closed: boolean;
  /** False when the site-wide kill switch is off. When that's the case
   *  this per-story toggle is informational only — the public guard is
   *  the AND of site-wide + per-article, so opening one story doesn't
   *  override the global kill. Surfaced in the helper text so the admin
   *  understands why their click here didn't change the public reader. */
  siteWideEnabled: boolean;
  /** Path to revalidate after the toggle commits; usually the story edit
   *  page so this control's defaultChecked matches reality on re-render. */
  revalidatePath: string;
}

export default function StoryCommentsToggle({
  resolvedArticleId,
  closed,
  siteWideEnabled,
  revalidatePath,
}: StoryCommentsToggleProps) {
  const [optimisticClosed, setOptimisticClosed] = useState(closed);
  const [pending, startTransition] = useTransition();

  function onToggle(next: boolean) {
    setOptimisticClosed(next);
    startTransition(async () => {
      try {
        await setArticleCommentsClosedAction(
          resolvedArticleId,
          next,
          revalidatePath,
        );
      } catch (err) {
        // Roll back the optimistic state on failure so the UI stays
        // honest about what the server thinks.
        setOptimisticClosed(closed);
        // eslint-disable-next-line no-console -- rule 14
        console.warn("[story comments toggle failed]", {
          article_id: resolvedArticleId,
          attempted_closed: next,
          err: String(err),
        });
      }
    });
  }

  const isOpen = !optimisticClosed;
  const stateLabel = isOpen
    ? "Open · readers can post"
    : "Closed · existing comments stay visible";

  return (
    <fieldset className="rounded-md border border-line bg-surface px-3 py-2.5">
      <legend className="px-1 font-mono text-[10px] uppercase tracking-wider text-muted">
        Comments
      </legend>

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">
            {isOpen ? "Open for comments" : "Closed for comments"}
          </p>
          <p className="mt-0.5 text-[11.5px] leading-snug text-muted">
            {stateLabel}
            {!siteWideEnabled && (
              <span className="ml-1 text-cat-entitled">
                · Site-wide kill switch is OFF, so this per-story setting
                won't take effect until you turn the kill switch back on.
              </span>
            )}
          </p>
        </div>

        <label className="relative inline-flex shrink-0 cursor-pointer items-center">
          <input
            type="checkbox"
            checked={isOpen}
            disabled={pending}
            onChange={(e) => onToggle(!e.target.checked)}
            className="peer sr-only"
            aria-label={isOpen ? "Close comments for this story" : "Open comments for this story"}
          />
          <span
            className="h-6 w-11 rounded-full bg-surface2 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-ink after:transition-transform after:content-[''] peer-checked:bg-accent peer-checked:after:translate-x-5 peer-disabled:opacity-60"
            aria-hidden
          />
        </label>
      </div>
    </fieldset>
  );
}
