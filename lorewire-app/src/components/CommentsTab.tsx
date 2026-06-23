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
}

interface InitResponse {
  /** The resolved comments article_id (== article.id when there's a
   *  linked published article; == storyId otherwise). All subsequent
   *  comment calls for this thread use this id, not the storyId. */
  articleId: string;
  count: number;
  enabled: boolean;
}

export function CommentsTab({ storyId, signedIn }: CommentsTabProps) {
  const [thread, setThread] = useState<CommentThreadPage | null>(null);
  const [meta, setMeta] = useState<InitResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
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
  }, [storyId]);

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
    />
  );
}
