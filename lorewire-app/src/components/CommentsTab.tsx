"use client";

// CommentsTab: wraps CommentsSection for client-side mount points where
// the initial thread + count can't be pre-fetched server-side.
//
// The article reader page (/articles/[locale]/[slug]) mounts CommentsSection
// directly because it's a server component — it can call loadCommentThread
// + countPublishedComments + commentsEnabledForArticle in Promise.all and
// pass the results down as props. The homepage TitleSheet is a client
// component opened dynamically from a list view, so the same pre-fetch
// isn't available. This wrapper fetches the initial thread the moment
// the tab mounts and renders the regular CommentsSection with the
// fetched data — same UX, same composer, same load-more / sort / reply.
//
// Story → article resolution happens server-side in /api/comments/count:
// the caller passes `storyId`, the endpoint looks up the matching
// published article via articles.story_id, and returns the RESOLVED
// articleId. That id is then used for the thread fetch and as
// CommentsSection's `articleId` prop. Net effect: the homepage thread
// and the article reader thread are THE SAME thread for any story
// that has a linked published article — readers see each other's
// comments regardless of which surface they comment from. Stories
// without a linked article fall through to a story-keyed thread.

import { useEffect, useState } from "react";

import { CommentsSection } from "@/components/CommentsSection";
import type { CommentThreadPage } from "@/lib/comments-read";

interface CommentsTabProps {
  storyId: string;
  /** True when the viewer has an lw_user session. Drives the composer's
   *  identity row ("Posting as @name" vs the guest-name input). Comments
   *  API verifies the actual session cookie server-side regardless. */
  signedIn: boolean;
  /** Deep-link target: when set, after the thread renders the matching
   *  comment glows briefly and the viewport scrolls to it. Falls
   *  through cleanly when the comment isn't on the first page (the
   *  user can load more to find it). */
  focusedCommentId?: string;
  /** SSR pre-fetched thread + count + enabled + resolved articleId for
   *  this storyId. Set by the homepage Page when the request URL carried
   *  `?story=<this id>`. When present, the tab paints with the seeded
   *  data on first render and skips its own fetch (no "Loading…"
   *  flash for permalink shares). The storyId check guards against
   *  applying a seed from a previous deep-link to a different open
   *  story — the seed is only used when storyIds match. */
  seed?: {
    storyId: string;
    articleId: string;
    count: number;
    enabled: boolean;
    thread: CommentThreadPage;
  } | null;
}

interface InitResponse {
  /** The resolved comments article_id (== article.id when there's a
   *  linked published article; == storyId otherwise). All subsequent
   *  comment calls for this thread use this id, not the storyId. */
  articleId: string;
  count: number;
  enabled: boolean;
}

export function CommentsTab({
  storyId,
  signedIn,
  focusedCommentId,
  seed,
}: CommentsTabProps) {
  // Apply the SSR seed only when it matches the open story id. The seed
  // is captured at request time from `?story=X` so it ALWAYS matches
  // first render of a deep-link visit, but a subsequent in-app modal
  // open of a DIFFERENT story would still receive the same seed via
  // prop — guard so we don't paint the wrong story's comments.
  const seedApplies = seed != null && seed.storyId === storyId;
  const [thread, setThread] = useState<CommentThreadPage | null>(
    seedApplies ? seed.thread : null,
  );
  const [meta, setMeta] = useState<InitResponse | null>(
    seedApplies
      ? {
          articleId: seed.articleId,
          count: seed.count,
          enabled: seed.enabled,
        }
      : null,
  );
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // Skip the client fetch when the SSR seed already covers this story.
    // The seed is sized to the first page (limit=20 in loadCommentThread,
    // same as the client's default), so sorting / load-more from the
    // user still work normally — they go through CommentsSection's own
    // /api/comments fetches with the resolved articleId in scope.
    if (seedApplies) return;
    let cancelled = false;
    setThread(null);
    setMeta(null);
    setErr(null);

    // Step 1: resolve story → article + read count + kill-switch. One
    // round trip; everything downstream keys off `info.articleId`.
    fetch(`/api/comments/count?storyId=${encodeURIComponent(storyId)}`)
      .then(async (r): Promise<InitResponse> => {
        if (!r.ok) throw new Error(`count ${r.status}`);
        return (await r.json()) as InitResponse;
      })
      .then(async (info) => {
        if (cancelled) return;
        // Step 2: fetch the first page of the resolved thread.
        const page = await fetch(
          `/api/comments?articleId=${encodeURIComponent(info.articleId)}`,
        ).then(async (r) =>
          r.ok
            ? ((await r.json()) as CommentThreadPage)
            : ({ nodes: [], nextCursor: null } as CommentThreadPage),
        );
        if (cancelled) return;
        // eslint-disable-next-line no-console -- rule 14
        console.info("[comments tab loaded]", {
          story_id: storyId,
          resolved_article_id: info.articleId,
          unified: info.articleId !== storyId,
          count: info.count,
          enabled: info.enabled,
          page_nodes: page.nodes.length,
        });
        setMeta(info);
        setThread(page);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console -- rule 14
        console.warn("[comments tab fetch failed]", {
          story_id: storyId,
          err: String(e),
        });
        setErr("Couldn't load comments. Try again in a moment.");
      });
    return () => {
      cancelled = true;
    };
  }, [storyId, seedApplies]);

  if (err) {
    return (
      <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
        {err}
      </p>
    );
  }

  if (!thread || !meta) {
    return (
      <p className="px-1 py-6 text-center font-mono text-[11px] uppercase tracking-[.2em] text-muted">
        Loading comments…
      </p>
    );
  }

  return (
    <CommentsSection
      articleId={meta.articleId}
      initial={thread}
      initialCount={meta.count}
      signedIn={signedIn}
      enabled={meta.enabled}
      permalinkStoryId={storyId}
      focusedCommentId={focusedCommentId}
    />
  );
}
